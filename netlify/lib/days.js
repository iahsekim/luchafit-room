// Per-day length ceilings. The browser enforces these for good UX; the server
// enforces them again because the browser cannot be trusted.
//
// Days vary a lot in shape: day 1 is one sentence, day 2 is a letter.
export const DAY_LIMIT = { 1: 240, 2: 1800, 3: 760, 4: 560, 5: 1300 };

// Absolute ceiling regardless of day, so a bad request cannot write a huge blob.
export const HARD_MAX = 2000;

export const limitFor = day => DAY_LIMIT[day] || 240;
