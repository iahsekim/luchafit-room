// Review console API. All actions require the x-admin-key header.
// POST /.netlify/functions/admin  { action, ... }

import { room, mutateWall, json } from '../lib/store.js';
import { isPriority } from '../lib/priority.js';

const ADMIN_KEY = process.env.ADMIN_KEY;
const PAGE = 60;

// Constant-time compare so the key cannot be guessed a character at a time.
function keyOk(given) {
  if (!ADMIN_KEY || !given || given.length !== ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < ADMIN_KEY.length; i++) diff |= ADMIN_KEY.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// Edit tokens are never sent to the browser, not even the console's.
const strip = ({ token, ...rest }) => rest;

// Fetch many blobs without opening hundreds of sockets at once.
async function getMany(s, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 12) {
    const batch = await Promise.all(
      keys.slice(i, i + 12).map(k =>
        s.get(k, { type: 'json', consistency: 'strong' })
          .then(v => (v ? { ...v, id: k } : null)).catch(() => null)
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
  if (req.method !== 'POST') return json({ ok: false, message: 'Method not allowed' }, 405);

  // Distinguish "no key configured on this deploy" from "wrong key typed".
  // Reveals nothing about the key itself, but saves an hour of guessing.
  if (!ADMIN_KEY)
    return json({ ok: false, message: 'ADMIN_KEY is not set on this deploy. Check env vars, then redeploy.' }, 503);

  if (!keyOk(req.headers.get('x-admin-key'))) return json({ ok: false, message: 'That key did not work.' }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, message: 'Bad request' }, 400); }

  const s = room();
  const days = d => (d >= 1 && d <= 5 ? [d] : [1, 2, 3, 4, 5]);

  try {
    if (body.action === 'stats') {
      const meta = await s.get('meta/open', { type: 'json' }).catch(() => null);
      const out = {
        pending: {}, priority: 0,
        openDays: Array.isArray(meta && meta.days) ? meta.days : [1, 2, 3, 4, 5]
      };
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
        return json({ ok: true, rows: (await getMany(s, keys.slice(0, PAGE))).map(strip) });
      }

      if (status === 'approved') {
        let rows = [];
        for (const d of list) rows = rows.concat((await s.get(`wall/d${d}`, { type: 'json' })) || []);
        return json({ ok: true, rows: rows.slice(0, PAGE).map(strip) });
      }

      let keys = [];
      for (const d of list) {
        const { blobs } = await s.list({ prefix: `rejected/d${d}/` });
        keys = keys.concat(blobs.map(b => b.key));
      }
      return json({ ok: true, rows: (await getMany(s, keys.sort().reverse().slice(0, PAGE))).map(strip) });
    }

    if (body.action === 'approve') {
      const ids = (body.ids || []).filter(k => String(k).startsWith('pending/'));
      const rows = await getMany(s, ids);
      const byDay = {};
      for (const r of rows) (byDay[r.day] ||= []).push(r);

      for (const [day, list] of Object.entries(byDay)) {
        // token rides along so the author can still edit after approval
        const add = list.map(r => ({
          id: r.id, day: r.day, text: r.text, original: r.original || null,
          priority: !!r.priority, seed: !!r.seed, token: r.token || null,
          created_at: r.created_at
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
      let moved = 0, failed = [];
      for (const id of body.ids || []) {
        const day = String(id).match(/pending\/d(\d)\//)?.[1];
        if (!day) { failed.push(id); continue; }
        let pulled = null;
        const okWrite = await mutateWall(s, day, wall => {
          pulled = wall.find(e => e.id === id) || null;
          return wall.filter(e => e.id !== id);
        });
        // Only restore to the queue if it actually came off the wall, otherwise a
        // failed write would leave the same entry in both places at once.
        if (okWrite && pulled) { await s.setJSON(id, pulled); moved++; }
        else failed.push(id);
      }
      return json({ ok: failed.length === 0, moved, failed: failed.length });
    }

    if (body.action === 'edit') {
      const id = String(body.id || '');
      const text = String(body.text || '').trim().replace(/\s+/g, ' ');
      if (text.length < 8 || text.length > 2000)
        return json({ ok: false, message: 'Edit must be 8 to 2000 characters' }, 400);

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

    // Bulk insert. Used for seeding the wall before launch so the first wrestler
    // through the door sees a room instead of a blank page.
    // Which days wrestlers can reach. Nothing to do with how many entries exist.
    if (body.action === 'setOpen') {
      const days = (body.days || [])
        .map(Number).filter(d => d >= 1 && d <= 5)
        .filter((d, i, a) => a.indexOf(d) === i).sort();
      await s.setJSON('meta/open', { days, updated_at: new Date().toISOString() });
      return json({ ok: true, openDays: days });
    }

    // Wipes the per-IP submission counters. Handy while testing from one machine.
    if (body.action === 'clearRates') {
      const { blobs } = await s.list({ prefix: 'rate/' });
      for (let i = 0; i < blobs.length; i += 12)
        await Promise.all(blobs.slice(i, i + 12).map(b => s.delete(b.key)));
      return json({ ok: true, cleared: blobs.length });
    }

    if (body.action === 'seed') {
      const day = parseInt(body.day, 10);
      if (!(day >= 1 && day <= 5)) return json({ ok: false, message: 'Pick a day' }, 400);

      const texts = (body.texts || [])
        .map(t => String(t).trim().replace(/\s+/g, ' '))
        .filter(t => t.length >= 8 && t.length <= 2000);
      if (!texts.length)
        return json({ ok: false, message: 'No usable lines. Each needs 8 to 400 characters.' }, 400);
      if (texts.length > 200)
        return json({ ok: false, message: ' 200 lines at a time, max.' }, 400);

      const now = Date.now();
      // Seeded entries run the same keyword check as real submissions, so the
      // review queue behaves identically no matter how an entry got there.
      const rows = texts.map((text, i) => {
        const prio = isPriority(text);
        return {
          id: `pending/d${day}/${prio ? '1' : '0'}/${now + i}-${crypto.randomUUID().slice(0, 8)}`,
          day, text, original: null, priority: prio, seed: true,
          created_at: new Date(now + i).toISOString()
        };
      });

      if (body.approve) {
        const okWrite = await mutateWall(s, day, wall => [...rows, ...wall]);
        if (!okWrite) return json({ ok: false, message: 'The wall was busy. Try again.' }, 409);
      } else {
        for (let i = 0; i < rows.length; i += 12)
          await Promise.all(rows.slice(i, i + 12).map(r => s.setJSON(r.id, r, { onlyIfNew: true })));
      }
      return json({ ok: true, added: rows.length });
    }

    return json({ ok: false, message: 'Unknown action' }, 400);
  } catch (e) {
    return json({ ok: false, message: 'Server error' }, 500);
  }
};
