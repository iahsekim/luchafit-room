// GET /.netlify/functions/wall?day=1&offset=0&limit=25&id=<optional own entry id>
// The public wall is one blob per day, written only by the review console.
// Never returns tokens, timestamps, or anything but entry text.

import { room, json } from '../lib/store.js';

export default async (req) => {
  const url = new URL(req.url);
  const day = parseInt(url.searchParams.get('day'), 10);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10)));
  const mineId = url.searchParams.get('id') || '';

  if (!(day >= 1 && day <= 5)) return json({ entries: [], shown: 0, total: 0 }, 400);

  try {
    // Strong consistency on purpose. Blobs defaults to eventual, where deletions can
    // take up to 60 seconds to reach every edge. Fine for adding an entry, not fine
    // for removing one: when something comes down it has to be gone now.
    const s = room();
    const wall = (await s.get(`wall/d${day}`, { type: 'json' })) || [];

    // "You are one of N" counts everyone who showed up, including entries still
    // waiting on review. Keys only, no blob bodies read.
    let pending = 0;
    for (const lane of ['1', '0']) {
      const { blobs } = await s.list({ prefix: `pending/d${day}/${lane}/` });
      pending += blobs.length;
    }

    let mine = null;
    if (mineId) {
      mine = wall.some(e => e.id === mineId) ? 'live'
           : (await s.getMetadata(mineId).catch(() => null)) ? 'pending'
           : 'gone';
    }

    // Which days are open is an explicit setting, not something inferred from
    // entry counts. Deriving it was circular: a day could not open until it had
    // entries, and it could not get entries while it was closed.
    // Missing setting means everything is open, so a bad read can never lock
    // every wrestler out of the challenge.
    const meta = await s.get('meta/open', { type: 'json' }).catch(() => null);
    const openDays = Array.isArray(meta && meta.days) ? meta.days.filter(d => d >= 1 && d <= 5) : [1, 2, 3, 4, 5];

    return json({
      entries: wall.slice(offset, offset + limit).map(e => ({ text: e.text })),
      shown: wall.length,
      total: wall.length + pending,
      open: openDays.includes(day),
      openDays,
      mine
    }, 200, 'no-store');
  } catch (e) {
    return json({ entries: [], shown: 0, total: 0 }, 500);
  }
};
