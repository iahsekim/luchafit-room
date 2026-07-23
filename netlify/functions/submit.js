// POST /.netlify/functions/submit  { day, text }
// One blob per entry, unique key, onlyIfNew. Concurrent submissions cannot
// collide because no two writers ever touch the same key.

import { getStore } from '@netlify/blobs';

const LIMIT = 240;

// These do NOT reject anything. They only put the entry in the priority lane so it
// sorts to the top of your review queue. The wrestler sees no difference.
const PRIORITY_TERMS = [
  'kill myself','kill my self','suicide','suicidal','end it all','want to die',
  'hurt myself','cut myself','cutting myself','self harm','worthless','hate myself',
  'no point','give up on everything',
  'starve','starving','not eating','stopped eating','throw up','throwing up',
  'purge','purged','laxative','diuretic','water weight','sauna suit','spit weight',
  'cut weight','weight cut','pull weight','anorexi','bulimi',
  'hits me','hit me','grabbed me','touched me','abuse','abusive','hazing','hazed',
  'scared of my coach','screams at me','concussion','hiding my injury'
];

const isPriority = t => {
  const s = t.toLowerCase();
  return PRIORITY_TERMS.some(w => s.includes(w));
};

export default async (req) => {
  const json = (b, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

  if (req.method !== 'POST') return json({ ok: false, message: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, message: 'Bad request' }, 400); }

  const day = parseInt(body.day, 10);
  const text = String(body.text || '').trim().replace(/\s+/g, ' ');

  if (!(day >= 1 && day <= 5)) return json({ ok: false, message: 'Unknown day' }, 400);
  if (text.length < 8) return json({ ok: false, message: 'Write a little more before you post.' }, 400);
  if (text.length > LIMIT) return json({ ok: false, message: 'Keep it under ' + LIMIT + ' characters.' }, 400);

  const store = getStore('room');

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
    const seen = await store.get(rateKey, { type: 'json', consistency: 'strong' });
    if (seen && seen.n >= 3) return json({ ok: false, message: 'You have already added yours for today.' }, 429);
    await store.setJSON(rateKey, { n: (seen?.n || 0) + 1 });
  } catch { /* rate limiting is best effort, never block a real submission on it */ }

  // pending/d{day}/{1|0}/{timestamp}-{random}
  // The priority flag lives in the key so the review queue can count and sort
  // priority entries from a single list call, without reading any blob contents.
  const lane = isPriority(text) ? '1' : '0';
  const key = `pending/d${day}/${lane}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const { modified } = await store.setJSON(
    key,
    { day, text, priority: lane === '1', created_at: new Date().toISOString() },
    { onlyIfNew: true }
  );
  if (!modified) return json({ ok: false, message: 'Could not save that. Try again in a moment.' }, 500);

  return json({ ok: true });
};
