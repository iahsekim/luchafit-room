// POST /.netlify/functions/revise  { id, token, text }
// Lets someone change their own entry without ever having an account.
//
// An edit ALWAYS returns the entry to the review queue and pulls it off the wall.
// Without that, anyone could post something harmless, wait for approval, then swap
// in whatever they wanted and have it appear on a page full of kids unreviewed.

import { room, mutateWall, json } from '../lib/store.js';
import { isPriority } from '../lib/priority.js';
import { limitFor, HARD_MAX } from '../lib/days.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, message: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, message: 'Bad request' }, 400); }

  const id = String(body.id || '');
  const token = String(body.token || '');
  const text = String(body.text || '').trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');

  const m = id.match(/^pending\/d([1-5])\/[01]\/\d+-[a-f0-9]+$/);
  if (!m || !token) return json({ ok: false, message: 'We could not find that entry.' }, 400);
  const day = m[1];

  const LIMIT = Math.min(limitFor(Number(day)), HARD_MAX);
  if (text.length < 8) return json({ ok: false, message: 'Write a little more before you save.' }, 400);
  if (text.length > LIMIT) return json({ ok: false, message: 'Keep it under ' + LIMIT + ' characters.' }, 400);

  const s = room();

  // Constant-time compare so a token cannot be guessed a character at a time.
  const same = (a, b) => {
    if (!a || !b || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  };

  // Still waiting on review: edit in place, stays in the queue.
  const pending = await s.get(id, { type: 'json', consistency: 'strong' });
  if (pending) {
    if (!same(pending.token, token)) return json({ ok: false, message: 'That entry is not yours to edit.' }, 403);
    await s.setJSON(id, {
      ...pending, text, priority: isPriority(text), edited_at: new Date().toISOString()
    });
    return json({ ok: true, state: 'pending' });
  }

  // Already published: verify against the wall copy, then take it back down.
  let onWall = null;
  const pulled = await mutateWall(s, day, wall => {
    onWall = wall.find(e => e.id === id) || null;
    if (!onWall || !same(onWall.token, token)) return wall;
    return wall.filter(e => e.id !== id);
  });

  if (!onWall) return json({ ok: false, message: 'We could not find that entry.' }, 404);
  if (!same(onWall.token, token)) return json({ ok: false, message: 'That entry is not yours to edit.' }, 403);
  if (!pulled) return json({ ok: false, message: 'The wall was busy. Try again in a moment.' }, 409);

  await s.setJSON(id, {
    ...onWall, text, priority: isPriority(text), edited_at: new Date().toISOString()
  });
  return json({ ok: true, state: 'pending' });
};
