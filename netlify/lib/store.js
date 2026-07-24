// Shared blob access. Kept out of netlify/functions so Netlify does not try to
// deploy it as its own endpoint.

import { getStore } from '@netlify/blobs';

export const room = (strong = true) =>
  strong ? getStore({ name: 'room', consistency: 'strong' }) : getStore('room');

// Blobs has no locking and last write wins, so every wall mutation is a
// read-modify-write guarded by an ETag. A losing write retries against fresh data.
export async function mutateWall(s, day, fn) {
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

export const json = (body, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache }
  });
