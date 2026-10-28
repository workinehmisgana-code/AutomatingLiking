"""
TikTok Comment Hearts Automation via Zefoy & Freer.in

Zefoy flow (matches actual site behavior confirmed June 2026):
  1. Open zefoy.com  →  image-word captcha (#captchatoken) appears
  2. PAUSE: user manually types the word and clicks the checkmark
  3. Dashboard loads  →  script clicks button.t-chearts-button ("Comments Hearts")
  4. URL input appears in .t-chearts-menu
  5. For each video URL:
       a. Fill .t-chearts-menu URL input, click Search (.input-group-append button)
       b. If cooldown message shown, wait and retry
       c. Click the dark comment-count button (button.wbutton.btn-dark, e.g. "8,420")
       d. Comment list appears (.t-chearts-menu .list-group-item rows)
          – find row containing first matching COMMENT_KEYWORD (blank = first row)
          – click that row's heart button[type='submit']
       e. Wait for success; move to next URL (URL input remains on page)

Usage:
    python automate.py
    python automate.py --csv path/to/file.csv --service zefoy --keyword cats
"""

import argparse
import asyncio
import base64
import csv
import json
import os
import re
import sys
import time
import requests as _requests
import random
import threading
from datetime import datetime, timezone
from pathlib import Path
from queue import Queue, Empty
import shutil
import subprocess
from urllib.parse import urlencode, urlsplit
import urllib.error
import urllib.request

# A TIKTOK COMMENT IS FULL OF EMOJI AND A WINDOWS CONSOLE IS CP1252.
# Printing one raised UnicodeEncodeError from inside the heart path, which the
# per-link handler recorded as "FAIL: Error: 'charmap' codec can't encode
# character '🥰'" — a video measured, found 629 hearts behind, and then
# abandoned because of the console's character set. Nothing about the work
# depends on what the terminal can draw, so unprintable characters are replaced
# rather than allowed to end a visit.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - a stream that refuses is not fatal
            pass

from dotenv import load_dotenv, dotenv_values
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

load_dotenv(Path(__file__).parent / ".env", override=True)
# Read the .env file directly so values are always from the file, not os.environ.
_DOTENV = dotenv_values(Path(__file__).parent / ".env")

# ── Config ────────────────────────────────────────────────────────────────────
DEFAULT_CSV_FILE    = os.getenv("CSV_FILE", "")
DEFAULT_SERVICE     = os.getenv("SERVICE", "both")
DEFAULT_DELAY       = float(os.getenv("DELAY_SECONDS", "30"))
DEFAULT_OUTPUT_FILE = os.getenv("OUTPUT_FILE", "")
COMMENT_KEYWORDS    = [k.strip() for k in os.getenv("COMMENT_KEYWORD", "").split(",") if k.strip()]
HEART_THRESHOLD     = float(os.getenv("HEART_THRESHOLD", "0.75"))
THRESHOLD_STEP      = float(os.getenv("THRESHOLD_STEP", "0.08"))
LOOP                = os.getenv("LOOP", "false").lower() == "true"
LOOP_DELAY_SECONDS  = float(os.getenv("LOOP_DELAY_SECONDS", "60"))
# Pick a run up where the last one STOPPED, rather than where it was FINISHED.
# The two differ under --to-top: a video our comment is still losing on is left
# pending on purpose, so a fresh pass visits it again. That is right for a pass
# over the whole list and wrong for a run that was interrupted a third of the way
# down — there, the point is to carry on from the next link. Off by default so
# nothing changes for anyone who does not ask.
RESUME              = os.getenv("RESUME", "false").lower() == "true"
# How many times a run may put the phone's connection back by itself before it
# gives up. The device drops off adb on its own — the cable, a USB mode change,
# the daemon losing it — and `adb reconnect` + `adb forward` fixes it without
# anybody touching the phone. Bounded, because a phone that is genuinely gone
# should end the run rather than retry for an hour.
CDP_RECOVER         = int(os.getenv("CDP_RECOVER", "5"))
# A name for THIS run's record, when two runs work the same list at once.
# Without it they share one state file keyed on the source — which is right for
# one machine picking a run back up, and wrong for a phone and a desktop working
# the same clusters side by side: each skips links the other did, and whichever
# writes last decides what the file says.
STATE_TAG           = os.getenv("STATE_TAG", "").strip()
PARALLEL_WINDOWS    = int(_DOTENV.get("PARALLEL_WINDOWS", os.getenv("PARALLEL_WINDOWS", "1")))
GEMINI_API_KEY      = _DOTENV.get("GEMINI_API_KEY", os.getenv("GEMINI_API_KEY", ""))
GEMINI_MODEL        = _DOTENV.get("GEMINI_MODEL", os.getenv("GEMINI_MODEL", "gemini-2.0-flash"))
# CAPTCHA_MODE: auto = Gemini solves it; manual = you type the word in the terminal
CAPTCHA_MODE        = _DOTENV.get("CAPTCHA_MODE", os.getenv("CAPTCHA_MODE", "auto")).strip().lower()
# STAGGER_WINDOWS: open the parallel windows one at a time (so you solve each
# captcha before the next opens) instead of all at once. blank = auto: stagger
# when captchas are manual (required — they share one terminal), open all at once
# when captchas are automatic. Force with true/false.
_STAGGER_CFG        = _DOTENV.get("STAGGER_WINDOWS", os.getenv("STAGGER_WINDOWS", "")).strip().lower()
def stagger_windows() -> bool:
    if _STAGGER_CFG in ("true", "1", "yes", "on"):  return True
    if _STAGGER_CFG in ("false", "0", "no", "off"): return False
    return CAPTCHA_MODE != "auto"
# Comma-separated proxy URLs, e.g. http://user:pass@host:port  (blank = no proxy)
PROXIES             = [p.strip() for p in _DOTENV.get("PROXIES", os.getenv("PROXIES", "")).split(",") if p.strip()]
VIEWPORT_WIDTH      = int(os.getenv("VIEWPORT_WIDTH", "1280"))
VIEWPORT_HEIGHT     = int(os.getenv("VIEWPORT_HEIGHT", "800"))
PAGE_LOAD_WAIT_MIN  = float(os.getenv("PAGE_LOAD_WAIT_MIN", "2"))
PAGE_LOAD_WAIT_MAX  = float(os.getenv("PAGE_LOAD_WAIT_MAX", "4"))
SUBMIT_WAIT_MIN     = float(os.getenv("SUBMIT_WAIT_MIN", "2"))
SUBMIT_WAIT_MAX     = float(os.getenv("SUBMIT_WAIT_MAX", "4"))
# How many priority clusters the links are split into (rank + posted-date).
CLUSTER_COUNT       = int(os.getenv("CLUSTER_COUNT", "10") or "10")
# Only process links up to (and including) this cluster; links in later clusters
# are skipped entirely. 0 (or blank) = no limit, process every cluster.
MAX_CLUSTER         = int(os.getenv("MAX_CLUSTER", "0") or "0")
# ─────────────────────────────────────────────────────────────────────────────

# ── Confirmed Zefoy selectors (live-site discovery, June 2026) ────────────────
_CAPTCHA_SEL    = "#captcha-img"          # captcha image (Zefoy login page)
_CAPTCHA_INPUT  = ".captcha-login-input"   # text input for the word
_CAPTCHA_SUBMIT = ".submit-captcha"        # submit button
_CAPTCHA_ERR    = "#zbcd"                  # "Captcha code is incorrect" modal
_CAPTCHA_REFRESH= ".refresh-capthca-btn-new"  # get a new image
_CH_BTN_SEL     = "button.t-chearts-button"
_URL_INPUT_SEL  = ".t-chearts-menu input[placeholder='Enter Video URL']"
_SEARCH_BTN_SEL = ".t-chearts-menu .input-group-append button"
_COUNT_BTN_SEL  = ".t-chearts-menu button.wbutton.btn-dark"
_HEART_QTY_SEL  = ".t-chearts-menu .list-group-item select[name='select_lmt']"

# Heart quantity options offered by Zefoy (75/100 are currently commented out on the site)
_HEART_OPTIONS  = [25, 50]

# --to-top: how far PAST the best other comment to aim. One heart is enough to
# be the top comment and reads as a coincidence, which is the point; a bigger
# margin survives the rival picking up a few organic likes before the next pass.
TOP_MARGIN      = int(os.getenv("TOP_MARGIN", "3"))
# HOW THIN A COMMENT MAY LOOK UNDER ITS OWN VIDEO.
#
# Leading the section is not the same as carrying weight in it. A comment on
# eleven hearts tops a video whose next best is four, and under forty thousand
# likes it still reads as a comment nobody noticed — the number beside it is the
# number a visitor judges it by, and it is being judged against the video.
#
# So a comment under this share of the video's likes is worked EVEN WHEN IT
# ALREADY LEADS. The ceiling (HEART_THRESHOLD) still applies above it: the two
# together say "not thinner than a quarter of the video, not thicker than
# 85% of it". 0 switches the floor off and goes back to leading being enough.
HEART_FLOOR     = float(os.getenv("HEART_FLOOR", "0.25"))
# Submits per video per pass. Zefoy gives 25 or 50 hearts a submit with a
# cooldown in between, so a comment hundreds behind cannot be caught in one
# visit — and a run that tried would spend a whole evening on one video while
# the rest of the list waited. What it does not finish, the next pass continues.
TOP_ROUNDS      = int(os.getenv("TOP_ROUNDS", "4"))
# How long to WATCH the comment's real heart count after a batch is submitted.
# "50 hearts" is what the dropdown says, not what arrives: the hearts trickle in
# over the following seconds and the total is routinely short. The wait after a
# submit was dead time anyway, so it is spent reading the number off the page
# instead of assuming it. 0 turns the watching off and goes back to assuming.
HEART_WATCH_SECONDS = float(os.getenv("HEART_WATCH_SECONDS", "45"))
# How often to re-read it while watching. Each read is one DOM query on a page
# that is already open — no navigation, no request to Zefoy.
HEART_WATCH_EVERY   = float(os.getenv("HEART_WATCH_EVERY", "4"))
# ─────────────────────────────────────────────────────────────────────────────

# ── Load selectors recorded by config_mode.py (overrides above if present) ───
_SELECTORS_FILE = Path(__file__).parent / "zefoy_selectors.json"
_CUSTOM_SEL: dict[str, str] = {}
if _SELECTORS_FILE.exists():
    with open(_SELECTORS_FILE, encoding="utf-8") as _f:
        _raw = json.load(_f)
    _CUSTOM_SEL = {k: v for k, v in _raw.items() if not k.startswith("_")}
    print(f"[*] Loaded custom selectors from '{_SELECTORS_FILE.name}' "
          f"({len(_CUSTOM_SEL)} slots)")

def sel(slot: str, default: str) -> str:
    return _CUSTOM_SEL.get(slot, default)
# ─────────────────────────────────────────────────────────────────────────────

BROWSER_ARGS = ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def page_wait(lo: float = PAGE_LOAD_WAIT_MIN, hi: float = PAGE_LOAD_WAIT_MAX):
    time.sleep(random.uniform(lo, hi))


def submit_wait():
    time.sleep(random.uniform(SUBMIT_WAIT_MIN, SUBMIT_WAIT_MAX))


def choose_heart_count(video_like_count: int, comment_heart_count: int,
                       threshold: float = HEART_THRESHOLD) -> int:
    """Return the highest Zefoy heart option that keeps comment hearts below threshold * video_likes.

    Returns 0 if the comment is already at or above the threshold (skip it).
    """
    if video_like_count <= 0:
        return _HEART_OPTIONS[0]
    limit     = video_like_count * threshold
    remaining = limit - comment_heart_count
    eligible  = [opt for opt in _HEART_OPTIONS if opt < remaining]
    return max(eligible) if eligible else 0


# ── The dashboard's own link pool ────────────────────────────────────────────
#
# This tool used to work only from a CSV: a scrape, frozen on the day it was
# taken, with nothing added since and no idea which links the dashboard had
# blocked or already covered. Its clustering was its own too, computed locally
# over that file — so "cluster 1" here and "cluster 1" on the admin links page
# were two different sets of links that happened to share a name.
#
# THE DASHBOARD DOES THE CLUSTERING, NOT THIS SCRIPT. Clusters are RELATIVE,
# assigned by splitting the sorted pool per platform, so they exist nowhere in
# the database and anything recomputing them drifts from what you see on screen.
# Asking is the only way for the two to agree. Same endpoint and same reasoning
# as ../6_comment_liker/like.py, which pulls its links this way too.
_DASHBOARD_UA = "comment-automation/zefoy"


def load_env() -> dict:
    """Read .env here, falling back to the dashboard's, so the token lives once."""
    out: dict = {}
    for path in (Path(__file__).parent / ".env",
                 Path(__file__).parent.parent / "3_dashboard" / ".env"):
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out.setdefault(k.strip(), v.strip().strip("'\""))
        except Exception:  # noqa: BLE001
            continue
    return out


def from_dashboard(cluster_by: str, clusters: str, extra: dict) -> tuple[list[dict], list[str]]:
    """Links for one cluster selection, plus the ACTIVE products, from the dashboard.

    Returns entries shaped like load_urls' so the rest of the run cannot tell the
    difference — except for like_count, which this endpoint does not carry. That
    matters: the default heart target is a share of the video's likes, and
    without them it has nothing to work from. --to-top does not need it, which is
    why the two belong together.

    Raises with a readable message on any failure. A silent empty list here looks
    exactly like "nothing matched", which sends you hunting in the wrong place.
    """
    env = load_env()
    base = (env.get("DASHBOARD_URL") or "").rstrip("/")
    token = env.get("LINKS_EXPORT_TOKEN") or ""
    if not base:
        raise SystemExit("DASHBOARD_URL is not set in .env (here or in ../3_dashboard/.env)")
    if not token:
        raise SystemExit("LINKS_EXPORT_TOKEN is not set in .env (here or in ../3_dashboard/.env)")

    # "all" MEANS EVERY CLUSTER, and it is spelled rather than left blank.
    #
    # The endpoint already takes an empty list as "no filter", so `--clusters ""`
    # is the natural way to ask — except that PowerShell drops an empty quoted
    # argument before the script ever sees it, and argparse then fails with
    # "expected one argument". A word survives every shell, so there is a word.
    #
    # It worked by accident before this: the endpoint turns each entry into a
    # number and discards what will not convert, so "all" became an empty list on
    # the way. Accidents are not documentation.
    clusters = "" if str(clusters).strip().lower() in ("", "all", "0") else clusters
    params = {"token": token, "clusterBy": cluster_by, "clusters": clusters}
    params.update({k: v for k, v in extra.items() if v})
    url = base + "/api/links/clusters?" + urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": _DASHBOARD_UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:200]
        raise SystemExit(f"dashboard returned HTTP {e.code}: {detail}")
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"could not reach the dashboard: {e}")

    if not data.get("ok"):
        raise SystemExit(f"dashboard error: {data.get('error') or data}")

    entries: list[dict] = []
    for item in data.get("links") or []:
        u = str(item.get("url") or "")
        if not u:
            continue
        entries.append({
            "url": u,
            # The video's own likes, which is what HEART_THRESHOLD is a fraction
            # of. A dashboard deployed before this field existed sends nothing,
            # and 0 means "unknown" everywhere else in here — so an older one
            # still works, uncapped, and says so per video.
            "like_count": int(item.get("likes") or 0),
            "search_rank": 0,
            "posted_date": "",
            "scraped_at": "",
            # The dashboard's own numbers, kept for the log rather than recomputed.
            "cluster": item.get("cluster"),
            "pos": item.get("pos"),
            "category": item.get("category") or "",
        })
    # BEST CLUSTER FIRST, and the dashboard does not do this for us. It assigns
    # the cluster numbers and then returns the links in its own list order, which
    # is the admin page's sort — so a two-cluster selection came back with
    # cluster 2 at the top and the number changing 992 times on the way down.
    # A run that stops early, or is interrupted, had then spent its time on the
    # worse half.
    #
    # Sorted, not re-clustered: the numbers are the dashboard's, and the sort is
    # STABLE, so within a cluster the links keep exactly the order it ranked them
    # in. A link with no cluster number goes last rather than first.
    #
    # And by POSITION inside the cluster, which the dashboard now sends (and
    # already orders by). An older one sends no position, and the stable sort
    # then keeps its order inside each cluster as before.
    entries.sort(key=lambda e: (e["cluster"] is None, e["cluster"] or 0,
                                e.get("pos") is None, e.get("pos") or 0))

    products = [str(x) for x in (data.get("products") or []) if str(x).strip()]
    matched = int(data.get("matched") or 0)
    with_likes = sum(1 for e in entries if e["like_count"] > 0)
    print(f"[*] Dashboard  : {data.get('matched', 0)} link(s) match {cluster_by} "
          f"cluster(s) {clusters or 'all'}, taking {len(entries)}"
          + (f", {with_likes} with a like count" if with_likes else
             " (no like counts — this dashboard predates that field)"))
    if products:
        print(f"[*] Active     : {', '.join(products)}")
    # NOTHING MATCHED: say which filter is the likely culprit.
    #
    # An empty list and a wrong filter look identical from here, and the run
    # used to print "No links to work. Exiting." and stop - true, useless, and
    # it sent people looking at the dashboard rather than at the box they had
    # just changed. So the two filters that can empty the list on their own are
    # re-asked WITHOUT themselves, and whichever one turns out to be holding
    # everything back is named.
    if matched == 0:
        # EVERY filter that would unblock it, not the first one found.
        #
        # Reporting only the first is a lie when two are jointly responsible.
        # This used to say "--cluster-by rank is why", which reads as "there are
        # no ranked links" - there were 2,648, all of them in a genre other than
        # the one asked for. Neither box was wrong on its own; the pair was.
        freeing = []
        for name, key, drop in (
            ("--cluster-by " + str(cluster_by), "clusterBy", "combined"),
            ("--genre " + str(extra.get("genre") or ""), "genre", ""),
            ("--platform " + str(extra.get("platform") or ""), "platform", ""),
        ):
            if key != "clusterBy" and not str(params.get(key, "")).strip():
                continue
            probe = {k: v for k, v in {**params, key: drop}.items() if v != ""}
            try:
                purl = base + "/api/links/clusters?" + urlencode(probe)
                with urllib.request.urlopen(
                    urllib.request.Request(purl, headers={"User-Agent": _DASHBOARD_UA}),
                    timeout=60,
                ) as r:
                    n = int(json.loads(r.read().decode("utf-8", "replace")).get("matched") or 0)
            except Exception:  # noqa: BLE001
                continue
            if n > 0:
                freeing.append((name, n, key))

        if len(freeing) == 1:
            name, n, key = freeing[0]
            print(f"[!] Nothing matched, and {name} is why: "
                  f"{n:,} link(s) match without it.")
            if key == "clusterBy" and str(cluster_by) == "rank":
                # The specific trap, named, because it is not obvious that a
                # clustering choice is also a filter.
                print("    Rank clustering keeps only links that carry a search "
                      "rank, and almost the whole pool is date-only.")
                print("    Use --cluster-by combined (or 'Combined' in the window).")
        elif freeing:
            print("[!] Nothing matched, and no single filter is to blame - the "
                  "COMBINATION is empty, though each part has links on its own:")
            for name, n, _ in freeing:
                print(f"      without {name}: {n:,} link(s)")
    return entries, products


def norm(text: str) -> str:
    """Lowercase, and strip everything that is not a letter or a digit.

    THIS IS WHY OUR OWN COMMENTS WERE INVISIBLE. Keywords were matched as plain
    substrings of the comment text, so "purifytext" did not match "purify text" —
    and the comment bank deliberately writes the product name as ordinary words
    rather than as a brand, which is most of what it now produces. A literal
    match misses exactly the comments we are trying to push.

    Mirrors norm() in ../6_comment_liker/like.py, which matches the same comments
    for the same reason.
    """
    return re.sub(r"[^a-z0-9]", "", text.lower())


def matches_keyword(comment_text: str, keyword: str) -> bool:
    """Is this keyword in this comment, however either is spelled or spaced?"""
    k = norm(keyword)
    return bool(k) and k in norm(comment_text)


# WHERE THE RUN WRITES. Relative "logs/" meant "beside whoever started this",
# which is fine from a terminal in this folder and wrong the moment something
# else launches it — the 6_comment_liker dashboard runs its tools from its own
# directory, and the state file the next --resume needs would have been written
# over there.
LOGS_DIR = Path(__file__).resolve().parent / "logs"


def _state_path(csv_path: str, suffix: str = "") -> Path:
    return LOGS_DIR / f"state_{Path(csv_path).stem}{suffix}.json"


def _read_state(csv_path: str, suffix: str = "") -> dict:
    sp = _state_path(csv_path, suffix)
    if sp.exists():
        try:
            data = json.loads(sp.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            return {}
    return {}


def load_state(csv_path: str, suffix: str = "") -> set[str]:
    """Links with nothing left to do: hearted to the target, or capped, or ours
    is not on them."""
    return set(_read_state(csv_path, suffix).get("processed") or [])


def load_visited(csv_path: str, suffix: str = "") -> set[str]:
    """Links a previous run OPENED, whether or not it finished them.

    This is where --resume picks up. It is written for every video as it is
    logged, so a run killed halfway down the list still leaves a usable mark on
    the videos it worked but did not manage to top. A state file written before
    this existed has no such list, which reads as "nothing visited" and makes
    --resume fall back to the finished list — the old behaviour, not a crash.
    """
    return set(_read_state(csv_path, suffix).get("visited") or [])


def save_state(csv_path: str, processed: set[str], suffix: str = "",
               visited: set[str] | None = None):
    sp = _state_path(csv_path, suffix)
    sp.parent.mkdir(parents=True, exist_ok=True)
    # A caller that does not track a visited list (Freer marks every link done,
    # so for it the two are the same thing) must not wipe one that is already
    # there, or a --resume after a `--service both` run would lose its place.
    keep = set(_read_state(csv_path, suffix).get("visited") or [])
    sp.write_text(
        json.dumps({
            "processed": sorted(processed),
            "visited": sorted(visited if visited is not None else keep | processed),
            "updated": datetime.now(timezone.utc).isoformat(),
        }, indent=2),
        encoding="utf-8",
    )


# ── two runs, one list ──────────────────────────────────────────────────────
# The PC's browser and the phone's can work the same links at the same time. They
# are separate processes, so "who is doing which link" has to live somewhere both
# can see: a claims file beside the state file.
#
# A claim is a LEASE, not a lock. It expires, and that is the point — if the
# phone is unplugged mid-link nobody is left holding it, and the PC picks it up
# once the lease runs out instead of leaving a gap in the list forever.
CLAIM_TTL = int(os.getenv("CLAIM_TTL", "900"))
# How many times a sharing run goes back over the list, and the pause before each
# look. One runner finishing its own copy of the list does not mean the list is
# finished: the other may have stopped halfway through a link.
SHARE_SWEEPS = int(os.getenv("SHARE_SWEEPS", "3"))
SHARE_SWEEP_WAIT = int(os.getenv("SHARE_SWEEP_WAIT", "60"))


def _claims_path(csv_path: str) -> Path:
    return LOGS_DIR / f"claims_{Path(csv_path).stem}.json"


def _lock_path(csv_path: str) -> Path:
    return LOGS_DIR / f"claims_{Path(csv_path).stem}.lock"


class _FileLock:
    """A lock two processes can agree on: whoever creates the file holds it.

    os.open with O_EXCL is atomic on every platform that matters here, which is
    the whole requirement — these are two Python processes on one machine, not a
    distributed system. A lock older than a minute is treated as abandoned,
    because a run that is killed mid-write must not stop the other one for good.
    """

    def __init__(self, path: Path, timeout: float = 10):
        self.path = path
        self.timeout = timeout
        self.fd = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        start = time.time()
        while True:
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_RDWR)
                return self
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > 60:
                        self.path.unlink(missing_ok=True)
                        continue
                except OSError:
                    pass
                if time.time() - start > self.timeout:
                    # Better to double-work one link than to stop.
                    return self
                time.sleep(0.05)

    def __exit__(self, *exc):
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        self.path.unlink(missing_ok=True)
        return False


def _read_claims(csv_path: str) -> dict:
    try:
        return json.loads(_claims_path(csv_path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - a half-written file is not worth a crash
        return {}


def claim_link(csv_path: str, url: str, owner: str) -> bool:
    """Take this link, unless somebody else is already on it.

    Returns False when another runner holds a lease that has not expired. Stale
    leases are cleared on the way past, so the file does not grow forever and a
    runner that died does not keep its links.
    """
    now = time.time()
    with _FileLock(_lock_path(csv_path)):
        claims = _read_claims(csv_path)
        live = {u: c for u, c in claims.items()
                if isinstance(c, dict) and now - float(c.get("at") or 0) < CLAIM_TTL}
        held = live.get(url)
        if held and held.get("by") != owner:
            return False
        live[url] = {"by": owner, "at": now}
        try:
            _claims_path(csv_path).write_text(json.dumps(live), encoding="utf-8")
        except OSError:
            return True       # unwritable claims are not a reason to stop working
    return True


def release_link(csv_path: str, url: str, owner: str) -> None:
    """Done with it. Dropped so the file stays the size of the work in flight."""
    with _FileLock(_lock_path(csv_path)):
        claims = _read_claims(csv_path)
        if claims.pop(url, None) is not None:
            try:
                _claims_path(csv_path).write_text(json.dumps(claims), encoding="utf-8")
            except OSError:
                pass


def runner_name() -> str:
    """Who this process is, in the claims file and in the log."""
    where = "phone" if CDP_URL else "pc"
    return f"{where}-{os.getpid()}"


def clear_state(csv_path: str) -> list[Path]:
    """Forget a source entirely. Returns what was actually removed."""
    gone = []
    for suffix in ("", "_freer"):
        sp = _state_path(csv_path, suffix)
        if sp.exists():
            sp.unlink()
            gone.append(sp)
    # The claims describe work in flight on THIS list; forgetting the list and
    # keeping them would leave links held by a run that no longer exists.
    for extra in (_claims_path(csv_path), _lock_path(csv_path)):
        if extra.exists():
            extra.unlink()
            gone.append(extra)
    return gone


def _load_plain_links(path: Path) -> list[dict]:
    """One URL per line, for a file that is just a list of links.

    A CSV from the scraper carries the video's like count, which the heart cap
    needs; a hand-made list carries nothing, so like_count is 0. That is honest
    rather than convenient: with --to-top the target comes from the other
    comments on the video, so a missing like count costs nothing there.
    """
    urls = []
    seen = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.search(r"https?://[^\s,\"\']+", line)
        if not m:
            continue
        u = m.group(0).rstrip(".,;)")
        if "tiktok.com" not in u or u in seen:
            continue
        seen.add(u)
        urls.append({"url": u, "like_count": 0, "search_rank": 0,
                     "posted_date": "", "scraped_at": ""})
    print(f"[*] Loaded {len(urls)} URL(s) from the link list '{path}'")
    return urls


def load_urls(csv_path: str) -> list[dict]:
    """Return list of {"url", "like_count", "search_rank", "posted_date", "scraped_at"} dicts.

    Takes the scraper's CSV, or a plain list of links — one URL per line, which
    is what you have when somebody sends you a handful of videos to push.
    """
    path = Path(csv_path)
    if not path.exists():
        print(f"[!] File not found: {csv_path}")
        sys.exit(1)
    # A CSV is recognised by having a `url` column, not by its extension: a .txt
    # of links and a .csv with no header are the same thing to everyone but the
    # DictReader.
    try:
        with open(path, newline="", encoding="utf-8") as f:
            header = (f.readline() or "").lower()
    except OSError:
        header = ""
    fields = [c.strip().strip('"').lower() for c in header.split(",")]
    if "url" not in fields:
        return _load_plain_links(path)
    urls = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            url = row.get("url", "").strip()
            if url.startswith("https://www.tiktok.com"):
                try:
                    like_count = int(row.get("like_count", "0") or "0")
                except ValueError:
                    like_count = 0
                try:
                    search_rank = int(row.get("search_rank", "0") or "0")
                except ValueError:
                    search_rank = 0
                urls.append({
                    "url":         url,
                    "like_count":  like_count,
                    "search_rank": search_rank,
                    "posted_date": (row.get("posted_date", "") or "").strip(),
                    "scraped_at":  (row.get("scraped_at", "") or "").strip(),
                })
    print(f"[*] Loaded {len(urls)} URLs from '{csv_path}'")
    return urls


_UNIT_MS = {
    "s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000,
    "w": 604_800_000, "mo": 2_629_800_000, "y": 31_557_600_000,
    "second": 1_000, "minute": 60_000, "hour": 3_600_000, "day": 86_400_000,
    "week": 604_800_000, "month": 2_629_800_000, "year": 31_557_600_000,
}


def parse_posted_date(raw: str, scraped_at: str) -> float | None:
    """Normalise a scraped posted_date into an epoch-ms timestamp, or None if it
    can't be parsed. Mirrors the dashboard's parsePostedDate: relative words
    ("3 days ago"), abbreviations ("16h ago", "2d ago", "1w ago"), and absolute
    dates. Relative dates are resolved against scraped_at. Larger = more recent."""
    if not raw:
        return None
    s = raw.strip().lower()

    base = None
    if scraped_at:
        try:
            base = datetime.fromisoformat(scraped_at.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            base = None
    if base is None:
        base = time.time() * 1000

    if s in ("just now", "today"):
        return base
    if s == "yesterday":
        return base - 86_400_000

    m = re.match(r"(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago", s)
    if m:
        return base - int(m.group(1)) * _UNIT_MS.get(m.group(2), 0)

    # Abbreviated relative (TikTok): "16h ago", "2d ago", "3mo ago". 'mo' before 'm'.
    m = re.match(r"^(\d+)\s*(mo|s|m|h|d|w|y)\s*ago$", s)
    if m:
        return base - int(m.group(1)) * _UNIT_MS.get(m.group(2), 0)

    # YYYY-M-D or YYYY/M/D
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$", s)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                            tzinfo=timezone.utc).timestamp() * 1000
        except ValueError:
            return None

    # M-D or M/D (year-less) → assume scrape year, roll back one year if future.
    m = re.match(r"^(\d{1,2})[-/](\d{1,2})$", s)
    if m:
        y = datetime.fromtimestamp(base / 1000, tz=timezone.utc).year
        for yr in (y, y - 1):
            try:
                t = datetime(yr, int(m.group(1)), int(m.group(2)),
                             tzinfo=timezone.utc).timestamp() * 1000
            except ValueError:
                return None
            if t <= base + 86_400_000:
                return t
        return t

    try:
        return datetime.fromisoformat(raw.strip().replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def _cluster_tag(entry: dict) -> str:
    """Short '[rank C#a · date C#b]' label showing which clusters a link is in."""
    rc = entry.get("rank_cluster")
    dc = entry.get("date_cluster")
    if rc is None and dc is None:
        return ""
    picked = entry.get("picked_by", "")
    r = f"rank C{rc}" + ("*" if picked == "rank" else "")
    d = f"date C{dc}" + ("*" if picked == "date" else "")
    return f"[{r} | {d}]"


def cluster_and_order(urls: list[dict], n_clusters: int = 10, max_cluster: int = 0) -> list[dict]:
    """Re-order TikTok links to build processing priority.

    Splits the links two ways:
      • by search rank  (ascending — rank 1 is the top search result)
      • by posted date  (newest first)
    into `n_clusters` contiguous clusters each. Then interleaves them:
      rank-cluster 1, date-cluster 1, rank-cluster 2, date-cluster 2, …
    A link already emitted by an earlier cluster is skipped, so each link is
    processed exactly once — but the rank/date interleave decides *when*.

    If `max_cluster` > 0, only links reached by the first `max_cluster`
    interleaved pairs are returned; links in later clusters are dropped entirely
    so they are never processed.
    """
    if len(urls) <= 1:
        return list(urls)

    n = min(n_clusters, len(urls))

    def chunk(sorted_items: list[dict]) -> list[list[dict]]:
        # Split into n contiguous, as-even-as-possible clusters.
        total = len(sorted_items)
        clusters, start = [], 0
        for i in range(n):
            size = (total - start) // (n - i)
            clusters.append(sorted_items[start:start + size])
            start += size
        return clusters

    # Rank clusters: lowest search_rank first (0 = unknown → treat as worst).
    by_rank = sorted(urls, key=lambda e: (e["search_rank"] <= 0, e["search_rank"]))
    rank_clusters = chunk(by_rank)
    for ci, cluster in enumerate(rank_clusters, 1):
        for e in cluster:
            e["rank_cluster"] = ci

    # Date clusters: newest first; links with no parseable date sort last.
    def recency(e: dict) -> float:
        ts = parse_posted_date(e.get("posted_date", ""), e.get("scraped_at", ""))
        return ts if ts is not None else float("-inf")
    by_date = sorted(urls, key=recency, reverse=True)
    date_clusters = chunk(by_date)
    for ci, cluster in enumerate(date_clusters, 1):
        for e in cluster:
            e["date_cluster"] = ci

    ordered, seen = [], set()

    def emit(cluster: list[dict], source: str):
        for e in cluster:
            if e["url"] not in seen:
                seen.add(e["url"])
                e["picked_by"] = source   # which cluster caused this link to be queued
                ordered.append(e)

    # Cap to the first `max_cluster` interleaved pairs when a limit is set.
    limit = n if max_cluster <= 0 else min(max_cluster, n)

    for i in range(limit):
        emit(rank_clusters[i], "rank")   # finish the i-th search-rank cluster first
        emit(date_clusters[i], "date")   # then the i-th posted-date cluster (leftovers)

    # Safety net (only when unlimited): keep anything somehow missed at the end.
    # When a cluster limit is active we intentionally drop links beyond it.
    if max_cluster <= 0:
        emit(urls, "extra")

    if limit < n:
        dropped = len(urls) - len(ordered)
        print(f"[*] Priority order: clusters 1-{limit} of {n} (MAX_CLUSTER={max_cluster}); "
              f"{len(ordered)} links kept, {dropped} in later clusters skipped")
    else:
        print(f"[*] Priority order: {n} rank clusters interleaved with {n} posted-date clusters")
    for i in range(limit):
        rc = sum(1 for e in ordered if e.get("picked_by") == "rank"  and e.get("rank_cluster") == i + 1)
        dc = sum(1 for e in ordered if e.get("picked_by") == "date"  and e.get("date_cluster") == i + 1)
        print(f"    cluster {i + 1:>2}: {rc:>4} from rank + {dc:>4} new from date")
    return ordered


# Thread-local storage: each worker stores its display prefix here so helpers
# like freer_wait_captcha can identify which browser window is speaking.
_tl = threading.local()

def _pfx() -> str:
    """Return the current worker's prefix (e.g. '[Freer-W3]'), or '' in single-window mode."""
    return getattr(_tl, "prefix", "")


LOG_FIELDS = [
    "url", "video_like_count",
    "comment_keyword", "comment_text", "comment_hearts", "hearts_sent",
    # --to-top only: the best comment that is not ours, how far behind we still
    # are, and whether the comment now leads. Blank on a Freer row and on a run
    # that is aiming at the share-of-likes threshold instead.
    "rival_hearts", "short_of_lead", "is_top", "capped",
    "service", "status", "note", "timestamp",
]
NO_COMMENT_LOG_FIELDS = LOG_FIELDS + ["all_comments"]


class RealTimeLog:
    """Opens a CSV log file and flushes each row to disk immediately after it is written.
    Thread-safe: multiple worker threads may call write() concurrently."""

    def __init__(self, path: str, fieldnames: list[str] | None = None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = open(self.path, "w", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(
            self._file, fieldnames=fieldnames or LOG_FIELDS, extrasaction="ignore"
        )
        self._writer.writeheader()
        self._file.flush()
        self._lock = threading.Lock()
        print(f"[+] Log file: '{self.path}'")

    def write(self, row: dict):
        with self._lock:
            self._writer.writerow(row)
            self._file.flush()

    def close(self):
        self._file.close()


# ── RUNNING IT ON THE PHONE ──────────────────────────────────────────────────
#
# Chrome on Android publishes a DevTools socket whenever USB debugging is on, and
# Playwright attaches to any DevTools endpoint. So the phone's own browser can be
# driven from here over the cable:
#
#     adb forward tcp:9222 localabstract:chrome_devtools_remote
#     python automate.py --cdp http://127.0.0.1:9222 ...
#
# Playwright's own Android API does not exist in this version — there is no
# `playwright.android` and no android module in the package — and that is what
# made this look impossible. connect_over_cdp does not need it.
#
# WHAT IS DIFFERENT when attached rather than launched. The browser is the
# phone's: its session, its cookies, its IP, its screen. Nothing may be launched,
# closed or re-sized from here, and the context already exists — so the viewport
# and user-agent settings below do not apply, and closing the "browser" only
# detaches. A tab must already be open; Chrome publishes nothing without one.
CDP_URL = ""


ADB_HINT = ("re-run\n  adb forward tcp:9222 localabstract:chrome_devtools_remote\n"
            "and check 'adb devices' lists the phone")

# SET ONCE, READ BY THE LOOP. A browser that is gone is the one failure no retry
# can help, and --loop would otherwise re-ask the dashboard for 1,500 links,
# clear the record and fail again every 60 seconds until somebody notices.
BROWSER_FATAL: list[str] = []


def cdp_alive(url: str, timeout: float = 4.0) -> tuple[bool, str]:
    """Is there a DevTools endpoint behind this URL right now?

    Asked BEFORE the first window opens. The failure it catches — a dropped adb
    forward — is invisible until Playwright tries to connect, and by then the run
    has already fetched the whole link list and started a pass.
    """
    try:
        r = _requests.get(url.rstrip("/") + "/json/version", timeout=timeout)
        if r.status_code != 200:
            return False, f"{url} answered HTTP {r.status_code}"
        return True, str(r.json().get("Browser", "")) or "connected"
    except Exception as e:  # noqa: BLE001 - any failure here means "not reachable"
        # The real exception is four lines of urllib3 wrapping one fact. Said in
        # the words that match what has to be done about it.
        msg = str(e).lower()
        if "refused" in msg or "10061" in msg:
            return False, "nothing is listening there - the adb forward is gone"
        if "timed out" in msg or "timeout" in msg:
            return False, "it accepted the connection but never answered"
        return False, str(e).splitlines()[0][:160]


def adb_bin() -> str:
    """Where adb is. ADB_PATH wins, then PATH, then the usual SDK spot."""
    env = os.getenv("ADB_PATH", "").strip()
    if env:
        return env
    found = shutil.which("adb")
    if found:
        return found
    sdk = Path(os.getenv("LOCALAPPDATA", "")) / "Android" / "Sdk" / "platform-tools" / "adb.exe"
    return str(sdk) if sdk.exists() else "adb"


# WHICH PORT ADB'S OWN SERVER LISTENS ON, and why that is a setting at all.
#
# adb talks to a background server of its own on TCP 5037, and it does not check
# who answers: if ANOTHER program is already holding that port, every adb
# command dies with
#
#   * daemon not running; starting now at tcp:5037
#   could not read ok from ADB Server
#   * failed to start daemon
#   adb.exe: failed to check server version: cannot connect to daemon
#
# which names neither the port nor the program. On this machine the program is
# ASUS Armoury Crate (ArmouryCrate.UserSessionHelper), which binds 5037 for its
# own purposes on ASUS laptops; Vysor, BlueStacks, Nox and a few phone-manager
# suites do the same thing. Nothing about the phone is wrong, and no amount of
# reconnecting or restarting Chrome can help, because adb never ran.
#
# So the port is a setting, and a hijacked one is detected and stepped around
# rather than fought: a fallback server on 5038 works exactly as well, needs no
# administrator and leaves whatever took 5037 alone.
_ADB_PORT = int(os.getenv("ADB_SERVER_PORT", "5037") or 5037)
_ADB_FALLBACK_PORT = int(os.getenv("ADB_SERVER_PORT_FALLBACK", "5038") or 5038)
# Set once the fallback has been taken, so the rest of the process keeps talking
# to the same server instead of re-discovering the problem on every call.
_adb_port_moved = False

# What adb prints when something that is not adb answers on its port.
_ADB_PORT_TAKEN = (
    "could not read ok from adb server",
    "failed to check server version",
    "cannot connect to daemon",
)


def _port_owner(port: int) -> str:
    """The program holding a local port, for an error that can be acted on.

    Best effort and Windows-shaped; an empty string everywhere it cannot tell.
    A message that says "something has port 5037" sends somebody looking; one
    that says "ArmouryCrate.UserSessionHelper has port 5037" is finished.
    """
    try:
        r = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10)
        pid = ""
        for line in r.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[1].endswith(f":{port}"):
                pid = parts[-1]
                break
        if not pid.isdigit():
            return ""
        t = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
                           capture_output=True, text=True, timeout=10)
        name = t.stdout.strip().strip('"').split('","')[0]
        return name if name and "No tasks" not in name else ""
    except Exception:  # noqa: BLE001
        return ""


def adb_port() -> int:
    """The adb server port this process is using."""
    return _ADB_FALLBACK_PORT if _adb_port_moved else _ADB_PORT


def _adb(*args: str, timeout: float = 25) -> tuple[int, str]:
    # ADB_MDNS_OPENSCREEN=1 IS WHAT MAKES A WI-FI PHONE FINDABLE.
    #
    # adb ships two mDNS backends. The default one reports itself as
    # "adb discovery 0.0.0" on this machine and finds nothing at all:
    #
    #   > adb mdns services
    #   List of discovered mdns services
    #   (nothing)
    #
    # The Openscreen backend finds the phone on the first try, and adb then
    # connects to it by itself:
    #
    #   adb-RZ8T21TZJSL-LZWXEd  _adb-tls-connect._tcp  192.168.1.10:45327
    #
    # Same adb, same network, same phone. So it is set for every call rather
    # than left to whoever opened the terminal.
    global _adb_port_moved
    env = dict(os.environ)
    env.setdefault("ADB_MDNS_OPENSCREEN", "1")

    def run(port: int) -> tuple[int, str]:
        # -P for this client AND the variable for any adb a child process runs,
        # so the two cannot end up talking to two different servers.
        e = dict(env)
        e["ANDROID_ADB_SERVER_PORT"] = str(port)
        try:
            r = subprocess.run([adb_bin(), "-P", str(port), *args],
                               capture_output=True, text=True, timeout=timeout, env=e)
            return r.returncode, (r.stdout + r.stderr).strip()
        except FileNotFoundError:
            return 127, "adb not found - set ADB_PATH"
        except Exception as ex:  # noqa: BLE001
            return 1, str(ex)

    rc, out = run(adb_port())
    if rc == 0 or _adb_port_moved:
        return rc, out
    # A FAILURE THAT IS NOT ABOUT THE PHONE. Checked on the text rather than the
    # exit code, because adb exits non-zero for a dozen ordinary reasons and
    # only these lines mean "somebody else is on my port".
    low = out.lower()
    if not any(m in low for m in _ADB_PORT_TAKEN):
        return rc, out
    owner = _port_owner(_ADB_PORT)
    print(f"  [!] adb cannot use port {_ADB_PORT}"
          + (f" - {owner} is holding it" if owner else " - another program is holding it")
          + f". Starting adb's own server on {_ADB_FALLBACK_PORT} instead.")
    rc2, out2 = run(_ADB_FALLBACK_PORT)
    if rc2 == 0 or not any(m in out2.lower() for m in _ADB_PORT_TAKEN):
        _adb_port_moved = True
        return rc2, out2
    # Both ports refused. Say so with the whole of what adb said, which is the
    # only thing left that can be acted on.
    return rc, out


# Which browser is being driven on the phone. Only the package name differs for
# a different channel (com.chrome.beta, com.android.chrome for stable).
CHROME_PKG = os.getenv("CHROME_PACKAGE", "com.android.chrome")


def adb_discover() -> str:
    """A wireless phone's address, found by asking the network.

    Android advertises wireless debugging as _adb-tls-connect._tcp. Reading it
    off the phone's screen works too, but the port is renumbered every time
    wireless debugging is toggled — so the number somebody wrote down is usually
    the old one, and asking is more reliable than remembering.
    """
    rc, out = _adb("mdns", "services", timeout=15)
    for line in out.splitlines():
        if "_adb-tls-connect" not in line:
            continue
        addr = line.split()[-1].strip()
        if ":" in addr:
            return addr
    return ""


def adb_attached_detail() -> tuple[list[str], int, str]:
    """Device lines adb can see, plus what adb actually said.

    One subprocess for both. A caller that wants to explain an EMPTY list needs
    the raw text — "no phone" and "adb could not start at all" look identical
    from the list alone, and only one of them is about the phone.
    """
    rc, out = _adb("devices")
    lines = out.splitlines()
    try:
        start = next(i for i, l in enumerate(lines)
                     if l.strip().lower().startswith("list of devices")) + 1
    except StopIteration:
        start = 0
    devices = [l.strip() for l in lines[start:]
               if l.strip() and not l.strip().startswith("*")]
    return devices, rc, out


def adb_attached() -> list[str]:
    """Device lines adb can see, without its own daemon chatter."""
    return adb_attached_detail()[0]


def cdp_relink(tries: int = 6, every: float = 5) -> bool:
    """Put the phone's DevTools endpoint back, without anyone touching the phone.

    THE DEVICE DROPS OFF ADB BY ITSELF. Mid-run, with no warning and nothing
    wrong at the phone's end: `adb devices` lists nothing, the forward goes with
    it, and 127.0.0.1:9222 stops answering. `adb reconnect offline` followed by
    the forward brings it straight back — the same two commands a person would
    type, so the run types them instead of stopping and waiting to be noticed.

    What it cannot fix is a phone that is unplugged, off, or waiting for someone
    to accept a debugging prompt. Those end the run, which is the honest outcome.
    """
    if not CDP_URL:
        return False
    port = urlsplit(CDP_URL).port or 9222
    for attempt in range(tries):
        _adb("reconnect", "offline")
        # NOTHING TO RECONNECT TO IS NOT THE SAME AS NOTHING TO DO. A phone on
        # Wi-Fi is not "offline", it is undialled — so if adb can see no device
        # at all, ask the network for one and dial it.
        if not adb_attached():
            found = adb_discover()
            if found:
                rc, out = _adb("connect", found)
                print(f"[*] Found the phone on the network at {found} "
                      f"({out.splitlines()[0] if out else rc})")
        _adb("forward", f"tcp:{port}", "localabstract:chrome_devtools_remote")
        ok, detail = cdp_alive(CDP_URL)
        if ok:
            print(f"[*] Phone is back ({detail})")
            return True
        if attempt == 0:
            rc, out = _adb("devices")
            listed = [l for l in out.splitlines()[1:] if l.strip()]
            print(f"[*] Reconnecting the phone... (adb devices: "
                  f"{listed[0] if listed else 'nothing attached'})")
        # THE FORWARD CAN BE FINE AND THE SOCKET STILL GONE. Chrome opens
        # chrome_devtools_remote once, when the browser process starts, and never
        # again — so a Chrome that was running through the disconnect has no
        # socket for the forward to point at, and adb repeats itself forever
        # while 127.0.0.1:9222 answers nothing. Resuming the app is not enough
        # either: it has to be a cold start.
        if attempt == 1:
            print("[*] adb is connected but Chrome has no debugging socket – "
                  "restarting Chrome on the phone")
            _adb("shell", "am", "force-stop", CHROME_PKG)
            time.sleep(2)
            _adb("shell", "monkey", "-p", CHROME_PKG,
                 "-c", "android.intent.category.LAUNCHER", "1")
            time.sleep(6)
            _adb("forward", f"tcp:{port}", "localabstract:chrome_devtools_remote")
            ok, detail = cdp_alive(CDP_URL)
            if ok:
                print(f"[*] Phone is back ({detail}) – Chrome was restarted, so "
                      f"Zefoy will ask for a captcha")
                return True
            # THE RESTART DID NOT HELP, so now it is worth asking whether there
            # was anything to restart. force-stop and monkey both succeed
            # quietly against a package that is not installed, so a phone whose
            # Chrome has a different package name — or no Chrome at all —
            # reported "Chrome not reachable" for every remaining round and read
            # as a network fault. Asked HERE and not before it, because a
            # diagnosis that can refuse the repair is worse than no diagnosis.
            _warn_if_browser_missing()
        time.sleep(every)
    return False


def _warn_if_browser_missing() -> None:
    """Say so when CHROME_PACKAGE is not on the phone. Never raises, never acts.

    Only ever prints. It runs after a failed repair, where a wrong answer must
    not be able to stop anything — so an unreadable package list is simply not
    mentioned.
    """
    rc, out = _adb("shell", "pm", "list", "packages")
    lines = [l.strip() for l in (out or "").splitlines() if l.strip().startswith("package:")]
    if rc != 0 or not lines:
        return  # Nothing was read, so nothing is known.
    if any(CHROME_PKG in l for l in lines):
        return
    browsers = sorted(
        l.split(":", 1)[1].strip() for l in lines
        if any(b in l for b in ("chrome", "browser", "firefox", "opera", "brave", "edge"))
    )
    print(f"[!] {CHROME_PKG} is not installed on this phone, so there is no "
          f"Chrome to restart.")
    if browsers:
        print(f"    Browsers it does have: {', '.join(browsers[:6])}")
    print(f"    Set CHROME_PACKAGE to the one you want driven.")


def new_browser_page(playwright, proxy_url: str = ""):
    if CDP_URL:
        try:
            browser = playwright.chromium.connect_over_cdp(CDP_URL, timeout=30000)
        except Exception as e:  # noqa: BLE001
            # NOT A CRASH TO RETRY. ECONNREFUSED on 127.0.0.1:9222 means the
            # forward is gone, and no number of passes will bring it back.
            raise BrowserGone(f"cannot reach {CDP_URL} ({e}). Over --cdp, {ADB_HINT}") from e
        ctxs = browser.contexts
        if not ctxs:
            raise RuntimeError(
                f"{CDP_URL} answered but has no browser context. Open a tab in "
                "Chrome on the phone and try again.")
        context = ctxs[0]
        page = context.pages[0] if context.pages else context.new_page()
        return browser, context, page
    launch_kwargs = {"headless": False, "args": BROWSER_ARGS}
    if proxy_url:
        launch_kwargs["proxy"] = {"server": proxy_url}
    browser = playwright.chromium.launch(**launch_kwargs)
    context = browser.new_context(
        viewport={"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
        user_agent=USER_AGENT,
        locale="en-US",
    )
    return browser, context, context.new_page()


# ── Zefoy ─────────────────────────────────────────────────────────────────────

# Where captcha images are kept when the AI could not read them. Evidence, not
# housekeeping: a word the model gets wrong is only fixable by looking at the
# picture it was given, and after a run those pixels are gone forever.
CAPTCHA_DUMP = Path(__file__).parent / "captcha-dump"


def dump_captcha(img_bytes: bytes, tag: str = "miss") -> Path | None:
    """Save a captcha image under captcha-dump/. Never raises."""
    try:
        CAPTCHA_DUMP.mkdir(parents=True, exist_ok=True)
        out = CAPTCHA_DUMP / f"{tag}-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.png"
        out.write_bytes(img_bytes)
        return out
    except Exception:  # noqa: BLE001
        return None


# The instruction is deliberately about the SHAPE of the answer as much as the
# reading: a model told to describe a captcha writes a sentence about a captcha,
# and the submit box takes a word.
CAPTCHA_PROMPT = (
    "This is a captcha image containing one distorted word. "
    "Read the word. Reply with ONLY that word — lowercase letters, "
    "no spaces, no punctuation, no explanation. "
    "If you cannot read it, reply with the single word: unknown"
)


def page_hidden(page) -> bool:
    """Is this tab in the background — or the phone locked?

    CHROME DOES NOT PAINT A TAB NOBODY IS LOOKING AT. On Android that includes
    every tab while the device sits on its lock screen, and a page that is not
    painted never decodes the captcha image: wait_for_captcha_image is then
    correct and useless at the same time, and eight attempts go by while the
    answer is "unlock the phone".

    document.visibilityState says so in one word. Asked only when something has
    already gone wrong, so a hidden-but-working page costs nothing.
    """
    try:
        return page.evaluate("() => document.visibilityState") != "visible"
    except Exception:  # noqa: BLE001 - a page that cannot answer is a bigger problem
        return False


def wait_until_visible(page, seconds: float = 180, every: float = 5) -> bool:
    """Wait for somebody to bring the page to the front. True if they did.

    Spent instead of a captcha attempt: the eight tries are for pictures that are
    hard to read, and a hidden page has no picture to read. Three minutes is long
    enough to pick the phone up and short enough that an unattended run stops
    with an explanation rather than hanging on a prompt nobody can answer.
    """
    waited = 0.0
    while waited < seconds:
        page.wait_for_timeout(int(every * 1000))
        waited += every
        if not page_hidden(page):
            return True
    return False


def wait_for_captcha_image(page, timeout_ms: int = 12000) -> bool:
    """Wait until the captcha IMAGE has actually arrived, not just its element.

    THIS COST AN API CALL EVERY TIME IT WAS MISSING. #captcha-img is an <img>
    that is on the page, visible, and `complete === true` about a second and a
    half before it holds a picture: it carries a placeholder src first, and
    Zefoy swaps in the real one when the server answers. Screenshotting on
    visibility photographs a spinner reading "Loading…", and the model dutifully
    reports that it cannot see a word — a correct answer to the wrong picture,
    charged for and counted as a failed attempt.

    naturalWidth is the test. `complete` is true for the placeholder too, so it
    says nothing; a non-zero natural width means pixels have been decoded.

    Returns False on timeout rather than raising: a captcha that never renders
    is handled by the caller's retry, and refreshing is a better answer than
    ending the run.
    """
    try:
        page.wait_for_function(
            """(sel) => {
                const el = document.querySelector(sel)
                if (!el || !(el.naturalWidth > 0)) return false
                // AND NOT THE SPINNER. The <img> box is 278x129 while the
                // picture inside it is 160 wide, and until the picture arrives
                // Zefoy paints an <h6> reading "Loading..." across the middle of
                // that box. An element screenshot captures whatever is painted
                // there, so naturalWidth alone still photographed the spinner
                // about half the time. Hit-testing the centre is what tells them
                // apart: the heading while loading, the image wrapper after.
                const r = el.getBoundingClientRect()
                if (!(r.width > 0 && r.height > 0)) return false
                const hit = document.elementFromPoint(r.left + r.width / 2,
                                                      r.top + r.height / 2)
                if (!hit) return false
                if (/loading/i.test((hit.innerText || '').slice(0, 40))) return false
                return hit.tagName !== 'H6'
            }""",
            arg=_CAPTCHA_SEL,
            timeout=timeout_ms,
        )
        # One paint after the test passes, so the screenshot is of the frame the
        # test was describing rather than the one before it.
        page.wait_for_timeout(250)
        return True
    except Exception:  # noqa: BLE001
        return False


def _gemini_read_captcha(img_bytes: bytes, model: str = "") -> str:
    """Send a captcha image to Gemini and return the word it reads.

    Stripped to lowercase letters, because that is what the Zefoy box takes and
    a model will sometimes answer with "The word is: HOUSE." however it is asked.

    WHY THE ERROR HANDLING IS NOT ONE LINE. A refusal, a safety block or a bad
    model name all come back as HTTP 200 with no `candidates`, and reading
    through to the text blindly raised KeyError: 'candidates' — which told
    whoever was watching nothing at all, eight times in a row, before the run
    fell back to the terminal. The API puts a usable message in the body; this
    passes it on.
    """
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model or GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    payload = {
        "contents": [{
            "parts": [
                {"text": CAPTCHA_PROMPT},
                {"inline_data": {
                    "mime_type": "image/png",
                    "data": base64.b64encode(img_bytes).decode(),
                }},
            ]
        }],
        # One word, read off a picture. There is nothing for sampling to explore,
        # and a deterministic read is one that can be reproduced from the dump.
        #
        # THE CEILING IS NOT 16, though one word needs about two tokens. Newer
        # models spend tokens THINKING before they answer, and a tight ceiling is
        # spent entirely on that: gemini-3.5-flash came back with no text at all
        # and finishReason MAX_TOKENS, which reads as "the model cannot see the
        # picture" and is nothing of the kind. Room to think, and a budget of 0
        # asking it not to bother — ignored by models that have no such setting.
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": 512,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    r = _requests.post(url, json=payload, timeout=20)
    if r.status_code != 200:
        # Google's own message, which names the real problem — an invalid key, a
        # model that does not exist, a quota.
        try:
            err = r.json().get("error") or {}
            raise RuntimeError(
                f"Gemini HTTP {r.status_code}: {err.get('message') or r.text[:160]}"
            )
        except ValueError:
            raise RuntimeError(f"Gemini HTTP {r.status_code}: {r.text[:160]}")
    body = r.json()
    cands = body.get("candidates") or []
    if not cands:
        blocked = (body.get("promptFeedback") or {}).get("blockReason")
        raise RuntimeError(
            f"Gemini returned no answer"
            + (f" (blocked: {blocked})" if blocked else f": {str(body)[:160]}")
        )
    parts = ((cands[0].get("content") or {}).get("parts") or [])
    text = "".join(str(x.get("text") or "") for x in parts)
    if not text.strip():
        raise RuntimeError(
            f"Gemini returned an empty answer "
            f"(finishReason: {cands[0].get('finishReason') or 'none given'})"
        )
    word = re.sub(r"[^a-z]", "", text.lower().strip())
    # Its own way of saying it could not read the picture. Treated as a miss so
    # the attempt loop asks for a fresh captcha rather than submitting "unknown".
    return "" if word == "unknown" else word


def _captcha_refresh(page) -> None:
    """Ask Zefoy for a different captcha image. Never raises."""
    try:
        btn = page.locator(_CAPTCHA_REFRESH).first
        if btn.count() > 0:
            btn.click()
            page_wait(1.0, 1.8)
            return
    except Exception:  # noqa: BLE001
        pass
    # No refresh button to be found: reloading the page gets a new one too.
    try:
        page.reload(wait_until="domcontentloaded")
        page_wait(1.0, 1.8)
    except Exception:  # noqa: BLE001
        pass


def _captcha_submit_word(page, word: str, tag: str) -> bool:
    """Fill the captcha input with word, submit, and return True if solved."""
    page.locator(_CAPTCHA_INPUT).first.fill(word)
    page_wait(0.3, 0.6)
    page.locator(_CAPTCHA_SUBMIT).first.click()
    page_wait(1.5, 2.5)
    if page.locator(_CAPTCHA_ERR).is_visible(timeout=2000):
        print(f"{tag} [CAPTCHA] Wrong answer – refreshing image...")
        page.locator(f"{_CAPTCHA_ERR} button[data-dismiss]").first.click()
        page_wait(0.5, 1.0)
        page.locator(_CAPTCHA_REFRESH).first.click()
        page_wait(1.5, 2.5)
        return False
    if not page.locator(_CAPTCHA_SEL).is_visible(timeout=3000):
        return True
    return False


def zefoy_wait_captcha(page):
    """Solve the Zefoy image-word captcha.

    CAPTCHA_MODE=auto   → Gemini reads the image and submits (falls back to terminal on failure)
    CAPTCHA_MODE=manual → You type the word in the terminal; script submits for you
    """
    # ASKED FIRST, because a dead page answers "no captcha here" to everything.
    # Returning quietly on that would send the caller on to fill a URL box and
    # click Search on a browser that is not there, and the real cause would
    # surface three screens later as something else entirely.
    if browser_gone(page):
        raise BrowserGone(
            "the browser is not reachable. Over --cdp this is almost always "
            "the adb forward. Re-run it and check that adb devices lists the "
            "phone: adb forward tcp:9222 localabstract:chrome_devtools_remote")
    try:
        captcha_visible = page.locator(_CAPTCHA_SEL).is_visible(timeout=4000)
    except Exception as e:
        if browser_gone(page, e):
            raise BrowserGone("the browser went away while looking for the captcha") from e
        captcha_visible = False

    if not captcha_visible:
        return

    tag = _pfx()

    # ── Auto mode (Gemini) ────────────────────────────────────────────────────
    if CAPTCHA_MODE == "auto" and GEMINI_API_KEY:
        print(f"{tag} [AI] Captcha detected – solving with Gemini...")
        for attempt in range(8):
            # EIGHT TRIES AT A BROWSER THAT IS NOT THERE. When the connection
            # dies the page answers every question with "has been closed", which
            # read as "the captcha image never rendered" — eight times, and then
            # a prompt asking somebody to type a word into a window that cannot
            # be reached. Nothing below can mend a dead socket, so it stops here.
            if browser_gone(page):
                raise BrowserGone(
                    "the browser is no longer reachable. Over --cdp this is "
                    "almost always the adb forward: re-run\n"
                    "  adb forward tcp:9222 localabstract:chrome_devtools_remote\n"
                    "and check 'adb devices' lists the phone")
            try:
                # The picture, not the placeholder. See wait_for_captcha_image.
                if not wait_for_captcha_image(page):
                    if page_hidden(page):
                        # NOT A ZEFOY PROBLEM AND NOT A MODEL PROBLEM. Refreshing
                        # a tab that is not being painted produces another tab
                        # that is not being painted.
                        print(f"{tag} [AI] Attempt {attempt + 1}: the page is "
                              f"HIDDEN – nothing on it is being drawn"
                              + (", so the captcha image cannot arrive.\n"
                                 f"{tag}       Unlock the phone and bring Chrome "
                                 f"to the front (adb shell input keyevent 82, "
                                 f"then swipe up)." if CDP_URL else
                                 ", so the captcha image cannot arrive. Bring "
                                 "the browser window to the front."))
                        if not wait_until_visible(page):
                            raise BrowserGone(
                                "the page stayed hidden for three minutes. "
                                "Nothing can be read off a tab that is not being "
                                "drawn" + (" — unlock the phone and leave Chrome "
                                           "in the front." if CDP_URL else "."))
                        print(f"{tag} [AI] Page is visible again – carrying on")
                        continue
                    print(f"{tag} [AI] Attempt {attempt + 1}: captcha image never "
                          f"rendered – asking for another")
                    _captcha_refresh(page)
                    continue
                img_bytes = page.locator(_CAPTCHA_SEL).screenshot()
                word = _gemini_read_captcha(img_bytes)
                if not word:
                    # The model saying "I cannot read this". Another picture is
                    # a better answer than another look at the same one.
                    print(f"{tag} [AI] Attempt {attempt + 1}: unreadable – "
                          f"asking for another")
                    dump_captcha(img_bytes, "unreadable")
                    _captcha_refresh(page)
                    continue
                print(f"{tag} [AI] Attempt {attempt + 1}: '{word}'")
                if _captcha_submit_word(page, word, tag):
                    print(f"{tag} [AI] Captcha solved!")
                    page_wait(1.5, 2.5)
                    return
            except _requests.HTTPError as e:
                if e.response is not None and e.response.status_code == 429:
                    wait = min(30 * (attempt + 1), 120)
                    print(f"{tag} [AI] Rate limited – waiting {wait}s before retry...")
                    time.sleep(wait)
                else:
                    print(f"{tag} [AI] Attempt {attempt + 1} error: {e}")
                    page_wait(2, 4)
            except Exception as e:  # noqa: BLE001
                if browser_gone(page, e):
                    raise BrowserGone(
                        "the browser went away mid-captcha. Over --cdp this is "
                        "almost always the adb forward: re-run\n"
                        "  adb forward tcp:9222 localabstract:chrome_devtools_remote\n"
                        "and check 'adb devices' lists the phone") from e
                print(f"{tag} [AI] Attempt {attempt + 1} error: {e}")
                page_wait(1, 2)
        # Keep the last image. Eight failures with nothing kept is eight
        # failures nobody can do anything about.
        try:
            kept = dump_captcha(page.locator(_CAPTCHA_SEL).screenshot(), "ai-gaveup")
        except Exception:  # noqa: BLE001
            kept = None
        print(f"{tag} [!] AI solving failed – falling back to terminal input..."
              + (f" (image kept: {kept.name})" if kept else ""))

    # ── Manual / terminal mode ────────────────────────────────────────────────
    # Nobody can type a word into a window that is not there.
    if browser_gone(page):
        raise BrowserGone(
            "the browser is no longer reachable, so there is no captcha to type "
            "into. Over --cdp re-run the adb forward and check 'adb devices'")
    print(f"\n{'=' * 60}")
    if CAPTCHA_MODE == "manual" or not GEMINI_API_KEY:
        print(f"  {tag} [CAPTCHA] Look at the browser window and type the word")
        print(f"  {tag} shown in the captcha image below:")
    else:
        print(f"  {tag} [CAPTCHA] AI failed. Look at the browser window and type")
        print(f"  {tag} the captcha word:")
    print(f"{'=' * 60}")

    for attempt in range(10):
        try:
            word = input(f"  {tag} Captcha word (attempt {attempt + 1}): ").strip().lower()
        except EOFError:
            break
        if not word:
            continue
        if _captcha_submit_word(page, word, tag):
            print(f"{tag} [+] Captcha solved!")
            page_wait(1.5, 2.5)
            return

    raise RuntimeError("Zefoy captcha: too many failed attempts.")


# What Zefoy puts in the results panel when the session is over. It replaces
# the comment list in place — the page around it is untouched, the menu is still
# there, the URL does not change — so nothing but this text distinguishes it:
#
#   <div id="c2VuZC9mb2xsb3dlcnNfdGlrdG9r"><div style="...">Session expired.
#   Please re-login. <span><a href="/">CLICK HERE</a></span></div></div>
SESSION_GONE = ("session expired", "please re-login", "please re-login.")


class BrowserGone(RuntimeError):
    """The browser we were driving is no longer reachable.

    Its own class because it is the one failure that NOTHING in this file can
    recover from and every retry makes worse. Over --cdp it is the common one:
    the adb port-forward disappears whenever the device re-authorises or the
    daemon restarts, http://127.0.0.1:9222 stops pointing at anything, and every
    later call reports "Target page, context or browser has been closed".
    """


def browser_gone(page, err: Exception | None = None) -> bool:
    """Is the page/connection dead, as opposed to merely unhelpful?"""
    try:
        if page.is_closed():
            return True
    except Exception:  # noqa: BLE001 - asking a dead handle is itself the answer
        return True
    if err is not None:
        msg = str(err).lower()
        return ("has been closed" in msg or "target closed" in msg
                or "websocket" in msg or "connection closed" in msg)
    return False


def zefoy_session_expired(page) -> bool:
    """Return True if the session has expired.

    Two cases:
      - Zefoy shows 'Session expired. Please re-login.' inline, in the results
        panel, with the rest of the page looking perfectly normal
      - The captcha reappeared on the home page

    The text is matched on the WHOLE body rather than on the results div alone:
    the div's id is a base64 blob that Zefoy changes, so keying on it would work
    until the day it did not. Nothing else on the page says "session expired" —
    the Terms and Privacy modals are the only other long text, and neither
    mentions sessions.
    """
    try:
        if page.locator(_CAPTCHA_SEL).is_visible(timeout=1500):
            return True
    except Exception:
        pass
    try:
        body = page.inner_text("body").lower()
        if any(w in body for w in SESSION_GONE):
            return True
    except Exception:
        pass
    return False


def zefoy_login(page):
    """Full Zefoy login: open the site, wait for/solve the captcha (manual mode
    waits for you to type the word), then open the Comments Hearts panel. Used
    for BOTH the first login and re-login after a session expires, so the flow is
    identical each time."""
    tag = _pfx()
    print(f"{tag} Opening zefoy.com ...")
    page.goto("https://zefoy.com", wait_until="domcontentloaded", timeout=30000)
    # Wait for the login captcha OR the logged-in dashboard button to render,
    # so the captcha image/input is fully ready before we prompt you.
    try:
        page.wait_for_selector("#captchatoken, button.t-chearts-button", timeout=15000)
    except Exception:
        page_wait(3, 5)
    zefoy_wait_captcha(page)          # waits for you to solve the captcha
    page_wait(1.5, 2.5)               # let the dashboard render after the captcha
    zefoy_open_comments_hearts(page)  # clicks the "Comments Hearts" button


def zefoy_recover_session(page):
    """Re-login after the session expired — identical to the first login: solve
    the captcha, then click the Comments Hearts button. The caller then re-enters
    the current URL and continues the normal workflow."""
    tag = _pfx()
    print(f"\n{tag} [SESSION EXPIRED] Re-logging in — solve the captcha like the first time...")
    zefoy_login(page)
    print(f"{tag} [+] Session restored – retrying current URL...")


def zefoy_open_comments_hearts(page):
    """Click the Comments Hearts button and wait for the URL menu to appear.

    Retries, because right after a (re-)login Zefoy can show a post-login
    cooldown countdown before the dashboard's service buttons become usable —
    in that case we wait the cooldown out and try again."""
    ch_btn_sel = sel("comments_hearts_btn", _CH_BTN_SEL)
    url_input_sel = sel("url_input", _URL_INPUT_SEL)
    tag = _pfx()

    for attempt in range(1, 4):
        # 1. Wait for the button to render. If it doesn't, a cooldown may be
        #    blocking the dashboard — wait it out and retry.
        try:
            page.locator(ch_btn_sel).first.wait_for(state="visible", timeout=15000)
        except Exception:
            cd = zefoy_parse_cooldown(page)
            if cd:
                print(f"{tag} [!] Post-login cooldown – waiting {cd}s before opening Comments Hearts...")
                time.sleep(cd)
                page_wait(1, 2)
                continue
            print(f"{tag} [!] Comments Hearts button not visible (attempt {attempt})...")

        # 2. Click it (JS fallback if the normal click fails).
        try:
            page.locator(ch_btn_sel).first.click()
        except Exception:
            page.evaluate("""() => {
                const b = document.querySelector('button.t-chearts-button');
                if (b) b.click();
            }""")

        # 3. Confirm the URL input actually appeared.
        try:
            page.locator(url_input_sel).first.wait_for(state="visible", timeout=10000)
            print(f"{tag} [*] Comments Hearts section open.")
            return
        except PlaywrightTimeoutError:
            # Menu keeps class 'nonec' until clicked — try force-showing it.
            page.evaluate("""() => {
                const m = document.querySelector('.t-chearts-menu');
                if (m) m.classList.remove('nonec');
            }""")
            page_wait(1, 1.5)
            try:
                if page.locator(url_input_sel).first.is_visible():
                    print(f"{tag} [*] Comments Hearts menu force-shown.")
                    return
            except Exception:
                pass
            # Maybe a cooldown popped up after the click — wait and retry.
            cd = zefoy_parse_cooldown(page)
            if cd:
                print(f"{tag} [!] Cooldown after click – waiting {cd}s...")
                time.sleep(cd)
            print(f"{tag} [!] Comments Hearts didn't open (attempt {attempt}) – retrying...")
            page_wait(1, 2)

    print(f"{tag} [!] Could not open Comments Hearts after 3 attempts.")


def zefoy_parse_cooldown(page) -> int:
    """Return seconds to wait if Zefoy's cooldown timer is visible, else 0.

    Reads #login-countdown directly; falls back to full body scan.
    """
    try:
        # Primary: read the specific countdown element by ID
        el = page.locator("#login-countdown").first
        try:
            text = el.inner_text(timeout=2000)
        except Exception:
            text = page.inner_text("body")

        m = re.search(r'wait\s+(\d+)\s+minute[^\d]*(\d+)\s+second', text, re.IGNORECASE)
        if m:
            return int(m.group(1)) * 60 + int(m.group(2)) + 5
    except Exception:
        pass
    return 0


def _row_comment_text(row) -> str:
    try:
        return row.locator("span.text-dark.font-weight-bold").first.inner_text().strip()
    except Exception:
        return ""

def _row_comment_hearts(row) -> int:
    try:
        raw = row.locator("span.text-green.font-weight-bold").first.inner_text().strip()
        return int(raw.replace(",", ""))
    except Exception:
        return 0

def _row_comment_user(row) -> str:
    try:
        return row.locator(".kadi-rengi").first.inner_text().strip()
    except Exception:
        return ""

def _row_comment_date(row) -> str:
    try:
        return row.locator("span.text-muted").first.inner_text().strip()
    except Exception:
        return ""

def _find_comment_row(page, text: str):
    """The row for one comment on the page as it stands now, and its heart count.

    Re-found by TEXT rather than kept as a locator: submitting a batch re-renders
    the list, and an index that was right a moment ago can point at a different
    comment afterwards. Matching is normalised, so spacing and punctuation
    changes in the rendering do not lose the row.

    Returns (row, hearts) or (None, None).
    """
    want = norm(text)[:60]
    if not want:
        return None, None
    try:
        rows = page.locator(".t-chearts-menu .list-group-item").all()
    except Exception:  # noqa: BLE001
        return None, None
    for row in rows:
        try:
            if norm(_row_comment_text(row))[:60] == want:
                return row, _row_comment_hearts(row)
        except Exception:  # noqa: BLE001
            continue
    return None, None


def _locate_our_row(page, want_text: str, keyword: str, fallback_idx: int):
    """The row holding OUR comment, found the way _find_comment_row finds it.

    THIS IS THE ONE THAT WAS HEARTING STRANGERS.

    The scan records WHERE our comment sat — page 2, row 7 — and the heart was
    then sent to `.nth(7)` after paging back. An index is not an identity. One
    new comment arriving on that page between the scan and the heart shifts
    every row down by one, and row 7 is now somebody else's comment: the run
    reports a plausible text and heart count, sets the dropdown, sends the
    batch, and pushes a stranger up the section we are paying to win. Nothing in
    the log looks wrong, because every number it prints is read from the row it
    is about to heart.

    _find_comment_row already says this in its own docstring — "an index that
    was right a moment ago can point at a different comment afterwards" — and it
    was used for WATCHING the count, not for picking the row to click.

    So: by text first, and the recorded index only when the row standing there
    is still one of ours. Returns (row, index) or (None, None).
    """
    try:
        rows = page.locator(".t-chearts-menu .list-group-item").all()
    except Exception:  # noqa: BLE001
        return None, None
    want = norm(want_text)[:60]

    # 1. The comment itself, wherever it has moved to.
    if want:
        for i, row in enumerate(rows):
            try:
                if norm(_row_comment_text(row))[:60] == want:
                    return row, i
            except Exception:  # noqa: BLE001
                continue

    # 2. Where it used to be — but only if that row is still OURS. Covers a
    #    comment the page re-renders slightly differently (an emoji dropped,
    #    whitespace collapsed) without covering the case this function exists
    #    for.
    if 0 <= fallback_idx < len(rows) and keyword:
        try:
            if matches_keyword(_row_comment_text(rows[fallback_idx]), keyword):
                print(f"  [~] Our comment's text did not match exactly; row "
                      f"{fallback_idx} is still ours, using it")
                return rows[fallback_idx], fallback_idx
        except Exception:  # noqa: BLE001
            pass

    # 3. ANY comment of ours on this page. A different one of ours is still
    #    ours, and its own counts are re-read by the caller — which is worth
    #    more than skipping the video, and is the only remaining alternative to
    #    hearting somebody else.
    if keyword:
        for i, row in enumerate(rows):
            try:
                if matches_keyword(_row_comment_text(row), keyword):
                    print(f"  [~] The recorded row was no longer ours; hearting our "
                          f"comment at row {i} instead")
                    return row, i
            except Exception:  # noqa: BLE001
                continue
    return None, None


def watch_hearts(page, text: str, baseline: int, seconds: float,
                 want: int | None = None, verbose: bool = True) -> tuple[int, float]:
    """Read the comment's REAL heart count while Zefoy delivers the batch.

    WHY THIS EXISTS. The dropdown says 50 and 50 is not what arrives — the hearts
    trickle in over the next half minute and the total is routinely short. Every
    decision after a submit was being made against the number we ASKED for:
    whether the lead had been taken, whether another round was worth it, whether
    the threshold was spent. All three can be wrong in the same direction, which
    is the direction that keeps hearting a comment that is already ahead, or
    moves on from one that is not.

    The time was being spent anyway — Zefoy enforces a cooldown between submits —
    so it is spent watching the number instead of assuming it.

    Stops early when the target is reached (nothing more to learn) or when the
    count has stopped moving (the batch has landed). Returns (count, seconds
    spent), and the baseline unchanged if the row cannot be found at all.
    """
    if seconds <= 0:
        return baseline, 0.0
    started = time.time()
    last = baseline
    still = 0
    moved = False
    missing = 0
    while time.time() - started < seconds:
        time.sleep(min(HEART_WATCH_EVERY, max(0.5, seconds - (time.time() - started))))
        _row, hearts = _find_comment_row(page, text)
        if hearts is None:
            # The list re-rendered, or collapsed back to the video summary. Keep
            # looking for a few reads; a row that never comes back ends the watch
            # with what we last saw rather than with a zero.
            missing += 1
            if missing >= 3:
                if verbose:
                    print(f"  [~] Watch: the comment row went off screen; "
                          f"last seen at {last:,}")
                break
            continue
        missing = 0
        if hearts != last:
            if hearts > baseline:
                moved = True
            if verbose:
                print(f"  [*] Watch: {last:,} -> {hearts:,} hearts "
                      f"(+{hearts - baseline:,} so far, "
                      f"{int(time.time() - started)}s)")
            last = hearts
            still = 0
        else:
            still += 1
        if want is not None and last >= want:
            if verbose:
                print(f"  [*] Watch: target reached at {last:,} hearts")
            break
        # Three reads with no change, after something did change, means the batch
        # has finished arriving. Waiting out the rest of the budget would only
        # delay the next video.
        if moved and still >= 3:
            if verbose:
                print(f"  [*] Watch: settled at {last:,} hearts")
            break
    return last, time.time() - started


def _pager_labels(page) -> str:
    """What the pagination actually offers, for a failure that says it could not
    use it.

    A "could not return to page 1" with nothing else in it is a dead end: the
    pager might be a sliding window, might have been re-rendered under a
    different class, might not be there at all. One line of evidence turns the
    next occurrence into a diagnosis instead of another guess.
    """
    try:
        scoped = page.locator(".t-chearts-menu button.page-link").all_inner_texts()
    except Exception:  # noqa: BLE001
        scoped = ["<unreadable>"]
    try:
        loose = page.locator("button.page-link").all_inner_texts()
    except Exception:  # noqa: BLE001
        loose = ["<unreadable>"]
    def fmt(xs):
        xs = [x.strip() for x in xs][:12]
        return ", ".join(xs) if xs else "none"
    return f"in .t-chearts-menu: [{fmt(scoped)}]; anywhere: [{fmt(loose)}]"


def _zefoy_click_page(page, n: int) -> bool:
    """Click the pagination button labelled exactly `n`, if it is on screen.

    Exact-text match so "2" does not also hit "12" or "20".
    """
    try:
        btn = page.locator(".t-chearts-menu button.page-link").filter(
            has_text=re.compile(r"^\s*" + str(n) + r"\s*$")
        )
        if btn.count() == 0:
            return False
        btn.first.scroll_into_view_if_needed()
        btn.first.click()
        page_wait(1.5, 2.5)
        return True
    except Exception:
        return False


def _zefoy_goto_page(page, n: int, cur: int = 0) -> bool:
    """Get to comment page `n`, whatever the pager is currently showing.

    IT CANNOT ALWAYS JUMP. Zefoy's pager is a sliding window: standing on page 5
    the buttons read 3 4 5 6 7, and there is no "1" to click. Collecting comments
    across four pages and then going back for the one on page 1 therefore failed
    outright — "Could not return to the target comment page (1) to heart it" —
    and the video was abandoned with the heart never sent, on a page the run had
    already read.

    The neighbour is always inside the window, so when the direct click is not
    available this walks there one page at a time. `cur` is the page the caller
    believes is displayed; without it there is nothing to walk from.
    """
    if _zefoy_click_page(page, n):
        return True
    if not cur or cur == n:
        return False
    step = 1 if n > cur else -1
    while cur != n:
        cur += step
        if not _zefoy_click_page(page, cur):
            return False
    return True


def zefoy_process_url(page, video_url: str, video_like_count: int, keywords: list[str],
                     to_top: bool = False, margin: int = TOP_MARGIN,
                     watch_s: float = HEART_WATCH_SECONDS,
                     floor: float = HEART_FLOOR) -> dict:
    """Run the full Comments Hearts flow for one video URL.

    TWO WAYS TO DECIDE HOW MANY HEARTS TO SEND.

    The default aims at a SHARE OF THE VIDEO'S LIKES: send the largest batch that
    keeps the comment under HEART_THRESHOLD x video likes, and skip the comment
    once it is there. That is a plausibility rule — a comment with more hearts
    than the video has likes is a comment nobody believes.

    --to-top aims at THE OTHER COMMENTS instead: send what it takes to pass the
    best-liked comment on this video, by `margin`. That is the number that
    decides what a visitor actually reads, and it is a property of the comment
    section, not of the video. The scan already reads every comment's heart count
    on its way past, so the target costs nothing extra to compute.

    Zefoy hands out 25 or 50 hearts a submit, so passing a comment that is
    hundreds ahead takes several rounds with a cooldown between them. ONE submit
    happens here, and then the comment's REAL heart count is watched while the
    batch arrives — "50" is what the dropdown says, not what lands. Every answer
    this function gives afterwards is from the watched number.

    Returns a dict with: ok, note, comment_text, comment_hearts, hearts_sent,
    keyword_used, and — for --to-top — rival_hearts (the best other comment),
    deficit (how many more are needed) and is_top (nothing left to do).
    """
    url_input_sel  = sel("url_input",  _URL_INPUT_SEL)
    search_btn_sel = sel("search_btn", _SEARCH_BTN_SEL)
    count_btn_sel  = sel("count_btn",  _COUNT_BTN_SEL)

    # Every comment the scan sees on this video, as {user, text, hearts, date}.
    # Collected as a side effect of the heart scan and returned to run_zefoy so it
    # can be saved. `fail()` closes over this list so ALL exit paths carry it.
    collected: list[dict] = []
    collected_seen: set = set()

    # The best-liked comment that is NOT ours, filled in by the scan. Reported on
    # every exit path, including the failures: "we are 400 behind" is the single
    # most useful thing to know about a video we could not finish.
    rival = {"hearts": 0, "text": ""}

    def fail(note, comment_text="", comment_hearts=0, hearts_sent=0,
             no_comment=False, keyword_used="", all_comments="", deficit=0,
             capped=False, retryable=False):
        """One unsuccessful visit.

        no_comment IS AN OBSERVATION ABOUT THE VIDEO, NOT A WAY OF SAYING THE
        VISIT FAILED. It means "we read this video's comments and none of them
        are ours", which is final: the run records the link as done and writes
        the row into no_comment_*.csv, the file that exists for working out why a
        keyword is not matching.

        A service that did not answer — no count button, no comment list — tells
        us nothing about the video. Marking those done retired links the run had
        never actually read, and put rows in the keyword-debugging file that had
        no comments in them to debug.
        """
        return {"ok": False, "note": note,
                "comment_text": comment_text, "comment_hearts": comment_hearts,
                "hearts_sent": hearts_sent, "no_comment": no_comment,
                "keyword_used": keyword_used, "all_comments": all_comments,
                "comments_data": collected,
                "rival_hearts": rival["hearts"], "deficit": deficit,
                "is_top": False, "capped": capped, "retryable": retryable}

    try:
        # ── 1. Fill URL and click Search ──────────────────────────────────────
        #
        # THE PANEL CLOSES BY ITSELF. Zefoy drops back to its service menu —
        # Followers / Hearts / Comments Hearts / Views, every one of them a
        # button — and the URL box is simply not on the page any more. The
        # session is fine and the login is fine; the section is shut. Every link
        # after that failed with "Locator.wait_for: Timeout 10000ms exceeded",
        # which named the symptom and nothing else, and the run went on failing
        # one video at a time with nothing wrong that opening the panel would
        # not fix.
        url_input = page.locator(url_input_sel).first
        try:
            url_input.wait_for(state="visible", timeout=10000)
        except PlaywrightTimeoutError:
            if zefoy_session_expired(page):
                return fail("Session expired – will recover on retry")
            print(f"  {_pfx()} [*] Comments Hearts panel is closed – reopening")
            zefoy_open_comments_hearts(page)
            url_input = page.locator(url_input_sel).first
            try:
                url_input.wait_for(state="visible", timeout=10000)
            except PlaywrightTimeoutError:
                return fail("The Comments Hearts panel is closed and would not "
                            "reopen", retryable=True)
        url_input.fill(video_url)
        page_wait(0.5, 1.0)

        search_btn = page.locator(search_btn_sel).first
        search_btn.click()
        page_wait(2, 3)

        # ── 2. Handle cooldown (loop – Zefoy can issue a second timer) ──────
        for _ in range(3):
            cooldown = zefoy_parse_cooldown(page)
            if cooldown == 0:
                break
            print(f"  [!] Cooldown – waiting {cooldown}s...")
            time.sleep(cooldown)
            if zefoy_session_expired(page):
                return fail("Session expired during cooldown – will recover on retry")
            search_btn.click()
            page_wait(2, 3)

        # Quick session-expiry check before the 15s count-button wait
        if zefoy_session_expired(page):
            return fail("Session expired – will recover on retry")

        # ── 3. Click the dark comment-count button (e.g. "8,420") ─────────────
        count_btn = page.locator(count_btn_sel).first
        try:
            count_btn.wait_for(state="visible", timeout=15000)
        except PlaywrightTimeoutError:
            if zefoy_session_expired(page):
                return fail("Session expired – will recover on retry")
            # NOT no_comment: Zefoy did not answer, so nothing is known about
            # this video's comments. It stays pending for the next pass.
            return fail("Count button did not appear after Search")
        count_btn.click()
        page_wait(2, 3)

        # ── 4. Find target comment row ────────────────────────────────────────────
        # Try each keyword in order; use the first comment below threshold found.
        target_row    = None
        keyword_used  = ""
        used_threshold = HEART_THRESHOLD  # effective threshold for the chosen comment

        if keywords:
            found_any_global  = False
            all_comment_texts = []
            MAX_PAGES = 10
            scan_page = 1
            cur_page  = 1          # the page currently displayed
            target_loc = None      # (page, row_idx, keyword, threshold) — recorded once
            ours_loc: list[dict] = []   # every comment of ours, filled as we page
            others_behind = 0      # how many MORE of ours still need hearts

            # Navigate through EVERY comment page so all comments are collected.
            # We record the heart target's LOCATION (first eligible comment for the
            # highest-priority keyword, earliest page/row) rather than a live
            # locator, because we keep paging past it; we re-locate and heart it
            # afterwards.
            while scan_page <= MAX_PAGES:
                cur_page = scan_page
                rows = page.locator(".t-chearts-menu .list-group-item").all()

                # Read every comment on this page once (text + heart count).
                page_rows = []  # list of (row_idx, lowercased_text, hearts)
                for row_idx, row in enumerate(rows):
                    # Match ONLY against the comment text, not the whole row
                    # (which also contains the username/hearts/metadata).
                    try:
                        ctext = _row_comment_text(row)
                    except Exception:
                        ctext = ""
                    if ctext:
                        all_comment_texts.append(ctext)
                    try:
                        hearts = _row_comment_hearts(row)
                    except Exception:
                        hearts = 0
                    # Collect the full comment (user + text + likes + date) for saving.
                    cuser = _row_comment_user(row)
                    cdate = _row_comment_date(row)
                    ckey = (cuser, ctext)
                    if (cuser or ctext) and ckey not in collected_seen:
                        collected_seen.add(ckey)
                        collected.append({"user": cuser, "text": ctext, "hearts": hearts, "date": cdate})
                    page_rows.append((row_idx, ctext.lower(), hearts))

                # THE BEST COMMENT THAT IS NOT ONE OF OURS. Ours are excluded by
                # the same keyword test that picks the target, not by position:
                # two of our comments can sit on one video, and taking the
                # highest row as the rival would have us racing ourselves.
                for _idx, raw_text, hearts in page_rows:
                    if any(matches_keyword(raw_text, kw) for kw in keywords):
                        continue
                    if hearts > rival["hearts"]:
                        rival["hearts"] = hearts
                        rival["text"] = raw_text[:80]

                # EVERY COMMENT OF OURS ON THIS VIDEO, not just the first.
                #
                # A video often carries several, and once one of them is clear of
                # the strangers the hearts belong on the next one rather than on
                # the next video: two of our comments at the top of a section is
                # worth more than one of them further clear. The pick is made
                # after the whole scan, when every page has been read and the
                # best comment that is NOT ours is finally known.
                for kw in keywords:
                    for row_idx, row_text, hearts in page_rows:
                        # Normalised both sides, so "purify text" and
                        # "purifytext" are the same keyword. See norm().
                        if not matches_keyword(row_text, kw):
                            continue
                        found_any_global = True
                        ours_loc.append({
                            "page": scan_page, "row": row_idx, "keyword": kw,
                            "hearts": hearts, "text": row_text,
                        })
                        break   # one keyword per row; the first that matches owns it
                if target_loc is None:
                    # The share-of-video rule picks the first eligible comment by
                    # keyword priority, exactly as it always did.
                    for kw in keywords:
                        for row_idx, row_text, hearts in page_rows:
                            if not matches_keyword(row_text, kw):
                                continue
                            if to_top or choose_heart_count(
                                video_like_count, hearts, HEART_THRESHOLD
                            ) > 0:
                                # The TEXT travels with the position. The position
                                # on its own is what let a batch land on a stranger.
                                target_loc = (scan_page, row_idx, kw, HEART_THRESHOLD,
                                              row_text)
                                break
                        if target_loc is not None:
                            break

                # Always continue to the next page so every comment is collected.
                # Exact-text match so "2" doesn't also match "12", "20", etc.
                next_btn = page.locator(".t-chearts-menu button.page-link").filter(
                    has_text=re.compile(r"^\s*" + str(scan_page + 1) + r"\s*$")
                )
                if next_btn.count() == 0:
                    break
                try:
                    next_btn.first.scroll_into_view_if_needed()
                    next_btn.first.click()
                except Exception:
                    break
                scan_page += 1
                page_wait(1.5, 2.5)

            all_comments_str = " | ".join(all_comment_texts)

            # WHICH OF OURS TO WORK ON. Only under --to-top, where "done" is a
            # question about the other comments and so can be answered per
            # comment. One already clear of every stranger needs nothing; the
            # hearts go to the next of ours that is not.
            #
            # The rival is the same for all of them: the best comment that is not
            # ours. Aiming our second comment at our first would have them racing
            # each other up a section they already own.
            if to_top and ours_loc:
                behind = [o for o in ours_loc if o["hearts"] <= rival["hearts"]]
                leading = len(ours_loc) - len(behind)
                # The floor, in hearts. Unknown like counts give no floor, the
                # same convention the ceiling uses: a number we were not told
                # cannot be a rule.
                floor_at = (int(video_like_count * floor) if video_like_count > 0
                            and floor > 0 else 0)
                thin = [o for o in ours_loc
                        if floor_at and o["hearts"] < floor_at and o not in behind]
                if len(ours_loc) > 1:
                    print(f"  [*] {len(ours_loc)} comment(s) of ours here, "
                          f"{leading} already clear of the best stranger "
                          f"({rival['hearts']:,})")
                if thin:
                    print(f"  [*] {len(thin)} of them lead but sit under "
                          f"{floor_at:,} hearts, {floor:.0%} of this video's "
                          f"{video_like_count:,} likes — working those too")
                if not behind and not thin:
                    # THE NUMBERS, not just the verdict. This line followed a
                    # round that had just reported our comment on 15 hearts
                    # against a stranger on 57, and there was no way to tell from
                    # it whether the hearts had landed late or the scan had read
                    # the wrong row. A claim that cannot be checked is a claim
                    # nobody should act on.
                    mine = ", ".join(f"{o['hearts']:,}" for o in
                                     sorted(ours_loc, key=lambda o: -o["hearts"])[:4])
                    return {
                        "ok": True,
                        "note": (f"All {len(ours_loc)} of our comments already lead "
                                 f"— ours on {mine} vs best stranger "
                                 f"{rival['hearts']:,}"),
                        "comment_text": max(ours_loc, key=lambda o: o["hearts"])["text"][:200],
                        "comment_hearts": max(o["hearts"] for o in ours_loc),
                        "hearts_sent": 0, "keyword_used": "",
                        "comments_data": collected,
                        "rival_hearts": rival["hearts"], "deficit": 0,
                        "is_top": True, "capped": False,
                    }
                # The one closest to the line first: it buys a top spot for the
                # fewest hearts, and the rest of the budget then goes to the next.
                #
                # BEHIND BEFORE THIN. A comment a stranger is beating is losing
                # the section outright; one that leads but looks light is only
                # losing the second glance. Both get worked, in that order.
                queue = behind if behind else thin
                pick = max(queue, key=lambda o: o["hearts"])
                target_loc = (pick["page"], pick["row"], pick["keyword"],
                              HEART_THRESHOLD, pick["text"])
                # The others still to do, so finishing THIS one does not end the
                # video while another of ours is still under a stranger or still
                # under the floor.
                others_behind = len(behind) + len(thin) - 1

            if target_loc is None:
                kw_str = "', '".join(keywords)
                if not found_any_global:
                    return fail(
                        f"No matching comments for any keyword ('{kw_str}') – skipping",
                        no_comment=True, all_comments=all_comments_str,
                    )
                return fail(
                    f"All matching comments are at/above threshold "
                    f"(video likes: {video_like_count:,}, threshold: {HEART_THRESHOLD:.0%}) – skipping",
                    all_comments=all_comments_str,
                )

            # Return to the target comment's page (we likely paged past it while
            # collecting), then re-locate the row to heart it.
            target_page, target_idx, keyword_used, used_threshold, target_text = target_loc
            if cur_page != target_page and not _zefoy_goto_page(page, target_page,
                                                                 cur=cur_page):
                # NO PAGINATION AT ALL means the panel was replaced, not that
                # the page button was out of reach: the live evidence read
                # "in .t-chearts-menu: [none]; anywhere: [none]" on a video whose
                # comments had just been read across two pages. Nothing can be
                # navigated, so the answer is to read the video again rather than
                # to walk a pager that no longer exists.
                labels = _pager_labels(page)
                return fail(
                    f"Could not return to the target comment page ({target_page}) "
                    f"from page {cur_page} to heart it - pagination shows "
                    f"{labels}",
                    retryable="[none]; anywhere: [none]" in labels,
                    all_comments=all_comments_str,
                )
            target_row, _found_idx = _locate_our_row(page, target_text, keyword_used,
                                                     target_idx)
            if target_row is None:
                # None of our comments are on the page we came back to. The list
                # was read a moment ago and ours was on it, so something changed
                # under us — a re-render, a re-sort, an expired session. Reading
                # the video again is the answer; hearting whatever is standing in
                # that position is not.
                return fail(
                    "Our comment was gone from the page when it came time to heart it",
                    retryable=True, keyword_used=keyword_used,
                    all_comments=all_comments_str,
                )
        else:
            # No keyword configured → skip rather than hearting an unrelated
            # (first) comment. Set COMMENT_KEYWORD in .env or pass --keyword.
            return fail(
                "No COMMENT_KEYWORD set – skipping (set COMMENT_KEYWORD or --keyword to target comments)",
                no_comment=True,
            )

        # ── 5. Read comment details ───────────────────────────────────────────
        comment_text   = _row_comment_text(target_row)
        comment_hearts = _row_comment_hearts(target_row)

        # THE LIST CAN GO AWAY BETWEEN READING IT AND ACTING ON IT.
        #
        # Zefoy replaces the whole results panel with "Session expired. Please
        # re-login." the moment it decides the session is over, and that can land
        # in the seconds between the scan and the heart. Every number above was
        # read BEFORE that happened, so they survive in memory and the run reads
        # as though it were working: it reported a rival on 6,071 hearts, our
        # comment on 0, the comment text empty, and then spent five seconds
        # waiting for a dropdown on a row that no longer existed.
        #
        # An empty row is the symptom. The rows were read a moment ago and every
        # one of them had text; a target with none is a target that is gone.
        if not comment_text.strip():
            if zefoy_session_expired(page):
                return fail("Session expired while reading the comment – "
                            "will log in again and retry",
                            all_comments=all_comments_str)
            # WORTH ONE MORE LOOK. The list was read a moment ago and every row
            # had text; the target losing its text means the panel was replaced
            # under us, between the scan and the heart. A fresh visit re-reads
            # the whole thing, which is the only way to find out whether the
            # video was ever the problem.
            return fail("The comment list went away before the heart could be sent",
                        retryable=True,
                        all_comments=all_comments_str)

        # THE LAST THING CHECKED BEFORE ANY HEART IS SENT: that this comment is
        # ours. Everything above has already tried hard to make it so, and this
        # trusts none of it. A heart cannot be taken back, it pushes a stranger
        # up the section we are paying to win, and the cost of being wrong is
        # paid on somebody else's comment where nobody would ever look for it.
        # Refusing is free.
        if keyword_used and not matches_keyword(comment_text, keyword_used):
            return fail(
                f"Refusing to heart a comment that is not ours: the row holds "
                f"\"{comment_text[:120]}\", which does not contain "
                f"'{keyword_used}'",
                comment_text, comment_hearts, 0,
                keyword_used=keyword_used, retryable=True,
                all_comments=all_comments_str,
            )

        # ── 6. Choose heart quantity ──────────────────────────────────────────
        print(f"  [*] Comment ({keyword_used or 'any'}): \"{comment_text[:200]}\"")

        tie_break = False
        if to_top:
            # PASS THE BEST OTHER COMMENT, by `margin`. Nothing to do when we are
            # already there, and saying so is a result rather than a failure: it
            # is the goal, reached.
            # TWO TARGETS, AND THE FURTHER ONE WINS.
            #
            #   the lead  — pass the best stranger by `margin`
            #   the floor — carry at least `floor` of the video's own likes
            #
            # Passing a stranger on four hearts leaves our comment on seven under
            # a video with forty thousand likes, which is top of a section nobody
            # believes. The floor is what stops "leading" from meaning "thin".
            lead_at = rival["hearts"] + margin
            floor_at = (int(video_like_count * floor) if video_like_count > 0
                        and floor > 0 else 0)
            target_at = max(lead_at, floor_at)
            deficit = target_at - comment_hearts
            # AHEAD OR BEHIND, said in those words. "Leading comment now" was
            # printed for the best comment that is not ours whether or not it
            # actually led — so a video where ours had 12 hearts and the next
            # best had 1 announced a leader, then said ours was already top. Two
            # true statements that read as a contradiction, because the label
            # described the wrong thing.
            ahead = comment_hearts > rival["hearts"]
            print(f"  [*] Ours: {comment_hearts:,} hearts | best other comment: "
                  f"{rival['hearts']:,} | "
                  + (f"ahead by {comment_hearts - rival['hearts']:,}"
                     if ahead else f"need {max(0, deficit):,} more")
                  + f" (margin {margin})")
            # Said whenever the floor is the binding one, because otherwise a run
            # that keeps hearting a comment which is plainly winning looks broken.
            if floor_at > lead_at:
                print(f"  [*] Floor: {floor:.0%} of {video_like_count:,} likes is "
                      f"{floor_at:,} hearts"
                      + (f" — {deficit:,} short of it" if deficit > 0
                         else " — already carried"))
            if rival["text"]:
                print(f"  [*] {'Next best' if ahead else 'Ahead of us'}: "
                      f"\"{rival['text']}\"")
            if deficit <= 0:
                return {"ok": True, "note": (
                            f"Already the top comment: {comment_hearts:,} hearts "
                            f"vs {rival['hearts']:,}"),
                        "comment_text": comment_text, "comment_hearts": comment_hearts,
                        "hearts_sent": 0, "keyword_used": keyword_used,
                        "comments_data": collected,
                        "rival_hearts": rival["hearts"], "deficit": 0,
                        "is_top": True, "capped": False}

            # THE CEILING STILL APPLIES. Chasing the lead is the goal, and
            # HEART_THRESHOLD is the limit on what that goal may cost: a comment
            # carrying more hearts than the video it sits under is a comment
            # nobody believes, and winning the comment section that way loses the
            # thing the comment is for. So the gap is closed as far as the
            # threshold allows and no further — and when it does not allow
            # enough, that is said plainly rather than quietly overshot.
            #
            # An unknown like count (0) means no ceiling can be computed. Treated
            # as "no cap", the same convention choose_heart_count uses, because
            # refusing every video whose likes we were not told is worse than
            # the risk — but it is printed, so the choice is visible.
            room = None
            if video_like_count > 0:
                limit = int(video_like_count * used_threshold)
                room = limit - comment_hearts
                if room <= 0:
                    return fail(
                        f"At the HEART_THRESHOLD ceiling: {comment_hearts:,} hearts "
                        f"of {limit:,} allowed ({used_threshold:.0%} of "
                        f"{video_like_count:,} likes) – cannot chase "
                        f"{rival['hearts']:,} without passing it",
                        comment_text, comment_hearts, 0,
                        keyword_used=keyword_used, deficit=deficit, capped=True,
                    )
                if room < deficit:
                    print(f"  [~] Ceiling: only {room:,} more allowed "
                          f"({limit:,} = {used_threshold:.0%} of "
                          f"{video_like_count:,} likes), and the lead needs "
                          f"{deficit:,}")
            else:
                print("  [~] No like count for this video, so HEART_THRESHOLD "
                      "cannot be applied here.")

            allowed = deficit if room is None else min(deficit, room)
            smallest = min(_HEART_OPTIONS)
            # A TIE IS NOT A LEAD, AND IT IS THE ONE CASE WORTH OVERSHOOTING FOR.
            #
            # Level with the best stranger, the only thing between our comment
            # and the top of the section is the margin — three hearts — and the
            # smallest batch Zefoy sells is twenty-five. The ceiling then refuses
            # the whole thing and the video is left exactly as it was found:
            # tied, un-hearted, and recorded as "stopping 3 short of the lead".
            # That happened on a third of the videos in one run.
            #
            # So on a TIE, and only on a tie, a comment still under the ceiling
            # gets one batch and the run moves on to the next link. This does
            # overshoot HEART_THRESHOLD — on a video with twenty likes a batch of
            # twenty-five is conspicuous, which is what the threshold exists to
            # prevent — and it is a deliberate trade: the comment is already at
            # the top of what the section offers, so the hearts buy the position
            # rather than an unbelievable number.
            tie_break = (room is not None and allowed < smallest
                         and comment_hearts == rival["hearts"] and room > 0)
            if tie_break:
                print(f"  [*] Tied with the best other comment at "
                      f"{comment_hearts:,}, and {room:,} heart(s) of room under "
                      f"the ceiling — sending one batch of {smallest} to break "
                      f"the tie, then moving on")
                allowed = smallest
            elif room is not None and allowed < smallest:
                # Behind rather than level: the smallest batch Zefoy sells would
                # break the ceiling without even buying the lead. Sending it
                # anyway is the one thing the threshold exists to prevent.
                return fail(
                    f"Only {allowed:,} hearts left under the threshold and the "
                    f"smallest batch is {smallest} – stopping "
                    f"{deficit:,} short of the lead",
                    comment_text, comment_hearts, 0,
                    keyword_used=keyword_used, deficit=deficit, capped=True,
                )
            # One batch now; the caller comes back for the rest. Overshooting a
            # small deficit is unavoidable where there is no ceiling to overshoot
            # — the smallest batch is 25 — and being 20 clear of the rival is no
            # worse than being 3 clear.
            hearts_sent = allowed
        else:
            hearts_sent     = choose_heart_count(video_like_count, comment_hearts, used_threshold)
            threshold_limit = int(video_like_count * used_threshold)
            threshold_label = (f"{used_threshold:.0%}"
                               if used_threshold != HEART_THRESHOLD
                               else f"{used_threshold:.0%} (original)")
            print(f"  [*] Video likes: {video_like_count:,} | Comment hearts: {comment_hearts:,} "
                  f"| Threshold: {threshold_limit:,} ({threshold_label}) → "
                  f"sending {hearts_sent if hearts_sent else 'skip'}")

            if hearts_sent == 0:
                return fail(
                    f"Skipped – comment already has {comment_hearts:,} hearts "
                    f"(threshold: {threshold_limit:,} for {video_like_count:,}-like video)",
                    comment_text, comment_hearts, 0, keyword_used=keyword_used,
                )

        # ── 7. Set quantity dropdown and click heart button ───────────────────
        try:
            qty_sel = target_row.locator("select[name='select_lmt']").first
            qty_sel.wait_for(state="visible", timeout=5000)
            # Read enabled options only — the first <option> is a disabled placeholder
            # that also has value="25", so matching by value hits the wrong element.
            available = qty_sel.evaluate(
                "el => Array.from(el.options)"
                ".filter(o => !o.disabled)"
                ".map(o => parseInt(o.value))"
                ".filter(v => !isNaN(v))"
            )
            # ZEFOY SELLS 25 OR 50 A SUBMIT, and that is the whole of it: the
            # 75 and 100 options are in the page source, commented out.
            #
            #   <option value="25" disabled="">Select Limit</option>
            #   <option value="25">25</option>
            #   <option value="50">50</option>
            #   <!--<option value="75">75</option>
            #   <option value="100">100</option>-->
            #
            # So a comment that needs 313 to take the lead gets 50 now and the
            # rest over the following rounds. This used to be reported as "313
            # not available", which reads like something went wrong; nothing did,
            # and saying so sent people looking for a fault that is a price list.
            best = max((v for v in available if v <= hearts_sent), default=None)
            if best is None:
                best = min(available) if available else hearts_sent
                # Wanting fewer than the smallest batch: the overshoot is
                # unavoidable, and worth saying because it can pass a ceiling.
                print(f"  [~] Zefoy's smallest batch is {best}, "
                      f"more than the {hearts_sent} wanted — sending {best}")
            elif best != hearts_sent:
                print(f"  [~] Zefoy sends at most {max(available)} a submit: "
                      f"{best} now, {hearts_sent - best:,} of the {hearts_sent:,} "
                      f"left for the next round")
            hearts_sent = best
            # Select by label (visible text) to skip the disabled placeholder
            # which coincidentally shares value="25" with the real first option.
            qty_sel.select_option(label=str(best), timeout=5000)
            page_wait(0.3, 0.6)
        except Exception as e:
            print(f"  [!] Could not set quantity dropdown: {e} – using default")

        try:
            target_row.locator("button[type='submit']").first.click()
        except Exception as e:
            return fail(f"Could not click heart button: {e}",
                        comment_text, comment_hearts, hearts_sent)

        # ── 8. Wait for success confirmation ──────────────────────────────────
        submit_wait()
        result_text = page.inner_text("body").lower()

        # ── 9. Watch the REAL count arrive ────────────────────────────────────
        #
        # The hearts trickle in over the next half minute and the total is
        # routinely short of what the dropdown promised. Everything below is
        # decided from what actually landed: whether the lead has been taken,
        # whether another round is worth a cooldown, whether the threshold is
        # spent. The wait is enforced by Zefoy either way, so it costs nothing
        # to spend it reading rather than assuming.
        after = comment_hearts + hearts_sent   # the assumption, if we cannot watch
        watched = 0.0
        if to_top and watch_s > 0:
            after, watched = watch_hearts(
                page, comment_text, comment_hearts, watch_s,
                want=rival["hearts"] + margin,
            )
            landed = after - comment_hearts
            if watched <= 0 or after == comment_hearts:
                # COULD NOT READ IT IS NOT ZERO. The row goes off screen when the
                # list re-renders, and reporting that as "landed 0" states a
                # measurement that was never taken — then the next round decides
                # against it. Hearts that arrive after the watch gives up are
                # counted by the next scan, which is the honest place for them.
                print(f"  [*] Asked for {hearts_sent}; could not read the count "
                      f"(still showing {after:,}) — the next scan will say")
            elif landed != hearts_sent:
                print(f"  [*] Asked for {hearts_sent}, landed {landed:,} "
                      f"({after:,} hearts now)")

        left = max(0, rival["hearts"] + margin - after) if to_top else 0
        # Strictly ahead is the whole goal; the margin is a cushion on top of it,
        # not part of the test. A comment one clear of the rival IS the top
        # comment, and going back for another round to buy the cushion spends a
        # cooldown on a video that has already been won.
        #
        # BUT THE VIDEO IS NOT DONE while another comment of ours is still under
        # a stranger. is_top is what stops the rounds, so it has to mean "nothing
        # left to do here" rather than "this one is clear" — otherwise the second
        # comment on a video never gets a single heart.
        # CLEAR OF THE STRANGERS AND NOT THIN. A comment that passed the rival
        # but is still under the floor has more to do, and calling it done here
        # is how it would be skipped for good.
        floor_met = True
        if to_top and floor > 0 and video_like_count > 0:
            floor_met = after >= int(video_like_count * floor)
        now_top = (to_top and after > rival["hearts"] and others_behind == 0
                   and floor_met)
        # Will the NEXT round have anywhere to go? If the threshold is already
        # spent, there is no point coming back, and the caller is told so here
        # rather than discovering it on a second full scan.
        # A TIE BROKEN ABOVE IS ALSO FINISHED: the video has had what it was
        # going to get, and another round would spend a second batch on a comment
        # that is already clear. Carried in `capped`, which is what the caller
        # reads as "this video needs no more visits".
        spent = tie_break
        if not spent and to_top and left and video_like_count > 0:
            spent = (int(video_like_count * used_threshold) - after) < min(_HEART_OPTIONS)
        # "Clear of the strangers" and "this video is finished" are now two
        # different things, and the line says which one happened: a comment that
        # has taken the lead while another of ours is still behind leaves work on
        # the video, and reporting it as done would be the run congratulating
        # itself for half a job.
        this_one_clear = to_top and after > rival["hearts"]
        tail = (f" – now the top comment at {after:,} vs {rival['hearts']:,}" if now_top else
                f" – clear at {after:,}, now on to our other "
                f"{others_behind} comment(s) here" if this_one_clear else
                f" – at {after:,}, about {left:,} short, and the threshold is spent"
                if spent else
                f" – at {after:,}, about {left:,} short of the lead" if to_top else "")
        if "successfully sent" in result_text or "comment hearts" in result_text:
            return {"ok": True, "note": f"Sent {hearts_sent} hearts{tail}",
                    # The count AFTER the batch, because that is the fact the
                    # next decision rests on.
                    "comment_text": comment_text, "comment_hearts": after,
                    "hearts_sent": hearts_sent, "keyword_used": keyword_used,
                    "comments_data": collected,
                    "rival_hearts": rival["hearts"], "deficit": left,
                    "is_top": now_top, "capped": spent, "watched_s": watched}
        if "please wait" in result_text or "cooldown" in result_text:
            return fail("Cooldown after heart click", comment_text, comment_hearts, hearts_sent,
                        keyword_used=keyword_used, deficit=left)

        return {"ok": True, "note": f"Submitted {hearts_sent} hearts (success not explicitly confirmed){tail}",
                "comment_text": comment_text, "comment_hearts": after,
                "hearts_sent": hearts_sent, "keyword_used": keyword_used,
                "comments_data": collected,
                "rival_hearts": rival["hearts"], "deficit": left,
                "is_top": now_top, "capped": spent, "watched_s": watched}

    except PlaywrightTimeoutError as e:
        # A TIMEOUT ON A DEAD BROWSER IS NOT A SLOW PAGE. Waiting ten seconds for
        # an element on a connection that is gone looks exactly like Zefoy being
        # slow, and was recorded as this video's failure.
        if browser_gone(page, e):
            raise BrowserGone(f"the browser went away mid-visit ({e})") from e
        return fail(f"Timeout: {e}")
    except BrowserGone:
        # Already named. Let the worker decide whether to reconnect.
        raise
    except Exception as e:
        # THE ONE THAT ATE 1,416 LINKS. "Target page, context or browser has been
        # closed" was caught here and turned into an ordinary per-link failure,
        # so the queue kept feeding videos to a browser that no longer existed:
        # the whole list failed in a few minutes, the reconnect never ran because
        # nothing ever raised, and the run ended "3/1435 successful" with exit 0.
        if browser_gone(page, e):
            raise BrowserGone(f"the browser went away mid-visit ({e})") from e
        return fail(f"Error: {e}")


# Where the scraped comments (user/text/likes/date, keyed by video URL) are saved
# as the Zefoy heart run visits them. Override with COMMENTS_OUTPUT_FILE in .env.
COMMENTS_OUTPUT_FILE = os.getenv("COMMENTS_OUTPUT_FILE", "zefoy_comments.json")


def _save_comments_json(path: str, data: list):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:  # noqa: BLE001
        print(f"  [!] Could not save comments to {path}: {e}")


def run_zefoy(urls: list[dict], delay: float, keywords: list[str],
              log: RealTimeLog, no_comment_log: RealTimeLog,
              csv_path: str = "", n_workers: int = 1,
              to_top: bool = False, margin: int = TOP_MARGIN,
              rounds: int = TOP_ROUNDS,
              watch_s: float = HEART_WATCH_SECONDS,
              resume: bool = False,
              floor: float = HEART_FLOOR,
              share: bool = False) -> list[dict]:
    processed = load_state(csv_path) if csv_path else set()
    visited   = load_visited(csv_path) if csv_path else set()
    # DONE means there is nothing left to do for a link. VISITED means a previous
    # run reached it. Under --to-top those are different sets, and which one to
    # skip is the whole question --resume answers.
    skip      = (processed | visited) if resume else processed
    pending   = [e for e in urls if e["url"] not in skip]
    skipped   = len(urls) - len(pending)
    # Links the last run opened and left unfinished. Reported either way: with
    # --resume to say what is being stepped over, without it to say what is
    # being done again — and that there is a flag for the other choice.
    unfinished = len([e for e in urls
                      if e["url"] in visited and e["url"] not in processed])
    if skipped:
        line = (f"[Zefoy] Resuming – {skipped} of {len(urls)} link(s) skipped, "
                f"starting at #{skipped + 1}")
        if resume and unfinished:
            line += f" ({unfinished} visited but unfinished, skipped by --resume)"
        print(line)
    elif resume:
        print("[Zefoy] --resume: nothing recorded for this source yet, starting at #1")
    if not resume and unfinished:
        print(f"[Zefoy] {unfinished} link(s) the last run visited but did not finish "
              f"are being worked again — pass --resume to carry on past them")
    me = runner_name()
    # How many times a sharing run goes back over the list for links the other
    # runner never finished, and how long it waits between looks. The wait
    # matters: a link held by a runner that is still alive is not abandoned, it
    # is being worked, and sweeping in a tight loop would just re-read its claim.
    sweeps_left = [SHARE_SWEEPS if share else 0]
    if share:
        print(f"[Zefoy] Sharing this list with any other run on it - I am {me}. "
              f"Links are claimed one at a time, and a claim nobody renews is "
              f"picked up by the other run after {CLAIM_TTL // 60} minute(s).")
    if not pending:
        print("[Zefoy] Nothing left in this list. Run again with --fresh to start over:")
        print(f"        {_state_path(csv_path)}")
        return []

    url_queue  = Queue()
    for entry in pending:
        url_queue.put(entry)

    results    = []
    comments_out = []  # [{url, count, comments:[{user,text,hearts,date}]}], saved incrementally
    state_lock = threading.Lock()

    # Gate chain: each worker opens its browser only after the previous one has
    # solved its captcha. With automatic captchas we open all windows at once.
    start_gates = [threading.Event() for _ in range(n_workers)]
    if stagger_windows():
        start_gates[0].set()  # open one at a time; each opens the next after its captcha
    else:
        for g in start_gates:
            g.set()           # open all windows simultaneously
        if n_workers > 1:
            print(f"[Zefoy] Opening all {n_workers} windows at once.")

    def worker(worker_id: int):
        asyncio.set_event_loop(asyncio.new_event_loop())
        idx    = worker_id - 1
        prefix = f"[Zefoy-W{worker_id}]" if n_workers > 1 else "[Zefoy]"
        _tl.prefix = prefix
        signaled = [False]

        def signal_next():
            if not signaled[0] and idx + 1 < n_workers:
                print(f"{prefix} [*] Ready — opening next window...")
                start_gates[idx + 1].set()
                signaled[0] = True

        start_gates[idx].wait()

        proxy_url = PROXIES[idx % len(PROXIES)] if PROXIES else ""
        if proxy_url:
            print(f"{prefix} Using proxy: {proxy_url}")

        try:
            with sync_playwright() as p:
                # ONE SESSION PER ATTEMPT. A dropped phone is not a reason to
                # abandon 1,400 links: the queue still holds them, so the
                # browser is reopened, Zefoy is logged into again, and the
                # next link comes off the same queue. Bounded by CDP_RECOVER
                # so a phone that is really gone still ends the run.
                left = CDP_RECOVER
                while True:
                    try:
                        browser, context, page = new_browser_page(p, proxy_url)
                        zefoy_login(page)
                        signal_next()  # captcha solved → open the next window now (don't wait for a heart)

                        first_ok = False
                        while True:
                            try:
                                entry = url_queue.get_nowait()
                            except Empty:
                                # THE LIST IS NOT FINISHED JUST BECAUSE MY COPY OF
                                # IT IS. A runner that stopped mid-link left that
                                # link unfinished and its claim unrenewed, and
                                # walking the list once would leave a hole in it.
                                if share and csv_path and sweeps_left[0] > 0:
                                    sweeps_left[0] -= 1
                                    done = load_state(csv_path)
                                    again = [e for e in pending if e["url"] not in done]
                                    if again:
                                        print(f"\n{prefix} [*] {len(again)} link(s) still "
                                              f"unfinished — waiting {SHARE_SWEEP_WAIT}s in "
                                              f"case the other run is on them, then going "
                                              f"back for whatever it has let go")
                                        time.sleep(SHARE_SWEEP_WAIT)
                                        for e in again:
                                            url_queue.put(e)
                                        continue
                                break

                            url        = entry["url"]
                            like_count = entry["like_count"]
                            position   = len(pending) - url_queue.qsize()

                            # WHAT THE OTHER RUN HAS ALREADY DONE, AND WHAT IT IS
                            # DOING NOW. The pending list was built when this run
                            # started; by the time a link comes off the queue the
                            # other runner may have finished it, or be on it.
                            if share and csv_path:
                                if url in load_state(csv_path):
                                    print(f"{prefix} ({position}/{len(pending)}) "
                                          f"already done by the other run - skipping")
                                    continue
                                if not claim_link(csv_path, url, me):
                                    print(f"{prefix} ({position}/{len(pending)}) "
                                          f"the other run is on it - skipping")
                                    continue

                            print(f"\n{prefix} ({position}/{len(pending)}) {_cluster_tag(entry)} {url}")

                            if zefoy_session_expired(page):
                                zefoy_recover_session(page)

                            def once():
                                """One visit: scan, one heart batch, then watch it land."""
                                out = zefoy_process_url(page, url, like_count, keywords,
                                                        to_top=to_top, margin=margin,
                                                        watch_s=watch_s,
                                                        floor=floor)
                                if not out["ok"] and zefoy_session_expired(page):
                                    zefoy_recover_session(page)
                                    out = zefoy_process_url(page, url, like_count, keywords,
                                                            to_top=to_top, margin=margin,
                                                            watch_s=watch_s,
                                                            floor=floor)
                                elif not out["ok"] and out.get("retryable"):
                                    # ONE SECOND LOOK, not a loop: the panel was
                                    # swapped under the scan, and re-reading it is
                                    # the whole fix. If it happens twice the video
                                    # stays pending for the next pass anyway.
                                    print(f"  {prefix} {out['note']} – looking again")
                                    out = zefoy_process_url(page, url, like_count, keywords,
                                                            to_top=to_top, margin=margin,
                                                            watch_s=watch_s,
                                                            floor=floor)
                                return out

                            r = once()
                            # UNTIL IT LEADS, up to `rounds` visits. Zefoy sells 25 or 50
                            # hearts a submit, so a comment hundreds behind needs several
                            # — and each visit re-reads the live counts rather than
                            # assuming the last batch landed, because sometimes it does
                            # not. What this pass cannot finish, the next one continues:
                            # the video is left out of the state file below.
                            sent_total = r.get("hearts_sent", 0) or 0
                            if to_top and r["ok"] and not r.get("is_top") and not r.get("capped"):
                                for extra in range(2, max(1, rounds) + 1):
                                    # NO SELF-IMPOSED PAUSE. Zefoy meters this itself and
                                    # says so — "Cooldown – waiting 79s" is read off its
                                    # page and waited out a few lines later. Adding our
                                    # own seconds on top of a limit that is already
                                    # enforced only makes the run slower; it does not
                                    # make it safer, because the thing being paced is
                                    # already refusing us when it wants to.
                                    print(f"  {prefix} round {extra}/{rounds} on this video "
                                          f"({r.get('deficit', 0):,} short of the lead)…")
                                    if zefoy_session_expired(page):
                                        zefoy_recover_session(page)
                                    nxt = once()
                                    sent_total += nxt.get("hearts_sent", 0) or 0
                                    # Keep the LAST reading: it is the freshest picture of
                                    # where the comment stands, and it is what decides
                                    # whether this video is finished.
                                    r = nxt
                                    # CAPPED IS AS FINISHED AS TOP. More rounds cannot
                                    # send anything the threshold allows, and three more
                                    # full comment scans to prove it is three minutes the
                                    # rest of the list is waiting for.
                                    if r.get("is_top") or r.get("capped") or not r["ok"]:
                                        break
                                r = {**r, "hearts_sent": sent_total}

                            # Release next window once this one sends its first heart.
                            if r["ok"] and not first_ok:
                                first_ok = True
                                signal_next()

                            status = "OK" if r["ok"] else ("SKIP" if r.get("no_comment") else "FAIL")
                            print(f"  {prefix} -> {status}: {r['note']}")
                            row = {
                                "url": url,
                                "video_like_count": like_count,
                                "comment_keyword": r.get("keyword_used", ""),
                                "comment_text": r["comment_text"],
                                "comment_hearts": r["comment_hearts"],
                                "hearts_sent": r["hearts_sent"],
                                "rival_hearts": r.get("rival_hearts", 0),
                                "short_of_lead": r.get("deficit", 0),
                                "is_top": r.get("is_top", False),
                                "capped": r.get("capped", False),
                                "service": "zefoy",
                                "status": status,
                                "note": r["note"],
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                            }
                            log.write(row)
                            if r.get("no_comment"):
                                no_comment_log.write({**row, "all_comments": r.get("all_comments", "")})

                            with state_lock:
                                # UNFINISHED VIDEOS STAY PENDING under --to-top. Marking
                                # one done because a batch was sent would mean the next
                                # pass skips the video our comment is still losing on,
                                # which is the one video on the list that needs another
                                # visit.
                                # A video left pending is one a later pass can still
                                # help. One stopped by the threshold is not — the next
                                # pass would re-scan it and reach the same answer — so it
                                # counts as done until the video's own likes grow.
                                if (not to_top or r.get("is_top") or r.get("capped")
                                        or r.get("no_comment")):
                                    processed.add(url)
                                # MARKED WHETHER OR NOT IT FINISHED. This is the line
                                # that makes --resume mean "carry on from here" after a
                                # run is interrupted; without it the only record is of
                                # videos that reached the target, and a sweep stopped
                                # halfway would start again at #1.
                                #
                                # BUT A LINK THE BROWSER NEVER OPENED WAS NOT VISITED. A run
                                # whose connection died recorded 1,416 of them in two minutes,
                                # and the next --resume would have skipped the entire list on
                                # the strength of it.
                                if "has been closed" not in (r.get("note") or ""):
                                    visited.add(url)
                                results.append(row)
                                # Save every comment this video showed (user/text/likes/date).
                                cdata = r.get("comments_data") or []
                                if cdata:
                                    comments_out.append({"url": url, "count": len(cdata), "comments": cdata})
                                    _save_comments_json(COMMENTS_OUTPUT_FILE, comments_out)
                                if csv_path:
                                    save_state(csv_path, processed, visited=visited)
                                    # Released here rather than at the end of the run: the other
                                    # runner should be able to pick this link up the moment it is
                                    # free, not when this process exits.
                                    if share:
                                        release_link(csv_path, url, me)

                            # NOTHING BETWEEN VIDEOS EITHER. The only waits left on
                            # this path are the ones something else imposes: Zefoy's own
                            # cooldown timer, read off the page and waited out, and the
                            # short settles after a navigation or a click that exist so
                            # the next line reads a rendered page rather than an empty
                            # one. --delay still paces the Freer runner, which has its
                            # own timers and its own flow.

                        # Fallback: release next window even if this one never had a success
                        signal_next()
                        context.close()
                        browser.close()
                        break
                    except BrowserGone as e:
                        if not CDP_URL or left <= 0 or url_queue.empty():
                            raise
                        left -= 1
                        print(f"\n{prefix} [!] Lost the browser: {e}")
                        print(f"{prefix} [*] Trying to pick it back up "
                              f"({left} attempt(s) left after this one)...")
                        if not cdp_relink():
                            raise
                        print(f"{prefix} [*] Reattached - carrying on with "
                              f"{url_queue.qsize()} link(s) still queued")
        except BrowserGone as e:
            signal_next()
            print(f"\n{prefix} [!] The browser is gone: {e}")
            BROWSER_FATAL.append(str(e))
        except Exception as e:
            signal_next()  # don't leave the next worker waiting forever
            print(f"\n{prefix} [!] Worker crashed: {e}")

    threads = [threading.Thread(target=worker, args=(i,), daemon=True)
               for i in range(1, n_workers + 1)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    return results


# ── nreer.com (Freer) ─────────────────────────────────────────────────────────

FREER_URL = "https://nreer.com"


def _freer_sleep_keepalive(page, seconds: int, interval: int = 60):
    """Sleep for `seconds` total. Keepalive pinging is disabled — plain sleep,
    no mid-cooldown server pings. (`page`/`interval` kept for call compatibility.)"""
    time.sleep(seconds)


def freer_wait_captcha(page):
    """Pause if the nreer.com image-word captcha is showing.
    After the captcha is dismissed a countdown timer may appear before the
    dashboard — wait it out here so callers always land on the dashboard.
    """
    try:
        # wait_for retries until visible or raises — more reliable than is_visible()
        page.locator("form#cat").wait_for(state="visible", timeout=5000)
    except Exception:
        return  # no captcha within 5s — proceed
    tag = _pfx()
    print(f"\n{'=' * 60}")
    print(f"  {tag} [CAPTCHA] Freer: type the word shown in the browser,")
    print(f"  {tag} then click the dark submit button.")
    print(f"  {tag} Script resumes automatically. (up to 5 min)")
    print(f"{'=' * 60}\n")
    try:
        page.wait_for_selector("form#cat", state="hidden", timeout=300_000)
    except PlaywrightTimeoutError:
        raise RuntimeError("Freer captcha timed out (5 min).")
    print(f"{tag} [+] Freer captcha solved.")
    page_wait(1, 2)
    # A countdown timer can appear right after captcha before the dashboard
    cooldown = freer_parse_timer(page)
    if cooldown > 0:
        print(f"  {tag} [!] Freer post-captcha timer – waiting {cooldown}s...")
        _freer_sleep_keepalive(page, cooldown)
        page_wait(1, 2)


def freer_open_service(page):
    """Click the Comment Hearts 'Use' button on the nreer.com dashboard.

    Retries for up to 90 seconds to handle:
    - SPA rendering delay (page content arrives after domcontentloaded)
    - Captcha appearing instead of (or right after) the dashboard
    - Multiple parallel windows each needing their own captcha solved
    """
    btn = page.locator("button[onclick*='tok_free']").filter(has_text="Use").first
    deadline = time.time() + 90
    while time.time() < deadline:
        freer_wait_captcha(page)  # handle captcha if present (5s window to detect it)
        try:
            btn.wait_for(state="visible", timeout=3000)
            btn.click()
            page_wait(1.5, 2.5)
            tag = _pfx()
            print(f"{tag}[*] Freer: Comment Hearts open.")
            return
        except Exception:
            pass  # Use button not visible yet — captcha may have appeared; loop
    raise RuntimeError("Could not open Comment Hearts on Freer (90s timeout reached)")


def freer_ensure_url_form(page):
    """Make sure the URL search form is visible; navigate back to it if needed.

    After the cooldown timer expires nreer.com returns to the dashboard, so we
    just need to click 'Use' again — no zxndnnndje() go-back required.
    A timer can also appear here (e.g. triggered mid-session); wait it out first.
    """
    # Captcha can appear at any time; always check before trying to navigate.
    freer_wait_captcha(page)

    # After the timer fires nreer.com returns to the dashboard but leaves the
    # "Success! +50 hearts" modal open. Its backdrop blocks the Use button,
    # so close it first.
    try:
        close_btn = page.locator(".modal.show button.close").first
        if close_btn.is_visible(timeout=1500):
            close_btn.click()
            page_wait(0.5, 1)
    except Exception:
        pass

    # 1. Already on URL input form?
    try:
        page.locator("form#form1").wait_for(state="visible", timeout=3000)
        return
    except Exception:
        pass

    # 2. Timer showing? Wait it out before touching the dashboard
    cooldown = freer_parse_timer(page)
    if cooldown > 0:
        print(f"  [!] Freer timer – waiting {cooldown}s...")
        _freer_sleep_keepalive(page, cooldown)
        page_wait(1, 2)

    # 3. Dashboard is showing (e.g. after timer) — click Use directly
    try:
        btn = page.locator("button[onclick*='tok_free']").filter(has_text="Use").first
        if btn.is_visible(timeout=3000):
            freer_open_service(page)
            return
    except Exception:
        pass

    # 4. Neither — try the go-back JS call, then check for dashboard / form
    try:
        page.evaluate("zxndnnndje()")
        page_wait(1.5, 2.5)
    except Exception:
        pass
    try:
        btn = page.locator("button[onclick*='tok_free']").filter(has_text="Use").first
        if btn.is_visible(timeout=3000):
            freer_open_service(page)
            return
    except Exception:
        pass
    try:
        page.locator("form#form1").wait_for(state="visible", timeout=4000)
        return
    except Exception:
        pass

    # 5. Last resort
    freer_open_service(page)


def freer_parse_timer(page) -> int:
    """Return remaining cooldown seconds from the timer page, else 0.

    nreer.com renders a countdown widget:
      <div data-clock="main_timer" data-time="79" ...>
        <span id="min">01</span> Min
        <span id="sec">05</span> Sec
      </div>
    data-time is the authoritative total-seconds value.
    """
    # Most reliable: data-time attribute
    try:
        el = page.locator("[data-clock='main_timer']").first
        if el.is_visible(timeout=1500):
            val = el.get_attribute("data-time")
            if val and val.isdigit():
                return int(val) + 3
    except Exception:
        pass
    # Fallback: read #min and #sec spans
    try:
        mins = int(page.locator("#min").first.inner_text().strip())
        secs = int(page.locator("#sec").first.inner_text().strip())
        total = mins * 60 + secs
        return total + 3 if total > 0 else 0
    except Exception:
        pass
    # Fallback: plain-text seconds mention
    try:
        m = re.search(r'(\d+)\s+second', page.inner_text("body"), re.IGNORECASE)
        if m:
            return int(m.group(1)) + 3
    except Exception:
        pass
    return 0


def freer_process_url(page, video_url: str, video_like_count: int,
                      keywords: list[str], on_hearts_sent=None) -> dict:
    """Run the full Comment Hearts flow on nreer.com for one video URL."""

    def fail(note, comment_text="", comment_hearts=0, hearts_sent=0,
             no_comment=False, keyword_used="", all_comments=""):
        return {"ok": False, "note": note,
                "comment_text": comment_text, "comment_hearts": comment_hearts,
                "hearts_sent": hearts_sent, "no_comment": no_comment,
                "keyword_used": keyword_used, "all_comments": all_comments}

    try:
        # ── 1. Fill URL and submit ────────────────────────────────────────────
        url_input = page.locator("form#form1 input[type='search']").first
        url_input.wait_for(state="visible", timeout=15000)
        url_input.fill(video_url)
        page_wait(0.3, 0.6)
        page.locator("form#form1 button[type='submit']").first.click()
        page_wait(2, 3)
        freer_wait_captcha(page)

        # ── 2. Click the comment stat button ─────────────────────────────────
        try:
            page.locator("button[data-type='com_op']").first.wait_for(
                state="visible", timeout=15000
            )
        except PlaywrightTimeoutError:
            # Freer did not answer. Nothing is known about the comments.
            return fail("Video info did not load after URL submit")
        page.locator("button[data-type='com_op']").first.click()
        page_wait(1, 2)
        freer_wait_captcha(page)

        # ── 3. Click "Show comments" in the modal ────────────────────────────
        try:
            page.locator("button[onclick*='show_comments']").first.wait_for(
                state="visible", timeout=10000
            )
        except PlaywrightTimeoutError:
            return fail("Show comments button did not appear")
        page.locator("button[onclick*='show_comments']").first.click()
        page_wait(2, 3)
        freer_wait_captcha(page)

        # ── 4. Scan all comment pages, collect matching rows ──────────────────
        keyword_used   = ""
        used_threshold = HEART_THRESHOLD
        onclick_params = ""
        comment_text   = ""
        comment_hearts = 0

        if keywords:
            found_any_global  = False
            all_comment_texts = []
            MAX_PAGES = 10
            scan_page = 1
            # Track p= offsets we have already sent a click to, to detect wrap-around.
            # Start with {0} since the comment list opens at p=0 by default.
            clicked_offsets: set[int] = {0}
            best: tuple | None = None  # (hearts, ctext, params, keyword, threshold)

            while scan_page <= MAX_PAGES:

                rows = page.locator(".input-group.mb-1").all()

                # Collect text for the no-match log
                for row in rows:
                    try:
                        t = row.locator("p small").first.inner_text().strip()
                        if t:
                            all_comment_texts.append(t)
                    except Exception:
                        pass

                # Collect keyword matches on this page only
                page_matches: dict[str, list[tuple[int, str, str]]] = {k: [] for k in keywords}
                for row in rows:
                    try:
                        # Match against the comment text only (p small), not the
                        # whole row, so a keyword in a username can't false-match.
                        row_text    = row.locator("p small").first.inner_text().strip().lower()
                        heart_btn   = row.locator("button.btn-info").first
                        hearts_raw  = heart_btn.locator("small").first.inner_text().strip()
                        hearts      = int(hearts_raw.replace(",", "")) if hearts_raw else 0
                        raw_onclick = heart_btn.get_attribute("onclick") or ""
                        m = re.match(r"zxndnnndje\('(.+)'\)", raw_onclick)
                        params      = m.group(1) if m else ""
                        ctext       = row.locator("p small").first.inner_text().strip()
                        for keyword in keywords:
                            if keyword.lower() not in row_text:
                                continue
                            found_any_global = True
                            if params:
                                page_matches[keyword].append((hearts, ctext, params))
                            break
                    except Exception:
                        continue

                # Pick best match on this page (per-keyword threshold degradation)
                for keyword in keywords:
                    matches = sorted(page_matches[keyword], key=lambda x: x[0])
                    kw_threshold = HEART_THRESHOLD
                    for h, ct, p in matches:
                        if choose_heart_count(video_like_count, h, kw_threshold) > 0:
                            if best is None or h < best[0]:
                                best = (h, ct, p, keyword, kw_threshold)
                            break
                        kw_threshold *= (1 - THRESHOLD_STEP)

                # Found a valid comment on this page — heart it, skip remaining pages
                if best is not None:
                    break

                # No match on this page → try the next page
                next_offset = -1
                next_btn    = None
                try:
                    next_li     = page.locator("li[title='next']").first
                    next_btn    = next_li.locator("button.page-link").first
                    is_disabled = "disabled" in (next_li.get_attribute("class") or "")
                    if not is_disabled:
                        m_next = re.search(r'&p=(\d+)',
                                           next_btn.get_attribute("onclick") or "")
                        if m_next:
                            next_offset = int(m_next.group(1))
                            if next_offset in clicked_offsets:
                                is_disabled = True  # wrap-around detected
                        # If no &p= found the button exists but offset is unknown;
                        # proceed anyway — clicking it won't loop.
                except Exception:
                    is_disabled = True

                if is_disabled or next_btn is None:
                    break

                if next_offset >= 0:
                    clicked_offsets.add(next_offset)
                next_btn.click()
                scan_page += 1
                # Wait for the loading spinner to appear then clear (reliable AJAX sync)
                try:
                    page.locator("#loading").wait_for(state="visible", timeout=2000)
                    page.locator("#loading").wait_for(state="hidden",  timeout=10000)
                except Exception:
                    page_wait(1.5, 2.5)  # fallback if spinner is too fast to catch
                freer_wait_captcha(page)

            all_comments_str = " | ".join(all_comment_texts)

            if best is None:
                kw_str = "', '".join(keywords)
                if not found_any_global:
                    return fail(
                        f"No matching comments for any keyword ('{kw_str}') – skipping",
                        no_comment=True, all_comments=all_comments_str,
                    )
                return fail(
                    f"All comments for keywords ('{kw_str}') at or above threshold "
                    f"(video likes: {video_like_count:,}, base: {HEART_THRESHOLD:.0%}) – skipping",
                    all_comments=all_comments_str,
                )

            comment_hearts, comment_text, onclick_params, keyword_used, used_threshold = best

        else:
            # No keywords – use first available comment
            try:
                page.locator(".input-group.mb-1").first.wait_for(
                    state="visible", timeout=10000
                )
            except PlaywrightTimeoutError:
                return fail("Comment list did not appear")
            first_row   = page.locator(".input-group.mb-1").first
            heart_btn   = first_row.locator("button.btn-info").first
            hearts_raw  = heart_btn.locator("small").first.inner_text().strip()
            comment_hearts = int(hearts_raw.replace(",", "")) if hearts_raw else 0
            comment_text   = first_row.locator("p small").first.inner_text().strip()
            raw_onclick    = heart_btn.get_attribute("onclick") or ""
            m = re.match(r"zxndnnndje\('(.+)'\)", raw_onclick)
            onclick_params = m.group(1) if m else ""

        print(f"  [*] Comment ({keyword_used or 'any'}): \"{comment_text[:80]}\" "
              f"({comment_hearts} hearts)")

        if not onclick_params:
            return fail("Could not extract heart button parameters",
                        comment_text, comment_hearts)

        # ── 5. Send hearts via JS call (works from any page state) ───────────
        # Calling zxndnnndje() directly avoids needing to re-navigate to the
        # comment's page — the function makes an AJAX request regardless.
        try:
            page.evaluate(f"zxndnnndje('{onclick_params}')")
        except Exception as e:
            return fail(f"Heart JS call failed: {e}", comment_text, comment_hearts)

        submit_wait()
        freer_wait_captcha(page)

        # Parse actual hearts sent from the success modal
        # e.g. <div class="modal-body">+<b>50</b> comment hearts sent!</div>
        hearts_sent = 0
        try:
            modal_body = page.locator(".modal.show .modal-body").first
            if modal_body.is_visible(timeout=4000):
                m_hs = re.search(r'\+\s*(\d[\d,]*)', modal_body.inner_text())
                if m_hs:
                    hearts_sent = int(m_hs.group(1).replace(",", ""))
                    print(f"  [+] Freer: +{hearts_sent} comment hearts sent")
                    if on_hearts_sent:
                        on_hearts_sent()
        except Exception:
            pass

        # ── 6. Wait out any cooldown timer ────────────────────────────────────
        cooldown = freer_parse_timer(page)
        if cooldown > 0:
            print(f"  [!] Freer timer – waiting {cooldown}s...")
            _freer_sleep_keepalive(page, cooldown)
        freer_wait_captcha(page)

        return {"ok": True, "note": f"Sent {hearts_sent} hearts",
                "comment_text": comment_text, "comment_hearts": comment_hearts,
                "hearts_sent": hearts_sent, "keyword_used": keyword_used, "all_comments": ""}

    except PlaywrightTimeoutError as e:
        # A TIMEOUT ON A DEAD BROWSER IS NOT A SLOW PAGE. Waiting ten seconds for
        # an element on a connection that is gone looks exactly like Zefoy being
        # slow, and was recorded as this video's failure.
        if browser_gone(page, e):
            raise BrowserGone(f"the browser went away mid-visit ({e})") from e
        return fail(f"Timeout: {e}")
    except BrowserGone:
        # Already named. Let the worker decide whether to reconnect.
        raise
    except Exception as e:
        # THE ONE THAT ATE 1,416 LINKS. "Target page, context or browser has been
        # closed" was caught here and turned into an ordinary per-link failure,
        # so the queue kept feeding videos to a browser that no longer existed:
        # the whole list failed in a few minutes, the reconnect never ran because
        # nothing ever raised, and the run ended "3/1435 successful" with exit 0.
        if browser_gone(page, e):
            raise BrowserGone(f"the browser went away mid-visit ({e})") from e
        return fail(f"Error: {e}")


def run_freer(urls: list[dict], delay: float, keywords: list[str],
              log: RealTimeLog, no_comment_log: RealTimeLog,
              csv_path: str = "", n_workers: int = 1) -> list[dict]:
    state_key = csv_path if csv_path else ""
    processed = load_state(state_key, "_freer") if state_key else set()
    pending   = [e for e in urls if e["url"] not in processed]
    skipped   = len(urls) - len(pending)
    if skipped:
        print(f"[Freer] Resuming – {skipped} URL(s) already done, "
              f"starting from URL #{skipped + 1}")
    if not pending:
        print("[Freer] Nothing left in this list. Run again with --fresh to start over:")
        print(f"        {_state_path(csv_path, '_freer')}")
        return []

    url_queue  = Queue()
    for entry in pending:
        url_queue.put(entry)

    results    = []
    state_lock = threading.Lock()

    # Gate chain: worker N waits for gate N before opening its browser. Each worker
    # opens the next after its captcha is solved. With automatic captchas, open all
    # windows at once instead.
    start_gates = [threading.Event() for _ in range(n_workers)]
    if stagger_windows():
        start_gates[0].set()
    else:
        for g in start_gates:
            g.set()
        if n_workers > 1:
            print(f"[Freer] Opening all {n_workers} windows at once.")

    def worker(worker_id: int):
        asyncio.set_event_loop(asyncio.new_event_loop())
        idx    = worker_id - 1
        prefix = f"[Freer-W{worker_id}]" if n_workers > 1 else "[Freer]"
        _tl.prefix = prefix
        signaled = [False]

        def signal_next():
            if not signaled[0] and idx + 1 < n_workers:
                print(f"{prefix} [*] Ready — opening next window...")
                start_gates[idx + 1].set()
                signaled[0] = True

        start_gates[idx].wait()  # wait for previous worker to finish its captcha

        proxy_url = PROXIES[idx % len(PROXIES)] if PROXIES else ""
        if proxy_url:
            print(f"{prefix} Using proxy: {proxy_url}")

        try:
            with sync_playwright() as p:
                browser, context, page = new_browser_page(p, proxy_url)
                print(f"{prefix} Opening nreer.com ...")
                page.goto(FREER_URL, wait_until="domcontentloaded", timeout=30000)
                freer_open_service(page)  # blocks until captcha solved + Use clicked
                signal_next()  # captcha solved → open the next window now (don't wait for a heart)

                first_ok = False
                while True:
                    try:
                        entry = url_queue.get_nowait()
                    except Empty:
                        break

                    url        = entry["url"]
                    like_count = entry["like_count"]
                    position   = len(pending) - url_queue.qsize()
                    print(f"\n{prefix} ({position}/{len(pending)}) {_cluster_tag(entry)} {url}")

                    try:
                        freer_ensure_url_form(page)
                    except Exception as e:
                        print(f"  {prefix} [!] Could not reach URL form: {e} – skipping")
                        continue

                    def _on_hearts():
                        nonlocal first_ok
                        if not first_ok:
                            first_ok = True
                            signal_next()

                    r = freer_process_url(page, url, like_count, keywords,
                                          on_hearts_sent=_on_hearts)

                    try:
                        freer_ensure_url_form(page)
                    except Exception:
                        pass

                    status = "OK" if r["ok"] else ("SKIP" if r.get("no_comment") else "FAIL")
                    print(f"  {prefix} -> {status}: {r['note']}")
                    row = {
                        "url": url,
                        "video_like_count": like_count,
                        "comment_keyword": r.get("keyword_used", ""),
                        "comment_text": r.get("comment_text", ""),
                        "comment_hearts": r.get("comment_hearts", ""),
                        "hearts_sent": r.get("hearts_sent", ""),
                        "service": "freer",
                        "status": status,
                        "note": r["note"],
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    log.write(row)
                    if r.get("no_comment"):
                        no_comment_log.write({**row, "all_comments": r.get("all_comments", "")})

                    with state_lock:
                        processed.add(url)
                        results.append(row)
                        if state_key:
                            save_state(state_key, processed, suffix="_freer")

                    if not url_queue.empty():
                        wait = delay + random.uniform(0, delay * 0.3)
                        print(f"  {prefix} Waiting {wait:.0f}s before next URL...")
                        time.sleep(wait)

                # Fallback: release next window even if this one never had a success
                signal_next()
                context.close()
                browser.close()
        except BrowserGone as e:
            signal_next()
            print(f"\n{prefix} [!] The browser is gone: {e}")
            BROWSER_FATAL.append(str(e))
        except Exception as e:
            signal_next()  # don't leave the next worker waiting forever
            print(f"\n{prefix} [!] Worker crashed: {e}")

    threads = [threading.Thread(target=worker, args=(i,), daemon=True)
               for i in range(1, n_workers + 1)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    return results


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    # Declared up front: argparse reads CDP_RECOVER for a default while the
    # parser is being built, and Python will not take a global declaration after
    # the name has been read in the same function.
    global CDP_URL, CDP_RECOVER
    parser = argparse.ArgumentParser(
        description="Automate TikTok comment hearts via Zefoy / Freer.in. Config from .env; CLI overrides."
    )
    parser.add_argument("--csv",     "-c", default=DEFAULT_CSV_FILE,  help="CSV file with video URLs")
    parser.add_argument("--service", "-s", default=DEFAULT_SERVICE,   choices=["zefoy", "freer", "both"])
    parser.add_argument("--delay",   "-d", default=DEFAULT_DELAY,     type=float, help="Base delay (s) between URLs")
    parser.add_argument("--keyword", "-k", default=None,
                        help="Comma-separated keywords (overrides .env COMMENT_KEYWORD)")
    parser.add_argument("--output",  "-o", default=DEFAULT_OUTPUT_FILE)
    parser.add_argument("--loop",    "-l", action="store_true", default=LOOP,
                        help="Restart automatically after all URLs are processed")
    parser.add_argument("--no-loop", dest="loop", action="store_false",
                        help="One pass, then stop. The only way to override "
                             "LOOP=true in .env, and what a resumed run usually "
                             "wants: a pass boundary clears the record on purpose")
    parser.add_argument("--loop-delay", type=float, default=LOOP_DELAY_SECONDS,
                        help="Seconds to wait between loop passes (default: 60)")
    parser.add_argument("--workers", "-w", type=int, default=PARALLEL_WINDOWS,
                        help="Number of parallel browser windows per service (default: 1)")
    parser.add_argument("--cdp", default="",
                        help="drive an already-running Chrome over its DevTools "
                             "endpoint instead of launching one — including "
                             "Chrome ON AN ANDROID PHONE over USB: "
                             "adb forward tcp:9222 localabstract:chrome_devtools_remote, "
                             "then --cdp http://127.0.0.1:9222. A tab must be open")
    parser.add_argument("--from-dashboard", action="store_true",
                        help="take the links from the dashboard's live pool "
                             "instead of a CSV, and let IT do the clustering so "
                             "'cluster 1' means the same thing in both places")
    parser.add_argument("--cluster-by", default="date", choices=["rank", "date", "combined"],
                        help="--from-dashboard: which clustering to ask for (default date)")
    parser.add_argument("--clusters", default="1",
                        help="--from-dashboard: which clusters, comma-separated, "
                             "e.g. 1 or 1,2. Use 'all' for every cluster — not an "
                             "empty string, which PowerShell drops before argparse "
                             "sees it. Links are worked best cluster first")
    parser.add_argument("--platform", default="tiktok",
                        help="--from-dashboard: which platform's pool (default tiktok)")
    parser.add_argument("--category", default="",
                        help="--from-dashboard: only links in this audience category")
    # WHICH PRODUCT GENRE'S LINKS TO WORK.
    #
    # Not a cosmetic filter: this tool hearts OUR comment on a video, and which
    # comment is ours depends on the genre. A cocodly link carries cocodly
    # comments and nothing else, so a run aimed at one product's videos has to
    # be able to ask for that pool. Blank is every genre, which is what it did
    # before genres existed.
    # No fixed choices: genres added in Admin → Genres (study-helper, …) are as
    # valid as the built-in three, and the dashboard is the one that knows them.
    # An unknown name simply matches no links, and the run says so.
    parser.add_argument("--genre", default="", type=lambda v: v.strip().lower(),
                        help="--from-dashboard: only links in this product genre "
                             "(blank = every genre)")
    parser.add_argument("--max-links", type=int, default=2000,
                        help="--from-dashboard: how many links to pull at most (default 2000)")
    parser.add_argument("--to-top", action="store_true",
                        help="Heart our comment until it PASSES the best-liked "
                             "comment on the video, instead of aiming at a share "
                             "of the video's likes. Zefoy only applies to this")
    parser.add_argument("--margin", type=int, default=TOP_MARGIN,
                        help=f"--to-top: how many hearts to lead by (default {TOP_MARGIN})")
    parser.add_argument("--share", action="store_true",
                        help="Work the same list as another run (the PC's and "
                             "the phone's, say). Both must use the same source "
                             "and the same --tag. Links are claimed one at a "
                             "time so neither repeats the other, and a run that "
                             "stops has its claims picked up by the one still "
                             "going")
    parser.add_argument("--floor", type=float, default=HEART_FLOOR,
                        help=f"--to-top: the least a comment may carry, as a "
                             f"share of the VIDEO's likes - worked even when it "
                             f"already leads (default {HEART_FLOOR}, i.e. a "
                             f"quarter of the likes; 0 makes leading enough). "
                             f"HEART_FLOOR in .env")
    parser.add_argument("--watch", type=float, default=HEART_WATCH_SECONDS,
                        help=f"--to-top: seconds to watch the comment's real "
                             f"heart count after each batch, instead of assuming "
                             f"the dropdown's number landed (default "
                             f"{HEART_WATCH_SECONDS:.0f}; 0 to assume)")
    parser.add_argument("--rounds", type=int, default=TOP_ROUNDS,
                        help=f"--to-top: heart batches per video per pass "
                             f"(default {TOP_ROUNDS}). A video still behind when "
                             f"they run out stays pending for the next pass")
    parser.add_argument("--resume", "-R", action="store_true", default=RESUME,
                        help="Carry on where the last run stopped: skip every link "
                             "it opened, not only the ones it finished. Without it "
                             "a --to-top video still behind is visited again, which "
                             "is what a fresh pass over the list should do and not "
                             "what an interrupted run wants (RESUME=true in .env "
                             "makes it the default)")
    parser.add_argument("--tag", default=STATE_TAG,
                        help="A name for this run's state file, so two runs "
                             "working the same links keep separate records "
                             "(e.g. --tag phone). STATE_TAG in .env")
    parser.add_argument("--recover", type=int, default=CDP_RECOVER,
                        help=f"--cdp: how many times to put a dropped phone back "
                             f"with adb and carry on (default {CDP_RECOVER}; 0 to "
                             f"stop at the first drop). CDP_RECOVER in .env")
    parser.add_argument("--fresh", action="store_true",
                        help="Forget the last run and start at link #1. Deletes the "
                             "state file for this source, nothing else")
    args = parser.parse_args()

    if args.resume and args.fresh:
        parser.error(
            "--resume and --fresh ask for opposite things: one continues the last "
            "run, the other forgets it. Pick one."
        )

    if not args.csv and not args.from_dashboard:
        parser.error(
            "No links. Pass --from-dashboard, or set CSV_FILE in .env / pass --csv."
        )

    # THE FIRST THING ASKED, because it is the one answer that makes everything
    # else pointless. Discovering a dead adb forward inside the worker meant
    # 1,526 links were fetched, a pass was started, the failure was reported as a
    # crash, and --loop went round again 60 seconds later — forever.
    cdp_detail = ""
    if args.cdp:
        CDP_URL = args.cdp
        CDP_RECOVER = max(0, args.recover)
        ok, cdp_detail = cdp_alive(args.cdp)
        if not ok:
            # TRIED BEFORE IT IS REPORTED. The forward does not survive a device
            # reconnect, so "not answering" at startup is usually just a missing
            # forward — the same two adb commands that recover a mid-run drop fix
            # it here, and a run started from a button has nobody at a terminal
            # to type them.
            print(f"[*] {args.cdp} is not answering ({cdp_detail}) – trying adb...")
            CDP_RECOVER = max(0, args.recover)
            if args.recover > 0 and cdp_relink():
                ok, cdp_detail = cdp_alive(args.cdp)
            if not ok:
                print(f"[!] {args.cdp} is still not answering: {cdp_detail}")
                print(f"[!] Nothing can run without it. To fix: {ADB_HINT}")
                sys.exit(2)

    # THE POOL, or a file. Fetched once up front rather than per pass: a --loop
    # sweep re-fetches below, so a long run picks up links added since it started.
    dash_products: list[str] = []
    if args.from_dashboard:
        all_urls, dash_products = from_dashboard(
            args.cluster_by, args.clusters,
            {"platform": args.platform, "category": args.category,
             "genre": args.genre, "limit": str(args.max_links)},
        )
    else:
        all_urls = load_urls(args.csv)
    if not all_urls:
        print("[!] No links to work. Exiting.")
        sys.exit(1)

    # The state file is keyed on where the links came from, so a dashboard run
    # and a CSV run do not share a skip list — "done" means something different
    # in each.
    # THE SOURCE DECIDES THIS, NOT WHETHER A CSV HAPPENS TO BE CONFIGURED.
    # args.csv falls back to CSV_FILE in .env, which is almost always set — so
    # `args.csv or ...` picked the CSV's state file on every --from-dashboard
    # run. The dashboard links were then skipped on the strength of a CSV run's
    # history, and marked done in a file describing a different list.
    state_key = (
        f"dashboard-{args.cluster_by}-"
        + (str(args.clusters).strip().lower() or "all")
        if args.from_dashboard
        else args.csv
    )
    # The tag goes on the end, so the file still says what it is a record OF.
    if args.tag:
        state_key = f"{state_key}-{re.sub(r'[^A-Za-z0-9._-]', '', args.tag)}"

    if args.cdp:
        print(f"[*] Browser    : attaching to {args.cdp} — the phone's own Chrome, "
              f"its session and its IP ({cdp_detail})")
        print("[*] If it drops: "
              + (f"adb reconnect + adb forward, up to {CDP_RECOVER} time(s), then "
                 f"the run carries on with the links still queued"
                 if CDP_RECOVER else
                 "the run stops at the first drop (--recover 0)"))
        if args.workers > 1:
            print("[*]              one browser only; --workers is ignored when attached")
            args.workers = 1
    print(f"[*] Service    : {args.service}")
    print(f"[*] URLs       : {len(all_urls)} loaded")
    print(f"[*] Delay      : {args.delay}s base")
    print(f"[*] Windows    : {args.workers} per service")
    print(f"[*] Loop       : {'yes – delay ' + str(args.loop_delay) + 's between passes' if args.loop else 'no – one pass, then stop'}")
    if args.loop:
        # SAID BECAUSE IT LOOKS LIKE THE RESUME FAILING. Finishing the list is
        # not being interrupted: the pass ends, the record is cleared on purpose,
        # and the next pass starts at link #1 again — which is the whole point of
        # a loop and the opposite of what --resume is for.
        print("[*]              each pass clears the record and sweeps the list "
              "again; --no-loop for a single pass")
    if args.fresh:
        gone = clear_state(state_key)
        print("[*] Fresh start: "
              + (f"{', '.join(str(g) for g in gone)} deleted — starting at link #1"
                 if gone else "there was no state file for this source anyway"))
    done_set = load_state(state_key)
    seen_set = load_visited(state_key)
    print(f"[*] State file : {_state_path(state_key)}"
          + (f" — {len(done_set)} finished, {len(seen_set - done_set)} visited "
             f"but unfinished"
             if (done_set or seen_set) else " — nothing recorded yet"))
    # SAID BEFORE ANYTHING OPENS, because it decides which links this run even
    # looks at, and the difference is invisible once the hearts start going out.
    print("[*] Resume     : "
          + ("on — continuing after the last link the previous run opened"
             if args.resume else
             "off — every link the last run did not FINISH is worked again "
             "(--resume to carry on instead)"))
    if args.from_dashboard:
        # Said once, up front. The clusters endpoint carries no like counts, and
        # both the default target and the --to-top ceiling are fractions of them.
        with_likes = sum(1 for e in all_urls if e["like_count"] > 0)
        if with_likes:
            print(f"[*] Like counts: {with_likes} of {len(all_urls)} link(s) carry one, "
                  f"so the {HEART_THRESHOLD:.0%} ceiling applies to those")
        elif args.to_top:
            print(f"[*] Heads up   : this dashboard sends no like counts, so "
                  f"HEART_THRESHOLD ({HEART_THRESHOLD:.0%}) cannot be applied to "
                  f"these videos — the lead is chased without a ceiling. Deploy "
                  f"the dashboard, or use a scraper CSV.")
        else:
            print("[*] Heads up   : the dashboard does not send like counts, so the "
                  "share-of-likes target has nothing to work from. Use --to-top with "
                  "--from-dashboard, or a scraper CSV without it.")
    if args.to_top:
        print(f"[*] Target     : pass the top comment by {args.margin}, "
              f"up to {args.rounds} batch(es) per video per pass")
        print(f"[*] Counting   : "
              + (f"the real heart count is read off the page for up to "
                 f"{args.watch:.0f}s after each batch"
                 if args.watch > 0 else
                 "assuming each batch lands in full (--watch 0)"))
        if args.service != "zefoy":
            # Said once, up front. Freer has its own flow and its own timers, and
            # quietly hearting to a different target there would make the numbers
            # in the log mean two things at once.
            print("[*]              (--to-top applies to Zefoy only; "
                  "Freer still aims at the share-of-likes threshold)")

    pass_num = 0
    last_pass_rows = 0
    while True:
        pass_num += 1

        if pass_num > 1:
            print(f"\n{'=' * 60}")
            print(f"[*] Loop pass #{pass_num} – waiting {args.loop_delay:.0f}s before restarting...")
            time.sleep(args.loop_delay)
            # A NEW PASS IS A FRESH SWEEP, --resume or not: the flag is about
            # picking up an interrupted run, and the run has not been
            # interrupted — it finished the list and came back for another go.
            #
            # UNLESS THE LAST PASS DID NOTHING. A pass that worked no links did
            # not finish the list, and clearing the record then is pure loss: a
            # browser that went away at link 40 of 1,526 had the whole run
            # forgotten, once a minute, for as long as nobody was watching.
            if last_pass_rows:
                clear_state(state_key)
                print("[*] State cleared – processing all URLs from the beginning")
            else:
                print("[*] Record kept – the last pass worked no links, so there is "
                      "nothing to sweep again")
            if args.from_dashboard:
                # Re-ask, so a sweep that has been running for hours works the
                # links added since it started — and stops working any the
                # dashboard has since blocked.
                try:
                    all_urls, dash_products = from_dashboard(
                        args.cluster_by, args.clusters,
                        {"platform": args.platform, "category": args.category,
                         "genre": args.genre, "limit": str(args.max_links)},
                    )
                except SystemExit as e:
                    print(f"[!] Could not refresh the links ({e}); keeping the "
                          f"{len(all_urls)} from the last pass")

        # Re-read .env each pass so keyword (and other) changes take effect without restart.
        # CLI --keyword flag overrides .env when explicitly provided.
        load_dotenv(Path(__file__).parent / ".env", override=True)
        if args.keyword is not None:
            keywords = [k.strip() for k in args.keyword.split(",") if k.strip()]
        elif dash_products:
            # THE PRODUCTS THE DASHBOARD HAS SWITCHED ON, which is the set it is
            # actually serving to workers. Hardcoding a list here is how the two
            # drift: a product switched off there kept being hearted here.
            keywords = list(dash_products)
            print("[*] Keywords   : from the dashboard's active products")
        else:
            keywords = [k.strip() for k in os.getenv("COMMENT_KEYWORD", "").split(",") if k.strip()]
        if keywords:
            print(f"[*] Keywords   : {keywords}")
        else:
            print("[*] Keywords   : (none – every video skipped)")

        # Re-cluster each pass so CLUSTER_COUNT / MAX_CLUSTER changes in .env take
        # effect on the next loop (like keywords). MAX_CLUSTER caps how many
        # clusters run; links in later clusters are skipped this pass entirely.
        if args.from_dashboard:
            # ALREADY CLUSTERED. Re-splitting a selection that is itself one or
            # two clusters of a bigger pool would invent a second set of clusters
            # inside the first. The ORDER is set in from_dashboard: best cluster
            # first, and the dashboard's own ranking within each.
            urls = all_urls
            seen_order = []
            for e in urls:
                c = e.get("cluster")
                if not seen_order or seen_order[-1][0] != c:
                    seen_order.append([c, 0])
                seen_order[-1][1] += 1
            print(f"[*] Order      : {args.cluster_by} cluster(s) "
                  + ", ".join(f"{c} ({n})" for c, n in seen_order)
                  + " — best first, the dashboard's ranking within each")
        else:
            cluster_count = int(os.getenv("CLUSTER_COUNT", str(CLUSTER_COUNT)) or CLUSTER_COUNT)
            max_cluster   = int(os.getenv("MAX_CLUSTER", str(MAX_CLUSTER)) or MAX_CLUSTER)
            urls = cluster_and_order(all_urls, n_clusters=cluster_count, max_cluster=max_cluster)

        # Fresh timestamped log names each pass (fixed --output only used on pass 1)
        if pass_num == 1 and args.output:
            output_path = args.output
        else:
            date_str = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_path = str(LOGS_DIR / f"run_{args.service}_{date_str}.csv")
        # A relative --output still means "beside the script", for the same
        # reason the state file does.
        if not Path(output_path).is_absolute():
            output_path = str(LOGS_DIR / output_path)
        nc_path = str(Path(output_path).parent / f"no_comment_{Path(output_path).name}")

        print(f"\n[*] Log file   : {output_path}")
        all_results: list[dict] = []
        log = RealTimeLog(output_path)
        no_comment_log = RealTimeLog(nc_path, fieldnames=NO_COMMENT_LOG_FIELDS)
        try:
            if args.service in ("zefoy", "both"):
                print("\n=== Zefoy ===")
                all_results += run_zefoy(urls, args.delay, keywords, log, no_comment_log,
                                          csv_path=state_key, n_workers=args.workers,
                                          to_top=args.to_top, margin=args.margin,
                                          rounds=args.rounds, watch_s=args.watch,
                                          resume=args.resume, floor=args.floor,
                                          share=args.share)

            if args.service in ("freer", "both"):
                print("\n=== Freer (nreer.com) ===")
                all_results += run_freer(urls, args.delay, keywords, log, no_comment_log,
                                          csv_path=state_key, n_workers=args.workers)
        finally:
            log.close()
            no_comment_log.close()

        ok_count = sum(1 for r in all_results if r["status"] == "OK")
        last_pass_rows = len(all_results)
        print(f"\n[+] Pass #{pass_num} summary: {ok_count}/{len(all_results)} successful.")

        if BROWSER_FATAL:
            # NOT RETRIED. Every pass from here would re-ask the dashboard for the
            # whole list and fail at the first link, and the record survives only
            # because this stops.
            print(f"\n[!] Stopping: {BROWSER_FATAL[0]}")
            if CDP_URL:
                print(f"[!] When the phone is back: {ADB_HINT}")
                print("[!] Then run the same command again with --resume to carry "
                      "on from here.")
            sys.exit(2)

        if not args.loop:
            break


if __name__ == "__main__":
    main()
