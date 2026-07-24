# The Room / 5-day challenge

Anonymous journal wall. One page, five days, gated so you only see the wall after you
add to it. Nothing appears publicly until you approve it at `/review`.

Storage is **Netlify Blobs**. No database, no second service, no third-party keys.

## Deploy

1. **Netlify**: connect the repo, or drag the folder in. Everything is already set in `netlify.toml`, so accept the defaults it detects.
2. **Environment variables** (Site configuration → Environment variables):

   | Key | Value |
   |---|---|
   | `ADMIN_KEY` | any long random string. This is your review console password. |
   | `HASH_SALT` | any random string. Used to hash IPs for rate limiting. |

   Generate both with `openssl rand -hex 24`. Tick **Contains secret values** on each.

3. Redeploy so the variables are picked up, then point `room.luchafit.com` at the site.

That is the whole setup. Blobs provisions itself the first time a function writes.

## The five URLs for Flodesk

```
https://room.luchafit.com/day/1  ...  /day/5
```

Plain links, no tokens, no merge fields. Nothing identifying ever leaves the email,
which is what makes the anonymity claim on the page actually true.

Flodesk workflow: trigger on segment join → email 1 immediately → wait 1 day → email 2,
and so on. Send at 6am MT so it is there before school.

## Reviewing

`https://room.luchafit.com/review`, enter your `ADMIN_KEY`.

| Key | Does |
|---|---|
| `J` / `K` | move down / up |
| `A` | approve |
| `R` | reject |
| `E` | edit |
| `⌘↵` | save the edit and approve it |
| `Esc` | cancel the edit |

Plus **Approve all** when the queue is clean.

Editing keeps the original permanently. Once you change an entry, the row shows what
the wrestler actually wrote underneath your version. Fix typos and trim freely, but
that record is there so you can see when you have rewritten someone rather than tidied
them. Rejected entries are archived, not deleted.

### Adding entries by hand

**Add entries** in the review console opens a paste box. One per line, pick a day, then:

- **Add to queue** drops them in for review like any other submission
- **Post straight to wall** publishes immediately, which is what you want for seeding

Seeded entries carry a `seed` flag and show a gold **SEED** tag in the console. The public
wall never shows it. Use this the day before launch so the first wrestler through the door
sees a room instead of an empty page.

Same thing from the terminal, if you would rather script it:

```bash
curl -s -X POST https://room.luchafit.com/.netlify/functions/admin \
  -H 'Content-Type: application/json' \
  -H "x-admin-key: $ADMIN_KEY" \
  -d '{"action":"seed","day":1,"approve":true,"texts":[
        "My standard this season is winning the third period.",
        "My standard this season is never getting outworked in my own room."
      ]}'
```

### The READ FIRST lane

Entries containing certain terms go into a separate priority lane and sort to the top of
your queue with a red badge. **This rejects nothing** and the wrestler never sees a
difference. It only decides what you read first. Manually seeded entries run the same
check, so the queue behaves the same no matter how an entry got there.

The list lives in `netlify/lib/priority.js` and covers self harm, disordered eating,
unsafe weight cutting, abuse, hazing, and hidden injuries. It works two ways: multi-word
phrases match anywhere in the text, and a short list of high-risk single words matches on
word boundaries, so `die` does not fire on `diet` and `fat` does not fire on `fatigue`.

Tune it freely. A false positive costs you three seconds of reading; a miss costs
something else. The one thing to avoid is flagging so much that the lane stops being a
signal.

**It is a keyword list, not comprehension.** It cannot read tone or context and it will
miss anything phrased in a way nobody thought to list. The real safety net is that you
read every entry before it goes up. This only sets the order.

Somewhere in a five day run across 11,700 subscribers, one of these is going to be real.
Decide now what you do when it is. You cannot reply to the wrestler, since there is no
identity attached, which means the only move available is what you say to everyone in
the next day's email.

## How the storage works

| Key | Holds |
|---|---|
| `pending/d{day}/{1 or 0}/{ts}-{rand}` | one blob per unreviewed entry, priority lane in the key |
| `wall/d{day}` | the approved wall, one blob, newest first |
| entry `token` | random edit capability, server side only, never returned to any browser |
| `rejected/d{day}/{id}` | what you turned away |
| `rate/{ipHash}/d{day}` | submission count per IP bucket |

Two things this design is doing on purpose:

**Submissions never collide.** Every entry gets its own key with `onlyIfNew`, so a
thousand wrestlers hitting submit at 6:01am cannot overwrite each other. Blobs has no
locking and last write wins, which would silently drop entries if they all appended to
one object.

**The public wall is a single blob read.** That is the hottest path in the app and it
costs one `get`. The wall blob is only ever written by you in the review console, and
those writes are ETag-guarded with a retry, so two browser tabs cannot clobber each other.

The priority flag lives in the key rather than the contents, so counting the READ FIRST
queue is a `list` call that never reads a single blob body.

**Ceiling:** the wall blob holds a full day of approved entries in memory inside the
function. Comfortable to roughly 5,000 entries per day. Past that it wants sharding into
pages, which is a twenty minute change you will probably never need.

## Editing

Anyone can change their own entry from the wall screen. There are no accounts, so
ownership is proved with a random token the server issues on submit and the browser
keeps. It is a capability, not an identity, and it is never sent to the review console.

**Every edit returns the entry to your queue and takes it off the wall until you
re-approve it.** This is not a nicety. Without it, someone could post something
harmless, wait for approval, then swap in anything they liked and have it appear
unreviewed on a page full of kids. Edited entries carry a green **EDITED** tag so you
know you are looking at a re-review rather than something new.

The token lives in `localStorage`, so clearing browser data or switching devices means
losing the ability to edit that entry. The entry itself is unaffected.

## The two-part structure

Each day asks for two different things:

1. **Public** — one line, anonymous, goes on the wall. This is the gate: post to read.
2. **Private** — a longer reflection that never leaves the device. `localStorage` only,
   never transmitted, nothing to moderate.

The public prompt comes first and the private one sits below the wall, after they have
read what everyone else wrote. That ordering is deliberate: the frictionless action
should not sit behind the harder one, and the reflection lands better once the room has
primed it.

On day 5 the page assembles everything from all five days, public and private, into a
recap directly above the Unstuck CTA. That recap is what makes the private box worth
filling in. Since it reads `localStorage`, someone who switches devices mid-week sees
only what that browser holds, so the copy never promises a complete week.

## Deliberately not built

- No accounts, no cookies beyond `localStorage`, no analytics on the entry text
- Private reflections never leave the device
- No likes or replies, which is what keeps it a wall instead of a comment section
