# 7_control_center — one window for the whole pipeline

A desktop app that runs the programs you already have, with their settings on a
form instead of in your head, and their output in front of you while they work.

```
Search extraction   →  1_tiktok_search_scraper/scraper.py      →  3_dashboard/upload.py
Instagram channels  →  1_tiktok_search_scraper/harvest_instagram.py
Comment liker       →  2_comment_automation/automate.py
```

It owns the settings, the window and the jobs. It owns none of the work: a
second copy of the scraper or the heart runner would drift from the first, and
the thing it would drift on is which links reach the dashboard.

---

## Run it

```bash
cd 7_control_center
python app.py
```

A native window opens (pywebview, using the Edge WebView2 runtime that ships
with Windows 11). Without pywebview it falls back to your browser and says so.

```bash
pip install pywebview      # for the window; everything works without it
python app.py --browser    # force the browser
python app.py --port 8750  # pick the port
```

On Windows, **Control Center.bat** starts it with no console window.

---

## Search extraction

Searches a platform for your phrases and records every video it returns with its
rank, likes and views. The result goes to the dashboard as **search-rank links**.

| Setting | What it does |
| --- | --- |
| Platforms | Tick any of TikTok, YouTube, Instagram and Reddit. **Each one is its own run** — `scraper.py` takes a single `--platform` and writes a single file — and they start together, so the wait is the slowest rather than the sum |
| YouTube tab | **Both** (Shorts first, then Videos), Shorts only, or Videos only. YouTube only, and greyed out elsewhere. **Both is two runs** — see below |
| Minimum, Maximum | Videos per phrase |
| Search phrases | One per line; each is searched separately and the results merged |
| Output CSV | Blank lets the scraper name it, which is usually what you want. With several platforms ticked the name gets the platform put into it (`run.csv` → `run_tiktok.csv`), because two scrapers running at once must not share a file |
| Upload automatically | Starts the upload as its **own job** when the search finishes |
| Upload mode | **Replace** — this scrape is the current ranking, so rank links it no longer returns are dropped. **Append** — add without removing, for one keyword out of several uploaded separately |

An upload only ever touches search-rank links; links with no rank came from the
verify list and neither mode will edit or delete one.

**YouTube is read a tab at a time.** Its results page mixes Shorts with long
videos, and `scraper.py` only clicks a filter chip when it is told which one:

```python
chip_label = {"shorts": "Shorts", "videos": "Videos"}.get(content)
```

For `all` that is `None`, so no tab is clicked and the mixed page is scraped as
it comes — mostly long videos. So **Both** expands into a Shorts run followed by
a Videos run, each clicking its own tab, writing its own file and uploading it.
Shorts go first.

**The upload only runs if the search actually finished.** A stopped scrape has
half a file, and replace-mode on half a file removes links that are still good.

**Each platform uploads its own file**, read from the line the scraper prints
when it is done (`Saved 1,204 unique URLs to '…'`). Not "the newest CSV": with
four searches running at once, the newest file when the TikTok run finishes may
belong to the Instagram one, and replace-mode on the wrong file removes the rank
links of a platform nobody was uploading. If a run never says where it wrote,
the upload is skipped and says so.

---

## Instagram channels

The dashboard turns the Instagram links in its pool into a **ranked channel
list** (`rankChannels()` — the same order the Links-to-verify extract page
shows). This asks for that list, keeps the Instagram channels, visits the best
of them, and collects the posts newer than what we already hold. Everything
found is staged on **Links to verify** for you to review and merge — nothing
reaches a user from here.

Measured against the live dashboard: **4,377 ranked channels, 1,506 of them
Instagram**. `--limit 50` takes the top fifty of those.

| Setting | What it does |
| --- | --- |
| Channels this run | Taken best-first, so a smaller number is the strongest ones |
| Accounts file | Blank asks the dashboard; a path skips that step |
| Stage what it finds | Off passes `--no-upload`: it scrapes and saves locally |
| Dry run | Find, report, change nothing |

The browser is **always on screen** here: Instagram's profile page is a
JavaScript shell, so the posts only exist once something has run the page, and
`scrape_channels.py` opens its context with `headless=False`. There is no
headless mode to offer — and `--headed` is not sent, because that scraper has no
such flag and refuses the whole run over it (`unrecognized arguments: --headed`,
exit 2, before a single channel is scraped).

---

## Comment liker

Hearts for our comments through Zefoy or Freer. Every flag `automate.py`
documents is on this page, grouped by what it decides.

**Service and links** — Zefoy, Freer or both; links from the dashboard's live
pool (cluster by rank/date/combined, which clusters, platform, category, how
many) or from a CSV. Keywords blank means the products the dashboard has
switched on.

**Target** — *Pass the best other comment* aims at the comment section instead of
at a share of the video's likes, leading by a margin, over a number of batches,
reading the real heart count off the page after each one.

**Where to run** — two checkboxes, and one press starts whatever they say:

| Ticked | What happens |
| --- | --- |
| This PC | One run, in a browser window here |
| The phone | One run, over adb — its session, its IP, its captcha |
| Both + *work the same list together* | **Two runs, one record.** A link claimed by one is skipped by the other, so neither repeats it — and if the phone drops out, the PC goes back for whatever it was holding and finishes the list alone |
| Both, without that box | Two runs on **separate records** (`-pc` and `-phone`), each working the whole list |

Sharing is only offered when both are ticked: one run has nobody to share with.
A shared pair is named `team` unless you give it a record name; an unshared pair
is kept apart by suffixing yours, because two runs on one record *without* the
claims protocol would each skip what the other finished and call a half-done list
finished.

A PC run never carries `--cdp`, even with an address saved — otherwise ticking
both would start two runs driving the same handset.

**Pace, place and memory** — browser windows, Freer's delay, the phone's CDP
address and its reconnect budget, a record name (`--tag`), and whether to carry
on where the last run stopped, start the list over, or sweep it again.

### The phone

Hearts can be given from the phone's own Chrome — its session, its IP, its
captcha — and the card at the top of this tab attaches it without a terminal.

| | |
| --- | --- |
| Status | `ready` (with the Chrome version), `phone found, Chrome not reachable`, `no phone`, or `adb is not working` — polled while the tab is open |
| Wi-Fi address | Usually unnecessary — the phone is **discovered** over mDNS and dialled for you. Fill it in only when discovery cannot see it |
| Connect the phone | `adb connect` (if an address is given) → `adb reconnect` → `adb forward` → and a **cold restart of Chrome** if its debugging socket is missing |

**`adb is not working` means the fault is on this machine, not the phone.**
adb runs a server of its own on TCP 5037 and does not check who answers, so
another program holding that port kills every command with `could not read ok
from ADB Server` — naming neither the port nor the program. On this laptop the
program is ASUS Armoury Crate; Vysor, BlueStacks and several phone-manager
suites do it too. The tools now notice, name whoever has the port, and start
adb's own server on 5038 instead; the card says `adb on port 5038` when that has
happened. Override either number with `ADB_SERVER_PORT` /
`ADB_SERVER_PORT_FALLBACK`.

That last step is the one that is not obvious: **Chrome opens
`chrome_devtools_remote` once, when the browser process starts, and never
again.** A Chrome that was running through a disconnect has no socket for the
forward to point at, so adb repeats itself while `127.0.0.1:9222` answers
nothing. Resuming the app is not enough either — it has to be a cold start,
which is why Connect force-stops it. A restarted Chrome has no Zefoy session, so
the first thing the run meets is a captcha; the AI solves it.

Connect takes up to about half a minute when it has to go that far. It calls
`automate.py`'s own helpers rather than reimplementing them, so the window and
the run cannot disagree about what "connected" means.

Two things worth knowing:

- **On the phone**, keep Chrome in front and the screen unlocked. A tab nobody is
  looking at is not painted, so the captcha image never arrives.
- **A tag gives a run its own record.** Two runs over the same clusters otherwise
  share one skip list, and each skips links the other did.

---

## Jobs

Everything the window has started, running or finished, newest first. Click one
to open its log; it follows the output and stays put if you scroll up.

- Jobs are **independent processes**, with one exception: the scraper and the
  harvester open the same Chrome profile (`BROWSER_PROFILE_DIR`), and Chromium
  allows a single window per profile — a second one is refused on the spot with
  *"Opening in existing browser session"*. So those two **queue**, shown as
  `queued`, and say what they are waiting for. Everything else runs alongside
  them: the liker opens its own throwaway browser or attaches to the phone, and
  an upload opens nothing at all.
- **Some programs ask questions.** `scraper.py` stops on TikTok until you have
  logged in and pressed Enter. Type into the box under its log and press Enter —
  the bar turns amber and says *waiting for you* when a prompt is detected, and
  your answer is echoed into the log so the pause has a visible reason for
  ending. Without this the run died instantly with `EOFError`, because a window
  has no keyboard attached to it.
- **Copy** puts the whole log on the clipboard and says how many lines it took.
  It falls back to a hidden textarea when the clipboard is refused, because a
  Copy button that fails silently is worse than no Copy button.
- **Edit** turns the log into a text box you can type in — cut a traceback down
  to the three lines worth sending, or annotate it before copying. Copy then
  takes what is in the box. Editing **pauses the follow**: new lines arriving
  under the cursor would move the text you are working on. The job keeps running
  and keeps its own output; nothing typed here is saved anywhere, and switching
  Edit off reloads the real log.
- **Stop** kills one job. **Stop everything** asks first, then kills them all.
- A job stopped on purpose is `stopped`, not `failed` — the difference is
  whether you should go looking for a bug.
- Closing the window stops every job it started.

---

## What it does for you that a terminal does not

- **The command is shown before it runs**, under every form. A window that hides
  what it is about to execute is a window you cannot check, and these commands
  reach live accounts.
- **Settings persist** in `settings.json` — every field on every tab: the search
  phrases, the ticked platforms, the YouTube tab, the channel count, the
  clusters, the tag, all of it. They are written **as you type** (debounced),
  and the sidebar says `settings saved 02:14` so you can see it happen. A change
  still inside the debounce is flushed when the window loses focus or closes, so
  the last thing typed is not the thing that gets lost. Opening the window only
  *reads* the file — the page asks for its command preview with `preview_only`,
  so a load can never write over what was saved. Delete the file to go back to
  the defaults.
- **Children are told to speak UTF-8.** A TikTok caption is full of emoji and a
  Windows console is cp1252; a child that prints one dies halfway through its
  work. That is a real failure this window removes.
- **Fields that cannot apply are greyed out** rather than hidden — a box that
  moves is harder to use than one that dims.

---

## Checking it

```bash
python check_app.py
```

Builds every command from every mode and asserts the flags, then drives the job
runner with harmless commands: output streaming, exit codes, stop, and that
three 1.5-second jobs finish in under three seconds rather than four and a half.
No browser is opened and no account is touched.

---

## Files

| File | What it is |
| --- | --- |
| `app.py` | The server, the job runner, the command builders, the window |
| `ui.html` | The interface — one file, no build step, no dependencies |
| `check_app.py` | The checks |
| `settings.json` | Written as you type; delete it to go back to the defaults |
| `Control Center.bat` | Double-click start on Windows |
