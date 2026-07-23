// Review console API. All actions require the x-admin-key header.
// POST /.netlify/functions/admin  { action, ... }

import { getStore } from '@netlify/blobs';

const ADMIN_KEY = process.env.ADMIN_KEY;
const PAGE = 60;

const store = () => getStore({ name: 'room', consistency: 'strong' });

// Constant-time compare so the key cannot be guessed a character at a time.
function keyOk(given) {
  if (!ADMIN_KEY || !given || given.length !== ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < ADMIN_KEY.length; i++) diff |= ADMIN_KEY.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// Blobs has no locking, so the wall blob is read-modify-write with an ETag check.
// If someone else wrote in between, the conditional write fails and we start over.
async function mutateWall(s, day, fn) {
  const key = `wall/d${day}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await s.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const next = fn(cur?.data || []);
    const opts = cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    const { modified } = await s.setJSON(key, next, opts);
    if (modified) return true;
    await new Promise(r => setTimeout(r, 60 * (attempt + 1)));
  }
  return false;
}

// Fetch many blobs without opening hundreds of sockets at once.
async function getMany(s, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 12) {
    const batch = await Promise.all(
      keys.slice(i, i + 12).map(k =>
        s.get(k, { type: 'json', consistency: 'strong' }).then(v => (v ? { ...v, id: k } : null)).catch(() => null)
      )
    );
    out.push(...batch.filter(Boolean));
  }
  return out;
}

async function pendingKeys(s, day) {
  const { blobs } = await s.list({ prefix: `pending/d${day}/` });
  // Priority lane first, then oldest first inside each lane, so nobody waits
  // longer than they have to and the urgent ones are never buried.
  return blobs.map(b => b.key).sort((a, b) => {
    const la = a.split('/')[2], lb = b.split('/')[2];
    if (la !== lb) return lb.localeCompare(la);
    return a.localeCompare(b);
  });
}

export default async (req) => {
  const json = (b, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

  if (req.method !== 'POST') return json({ ok: false, message: 'Method not allowed' }, 405);
  if (!keyOk(req.headers.get('x-admin-key'))) return json({ ok: false, message: 'Wrong key' }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, message: 'Bad request' }, 400); }

  const s = store();
  const days = d => (d >= 1 && d <= 5 ? [d] : [1, 2, 3, 4, 5]);

  try {
    if (body.action === 'stats') {
      const out = { pending: {}, priority: 0 };
      for (let d = 1; d <= 5; d++) {
        const { blobs } = await s.list({ prefix: `pending/d${d}/` });
        out.pending[d] = blobs.length;
        out.priority += blobs.filter(b => b.key.split('/')[2] === '1').length;
      }
      return json({ ok: true, stats: out });
    }

    if (body.action === 'list') {
      const status = ['pending', 'approved', 'rejected'].includes(body.status) ? body.status : 'pending';
      const list = days(parseInt(body.day, 10));

      if (status === 'pending') {
        let keys = [];
        for (const d of list) keys = keys.concat(await pendingKeys(s, d));
        return json({ ok: true, rows: await getMany(s, keys.slice(0, PAGE)) });
      }

      if (status === 'approved') {
        let rows = [];
        for (const d of list) rows = rows.concat((await s.get(`wall/d${d}`, { type: 'json' })) || []);
        return json({ ok: true, rows: rows.slice(0, PAGE) });
      }

      let keys = [];
      for (const d of list) {
        const { blobs } = await s.list({ prefix: `rejected/d${d}/` });
        keys = keys.concat(blobs.map(b => b.key));
      }
      return json({ ok: true, rows: await getMany(s, keys.sort().reverse().slice(0, PAGE)) });
    }

    if (body.action === 'approve') {
      const ids = (body.ids || []).filter(k => String(k).startsWith('pending/'));
      const rows = await getMany(s, ids);
      const byDay = {};
      for (const r of rows) (byDay[r.day] ||= []).push(r);

      for (const [day, list] of Object.entries(byDay)) {
        const add = list.map(r => ({
          id: r.id, day: r.day, text: r.text, original: r.original || null,
          priority: !!r.priority, created_at: r.created_at
        }));
        const okWrite = await mutateWall(s, day, wall => [...add, ...wall]);
        if (!okWrite) return json({ ok: false, message: 'The wall was busy. Try again.' }, 409);
        await Promise.all(list.map(r => s.delete(r.id)));
      }
      return json({ ok: true });
    }

    if (body.action === 'reject') {
      const ids = (body.ids || []).filter(k => String(k).startsWith('pending/'));
      const rows = await getMany(s, ids);
      // Kept rather than deleted, so you can look back at what you turned away.
      await Promise.all(rows.map(r =>
        s.setJSON(`rejected/d${r.day}/${r.id.split('/').pop()}`, { ...r, rejected_at: new Date().toISOString() })
          .then(() => s.delete(r.id))
      ));
      return json({ ok: true });
    }

    if (body.action === 'unpost') {
      for (const id of body.ids || []) {
        const day = String(id).match(/pending\/d(\d)\//)?.[1];
        if (!day) continue;
        let pulled = null;
        await mutateWall(s, day, wall => {
          pulled = wall.find(e => e.id === id) || null;
          return wall.filter(e => e.id !== id);
        });
        if (pulled) await s.setJSON(id, pulled);
      }
      return json({ ok: true });
    }

    if (body.action === 'edit') {
      const id = String(body.id || '');
      const text = String(body.text || '').trim().replace(/\s+/g, ' ');
      if (text.length < 8 || text.length > 400)
        return json({ ok: false, message: 'Edit must be 8 to 400 characters' }, 400);

      const day = id.match(/d(\d)\//)?.[1];
      if (!day) return json({ ok: false, message: 'No such entry' }, 404);

      const pending = await s.get(id, { type: 'json', consistency: 'strong' });

      if (pending) {
        // Preserve what they actually wrote, once, the first time you touch it.
        const updated = { ...pending, text, original: pending.original || pending.text };
        if (body.approve) {
          const okWrite = await mutateWall(s, day, wall => [{ ...updated, id }, ...wall]);
          if (!okWrite) return json({ ok: false, message: 'The wall was busy. Try again.' }, 409);
          await s.delete(id);
        } else {
          await s.setJSON(id, updated);
        }
        return json({ ok: true });
      }

      // Already on the wall. Edit it in place.
      const okWrite = await mutateWall(s, day, wall =>
        wall.map(e => (e.id === id ? { ...e, text, original: e.original || e.text } : e))
      );
      return json({ ok: okWrite });
    }

    return json({ ok: false, message: 'Unknown action' }, 400);
  } catch (e) {
    return json({ ok: false, message: 'Server error' }, 500);
  }
};
