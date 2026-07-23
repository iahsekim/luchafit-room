// GET /.netlify/functions/wall?day=1&offset=0&limit=25
// The public wall is one blob per day, written only by the review console.
// This is a single read on the hottest path in the whole app.

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const day = parseInt(url.searchParams.get('day'), 10);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10)));

  const json = (b, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' }
    });

  if (!(day >= 1 && day <= 5)) return json({ entries: [], shown: 0, total: 0 }, 400);

  try {
    const store = getStore('room');
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
