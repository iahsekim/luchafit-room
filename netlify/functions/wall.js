// GET /.netlify/functions/wall?day=1&offset=0&limit=25
// The public wall is one blob per day, written only by the review console.
// This is a single read on the hottest path in the whole app.

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const day = parseInt(url.searchParams.get('day'), 10);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10)));

  // Only successful responses are cacheable. Caching an error meant a brief blip
  // during a deploy got pinned at the CDN and kept serving a broken wall.
  const json = (b, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': s === 200 ? 'public, max-age=10' : 'no-store'
      }
    });

  if (!(day >= 1 && day <= 5)) return json({ entries: [], shown: 0, total: 0 }, 400);

  try {
    // Strong consistency on purpose. Blobs defaults to eventual, where updates and
    // deletions can take up to 60 seconds to reach every edge. That is fine for adding
    // an entry, but not for removing one: when you pull something down it has to be
    // gone now, not eventually. One extra blob read is worth that.
    const store = getStore({ name: 'room', consistency: 'strong' });
    const wall = (await store.get(`wall/d${day}`, { type: 'json' })) || [];

    // "You are one of N" counts everyone who showed up, including the ones still
    // waiting on review. Two list calls, keys only, no blob contents read.
    let pending = 0;
    for (const lane of ['1', '0']) {
      const { blobs } = await store.list({ prefix: `pending/d${day}/${lane}/` });
      pending += blobs.length;
    }

    return json({
      entries: wall.slice(offset, offset + limit).map(e => ({ text: e.text })),
      shown: wall.length,
      total: wall.length + pending
    });
  } catch (e) {
    return json({ entries: [], shown: 0, total: 0 }, 500);
  }
};
