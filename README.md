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

### The READ FIRST lane

Entries containing certain terms are written into a separate priority lane and sort to
the top of your queue with a red badge. This rejects nothing and the wrestler never sees
a difference. It only decides what you read first. The term list is at the top of
`netlify/functions/submit.js` and covers self harm, disordered eating, unsafe weight
cutting, abuse, hazing, and hidden injuries.

Somewhere in a five day run across 11,700 subscribers, one of these is going to be real.
Decide now what you do when it is. You cannot reply to the wrestler, since there is no
identity attached, which means the only move available is what you say to everyone in
the next day's email.

## How the storage works

| Key | Holds |
|---|---|
| `pending/d{day}/{1 or 0}/{ts}-{rand}` | one blob per unreviewed entry, priority lane in the key |
| `wall/d{day}` | the approved wall, one blob, newest first |
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

## Deliberately not built

- No accounts, no cookies beyond `localStorage`, no analytics on the entry text
- Private reflections never leave the device
- No editing or deleting by the wrestler, since there is no identity to authenticate against
- No likes or replies, which is what keeps it a wall instead of a comment section
