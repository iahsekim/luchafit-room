// POST /.netlify/functions/submit  { day, text }
// One blob per entry, unique key, onlyIfNew. Concurrent submissions cannot collide
// because no two writers ever touch the same key.
//
// Returns an edit token. It is random, stored only in the submitter's browser, and
// tied to nothing about them. A capability, not an identity, so anonymity holds.

import { room, json } from '../lib/store.js';
import { isPriority } from '../lib/priority.js';
import { limitFor, HARD_MAX } from '../lib/days.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, message: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, message: 'Bad request' }, 400); }

  const day = parseInt(body.day, 10);
  const text = String(body.text || '').trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');

  if (!(day >= 1 && day <= 5)) return json({ ok: false, message: 'Unknown day' }, 400);
  const LIMIT = Math.min(limitFor(day), HARD_MAX);
  if (text.length < 8) return json({ ok: false, message: 'Write a little more before you post.' }, 400);
  if (text.length > LIMIT) return json({ ok: false, message: 'Keep it under ' + LIMIT + ' characters.' }, 400);

  const s = room();

  // Coarse IP bucket for rate limiting. Hashed, raw IP never stored.
  const ip = req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(ip + (process.env.HASH_SALT || 'luchafit'))
  );
  const ipHash = [...new Uint8Array(digest)].slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const rateKey = `rate/${ipHash}/d${day}`;
  try {
    const seen = await s.get(rateKey, { type: 'json', consistency: 'strong' });
    if (seen && seen.n >= 3) return json({ ok: false, message: 'You have already added yours for today.' }, 429);
    await s.setJSON(rateKey, { n: (seen?.n || 0) + 1 });
  } catch { /* best effort, never block a real submission on it */ }

  // pending/d{day}/{1|0}/{timestamp}-{random}
  // The priority flag lives in the key so the queue can count and sort urgent
  // entries from one list call, without reading any blob contents.
  const lane = isPriority(text) ? '1' : '0';
  const id = `pending/d${day}/${lane}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const token = crypto.randomUUID().replace(/-/g, '');

  const { modified } = await s.setJSON(
    id,
    { day, text, priority: lane === '1', token, created_at: new Date().toISOString() },
    { onlyIfNew: true }
  );
  if (!modified) return json({ ok: false, message: 'Could not save that. Try again in a moment.' }, 500);

  return json({ ok: true, id, token });
};
