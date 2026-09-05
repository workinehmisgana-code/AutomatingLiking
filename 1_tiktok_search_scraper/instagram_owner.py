"""Who posted this Instagram link?

TikTok puts the account in the URL, so the account is free. Instagram does not:
a search result is https://www.instagram.com/p/<code>/ and nothing more, which
is why extract_accounts.py used to throw every Instagram row away. The username
has to be fetched.

WHAT WORKS, measured rather than assumed. Four routes were tried against real
codes from results/ (probe_ig_owner.py):

  * /p/<code>/embed/captioned/  — 200, but a JS shell with no metadata in it
  * api.instagram.com/oembed/   — dead without an app token
  * /api/v1/media/<code>/info/  — 404 or a shell, needs a logged-in app id
  * /p/<code>/                  — WORKS, but only sometimes

The post page is served in several variants. One carries a normal description
meta tag:

    <meta name="description" content="816 likes, 414 comments - mavgpt on
                                      February 22, 2026: ...">

and that is the username. Another carries og:title, which holds the DISPLAY name
("Maverick Maltin | AI & ChatGPT") and not the handle — useless for building a
profile URL, so it is not used. A third is a bare shell with no metadata at all.

Which variant you get looks random per request, so the fetch retries with a
different client on each attempt. Over a random sample of 20 real posts this
resolved 17 (85%), all on the first attempt, at ~2.7s each. The remaining 15%
returned the bare shell however many times they were asked, across five
different clients and with pauses between — those need a logged-in browser, and
resolve_with_browser() does them if you ask for it.

Results are cached in results/instagram_owners.json, so this cost is paid once.
"""

from __future__ import annotations

import json
import random
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE_PATH = HERE / "results" / "instagram_owners.json"

# A post link with no account in it. The /<user>/reel/<code>/ form is NOT here:
# that one already names the account, and extract_accounts.py reads it directly.
POST_RE = re.compile(
    r"https?://(?:www\.)?instagram\.com/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)", re.I
)

# One per attempt, so a retry asks as a different client. Which page variant
# Instagram serves varies per request, and varying the client is the only lever
# there is on which one comes back.
CLIENTS = [
    "curl/8.4.0",
    "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/60.0 Safari/537.36",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
]

# In order of how much they prove. The description tag is the one that actually
# fires; the others are kept because they cost nothing and Instagram's page
# shapes move around.
OWNER_PATTERNS = [
    # "816 likes, 414 comments - mavgpt on February 22, 2026:"
    re.compile(r'name="description"\s+content="[^"]*?-\s*([A-Za-z0-9_.]{1,30})\s+on\s'),
    re.compile(r'"owner"\s*:\s*\{[^{}]{0,300}?"username"\s*:\s*"([A-Za-z0-9_.]{1,30})"'),
    re.compile(r'"alternateName"\s*:\s*"@([A-Za-z0-9_.]{1,30})"'),
    re.compile(r'"username"\s*:\s*"([A-Za-z0-9_.]{1,30})"'),
]

# Words that are paths, not people. A malformed page could otherwise turn
# "explore" into an account with 400 videos.
NOT_A_HANDLE = {
    "p", "reel", "reels", "tv", "explore", "accounts", "direct", "stories",
    "instagram", "about", "developer", "legal", "privacy", "terms", "api",
}

MISS_RETRY_DAYS = 14


def post_code(url: str) -> str | None:
    """The shortcode in an Instagram post URL, or None if it is not one."""
    m = POST_RE.match((url or "").strip())
    return m.group(1) if m else None


def profile_url(handle: str) -> str:
    return f"https://www.instagram.com/{handle}/"


# ── the cache ────────────────────────────────────────────────────────────────
# code -> {"user": "<handle>" | null, "at": "<iso>"}. Misses are kept, not
# dropped: without them every run would re-fetch the same dead posts. They are
# retried after MISS_RETRY_DAYS, since a post can come back from private.


def load_cache(path: Path = CACHE_PATH) -> dict:
    try:
        with path.open(encoding="utf-8") as f:
            d = json.load(f)
        return d.get("owners", {}) if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_cache(owners: dict, path: Path = CACHE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump({"version": 1, "saved_at": _now(), "owners": owners}, f, indent=1)
    tmp.replace(path)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def stale_miss(entry: dict) -> bool:
    """Is this a recorded miss old enough to be worth another try?"""
    if entry.get("user"):
        return False
    try:
        at = datetime.fromisoformat(entry.get("at", ""))
    except ValueError:
        return True
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - at > timedelta(days=MISS_RETRY_DAYS)


# ── fetching ─────────────────────────────────────────────────────────────────


def _get(url: str, ua: str, timeout: int = 25) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": ua, "Accept-Language": "en-US,en;q=0.9"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError):
        return ""


def owner_in(html: str) -> str | None:
    for pat in OWNER_PATTERNS:
        m = pat.search(html)
        if m and m.group(1).lower() not in NOT_A_HANDLE:
            return m.group(1)
    return None


def resolve_http(code: str, attempts: int = 3) -> str | None:
    """One post, over plain HTTP. None when every attempt got the bare shell."""
    for i in range(attempts):
        html = _get(f"https://www.instagram.com/p/{code}/", CLIENTS[i % len(CLIENTS)])
        who = owner_in(html)
        if who:
            return who
        # A short, jittered pause: the variants differ per request, and hammering
        # the same code back to back is both rude and no more likely to work.
        if i + 1 < attempts:
            time.sleep(0.8 + random.random())
    return None


def resolve_many(
    codes: list[str],
    workers: int = 8,
    attempts: int = 3,
    cache: dict | None = None,
    cache_path: Path = CACHE_PATH,
    on_progress=None,
) -> dict:
    """Resolve many codes, reading and updating the cache.

    Returns the whole cache-shaped mapping so a caller can look up any code it
    asked about, cached or freshly fetched.
    """
    owners = cache if cache is not None else load_cache(cache_path)
    todo = [c for c in dict.fromkeys(codes) if c not in owners or stale_miss(owners[c])]
    if not todo:
        return owners

    lock = threading.Lock()
    done = 0

    def one(code: str):
        nonlocal done
        who = resolve_http(code, attempts)
        with lock:
            owners[code] = {"user": who, "at": _now()}
            done += 1
            if on_progress:
                on_progress(done, len(todo), code, who)
            # Written as we go: this is a long job over the network, and a run
            # stopped half way should keep what it paid for.
            if done % 50 == 0:
                save_cache(owners, cache_path)

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        list(pool.map(one, todo))
    save_cache(owners, cache_path)
    return owners


# ── the logged-in fallback ───────────────────────────────────────────────────


def resolve_with_browser(
    codes: list[str],
    cache: dict | None = None,
    cache_path: Path = CACHE_PATH,
    profile_dir: Path | None = None,
    headless: bool = False,
    on_progress=None,
) -> dict:
    """The ~15% plain HTTP will not give up, through the scraper's own browser.

    Uses browser_profile/, the same logged-in Chromium scraper.py drives, so it
    sees what a signed-in person sees. Slow and serial by nature — this is for
    finishing a job, not for doing all of it.
    """
    from playwright.sync_api import sync_playwright  # imported late: optional

    owners = cache if cache is not None else load_cache(cache_path)
    todo = [c for c in dict.fromkeys(codes) if not (owners.get(c) or {}).get("user")]
    if not todo:
        return owners

    pdir = profile_dir or (HERE / "browser_profile")
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            str(pdir), headless=headless, viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        for i, code in enumerate(todo, 1):
            who = None
            try:
                page.goto(f"https://www.instagram.com/p/{code}/",
                          wait_until="domcontentloaded", timeout=30000)
                # The header link to the author's profile is the whole point of
                # loading a browser: it is in the DOM even when the served HTML
                # carried no metadata.
                page.wait_for_timeout(1200)
                who = page.evaluate(
                    """() => {
                      const bad = new Set(['p','reel','reels','tv','explore','accounts','stories']);
                      for (const a of document.querySelectorAll('header a[href^="/"], article a[href^="/"]')) {
                        const m = a.getAttribute('href').match(/^\\/([A-Za-z0-9_.]{1,30})\\/?$/);
                        if (m && !bad.has(m[1])) return m[1];
                      }
                      return null;
                    }"""
                )
                if not who:
                    who = owner_in(page.content())
            except Exception:
                who = None
            owners[code] = {"user": who, "at": _now()}
            if on_progress:
                on_progress(i, len(todo), code, who)
            if i % 25 == 0:
                save_cache(owners, cache_path)
            time.sleep(0.6 + random.random())
        ctx.close()
    save_cache(owners, cache_path)
    return owners
