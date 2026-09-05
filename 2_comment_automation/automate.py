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


def _state_path(csv_path: str, suffix: str = "") -> Path:
    return Path("logs") / f"state_{Path(csv_path).stem}{suffix}.json"


def load_state(csv_path: str, suffix: str = "") -> set[str]:
    sp = _state_path(csv_path, suffix)
    if sp.exists():
        try:
            return set(json.loads(sp.read_text(encoding="utf-8")).get("processed", []))
        except Exception:
            return set()
    return set()


def save_state(csv_path: str, processed: set[str], suffix: str = ""):
    sp = _state_path(csv_path, suffix)
    sp.parent.mkdir(parents=True, exist_ok=True)
    sp.write_text(json.dumps({"processed": sorted(processed)}, indent=2), encoding="utf-8")


def load_urls(csv_path: str) -> list[dict]:
    """Return list of {"url", "like_count", "search_rank", "posted_date", "scraped_at"} dicts."""
    path = Path(csv_path)
    if not path.exists():
        print(f"[!] CSV not found: {csv_path}")
        sys.exit(1)
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


def new_browser_page(playwright, proxy_url: str = ""):
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

def _gemini_read_captcha(img_bytes: bytes) -> str:
    """Send a captcha image to Gemini and return the word it reads (lowercase letters only)."""
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    payload = {
        "contents": [{
            "parts": [
                {"text": (
                    "This is a captcha image. What is the single word shown? "
                    "Reply with ONLY the word — lowercase letters, no spaces, no punctuation."
                )},
                {"inline_data": {
                    "mime_type": "image/png",
                    "data": base64.b64encode(img_bytes).decode(),
                }},
            ]
        }]
    }
    r = _requests.post(url, json=payload, timeout=20)
    r.raise_for_status()
    text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    return re.sub(r"[^a-z]", "", text.lower().strip())


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
    try:
        captcha_visible = page.locator(_CAPTCHA_SEL).is_visible(timeout=4000)
    except Exception:
        captcha_visible = False

    if not captcha_visible:
        return

    tag = _pfx()

    # ── Auto mode (Gemini) ────────────────────────────────────────────────────
    if CAPTCHA_MODE == "auto" and GEMINI_API_KEY:
        print(f"{tag} [AI] Captcha detected – solving with Gemini...")
        for attempt in range(8):
            try:
                img_bytes = page.locator(_CAPTCHA_SEL).screenshot()
                word = _gemini_read_captcha(img_bytes)
                if not word:
                    raise ValueError("Gemini returned empty string")
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
            except Exception as e:
                print(f"{tag} [AI] Attempt {attempt + 1} error: {e}")
                page_wait(1, 2)
        print(f"{tag} [!] AI solving failed – falling back to terminal input...")

    # ── Manual / terminal mode ────────────────────────────────────────────────
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


def zefoy_session_expired(page) -> bool:
    """Return True if the session has expired.

    Two cases:
      - Zefoy shows 'Session expired. Please re-login.' inline (still on chearts page)
      - The captcha reappeared on the home page
    """
    try:
        if page.locator(_CAPTCHA_SEL).is_visible(timeout=1500):
            return True
    except Exception:
        pass
    try:
        if "session expired" in page.inner_text("body").lower():
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

def _zefoy_goto_page(page, n: int) -> bool:
    """Click the Zefoy comment-pagination button for page `n` (exact-text match so
    '2' doesn't hit '12'/'20'). Returns True on success."""
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


def zefoy_process_url(page, video_url: str, video_like_count: int, keywords: list[str]) -> dict:
    """Run the full Comments Hearts flow for one video URL.

    Returns a dict with keys: ok, note, comment_text, comment_hearts, hearts_sent, keyword_used.
    """
    url_input_sel  = sel("url_input",  _URL_INPUT_SEL)
    search_btn_sel = sel("search_btn", _SEARCH_BTN_SEL)
    count_btn_sel  = sel("count_btn",  _COUNT_BTN_SEL)

    # Every comment the scan sees on this video, as {user, text, hearts, date}.
    # Collected as a side effect of the heart scan and returned to run_zefoy so it
    # can be saved. `fail()` closes over this list so ALL exit paths carry it.
    collected: list[dict] = []
    collected_seen: set = set()

    def fail(note, comment_text="", comment_hearts=0, hearts_sent=0,
             no_comment=False, keyword_used="", all_comments=""):
        return {"ok": False, "note": note,
                "comment_text": comment_text, "comment_hearts": comment_hearts,
                "hearts_sent": hearts_sent, "no_comment": no_comment,
                "keyword_used": keyword_used, "all_comments": all_comments,
                "comments_data": collected}

    try:
        # ── 1. Fill URL and click Search ──────────────────────────────────────
        url_input = page.locator(url_input_sel).first
        url_input.wait_for(state="visible", timeout=10000)
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
            return fail("Count button did not appear after Search", no_comment=True)
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

                # Lock the heart target the first time an eligible comment appears
                # (highest-priority keyword, first eligible row). Keep scanning.
                if target_loc is None:
                    for kw in keywords:
                        kwl = kw.lower()
                        for row_idx, row_text, hearts in page_rows:
                            if kwl not in row_text:
                                continue
                            found_any_global = True
                            if choose_heart_count(video_like_count, hearts, HEART_THRESHOLD) > 0:
                                target_loc = (scan_page, row_idx, kw, HEART_THRESHOLD)
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
            target_page, target_idx, keyword_used, used_threshold = target_loc
            if cur_page != target_page and not _zefoy_goto_page(page, target_page):
                return fail(
                    f"Could not return to the target comment page ({target_page}) to heart it",
                    all_comments=all_comments_str,
                )
            target_row = page.locator(".t-chearts-menu .list-group-item").nth(target_idx)
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

        # ── 6. Choose heart quantity based on video likes AND comment hearts ──
        hearts_sent     = choose_heart_count(video_like_count, comment_hearts, used_threshold)
        threshold_limit = int(video_like_count * used_threshold)
        threshold_label = (f"{used_threshold:.0%}"
                           if used_threshold != HEART_THRESHOLD
                           else f"{used_threshold:.0%} (original)")
        print(f"  [*] Video likes: {video_like_count:,} | Comment hearts: {comment_hearts:,} "
              f"| Threshold: {threshold_limit:,} ({threshold_label}) → "
              f"sending {hearts_sent if hearts_sent else 'skip'}")
        print(f"  [*] Comment ({keyword_used or 'any'}): \"{comment_text[:200]}\"")

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
            best = max((v for v in available if v <= hearts_sent), default=None)
            if best is None:
                best = min(available) if available else hearts_sent
                print(f"  [~] Dropdown: no option ≤ {hearts_sent} – using smallest ({best})")
            elif best != hearts_sent:
                print(f"  [~] Dropdown: {hearts_sent} not available – using {best}")
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
        if "successfully sent" in result_text or "comment hearts" in result_text:
            return {"ok": True, "note": f"Sent {hearts_sent} hearts",
                    "comment_text": comment_text, "comment_hearts": comment_hearts,
                    "hearts_sent": hearts_sent, "keyword_used": keyword_used,
                    "comments_data": collected}
        if "please wait" in result_text or "cooldown" in result_text:
            return fail("Cooldown after heart click", comment_text, comment_hearts, hearts_sent,
                        keyword_used=keyword_used)

        return {"ok": True, "note": f"Submitted {hearts_sent} hearts (success not explicitly confirmed)",
                "comment_text": comment_text, "comment_hearts": comment_hearts,
                "hearts_sent": hearts_sent, "keyword_used": keyword_used,
                "comments_data": collected}

    except PlaywrightTimeoutError as e:
        return fail(f"Timeout: {e}")
    except Exception as e:
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
              csv_path: str = "", n_workers: int = 1) -> list[dict]:
    processed = load_state(csv_path) if csv_path else set()
    pending   = [e for e in urls if e["url"] not in processed]
    skipped   = len(urls) - len(pending)
    if skipped:
        print(f"[Zefoy] Resuming – {skipped} URL(s) already done, starting from URL #{skipped + 1}")
    if not pending:
        print("[Zefoy] All URLs already processed. Delete the state file to restart:")
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
                browser, context, page = new_browser_page(p, proxy_url)
                zefoy_login(page)
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

                    if zefoy_session_expired(page):
                        zefoy_recover_session(page)

                    r = zefoy_process_url(page, url, like_count, keywords)

                    if not r["ok"] and zefoy_session_expired(page):
                        zefoy_recover_session(page)
                        r = zefoy_process_url(page, url, like_count, keywords)

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
                        "service": "zefoy",
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
                        # Save every comment this video showed (user/text/likes/date).
                        cdata = r.get("comments_data") or []
                        if cdata:
                            comments_out.append({"url": url, "count": len(cdata), "comments": cdata})
                            _save_comments_json(COMMENTS_OUTPUT_FILE, comments_out)
                        if csv_path:
                            save_state(csv_path, processed)

                    if not url_queue.empty():
                        wait = delay + random.uniform(0, delay * 0.3)
                        print(f"  {prefix} Waiting {wait:.0f}s before next URL...")
                        time.sleep(wait)

                # Fallback: release next window even if this one never had a success
                signal_next()
                context.close()
                browser.close()
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
            return fail("Video info did not load after URL submit", no_comment=True)
        page.locator("button[data-type='com_op']").first.click()
        page_wait(1, 2)
        freer_wait_captcha(page)

        # ── 3. Click "Show comments" in the modal ────────────────────────────
        try:
            page.locator("button[onclick*='show_comments']").first.wait_for(
                state="visible", timeout=10000
            )
        except PlaywrightTimeoutError:
            return fail("Show comments button did not appear", no_comment=True)
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
                return fail("Comment list did not appear", no_comment=True)
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
        return fail(f"Timeout: {e}")
    except Exception as e:
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
        print("[Freer] All URLs already processed. Delete the state file to restart:")
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
    parser.add_argument("--loop-delay", type=float, default=LOOP_DELAY_SECONDS,
                        help="Seconds to wait between loop passes (default: 60)")
    parser.add_argument("--workers", "-w", type=int, default=PARALLEL_WINDOWS,
                        help="Number of parallel browser windows per service (default: 1)")
    args = parser.parse_args()

    if not args.csv:
        parser.error("CSV_FILE not set in .env and --csv not provided.")

    all_urls = load_urls(args.csv)
    if not all_urls:
        print("[!] No valid TikTok URLs found in CSV. Exiting.")
        sys.exit(1)

    print(f"[*] Service    : {args.service}")
    print(f"[*] URLs       : {len(all_urls)} loaded")
    print(f"[*] Delay      : {args.delay}s base")
    print(f"[*] Windows    : {args.workers} per service")
    print(f"[*] Loop       : {'yes – delay ' + str(args.loop_delay) + 's between passes' if args.loop else 'no'}")
    print(f"[*] State file : {_state_path(args.csv)}")

    pass_num = 0
    while True:
        pass_num += 1

        if pass_num > 1:
            print(f"\n{'=' * 60}")
            print(f"[*] Loop pass #{pass_num} – waiting {args.loop_delay:.0f}s before restarting...")
            time.sleep(args.loop_delay)
            for suffix in ("", "_freer"):
                sp = _state_path(args.csv, suffix)
                if sp.exists():
                    sp.unlink()
            print("[*] State cleared – processing all URLs from the beginning")

        # Re-read .env each pass so keyword (and other) changes take effect without restart.
        # CLI --keyword flag overrides .env when explicitly provided.
        load_dotenv(Path(__file__).parent / ".env", override=True)
        if args.keyword is not None:
            keywords = [k.strip() for k in args.keyword.split(",") if k.strip()]
        else:
            keywords = [k.strip() for k in os.getenv("COMMENT_KEYWORD", "").split(",") if k.strip()]
        if keywords:
            print(f"[*] Keywords   : {keywords}")
        else:
            print("[*] Keywords   : (none – first comment used)")

        # Re-cluster each pass so CLUSTER_COUNT / MAX_CLUSTER changes in .env take
        # effect on the next loop (like keywords). MAX_CLUSTER caps how many
        # clusters run; links in later clusters are skipped this pass entirely.
        cluster_count = int(os.getenv("CLUSTER_COUNT", str(CLUSTER_COUNT)) or CLUSTER_COUNT)
        max_cluster   = int(os.getenv("MAX_CLUSTER", str(MAX_CLUSTER)) or MAX_CLUSTER)
        urls = cluster_and_order(all_urls, n_clusters=cluster_count, max_cluster=max_cluster)

        # Fresh timestamped log names each pass (fixed --output only used on pass 1)
        if pass_num == 1 and args.output:
            output_path = args.output
        else:
            date_str = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_path = f"logs/run_{args.service}_{date_str}.csv"
        nc_path = str(Path(output_path).parent / f"no_comment_{Path(output_path).name}")

        print(f"\n[*] Log file   : {output_path}")
        all_results: list[dict] = []
        log = RealTimeLog(output_path)
        no_comment_log = RealTimeLog(nc_path, fieldnames=NO_COMMENT_LOG_FIELDS)
        try:
            if args.service in ("zefoy", "both"):
                print("\n=== Zefoy ===")
                all_results += run_zefoy(urls, args.delay, keywords, log, no_comment_log,
                                          csv_path=args.csv, n_workers=args.workers)

            if args.service in ("freer", "both"):
                print("\n=== Freer (nreer.com) ===")
                all_results += run_freer(urls, args.delay, keywords, log, no_comment_log,
                                          csv_path=args.csv, n_workers=args.workers)
        finally:
            log.close()
            no_comment_log.close()

        ok_count = sum(1 for r in all_results if r["status"] == "OK")
        print(f"\n[+] Pass #{pass_num} summary: {ok_count}/{len(all_results)} successful.")

        if not args.loop:
            break


if __name__ == "__main__":
    main()
