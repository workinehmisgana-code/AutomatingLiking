# 6_comment_liker

Likes comments from your own accounts, driven by the links and products in the
admin dashboard.

| site | script | how it likes |
| --- | --- | --- |
| TikTok | `like.py` | TikTok's own signed API, with the browser there to sign it |
| Instagram | `like_web.py --site instagram` | clicks the heart, then reads the button back |
| YouTube | `like_web.py --site youtube` | clicks the heart, then reads the button back |

TikTok gets its own script because it is the only one of the three with an API
to call. YouTube's Data API has no endpoint for liking a comment at all, and
Instagram's is closed to anything but approved apps, so both are done the way a
person does it. See **[Instagram and YouTube](#instagram-and-youtube)**.

---

## Quick start

```bash
pip install -r requirements.txt
python -m playwright install chromium

python login.py                              # one visible sign-in
python like.py --from-dashboard --cluster-by date --clusters 1 --products --dry-run
python like.py --from-dashboard --cluster-by date --clusters 1 --products --limit 5
python verify.py                             # did the likes actually land?
```

Always `--dry-run` first, then a small `--limit`, then `verify.py`. The reason
that order matters is in **[Why verify.py exists](#why-verifypy-exists)**.

---

## Setup

### 1. Dependencies

```bash
pip install -r requirements.txt
python -m playwright install chromium
```

`playwright install chromium` also fetches the **headless shell**, a separate
download from full Chromium. Without it every run dies at
`Executable doesn't exist at …chrome-headless-shell.exe`.

### 2. Config

`DASHBOARD_URL` and `LINKS_EXPORT_TOKEN` are read from `.env` here, falling back
to `../3_dashboard/.env` — so normally there is nothing to set up. The token is
the same shared one `/api/links/export` uses.

### 3. Sign in

```bash
python login.py                       # TikTok, default account  -> ./profile
python login.py --site instagram      # -> ./profile-ig
python login.py --site youtube        # -> ./profile-yt
python login.py --profile b           # a second account          -> ./profile-b
python login.py --check               # is the stored session still good?
```

Each site keeps its own profile directory. A Chromium user data directory is a
whole signed-in browser, and sharing one between three sites means every refresh
of one risks the others.

A visible browser opens. Log in however you normally do; the script waits until
it can confirm the session, then closes.

The session lives in `./profile` (or `./profile-b`), a real Chromium user data
directory rather than a cookie dump — TikTok's request signing reads more than
cookies, so half a session is no session.

---

## Running one account

```bash
# from the dashboard, by cluster
python like.py --from-dashboard --cluster-by date --clusters 1 --products
python like.py --from-dashboard --cluster-by rank --clusters 1,2 --products
python like.py --from-dashboard --cluster-by combined --clusters 1 --category competitors --products

# from a file, or inline
python like.py --links links.txt --products
python like.py --links scraped.csv --users worker1,worker2
python like.py https://www.tiktok.com/@x/video/123 --products

# undo
python like.py --links links.txt --products --unlike
```

### Options that matter

| Flag | Meaning |
|---|---|
| `--from-dashboard` | pull links from the admin dashboard |
| `--cluster-by rank\|date\|combined` | which clustering to use (default `rank`) |
| `--clusters 1,2` | which clusters; blank means all |
| `--category` | `competitors`, `ai_detector` or `generic` |
| `--max-links` | how many links to pull (default 500) |
| `--products` | like comments naming an active product |
| `--all-products` | like comments naming ANY product, deactivated included |
| `--users a,b` | like comments by these handles |
| `--all` | like every comment (rarely what you want) |
| `--limit N` | stop after N likes |
| `--delay 2,5` | jittered seconds between videos |
| `--scrolls 6` | how far to scroll the comment list per video |
| `--dry-run` | find targets, like nothing |
| `--profile NAME` | which signed-in account to use |

### Which products get liked

Six exist: `purifytext`, `acoustictext`, `prohumanly`, `humlexic`, `kinprose`,
`tintfolio`.

`--products` uses whichever the dashboard reports as ACTIVE — three, at the time
of writing — so switching one off there stops it being liked here with no edit.

`--all-products` matches all six. Comments for a product go on being liked after
it is switched off, which is usually what you want: the comments are already
posted and a like is worth the same whatever the dashboard is generating today.
It takes the UNION of the compiled list and whatever the dashboard sends, rather
than the dashboard's answer alone — the deployed dashboard currently ignores the
parameter and replies with the active three regardless, and trusting that reply
made the flag a silent no-op.

Measured over the first 300 links of date cluster 1: **169 comments with all
six** against 130 with the active three — a 30% increase, from the same page
loads.

Matching strips punctuation and case, so `purify text`, `Purify-Text` and
`purifytext` are all the same string. The comment pool deliberately varies that
spelling, and a literal match would miss most of its own output.

**The dashboard decides the clusters, not this script.** Clusters are relative —
assigned by splitting the sorted pool per platform — so they exist nowhere in the
database, and anything recomputing them locally would drift from what you see on
screen.

---

## Running several accounts

```bash
python login.py --profile a
python login.py --profile b
python login.py --profile c

python run_parallel.py --profiles a,b,c --cluster-by date --clusters 1
python run_parallel.py --profiles a,b --links links.txt --per-account 50
python run_parallel.py --profiles a,b,c --clusters 1 --dry-run
```

Links are pulled once, sharded, and handed to one child process per account.
Output is prefixed with the account name.

**`--share split`** (default) — each video goes to one account. Three accounts,
roughly three times the coverage. Sharding is round-robin rather than in blocks,
because the dashboard returns links in ranked order and blocks would hand one
account every good link and another the tail.

**`--share stack`** — every account visits every video, so a comment collects N
likes instead of one. This is the mode that actually pushes a comment up the
ranking. It is also the clearest coordination signal you can emit: several
accounts liking the same comments within minutes, from one machine and one IP.
Use a long `--delay`, or don't use it.

Separate processes rather than threads, because Playwright's sync API is not
built to be shared across threads and this way a browser crash costs one account
instead of the run.

### Lockstep — every account on the same link at once

```bash
python run_lockstep.py --profiles a,b,c --cluster-by date --clusters 1
python run_lockstep.py --profiles a,b --links links.txt --limit 20
python run_lockstep.py --profiles a,b,c --clusters 1 --dry-run
```

Every account works the **same video at the same time**, so a comment collects
one like per account before anybody moves on. Nobody starts video N+1 until
everyone has finished N.

This is the mode that lifts a comment up the ranking, because the likes land
together rather than trickling in over an hour. Use it when the goal is a
specific comment's position; use `run_parallel.py --share split` when the goal is
covering more links.

One process, one thread and one browser per account, with a barrier between
videos. If an account stalls, the barrier times out after four minutes and the
rest carry on without it rather than the run hanging. Threads here rather than
processes because the barrier has to be shared.

`--stagger 0,4` (default) offsets each account by a few seconds before each
video. Three accounts liking the same comment in the same millisecond from one
IP is the most legible coordination signal there is. `--stagger 0,0` removes the
offset if you want them exactly simultaneous.

---

## Checking the work

```bash
python verify.py                     # default account
python verify.py --profile b
python verify.py --all               # include rows that failed
```

Each account keeps its own ledger — `done.csv`, `done-b.csv` — and re-runs skip
rows already in it. Two reasons for that split: concurrent appends to one file
interleave and corrupt it, and "already liked" is a fact about an *account*, not
about a comment, so account B must not skip what A liked.

Columns: `when, url, aweme_id, cid, user, text, status, note`. A failure's `note`
says which kind it was — `not found among 19 row(s) [handle,handle]`,
`no heart in row`, `comment panel did not open` — because those need completely
different fixes.

---

## Why verify.py exists

**TikTok answers `status_code: 0` — success — for likes it has no intention of
applying.** Wrong signature, missing signature, missing CSRF token: all report
success, all do nothing, and no error appears anywhere. Four rounds of debugging
went into learning that, so nothing here trusts a response code.

`verify.py` re-reads each comment **from inside the logged-in page** and checks
`user_digged`, which answers "has *this* account liked it". That is the only
reliable evidence. It must be read from within the session — an unauthenticated
read always returns 0 and would look like total failure whether or not the likes
worked.

`like.py` follows the same rule: after clicking, it re-reads the comments and
only writes `ok` for comments that actually flipped. A click that appeared to
work and changed nothing is logged `fail:dom`.

---

## How it works, and why

### Reads are open, writes are not

```
comment list (read)   HTTP 200   16386b  status_code=0
comment like (digg)   HTTP 403      35b  Web SDK blocked by Argus TLB Plugin
```

Everything that *finds* comments is plain HTTP — no browser, no session, ~50
comments per request. That is where nearly all the work is and it runs at
network speed. Only the like itself needs a browser.

### The like has to be a real click

The API route was tried thoroughly and is closed:

1. `type=1` → `status_code 5`. It wants **`digg_type`**.
2. Missing CSRF handshake → the real client sends a `HEAD` with
   `x-secsdk-csrf-request: 1` first and puts the returned token in
   `x-secsdk-csrf-token`. Without it: accepted, applied nothing.
3. Missing `X-Gnarly`, the per-request signature. It is computed by TikTok's own
   bundle, and a `fetch` or `XMLHttpRequest` issued from page context never
   passes through the code that adds it. Both transports were tested. Neither is
   signed.

So the write is a click. `--mode api` is still there for the day that changes,
but it does not work today.

### Clicking the heart

Three things that are not obvious and each cost a debugging round:

- **The comment list is not in the DOM until you open it.** The page arrives as
  the feed player: `comment-icon` and `comment-count` are present, every comment
  selector is zero. The script clicks the icon and waits.
- **The heart is `DivLikeContainer`.** `data-e2e="comment-like-icon"` no longer
  exists, and `aria-label` says "Like video" on both the video's heart and every
  comment's — matching on it presses the wrong control.
- **The username element holds the display name, not the handle.** `<a
  href="/@lfdwesk">…<p>Dwesk</p></a>`. The API gives `unique_id`, so matching on
  the visible text fails for anyone whose display name differs from their handle
  — which is most people. The handle is read from the `href`.

Scrolling moves the comment list, never the window: this layout has
`feed-navigation-next`, and scrolling the page can advance to a different video.

---

## The captcha

TikTok shows a "drag the slider to fit the puzzle" challenge to accounts it is
unsure about. While it is up the comment list renders as grey placeholders, so
every symptom points at the DOM and none of them is the cause.

**It comes straight to you.** A captcha raises a Windows notification and starts
a repeating sound immediately; you drag the slider in the browser window and the
run carries on. Nothing is attempted automatically first.

That is deliberate. Trying a solving API first buys half a minute of silence
before anyone is told there is anything to look at, and two attempts against
TikTok's puzzle were not reliably clearing it anyway. The API is still there,
opt-in:

```
python like.py --solve-captcha ...
```

which tries it twice and only then sounds the alarm.

Run **`--headed`** if you want to solve them: a headless run has no window to
drag anything in, so it alerts once, says which profile is stuck, and moves on.

### Set it up (only needed for --solve-captcha)

```
CAPTCHA_API_KEY=your-key
CAPTCHA_API_URL=https://www.sadcaptcha.com/api/v1/rotate     # the default
```

in `.env` here or in `../3_dashboard/.env`. Two services take this request shape:
[SadCaptcha](https://www.sadcaptcha.com/) and
[Euler Stream](https://www.eulerstream.com/captchas) (25 solves/day free, then
$25/mo as an add-on to a paid plan). Set `CAPTCHA_API_URL` to whichever you have
a key for. The key is sent both as `?licenseKey=` and as an `x-api-key` header,
because the two want it differently.

**With no key set, nothing breaks** — every captcha simply goes straight to you,
which is also what happens without `--solve-captcha`.

### How it works

TikTok sends the puzzle as TWO images, an outer annulus and an inner disc, both
`data:` URIs. They are lifted straight out of the DOM and posted as-is:

```
POST {"outerImageB64": ..., "innerImageB64": ...}  ->  {"angle": N}
```

The angle becomes a slider distance — `(track - handle) x angle / 360` — and the
drag itself is eased, jittered and settled before release, because a
constant-velocity drag across the track in three frames is a stronger bot signal
than the captcha.

### The alarm

Whether the API was tried or not, `like.py` raises a **Windows notification and
repeats a sound every 20 seconds** until you drag the slider — four minutes,
then it gives up on that account for the run.

With `--solve-captcha`, a puzzle that survives two goes is not going to fall to a
third: either the service is wrong about this puzzle, or it is not the puzzle we
think it is. So it stops rather than burning solves. It also stops immediately,
without calling the API at all, if the widget is the pick-the-shapes kind rather
than a rotation.

Every failure writes the page, both source images and the instruction text to
`captcha-dump/`. `python captcha_study.py` takes an older dump apart.

Clear one by hand at any time:

```
python solve_captcha.py --profile e
```

### Why the maths was dropped

An earlier version computed the angle locally by correlating the pixels either
side of the seam. The maths was right — it read discs rotated by known angles to
within 0.0 degrees — and it still failed, because the widget is not the puzzle
that method assumes. Correlating every radius of the inner image against every
radius of the outer, on two live samples, found nothing above 3 sd and no
agreement on the angle; testing a single magnification across all radii found
nothing above 2.5 sd and the samples disagreed on the scale (2.04 against 1.12).
There was no correspondence to find, so no tuning would have fixed it.

The two images that method could not use are exactly what the API wants, so the
extraction survived and only the arithmetic went.

## Bandwidth

Every run blocks the video, images and fonts. That is not a nicety — measured on
one video page:

| | nothing blocked | blocked |
|---|---|---|
| total | 20.3 MB | 6.6 MB |
| fetch (the video) | 12.5 MB | 0.2 MB |
| script | 6.2 MB | 6.2 MB |
| fonts + images | 1.5 MB | 0 |

**67% saved, ~14 MB per video.** Over a 1,151-link cluster that is roughly 16 GB
against 8 GB.

The catch that made this worth doing: the video does *not* arrive as a `media`
request. TikTok streams it through `fetch`, so a filter that only looks at the
resource type — which is what this had — lets the single largest thing on the
page straight through and saves less than a megabyte. It is blocked by URL now
(`mime_type=video_mp4`, `/video/tos/`, `.mp4`, `v16-webapp`…), with `/api/`
excluded so the comment list and the like itself still work.

Headed runs get the same treatment, so watching a run costs no more than not
watching one. The window shows a black video frame and a working comment panel.

`--with-media` turns all of it off, for when you need to see the page as TikTok
serves it.

The remaining 6.2 MB is TikTok's own JavaScript, which the page needs to render
comments at all. It is cached in the profile between videos, so the steady-state
cost per link is well under the figure above.

## When it breaks

TikTok changes this markup regularly. The tools to find out what changed:

```bash
python inspect_dom.py                 # what the page actually renders
python inspect_dom.py --headed        # watch it
python probe.py                       # which digg parameter shape works
python probe2.py                      # whether any transport gets signed
python capture.py                     # record a real like you perform by hand
```

`inspect_dom.py` is the one to reach for first. It prints every `data-e2e` value
on the page, which candidate selectors match, anything resembling a like control,
and the HTML around the first comment. If it reports `login wall: True` or
`body text: 0 chars`, the problem is not selectors.

`capture.py` opens a video headed, you like a comment yourself, and it records
exactly what the page sent — URL, method, headers — to `capture.json`. That file
is also the source of the ~32 request parameters `--mode api` reuses. It does not
record cookies: it is a debugging artefact, not a credential store.

---

## Worth knowing

Automated engagement is against TikTok's terms, and accounts doing it get
shadowbanned or removed.

More specifically for this operation: likes arriving on your workers' comments
from accounts you control, on the same videos, from one machine, is a legible
coordination signal — and the presence analysis in the dashboard already suggests
those comments are being filtered. This may make that worse rather than better.

The cheaper lever is still the comment wording. The same worker scored 48% with
one product and 8% with another over the same days and the same pace, which no
amount of liking will change.

---

## Instagram and YouTube

`like_web.py` covers both. Same product list, same ledger rules, same
notifications as the TikTok liker — it imports them rather than copying them, so
"which comments count" has one definition across all three sites.

```bash
python login.py --site youtube
python login.py --site instagram

# always look first
python like_web.py --site youtube --from-dashboard --platform youtube --products --dry-run
python like_web.py --site youtube --from-dashboard --platform youtube --products --limit 5

python like_web.py --site instagram --links ig.txt --products --limit 5
python like_web.py --site instagram --probe --links one.txt   # what does the page actually show?
```

Ledgers are per site and per account: `done-yt.csv`, `done-ig.csv`,
`done-yt-b.csv`, `done-ig-b.csv`. TikTok's `done.csv` is never touched.

### A click is not a like

Neither site tells you whether a like landed, so the button is read back after
every click:

* **YouTube** — `aria-pressed` on the comment's like button flips to `true`.
* **Instagram** — the control's label changes from `Like` to `Unlike`.

A click whose state did not change is written as `fail:noverify`, not as a like.
Like every other failure, it is cleared from the ledger on the next run and
tried again. Three failures with nothing liked stops the run and notifies you,
rather than spending an account on a broken session.

### Shorts

`youtube.com/shorts/<id>` is a different page from a watch URL, and it is the
majority of the YouTube links in the scraper's results (1,211 of 2,080). It is
handled automatically — you pass the links as they are — but by a different
route, because two things about a Short are not like a watch page:

* **A Short shows no comments at all until its panel is opened.** Verified: 0
  comments on load, 38 after the comment button is clicked. A run that only
  scrolled would report every Short as having nothing to like.
* **Scrolling the window moves to the NEXT Short.** So the panel is scrolled
  directly instead, and the run checks it is still on the video it was given.
  Otherwise it would keep liking, under this link's name, comments belonging to
  whatever video it had drifted onto.

Once the panel is open it is an ordinary comment list, so the same collector and
the same verified like button do the rest. A Short and a watch URL for the same
video reduce to the same key, so a comment cannot be liked once under each.

### Which comment is which

The ledger needs a stable answer to "have I liked this already".

* **YouTube** publishes one: the comment id in its permalink (`?lc=…`). Verified
  present on all 40 comments of a real video.
* **Instagram** publishes none anywhere in the page, so the key is a hash of the
  post, the author and the *normalised* text — the same normalisation used for
  matching, so a re-rendered space or a stray emoji does not make an old comment
  look new.

### Useful flags

| flag | what it does |
| --- | --- |
| `--probe` | prints every comment the page yields and stops. The first thing to run when a site changes its markup. |
| `--per-link N` | at most N likes on one post |
| `--rounds N` | how hard to work at loading more comments |
| `--link-delay a,b` | seconds between posts, on top of `--delay` between likes |

### What is verified, and what is not

The YouTube path is checked against live pages by `check_like_web.py --live`:
80 comments off a watch page and 38 off a Short, every one with an author, text,
a native comment id and a like button — plus the checks that a Short yields
nothing before its panel is opened, and that the run has not drifted onto a
different video by the end.

The Instagram path's bookkeeping is tested offline, but its **selectors have not
been confirmed against a live signed-in page** — no Instagram session existed
here to check them with. Run `--probe` first: it prints what it can see without
clicking anything. If it lists comments, the selectors are right; if it lists
none, they need adjusting and the probe output says what is on the page instead.
