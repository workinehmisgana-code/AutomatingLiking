# 2_comment_automation — comment hearts via Zefoy and Freer

Gives **hearts to a comment** on a TikTok video, so our product comment sits
above the rest of the comment section instead of being buried in it.

Two free services do the work. Both are web forms behind a captcha, and both are
driven here with Playwright:

| Service | Site | What it is used for |
| --- | --- | --- |
| **Zefoy** | `zefoy.com` | Hearting comments. 25 or 50 hearts a submit, with a cooldown between submits. |
| **Freer** | `nreer.com` | Hearting comments, and reading them — it lists every comment on a video, which is how `extract_comments.py` and the two `verify_*` scripts work. |

Neither service needs a TikTok login. They take a video URL, show you its
comments, and let you send hearts to one of them.

---

## Install

```bash
pip install -r requirements.txt
python -m playwright install chromium
```

Then copy the settings you want into a `.env` file beside `automate.py` (see
[Settings](#settings-env)). `CSV_FILE` and `COMMENT_KEYWORD` are the two that
have to be set for a run to do anything.

---

## Quick start

```bash
# the recommended run: the dashboard's own cluster 1, pushed to the top
python automate.py --service zefoy --from-dashboard --cluster-by date --clusters 1 --to-top

# both services, links from the CSV in .env
python automate.py

# push our comment to the TOP of each video's comment section
python automate.py --service zefoy --to-top --csv my-links.txt

# one service, a specific list, five windows at once
python automate.py --service zefoy --csv theFile/links.csv --workers 5

# keep sweeping the list until you stop it
python automate.py --loop --loop-delay 300
```

---

## The two targeting modes

This is the most important choice in the tool, so it is worth being explicit
about. Both modes pick the same comment — the first one matching a keyword — and
differ only in **how many hearts they decide to send**.

### Default: a share of the video's likes

Send the largest batch that keeps the comment below
`HEART_THRESHOLD × the video's like count`, and skip the comment once it is
there. This is a **plausibility** rule: a comment with more hearts than the
video has likes is a comment nobody believes. It needs a like count, so it needs
the scraper's CSV.

It says nothing about whether our comment is the one a visitor actually reads.

### `--to-top`: pass the best comment on the video, up to the ceiling

Send what it takes to overtake the best-liked comment that is **not** ours, by
`--margin` — but never past `HEART_THRESHOLD × the video's likes`. That is the
whole rule in one line: **chase the lead, respect the ceiling.**

The target is a property of the comment section rather than of the video, which
is what makes it the number that decides what gets read. The ceiling is still a
property of the video, because a comment carrying more hearts than the video it
sits under is a comment nobody believes — and winning the comment section that
way loses the thing the comment is for. The scan already reads every comment's
heart count on its way past, so neither number costs anything extra.

```
[*] Comment (purifytext): "my english essay was fine with purify text."
[*] Ours: 12 hearts | top other comment: 148 | need 139 more (margin 3)
[*] Leading comment now: "wait this actually works??"
  [Zefoy] -> OK: Sent 50 hearts – about 89 short of the lead
  [Zefoy] round 2/4 on this video in 32s (89 short of the lead)…
```

**When the ceiling gets in the way** it says so and stops, rather than
overshooting:

```
[*] Ours: 60 hearts | top other comment: 100 | need 43 more (margin 3)
[~] Ceiling: only 40 more allowed (100 = 100% of 100 likes), and the lead needs 43
  [Zefoy] -> OK: Sent 25 hearts – about 18 short, and the threshold is spent
```

Three ways it can stop short, all reported and all logged under `capped`:

| Situation | What happens |
| --- | --- |
| Room for part of the gap | Sends what fits, stops there. |
| Already at or over the ceiling | Sends nothing, says how far it is from the lead. |
| Under 25 of room left | Sends nothing — 25 is the smallest batch Zefoy sells, and sending it would break the ceiling. |

A capped video is **not** left pending: a later pass would re-scan it and reach
the same answer. It becomes workable again when the video's own likes grow.

With `HEART_THRESHOLD=1` the ceiling is the video's own like count, which is the
loosest setting that still keeps a comment below the video carrying it.

**50 is what the dropdown says, not what arrives.** The hearts trickle in over
the following seconds and the total is routinely short, so after each batch the
comment's real count is read off the page while it lands:

```
[*] Ours: 171 hearts | best other comment: 351 | need 183 more (margin 3)
[~] Dropdown: 183 not available – using 50
[*] Watch: 171 -> 196 hearts (+25 so far, 8s)
[*] Watch: 196 -> 208 hearts (+37 so far, 16s)
[*] Watch: settled at 208 hearts
[*] Asked for 50, landed 37 (208 hearts now)
  [Zefoy] -> OK: Sent 50 hearts – at 208, about 146 short of the lead
```

Everything decided after a submit — whether the lead has been taken, whether
another round is worth a cooldown, whether the threshold is spent — comes from
that watched number rather than from the one the dropdown promised. All three can
be wrong in the same direction, and that direction is the one that moves on from
a comment which never actually took the lead.

The watch stops as soon as the target is reached or the count stops moving, and
the time it uses is **deducted from the wait before the next round**, so the
run's pacing is unchanged — Zefoy enforces a cooldown between submits either
way, and that time was previously spent doing nothing.

**Several comments of ours on one video are all worked, in turn.** Once one is
clear of every stranger the hearts go to the next of ours rather than to the next
video — two of our comments at the top of a section is worth more than one of
them further clear:

```
[*] 3 comment(s) of ours here, 1 already clear of the best stranger (200)
[*] Ours: 180 hearts | best other comment: 200 | need 23 more (margin 3)
  [Zefoy] -> OK: Sent 25 hearts – clear at 205, now on to our other 1 comment(s) here
```

The one **closest to the line goes first**, because it buys a top spot for the
fewest hearts and leaves the rest of the budget for the next. They all aim at the
same rival — the best comment that is **not** ours — so our second comment is
never aimed at our first, which would have them racing each other up a section
they already own.

A video counts as finished only when **every** comment of ours leads. Clearing
one while another is still under a stranger leaves work on the video, and the run
says which happened.

Things to know about it:

- **Several rounds per video.** Zefoy sells 25 or 50 hearts a submit, so a
  comment 139 behind cannot be caught in one visit. `--rounds` (default 4) caps
  the batches per video per pass, so one stubborn video cannot eat an evening
  while the rest of the list waits.
- **Each round re-reads the live counts** rather than assuming the last batch
  landed, because sometimes it does not.
- **A video still behind stays pending.** It is left out of the state file, so
  the next pass picks up exactly the videos that still need work. Pair it with
  `--loop`.
- **Our own comments are excluded from the target.** Two of our comments can sit
  on one video; treating the top row as the rival would have the tool racing
  itself upward forever.
- **Already leading is a success, not a skip** — it is the goal, reached. One
  heart clear of the rival counts: the margin is a cushion aimed for on the way
  up, not part of the test, so a won video does not spend another cooldown
  buying it.
- **No like count, no ceiling.** Dashboard links carry none, so the chase runs
  uncapped there and the run says so at startup. Use a scraper CSV when the
  ceiling matters.
- **Zefoy only.** Freer has its own flow and its own timers, and the run says so
  once at startup rather than quietly aiming at two different targets in one log.

---

## Two runs on one list

The PC's browser and the phone's can work the same links at the same time.

```bash
# on the PC
python automate.py --from-dashboard --clusters 1 --to-top --tag team --share
# and, in another window, on the phone
python automate.py --from-dashboard --clusters 1 --to-top --tag team --share     --cdp http://127.0.0.1:9222
```

Same source, same `--tag`, `--share` on both. Without `--share` they are
**independent**: give them different tags and each keeps its own record and
works the whole list.

**How they stay out of each other's way.** They are separate processes, so who
is doing which link lives in a claims file beside the state file
(`logs/claims_<key>.json`). Before a link is worked it is claimed; a link
somebody else holds is skipped; a link the other run has already finished is
skipped too, because the pending list was built before they started.

**A claim is a lease, not a lock**, and that is the point. If the phone is
unplugged mid-link nobody is left holding it: the lease lapses after `CLAIM_TTL`
(15 minutes by default) and the PC can take it. And when a run reaches the end of
its own copy of the list, it goes back — up to `SHARE_SWEEPS` times, pausing
`SHARE_SWEEP_WAIT` seconds each time, since a live claim means work in progress
rather than a leak — and finishes whatever the other one let go. Walking the list
once would leave a hole exactly where the other runner stopped.

Measured with two processes on a twelve-link list, killing one of them a third
of the way through: twelve links finished, none twice, nothing left held.

---

## Starting where the last run stopped

Every run keeps a state file and skips what it has already dealt with — that part
has always been there. What it records is the question.

| | what it skips | when you want it |
| --- | --- | --- |
| default | links the last run **finished** | a fresh pass over the list: a video our comment is still losing on gets another visit |
| `--resume` | links the last run **opened** | a run that was interrupted — carry on from the next link instead of re-working the first forty |
| `--fresh` | nothing, and forgets the record | starting the list over deliberately |

The two differ only under `--to-top`. There, a video our comment has not yet
passed is deliberately left pending, because the next pass is its second chance.
That is right when the list ran to the end and wrong when the run was killed a
third of the way down — which is what `--resume` is for.

```bash
# the run
python automate.py --from-dashboard --clusters 1 --to-top
# ...killed halfway. Carry on from where it stopped:
python automate.py --from-dashboard --clusters 1 --to-top --resume
```

The startup banner says which mode is on and what the record holds, so there is
no guessing:

```
[*] State file : logs\state_dashboard-date-1.json — 834 finished, 29 visited but unfinished
[*] Resume     : on — continuing after the last link the previous run opened
```

`RESUME=true` in `.env` makes it the default. `--resume` and `--fresh` together
are refused — they ask for opposite things.

**`--loop` clears the record between passes, on purpose.** A pass that reaches
the end of the list has not been interrupted, so the next one starts at link #1
again. If a loop is on in `.env` (`LOOP=true`) and you want a single pass that
stops when the list is done, pass `--no-loop`. Progress *inside* a pass is saved
after every video either way, so a run killed mid-pass still has somewhere to
resume from.

**A resumed run can only skip links it is given.** With `--from-dashboard` the
pull is the top `--max-links` of the ordered pool — and those are exactly the
links an earlier run already worked. If a `--resume` reports almost nothing left
to do, raise `--max-links` (or drop it) rather than assuming the record is wrong.

---

## `automate.py` command-line options

Every flag overrides the matching `.env` setting for that run.

| Flag | Default | What it does |
| --- | --- | --- |
| `--csv`, `-c` | `CSV_FILE` | The links to work. A scraper CSV **or** a plain list of links, one URL per line. Not needed with `--from-dashboard`. |
| `--from-dashboard` | off | Take the links from the dashboard's **live pool** and let it do the clustering. See [Where the links come from](#where-the-links-come-from). |
| `--cluster-by` | `date` | `--from-dashboard`: `rank`, `date` or `combined`. |
| `--clusters` | `1` | `--from-dashboard`: which clusters, e.g. `1` or `1,2`. Use **`all`** for every cluster — not `""`, which PowerShell drops before argparse sees it. Links are worked **best cluster first**, keeping the dashboard's ranking within each. |
| `--platform` | `tiktok` | `--from-dashboard`: which platform's pool. |
| `--category` | all | `--from-dashboard`: only links in this audience category. |
| `--max-links` | `2000` | `--from-dashboard`: how many links to pull at most. |
| `--service`, `-s` | `SERVICE` (`both`) | `zefoy`, `freer` or `both`. With `both`, Zefoy runs the whole list first, then Freer. |
| `--delay`, `-d` | `DELAY_SECONDS` (`30`) | Seconds between videos, **Freer only**. The Zefoy runner imposes no delay of its own — it waits only when Zefoy's own cooldown says to. |
| `--keyword`, `-k` | `COMMENT_KEYWORD` | Comma-separated keywords, highest priority first. The first comment matching the earliest keyword is the target. |
| `--output`, `-o` | `OUTPUT_FILE` | Log CSV path. Used on the first pass only; later `--loop` passes get timestamped names. |
| `--workers`, `-w` | `PARALLEL_WINDOWS` (`1`) | Browser windows per service, each taking videos off one shared queue. |
| `--loop`, `-l` | `LOOP` (`false`) | After finishing the list, clear the state files and sweep it again, forever. |
| `--no-loop` | — | One pass, then stop. The only way to override `LOOP=true` in `.env`. |
| `--loop-delay` | `LOOP_DELAY_SECONDS` (`60`) | Seconds between `--loop` passes. |
| `--resume`, `-R` | `RESUME` (`false`) | Carry on where the last run **stopped**: skip every link it opened, not only the ones it finished. See [Starting where the last run stopped](#starting-where-the-last-run-stopped). |
| `--fresh` | off | Forget the last run and start at link #1. Deletes the state file for this source, nothing else. |
| `--share` | off | Work the same list as another run. Both need the same source and the same `--tag`; links are claimed one at a time so neither repeats the other. |
| `--recover` | `CDP_RECOVER` (`5`) | `--cdp`: how many times a dropped phone is put back with `adb reconnect` + `adb forward` so the run can carry on. `0` stops at the first drop. |
| `--to-top` | off | Aim at the best other comment instead of a share of the video's likes. See above. Zefoy only. |
| `--margin` | `TOP_MARGIN` (`3`) | `--to-top`: how many hearts to lead the rival by. |
| `--floor` | `HEART_FLOOR` (`0.25`) | `--to-top`: the least a comment may carry, as a share of the **video's** likes — worked even when it already leads. `0` makes leading enough. |
| `--rounds` | `TOP_ROUNDS` (`4`) | `--to-top`: heart batches per video per pass. |
| `--watch` | `HEART_WATCH_SECONDS` (`45`) | `--to-top`: seconds spent reading the comment's **real** heart count after each batch. `0` goes back to assuming the batch landed in full. |

`--keyword`, `CLUSTER_COUNT` and `MAX_CLUSTER` are **re-read from `.env` on every
`--loop` pass**, so you can retune a long-running sweep by editing the file — no
restart needed. A `--keyword` passed on the command line wins over `.env` and
stays fixed for the whole run.

---

## Settings (`.env`)

### What to run

| Variable | Default | Notes |
| --- | --- | --- |
| `CSV_FILE` | — | Links to work. Required unless `--csv` is passed. |
| `SERVICE` | `both` | `zefoy`, `freer` or `both`. |
| `COMMENT_KEYWORD` | — | Comma-separated, highest priority first, e.g. `purifytext,acoustictext,prohumanly`. **With none set, every video is skipped** rather than hearting an unrelated comment. |
| `OUTPUT_FILE` | timestamped | Log CSV path for the first pass. |
| `COMMENTS_OUTPUT_FILE` | `zefoy_comments.json` | Where the comments the Zefoy scan reads are saved. No CLI flag. |
| `DASHBOARD_URL` | — | `--from-dashboard`: the deployed dashboard, e.g. `https://…vercel.app`. Falls back to `../3_dashboard/.env`. |
| `LINKS_EXPORT_TOKEN` | — | `--from-dashboard`: the shared token that endpoint checks. Falls back to `../3_dashboard/.env`. |

Keywords are matched with punctuation, spacing and case ignored, so
`purifytext` finds `purify text`, `Purify-Text` and `"Purify Text"`. The comment
bank writes the product name as ordinary words on purpose, and a literal match
missed most of its own output.

### How many hearts

| Variable | Default | Notes |
| --- | --- | --- |
| `HEART_FLOOR` | `0.25` | The least a comment may carry, as a share of the video's likes. Below it the comment is hearted even when it already leads the section. |
| `HEART_THRESHOLD` | `0.75` | The ceiling, in **both** modes: a comment is never taken above this fraction of the video's likes. `1` means "up to the video's own like count". In the default mode it is also the target; under `--to-top` it is only the limit. |
| `THRESHOLD_STEP` | `0.08` | **Freer only.** When no matching comment fits the threshold, relax it by this fraction per candidate and try again. |
| `TOP_MARGIN` | `3` | `--to-top`: hearts to lead the rival by. |
| `TOP_ROUNDS` | `4` | `--to-top`: heart batches per video per pass. |
| `HEART_WATCH_SECONDS` | `45` | `--to-top`: how long to watch the real heart count arrive after a batch. `0` assumes instead. |
| `HEART_WATCH_EVERY` | `4` | Seconds between reads while watching. Each read is one DOM query on a page already open — nothing is asked of Zefoy. |

### Pacing

| Variable | Default | Notes |
| --- | --- | --- |
| `DELAY_SECONDS` | `30` | Gap between videos on the **Freer** runner; a random 0–30 % is added. **Zefoy ignores it.** |
| `LOOP` | `false` | `true` to sweep the list repeatedly. `--no-loop` overrides it for one run. |
| `LOOP_DELAY_SECONDS` | `60` | Gap between passes. |
| `RESUME` | `false` | `true` to make `--resume` the default: skip every link the last run opened, not only the ones it finished. |
| `CDP_RECOVER` | `5` | `--cdp`: how many times to reconnect a phone that drops off adb mid-run. |
| `ADB_PATH` | (found) | Where `adb` is, if it is not on PATH and not in the Android SDK's `platform-tools`. |
| `PAGE_LOAD_WAIT_MIN`, `PAGE_LOAD_WAIT_MAX` | `2`, `4` | Random wait after a navigation, in seconds. |
| `SUBMIT_WAIT_MIN`, `SUBMIT_WAIT_MAX` | `2`, `4` | Random wait after pressing a heart, before reading the result. |

**The Zefoy runner never pauses on its own.** Zefoy meters hearts itself and
says so — `Cooldown – waiting 79s...` is its own countdown, read off the page
and waited out — so a second delay of ours only made the run slower without
making it safer. It moves to the next video, and to the next round, the moment
the previous one is finished.

What still takes time on that path, and why:

| Wait | Why it is there |
| --- | --- |
| Zefoy's cooldown | Imposed by Zefoy. Read off the page and waited out. |
| `PAGE_LOAD_WAIT_*`, `SUBMIT_WAIT_*` | Short settles after a navigation or a click, so the next line reads a rendered page instead of an empty one. Seconds, not pacing. |
| `--watch` | Only while hearts are actually arriving, and it stops as soon as they settle. |

### Captcha

Zefoy guards its dashboard with an image-word captcha: a distorted word in a
picture, typed into a box. It is solved **once per window per session**, not per
video, and a session that expires mid-run is detected and re-solved.

| Variable | Default | Notes |
| --- | --- | --- |
| `CAPTCHA_MODE` | `auto` | `auto` — the image is sent to Gemini and the word it reads is submitted, falling back to the terminal after 8 tries. `manual` — you type the word in the terminal and the script submits it. |
| `GEMINI_API_KEY` | — | Required by `auto`. **Without it, `auto` silently behaves like `manual`** — both conditions are checked together. Get one at <https://aistudio.google.com/apikey>. |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Which model reads the image. Any model that supports `generateContent` works; a flash model is the right shape for reading one short word. |

To let the AI solve them, **both** of these have to be set:

```ini
CAPTCHA_MODE=auto
GEMINI_API_KEY=...
```

The request is deliberately boring: temperature 0, a 16-token ceiling, and an
instruction about the shape of the answer as much as the reading — a model told
to describe a captcha writes a sentence about a captcha, and the box takes a
word. The reply is stripped to lowercase letters, and a model that answers
`unknown` is treated as a miss so a fresh captcha is requested rather than
`unknown` being submitted.

**Check it before a run, not during one:**

```bash
python check_captcha.py                 # configured? which models does the key allow?
python check_captcha.py --live          # fetch a real Zefoy captcha and read it
python check_captcha.py --live --solve  # ...and submit it, proving the whole path
python check_captcha.py --image captcha-dump/ai-gaveup-….png
```

Each question is answered separately, so a failure names itself: an empty key, a
refused key, a model that no longer exists, and a model that simply misread the
picture are four different messages rather than one "attempt failed" repeated
eight times.

**Images are kept.** Every captcha the AI gives up on is written to
`captcha-dump/`, because a word the model gets wrong can only be fixed by
looking at the picture it was given — and after a run those pixels are gone.

### Windows, proxies, browser

| Variable | Default | Notes |
| --- | --- | --- |
| `PARALLEL_WINDOWS` | `1` | Windows per service. Each takes videos off one shared queue, so more windows means more throughput, not duplicated work. |
| `STAGGER_WINDOWS` | auto | Open windows one at a time, each after the previous one's captcha is solved. Blank = automatic: staggered when captchas are `manual` (they share one terminal, so they have to be), all at once when `auto`. Force with `true` / `false`. |
| `PROXIES` | — | Comma-separated, e.g. `http://user:pass@host:port`. Handed to windows round-robin. Blank = no proxy. |
| `VIEWPORT_WIDTH`, `VIEWPORT_HEIGHT` | `1280`, `800` | Browser window size. |

### Which links, in what order

Links are split into priority clusters twice over — once by the scraper's
`search_rank`, once by `posted_date` — and then interleaved, so a run alternates
between "ranks well" and "posted recently" rather than exhausting one idea first.
This mirrors what the dashboard does.

| Variable | Default | Notes |
| --- | --- | --- |
| `CLUSTER_COUNT` | `10` | How many clusters to split the links into. |
| `MAX_CLUSTER` | `0` | Only work clusters up to and including this one; later links are skipped entirely this pass. `0` or blank = no limit. |

Both are re-read on every `--loop` pass, and **both are ignored under
`--from-dashboard`**, where the dashboard has already clustered and ordered the
selection.

---

## Where the links come from

Three sources. Prefer the first.

### `--from-dashboard` — the live pool

```bash
python automate.py --service zefoy --from-dashboard --cluster-by date --clusters 1 --to-top
```

Asks `3_dashboard` for one cluster selection, exactly as `6_comment_liker` does.
**The dashboard does the clustering, not this script.** That matters because
clusters are *relative* — assigned by splitting the sorted pool per platform —
so they exist nowhere in the database, and anything recomputing them drifts from
what you see on the admin links page. Asking is the only way the two can agree
on what "cluster 1" means.

It also brings back **the products the dashboard currently has switched on**, and
uses them as the keywords unless `--keyword` says otherwise. A product switched
off there stops being hearted here with no edit.

Under `--loop`, each pass re-asks — so a sweep running for hours picks up links
added since it started, and drops any the dashboard has since blocked.

Needs `DASHBOARD_URL` and `LINKS_EXPORT_TOKEN`, read from `.env` here or from
`../3_dashboard/.env`, so the token lives in one place.

**One limitation, and it decides how you run this.** The clusters endpoint sends
no like counts, so the default share-of-the-video's-likes target has nothing to
work from and would send the smallest batch to every video. Use
`--from-dashboard` **with `--to-top`**, which reads what it needs off the comment
section. The run says so at startup if you forget.

The local `CLUSTER_COUNT` / `MAX_CLUSTER` settings are ignored here: the
selection is already one cluster of a bigger pool, already in the order the
dashboard ranked it, and re-splitting it would invent a second set of clusters
inside the first.

### A scraper CSV

Needs a `url` column; `like_count`, `search_rank`, `posted_date` and
`scraped_at` are used when present. The like count feeds the default heart
target, and the other three feed the **local** clustering (`CLUSTER_COUNT` /
`MAX_CLUSTER`) — which is this file's own clustering and will not match the
dashboard's numbers.

### A plain list of links

One URL per line. Blank lines, `#` comments and non-TikTok URLs are ignored, and
duplicates are dropped. Recognised by the first line having no `url` column, so
the extension does not matter. These entries carry no like count either, so the
same `--to-top` advice applies.

---

## Output files

| File | What it holds |
| --- | --- |
| `logs/run_<service>_<timestamp>.csv` | One row per video, flushed as it happens. See the columns below. |
| `logs/no_comment_run_….csv` | The subset where no matching comment was found, plus an `all_comments` column holding everything the video did have — this is the file to read when a keyword is not matching. |
| `logs/state_<csv-stem>.json` | Two lists: `processed` (videos with nothing left to do) and `visited` (videos a run opened, finished or not — where `--resume` picks up). Zefoy and Freer keep separate state (`_freer` suffix). `--fresh` deletes it. A dashboard run keys this on the selection instead — `state_dashboard-date-1.json` — so the two do not share a skip list, because "done" means something different in each. |
| `zefoy_comments.json` | Every comment the Zefoy scan read, per video: user, text, hearts, date. A free by-product of looking for our own comment. |
| `zefoy_selectors.json` | Selectors recorded by `config_mode.py`, loaded automatically when present and overriding the built-in ones. |
| `captcha-dump/*.png` | Captcha images the AI could not read, plus anything `check_captcha.py` fetched. Safe to delete. |

Log columns: `url`, `video_like_count`, `comment_keyword`, `comment_text`,
`comment_hearts`, `hearts_sent`, `rival_hearts`, `short_of_lead`, `is_top`,
`service`, `status`, `note`, `timestamp`. The three in the middle are filled in
by `--to-top` only and are blank otherwise.

`status` is `OK` (hearts sent), `SKIP` (no matching comment on the video) or
`FAIL` (something went wrong — `note` says what).

---

## The other scripts

### `config_mode.py` — re-record the selectors

```bash
python config_mode.py
```

Opens Zefoy, records what you click and type, and writes `zefoy_selectors.json`.
Run it when Zefoy changes its markup and `automate.py` starts reporting
"count button did not appear". The recorded file overrides the built-in
selectors on every later run; delete it to go back to the defaults.

### `extract_comments.py` — read comments, send nothing

```bash
python extract_comments.py --links theFile/links.csv --out comments.json
python extract_comments.py https://www.tiktok.com/@x/video/123
```

Reads every comment on each video through Freer and writes them to JSON.
**No hearts are ever given.** Resumes from its own output file.

| Flag | Default | Notes |
| --- | --- | --- |
| `urls` | — | URLs straight on the command line. |
| `--links` | — | A scraper CSV (for real clustering) or a URL-per-line file. |
| `--out` | `comments_extracted.json` | Output path. |
| `--max-pages` | `30` | Comment pages to read per video. |
| `--clusters` | `10` | Cluster count, as the dashboard uses. |
| `--no-cluster` | off | Keep the input order instead. |
| `--restart` | off | Ignore the existing output and start over. |

### `verify_user.py` / `verify_all.py` — did this person really comment?

Used by the dashboard, not usually by hand. Both open Freer, read a video's
commenters, and look for a particular `@username`, stopping the moment they find
it. Each prints one JSON line on stdout for the dashboard to parse.

```bash
python verify_user.py --username kezyyy6 --links https://www.tiktok.com/@x/video/123
echo '[{"userId":"…","username":"@handle","sampleUrls":["https://…"]}]' | python verify_all.py
```

`verify_user.py` takes `--username` (required), `--name`, `--links` and
`--max-pages` (default 30). `verify_all.py` takes no flags — it reads its list of
users from stdin and holds one browser session open for all of them, so the
captcha is solved once rather than once per user.

### `check_captcha.py` — is the AI solver working?

```bash
python check_captcha.py
python check_captcha.py --live --headed --solve
```

Answers the captcha questions without starting a run: whether a key is set,
which models that key can call, whether `GEMINI_MODEL` is among them, and what
the model makes of a real captcha. See [Captcha](#captcha).

### `inspect_zefoy.py` / `inspect_freer.py` — diagnostics

```bash
python inspect_zefoy.py
python inspect_freer.py
```

Walk the flow by hand and dump the real DOM at each step, so a broken selector
can be found and fixed. No flags; you solve the captcha and they do the rest.

---

## When something goes wrong

**"No matching comments for any keyword"** — read the `no_comment_…csv` log:
its `all_comments` column holds every comment the video actually had. Usually
the video genuinely carries none of ours.

**Captchas are not being solved automatically** — run `python check_captcha.py`.
Nine times in ten it is an empty `GEMINI_API_KEY` or `CAPTCHA_MODE` still set to
`manual`, and the run gives no hint of either: it just asks you to type the word.

**"Count button did not appear after Search"** — Zefoy changed its markup, or
the session quietly expired. Run `config_mode.py` to re-record, or
`inspect_zefoy.py` to look.

**Cooldowns** — both services meter hearts per account and per IP. The run reads
the countdown off the page and waits; `PROXIES` and a larger `DELAY_SECONDS` are
the levers if you are hitting them constantly.

**A run that seems to skip everything** — the banner prints the state file and
what it holds. `--fresh` works the whole list again. Under `--from-dashboard`,
also check `--max-links`: the pull is the top N of the ordered pool, which is
where an earlier run started.

**A run that seems to start over** — check the `Loop` line in the banner. With
`LOOP=true` in `.env` every pass clears the record deliberately; `--no-loop` runs
one pass and stops, and `--resume` continues an interrupted one. A pass that
worked **no** links keeps the record instead of clearing it, so a browser that
died at link 40 of 1,526 no longer costs the whole run.

**`ECONNREFUSED 127.0.0.1:9222`** — the adb forward is gone. The phone is now
checked before the link list is fetched, so this fails in one line instead of
retrying every 60 seconds:

```
[!] http://127.0.0.1:9222 is not answering: nothing is listening there - the adb forward is gone
[!] Nothing can run without it. To fix: re-run
  adb forward tcp:9222 localabstract:chrome_devtools_remote
and check 'adb devices' lists the phone
```

If the forward drops *mid-run*, the run no longer stops: it runs `adb reconnect
offline` and `adb forward` itself, reopens the browser, logs back into Zefoy and
carries on with the links still queued.

```
[Zefoy] [!] Lost the browser: the browser went away mid-captcha...
[Zefoy] [*] Trying to pick it back up (4 attempt(s) left after this one)...
[*] Phone is back (Chrome/154.0.8037.57)
[Zefoy] [*] Reattached - carrying on with 1,443 link(s) still queued
```

The budget is `--recover` (default 5), because a phone that is unplugged, off, or
waiting for someone to accept a debugging prompt is not something adb can fix —
that still ends the run, with the record kept and `--resume` to carry on.

**A phone on Wi-Fi that adb cannot see** — adb ships two mDNS backends and the
default one finds nothing on some machines, reporting itself as
`adb discovery 0.0.0`:

```
> adb mdns services
List of discovered mdns services
(nothing)
```

The Openscreen backend finds it on the first try, so every adb call this project
makes sets `ADB_MDNS_OPENSCREEN=1`:

```
adb-RZ8T21TZJSL-LZWXEd  _adb-tls-connect._tcp  192.168.1.10:45327
```

Same adb, same network, same phone. If you are running adb by hand, set that
variable too, or the phone is invisible. Recovery now dials a discovered phone
by itself — an undialled phone is not the same as an offline one — so a wireless
phone needs no address typed anywhere.

**`captcha image never rendered`, over and over** — the phone is locked or Chrome
is in the background. Chrome does not paint a tab nobody is looking at, so the
captcha image never decodes and no number of refreshes will produce one. The run
now says so (`the page is HIDDEN – nothing on it is being drawn`) and waits three
minutes for the page to come back rather than spending its eight attempts on it.
Unlock the phone and leave Chrome in front:

```bash
adb shell input keyevent 82          # dismiss the keyguard
adb shell input swipe 360 1200 360 300 150
adb shell svc power stayon usb       # and keep the screen on while plugged in
```

---

## Related projects

- `1_tiktok_search_scraper` — produces the link CSVs this reads.
- `3_dashboard` — writes the comments, holds the link pool, and does the
  clustering that `--from-dashboard` asks for.
- `6_comment_liker` — likes comments with our **own** TikTok accounts, which is
  a different trade: no captcha and no cooldown, but the accounts are ours and
  can be suppressed. Zefoy's hearts come from strangers.
