#!/usr/bin/env python3
"""
Scrape every video from a list of TikTok and Instagram accounts.

Reads an accounts CSV (the unique_accounts_*.csv produced by extract_accounts.py,
or any CSV with an `account_url`/`handle` column, or a plain list of profile
URLs), visits each profile, scrolls to load its videos, and records for each
video: the account name, video URL, view count, heart (like) count, posted date,
title, and a `state` column ("NEW" for everything this run scrapes).

Output goes to ONE FILE PER SITE, appended, so the two never mix:
  • TikTok    -> results/channel_videos_*.csv
  • Instagram -> results/instagram_videos_*.csv
Each appends to the newest file of its own kind, and only starts a new one when
there is none; --out overrides both and puts everything in a single file.
Routing is by the ROW's site, not by how the run was invoked, so an account
lands in the same file whether or not --platform was used.

Each channel is written and FLUSHED TO DISK the moment its scan finishes, along
with its entry in the sidecar scan state — stop a run at any point and every
channel that completed is already saved.

Behaviour per channel:
  • Channel ALREADY in the file → INCREMENTAL scan: save only its new videos and
    stop as soon as a NON-PINNED video that's already in the file is reached
    (pinned posts sit out-of-date-order at the top and are skipped, never a stop).
  • Brand-NEW channel → full scan up to CHANNEL_MAX_VIDEOS (default 400).
  • Channel whose LAST scan didn't finish (TikTok stopped serving) → automatic
    FULL re-scan, so a truncated prefix isn't frozen in place forever.
Rows already present are never re-written; new rows are marked state = "NEW".

Each run writes <out>.scan.json recording, per channel, how its scan ended and
how many videos the channel actually has (from the profile's own videoCount), so
short scrapes are reported instead of passing silently.

How it gets the stats: both sites load a profile's posts over XHR as you scroll,
and those responses already carry views/hearts/date/title — so we intercept them
instead of opening every post. TikTok answers on `/api/post/item_list/`;
Instagram on `/graphql/query` and `/api/v1/feed/user/`, in any of three JSON
shapes it still ships, so its responses are WALKED for post-shaped objects
rather than read at a fixed path. Uses the same persistent Chrome profile as
scraper.py, which is what gets past the bot walls — a real window opens; sign in
to both sites once.

Instagram differences worth knowing, all of them the site's doing and not ours:
  • view_count is always 0: Instagram sends no play count in the profile feed,
    for reels or anything else (checked field by field with probe_ig_counts.py).
  • share_count carries Instagram's repost count, its nearest equivalent.
  • the account column holds the bare handle, as it does for TikTok, and the url
    column is what says which site a row came from. The CSV columns are
    unchanged, so an existing channel_videos file keeps working.

Usage:
    python scrape_channels.py                         # newest results/unique_accounts_*.csv
    python scrape_channels.py --accounts my.csv
    python scrape_channels.py https://www.tiktok.com/@handle https://www.instagram.com/handle/
    python scrape_channels.py --platform instagram    # only the Instagram accounts
    python scrape_channels.py --out results/one_file.csv   # force both into one file
    python scrape_channels.py --start-at studywithlaia  # resume from this account
    python scrape_channels.py --rescan calandcoffee   # re-scan ONE channel in full
    python scrape_channels.py --rescan                # re-scan every channel in full
"""
import argparse
import csv
import glob
import json
import os
import random
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

load_dotenv()

BROWSER_PROFILE_DIR = os.getenv("BROWSER_PROFILE_DIR", "./browser_profile")
VIEWPORT_WIDTH      = int(os.getenv("VIEWPORT_WIDTH", "1280"))
VIEWPORT_HEIGHT     = int(os.getenv("VIEWPORT_HEIGHT", "800"))
SCROLL_DELAY_MIN    = float(os.getenv("SCROLL_DELAY_MIN", "4.5"))
SCROLL_DELAY_MAX    = float(os.getenv("SCROLL_DELAY_MAX", "9.0"))
MAX_SCROLL_ATTEMPTS = int(os.getenv("CHANNEL_MAX_SCROLLS", "300"))
MAX_STALE_SCROLLS   = int(os.getenv("CHANNEL_MAX_STALE", "8"))
MAX_VIDEOS_PER_CHANNEL = int(os.getenv("CHANNEL_MAX_VIDEOS", "50"))  # stop after this many per channel
# Incremental scans never STOP on one of the first N items: pinned posts (TikTok
# allows up to 3, always shown first, out of date order) live there. So an old
# pinned video that's already in the file can't end the scan prematurely.
PINNED_SKIP_TOP     = int(os.getenv("CHANNEL_PIN_SKIP", "5"))
# A full scan that dried up at or below this many videos, with no videoCount to
# check against, is treated as THROTTLED rather than exhausted — TikTok serves
# ~30 videos per item_list page, so stopping around one or two pages is the
# signature of being cut off, not of a channel that small.
BATCH_STALL_MAX     = int(os.getenv("CHANNEL_BATCH_STALL_MAX", "70"))
PAGE_LOAD_TIMEOUT   = int(os.getenv("CHANNEL_LOAD_TIMEOUT_MS", "60000"))

RESULTS_DIR = Path(__file__).parent / "results"
HANDLE_RE   = re.compile(r"tiktok\.com/@([A-Za-z0-9._]+)")
# An Instagram PROFILE, which is any first path segment that is not one of the
# app's own routes. /p/<code>/ and /reel/<code>/ are posts, not accounts.
IG_HANDLE_RE = re.compile(
    r"instagram\.com/(?!p/|reel/|reels/|tv/|explore/|accounts/|stories/)([A-Za-z0-9._]+)", re.I
)
FIELDS = ["account", "url", "view_count", "heart_count", "comment_count",
          "share_count", "posted_date", "title", "bio", "state"]
COMMENT_FIELDS = ["account", "video_url", "video_title",
                  "comment_user", "comment_text", "comment_likes", "comment_date"]


# How the last scan of a channel ended, recorded in a sidecar JSON next to the
# output CSV (<out>.scan.json). The CSV schema is consumed by the dashboard, so
# per-channel bookkeeping lives outside it.
#
# Why it matters: a channel is only scanned INCREMENTALLY (stop at the first
# already-known video) when the previous scan reached the end of the channel. If
# the previous scan merely STALLED — TikTok stopped answering /api/post/item_list,
# which is indistinguishable from "no more videos" by scrolling alone — then the
# stored rows are a truncated prefix, and going incremental would freeze that gap
# forever: every later run stops at the newest known video and never reaches the
# missing older ones.
COMPLETE_ENDINGS = {"caught_up", "exhausted", "cap"}


def scan_state_path(out_path: Path) -> Path:
    return out_path.with_suffix(out_path.suffix + ".scan.json")


def load_scan_state(out_path: Path) -> dict:
    try:
        return json.loads(scan_state_path(out_path).read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_scan_state(out_path: Path, state: dict) -> None:
    try:
        scan_state_path(out_path).write_text(
            json.dumps(state, indent=1, sort_keys=True), encoding="utf-8"
        )
    except Exception:
        pass


def get_profile_bio(page) -> str:
    """The channel's bio/signature from the profile's rehydration JSON.

    Same source as get_profile_video_count — no extra request. It's a property of
    the CHANNEL, so it is stamped onto every one of that channel's rows: the
    dashboard's verify list works link-by-link, and seeing "AI humanizer • link in
    bio" next to a video is what makes it judgeable without opening it."""
    try:
        raw = page.evaluate("""() => {
            try {
                const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
                if (!el) return '';
                const data = JSON.parse(el.textContent || '{}');
                let found = '';
                const walk = (o, depth) => {
                    if (found || !o || typeof o !== 'object' || depth > 8) return;
                    if (typeof o.signature === 'string' && o.signature.trim()) { found = o.signature; return; }
                    for (const k of Object.keys(o)) walk(o[k], depth + 1);
                };
                walk(data, 0);
                return found;
            } catch (e) { return ''; }
        }""") or ""
    except Exception:
        return ""
    # Collapse newlines/runs of spaces so the CSV stays one row per link.
    return " ".join(str(raw).split())


def get_profile_video_count(page) -> int:
    """The channel's TRUE video count, from the profile's rehydration JSON.

    Lets us tell a genuinely exhausted channel from one TikTok stopped serving:
    if we collected far fewer than this, the scan was truncated. Returns 0 when
    the value can't be found (older layout / blocked page)."""
    try:
        return int(page.evaluate("""() => {
            try {
                const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
                if (!el) return 0;
                const data = JSON.parse(el.textContent || '{}');
                let found = 0;
                const walk = (o, depth) => {
                    if (found || !o || typeof o !== 'object' || depth > 8) return;
                    if (typeof o.videoCount === 'number' && o.videoCount > 0) { found = o.videoCount; return; }
                    for (const k of Object.keys(o)) walk(o[k], depth + 1);
                };
                walk(data, 0);
                return found;
            } catch (e) { return 0; }
        }""") or 0)
    except Exception:
        return 0


def _int(v) -> int:
    try:
        return int(str(v).replace(",", "").strip())
    except Exception:
        return 0


def _fmt_date(ts) -> str:
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return ""


def platform_of(url: str) -> str:
    """Which site a profile or video URL belongs to."""
    return "instagram" if "instagram.com" in (url or "").lower() else "tiktok"


def account_key(platform: str, handle: str) -> str:
    """The key a channel's stored rows and scan state live under.

    TikTok keeps the bare handle it has always used, so every existing entry in
    channel_videos.scan.json still matches and no channel gets needlessly
    re-scanned in full. Instagram is prefixed, because the same name exists on
    both sites — @studywitharyana is a real person on TikTok AND on Instagram,
    and one shared key would let one account's videos end another's scan.
    """
    h = (handle or "").lower()
    return h if platform == "tiktok" else f"ig:{h}"


def load_accounts(accounts_file: str, positional: list[str]) -> list[dict]:
    """Return [{handle, url, platform}] from a CSV or a list of profile URLs.

    unique_accounts_*.csv already carries a `platform` column; anything else is
    judged by the URL. A bare handle with no URL is taken as TikTok, which is
    what it has always meant here.
    """
    out, seen = [], set()

    def add(url: str, handle: str = "", platform: str = ""):
        url = (url or "").strip()
        plat = (platform or "").strip().lower() or platform_of(url)
        if plat not in ("tiktok", "instagram"):
            return
        if not handle:
            m = (IG_HANDLE_RE if plat == "instagram" else HANDLE_RE).search(url)
            handle = m.group(1) if m else ""
        handle = handle.lstrip("@")
        key = account_key(plat, handle)
        if not handle or key in seen:
            return
        seen.add(key)
        out.append({
            "handle": handle,
            "platform": plat,
            "url": (f"https://www.instagram.com/{handle}/" if plat == "instagram"
                    else f"https://www.tiktok.com/@{handle}"),
        })

    if accounts_file:
        text = Path(accounts_file).read_text(encoding="utf-8", errors="ignore")
        head = next((ln for ln in text.splitlines() if ln.strip()), "")
        if "," in head and ("account_url" in head.lower() or "handle" in head.lower() or "url" in head.lower()):
            import io
            for row in csv.DictReader(io.StringIO(text)):
                add(row.get("account_url") or row.get("url") or "",
                    (row.get("handle") or "").strip(),
                    (row.get("platform") or "").strip())
        else:
            for line in text.splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    add(line)
    for u in positional or []:
        add(u)
    return out


def scrape_profile(page, acct: dict, handle_holder: dict, incremental: bool) -> dict:
    """Navigate one profile and scroll to load its videos. Video items arrive via
    the response handler into handle_holder['collected'] (id -> row).

    Two stop modes:
      • FULL scan (new channel)  → stop at the per-channel cap (CHANNEL_MAX_VIDEOS)
        or when the whole channel is loaded (stale scrolls).
      • INCREMENTAL (channel already in the file) → stop as soon as we reach a
        NON-PINNED video that is already in the file (handle_holder['caught_up'],
        set by the response handler). Pinned videos sit out-of-order at the top and
        are old, so they never trigger the stop.

    Returns {ended, collected, video_count} where `ended` is one of:
      caught_up  — incremental reached known content (clean)
      cap        — hit CHANNEL_MAX_VIDEOS (clean)
      exhausted  — scrolling dried up AND we have ~all of the channel (clean)
      stalled    — scrolling dried up but far short of the channel's videoCount,
                   i.e. TikTok stopped answering. NOT clean: the stored rows are a
                   truncated prefix and this channel must be re-scanned in full.
      max_scrolls / load_failed — abnormal endings, also treated as not clean.
    """
    collected = handle_holder["collected"]
    url = acct["url"]
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
    except PlaywrightTimeoutError:
        print("    · profile load timed out")
        return {"ended": "load_failed", "collected": 0, "video_count": 0, "bio": ""}
    time.sleep(random.uniform(2.5, 4.0))

    video_count = get_profile_video_count(page)
    bio = get_profile_bio(page)

    def result(ended: str) -> dict:
        return {"ended": ended, "collected": len(collected),
                "video_count": video_count, "bio": bio}

    # Scroll to the bottom repeatedly; each scroll triggers the next item_list XHR.
    last = -1
    stale = 0
    for _ in range(MAX_SCROLL_ATTEMPTS):
        if incremental:
            if handle_holder.get("caught_up"):
                return result("caught_up")  # reached previously-scraped content
        elif len(collected) >= MAX_VIDEOS_PER_CHANNEL:
            return result("cap")
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))
        n = len(collected)
        if n == last:
            stale += 1
            if stale >= MAX_STALE_SCROLLS:
                # Scrolling stopped producing videos. That is EITHER the end of the
                # channel OR TikTok throttling us — the scroll loop alone can't tell.
                #
                # Collecting NOTHING is the clearest tell: a profile that served no
                # item_list response at all was blocked, not empty. TikTok also
                # withholds the rehydration JSON on a blocked page, so video_count
                # is 0 in exactly the cases we most need it — never read that as
                # "channel exhausted".
                if len(collected) == 0:
                    return result("stalled")
                # With a known videoCount, only call it exhausted when we actually hold
                # ~all of them. An incremental pass legitimately sees just the new ones,
                # so it is judged against what's already on file.
                have = len(collected) + (len(handle_holder.get("existing_urls") or ()) if incremental else 0)
                if video_count and have < video_count * 0.9:
                    return result("stalled")
                # videoCount unavailable: a full scan that dried up on a batch boundary
                # is far more likely throttling than a channel that owns one page.
                if not video_count and not incremental and len(collected) <= BATCH_STALL_MAX:
                    return result("stalled")
                return result("exhausted")
        else:
            stale = 0
            last = n
    return result("max_scrolls")


# ── Instagram ────────────────────────────────────────────────────────────────
# Same shape of job as TikTok — open the profile, scroll, and read the JSON the
# page fetches for itself — but Instagram has rewritten that JSON three times and
# ships all three: the modern GraphQL feed
# (xdt_api__v1__feed__user_timeline_graphql_connection), the older one
# (edge_owner_to_timeline_media), and a plain REST list ({"items": [...]}).
#
# So rather than parse a named path that will move again, this WALKS the
# response for anything that looks like a post: a dict carrying a shortcode and
# a timestamp. That is the one thing all three shapes agree on, and it survives
# the next rename.

IG_XHR_BITS = ("/graphql/query", "/api/v1/feed/user/", "web_profile_info",
               "/api/graphql")
IG_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{5,24}$")


def _first(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v not in (None, "", 0):
            return v
    return None


def _ig_media_nodes(obj, out: list, depth: int = 0) -> None:
    """Every post-shaped dict anywhere in a response."""
    if depth > 14 or len(out) > 50:
        return
    if isinstance(obj, list):
        for v in obj:
            _ig_media_nodes(v, out, depth + 1)
        return
    if not isinstance(obj, dict):
        return
    code = obj.get("code") or obj.get("shortcode")
    ts = _first(obj, "taken_at", "taken_at_timestamp")
    if isinstance(code, str) and IG_CODE_RE.match(code) and ts:
        out.append(obj)
        # Do NOT walk into it: a carousel's children repeat the parent's fields
        # and would be saved as separate posts.
        return
    for v in obj.values():
        _ig_media_nodes(v, out, depth + 1)


def _ig_caption(node: dict) -> str:
    cap = node.get("caption")
    if isinstance(cap, dict):
        return str(cap.get("text") or "")
    if isinstance(cap, str):
        return cap
    edges = ((node.get("edge_media_to_caption") or {}).get("edges") or [])
    if edges:
        return str((edges[0].get("node") or {}).get("text") or "")
    return ""


def _ig_count(node: dict, direct: tuple, *nested: str) -> int:
    """A count that is either a plain field or an edge's {"count": n}."""
    v = _first(node, *direct)
    if v is not None:
        return _int(v)
    for key in nested:
        sub = node.get(key)
        if isinstance(sub, dict) and sub.get("count") is not None:
            return _int(sub["count"])
    return 0


def ig_owner_names(node: dict) -> set:
    """Every handle that can legitimately claim this post.

    Usually just the poster. A collaboration is the exception: Instagram shows
    the same post on each collaborator's profile, and lists the others in
    coauthor_producers — so those count as owners too, or a genuine post would
    be dropped from the profile it appears on.
    """
    names = set()
    for key in ("user", "owner"):
        who = node.get(key)
        if isinstance(who, dict) and who.get("username"):
            names.add(str(who["username"]).lower())
    co = node.get("coauthor_producers")
    if isinstance(co, list):
        for c in co:
            if isinstance(c, dict) and c.get("username"):
                names.add(str(c["username"]).lower())
    return names


def ig_owned_by(node: dict, handle: str) -> bool:
    """Is this post the given account's — as opposed to a suggestion?

    A post with no owner named at all is REFUSED. That is the shape a stray
    response takes, and letting it through is how a stranger's video ends up
    filed under someone else's name.
    """
    if not handle:
        return False
    return handle.lower() in ig_owner_names(node)


def ig_row(node: dict, fallback_handle: str) -> dict | None:
    code = node.get("code") or node.get("shortcode")
    if not isinstance(code, str) or not IG_CODE_RE.match(code):
        return None
    owner = node.get("user") or node.get("owner") or {}
    author = (owner.get("username") if isinstance(owner, dict) else None) or fallback_handle
    return {
        "account": author,
        "url": f"https://www.instagram.com/p/{code}/",
        # Always 0 in practice. Instagram sends no play count in the profile
        # feed at all — dumping every count-ish field of a real reel node
        # (probe_ig_counts.py) turns up like_count, comment_count,
        # media_repost_count and nothing else. The keys are still read in case
        # some account or some future response does carry one.
        "view_count": _ig_count(node, ("play_count", "video_view_count", "ig_play_count", "view_count")),
        "heart_count": _ig_count(node, ("like_count",), "edge_liked_by", "edge_media_preview_like"),
        "comment_count": _ig_count(node, ("comment_count",), "edge_media_to_comment",
                                   "edge_media_preview_comment"),
        # Instagram's nearest thing to a share: how many times the post was
        # reposted. Not the same number TikTok reports, but real and comparable
        # within Instagram.
        "share_count": _ig_count(node, ("media_repost_count", "reshare_count")),
        "posted_date": _fmt_date(_first(node, "taken_at", "taken_at_timestamp")),
        "title": _ig_caption(node).replace("\n", " ").strip(),
    }


def _ig_num(text) -> int:
    """"676", "1,234" or "1.3M" as a number. 0 when it is not one.

    Instagram rounds big figures in its own UI. A rounded post count is still
    worth having: it is only ever compared against what we collected, to tell a
    finished scan from a truncated one, and 1.3M vs 1,300,000 does not change
    that answer.
    """
    s = str(text or "").strip().replace(",", "")
    m = re.match(r"^([\d.]+)\s*([KMB]?)$", s, re.I)
    if not m:
        return 0
    try:
        n = float(m.group(1))
    except ValueError:
        return 0
    return int(n * {"": 1, "K": 1_000, "M": 1_000_000, "B": 1_000_000_000}[m.group(2).upper()])


def ig_profile_info(page, handle: str) -> dict:
    """Post count and bio — the Instagram equivalents of TikTok's videoCount and
    signature, which decide whether a scan finished and what every row carries.

    Read from the PAGE, not from an API. The obvious call,
    /api/v1/users/web_profile_info/, answers 429 even from inside a logged-in
    session (probe_ig_info.py), so it is not something to depend on. What the
    profile document always carries is its own description tag:

        1M Followers, 625 Following, 676 Posts - Maverick Maltin (@mavgpt)
        on Instagram: "<the bio>"

    which holds both numbers we need. The rendered header ("676 posts", then the
    bio) is the fallback for when that tag is missing.
    """
    try:
        info = page.evaluate(
            """() => {
              const out = {count: 0, bio: ''};
              const meta = document.querySelector('meta[name="description"]')?.content
                        || document.querySelector('meta[property="og:description"]')?.content || '';
              const posts = meta.match(/([\\d.,]+[KMB]?)\\s+Posts?\\b/i);
              if (posts) out.count = posts[1];
              const bio = meta.match(/on Instagram:\\s*"([\\s\\S]*)"\\s*$/);
              if (bio) out.bio = bio[1];

              if (!out.count || !out.bio) {
                const head = (document.querySelector('header')?.innerText || '');
                const hp = head.match(/([\\d.,]+[KMB]?)\\s+posts?\\b/i);
                if (!out.count && hp) out.count = hp[1];
                if (!out.bio) {
                  // Everything after the counts line is the bio.
                  const lines = head.split('\\n').map(s => s.trim()).filter(Boolean);
                  const i = lines.findIndex(l => /\\bfollowing\\b/i.test(l));
                  if (i >= 0) out.bio = lines.slice(i + 1)
                    .filter(l => !/^(Follow|Message|more|Following)$/i.test(l)).join(' ');
                }
              }
              return out;
            }"""
        )
    except Exception:
        info = None
    if not info:
        return {"count": 0, "bio": ""}
    return {"count": _ig_num(info.get("count")),
            "bio": " ".join(str(info.get("bio") or "").split())}


def scrape_instagram_profile(page, acct: dict, handle_holder: dict, incremental: bool) -> dict:
    """One Instagram profile, with the same endings scrape_profile reports.

    Deliberately the same contract — ended / collected / video_count / bio — so
    the caller, the sidecar scan state and the "did this finish?" rule need to
    know nothing about which site a channel is on.
    """
    collected = handle_holder["collected"]
    try:
        page.goto(acct["url"], wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
    except PlaywrightTimeoutError:
        print("    · profile load timed out")
        return {"ended": "load_failed", "collected": 0, "video_count": 0, "bio": ""}
    time.sleep(random.uniform(2.5, 4.0))

    # A login wall answers every scroll with nothing, which would otherwise be
    # reported as an empty channel.
    if "/accounts/login" in page.url:
        print("    · Instagram wants a login — sign in once in this window")
        return {"ended": "load_failed", "collected": 0, "video_count": 0, "bio": ""}

    info = ig_profile_info(page, acct["handle"])
    video_count, bio = info["count"], info["bio"]

    def result(ended: str) -> dict:
        return {"ended": ended, "collected": len(collected),
                "video_count": video_count, "bio": bio}

    last, stale = -1, 0
    for _ in range(MAX_SCROLL_ATTEMPTS):
        if incremental:
            if handle_holder.get("caught_up"):
                return result("caught_up")
        elif len(collected) >= MAX_VIDEOS_PER_CHANNEL:
            return result("cap")
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))
        n = len(collected)
        if n == last:
            stale += 1
            if stale >= MAX_STALE_SCROLLS:
                # Same reasoning as the TikTok scan: nothing collected means we
                # were blocked, not that the account is empty, and a scan far
                # short of the real post count is truncated rather than finished.
                if len(collected) == 0:
                    return result("stalled")
                have = len(collected) + (len(handle_holder.get("existing_urls") or ())
                                         if incremental else 0)
                if video_count and have < video_count * 0.9:
                    return result("stalled")
                if not video_count and not incremental and len(collected) <= BATCH_STALL_MAX:
                    return result("stalled")
                return result("exhausted")
        else:
            stale = 0
            last = n
    return result("max_scrolls")


def scrape_video_comments(page, video_url: str, handle_holder: dict, max_scrolls: int) -> list[dict]:
    """Open one video and scroll its comment panel, collecting comments (user,
    text, likes, date) from the intercepted /api/comment/list/ XHR. Returns them."""
    handle_holder["comments"] = []
    handle_holder["comment_seen"] = set()
    try:
        page.goto(video_url, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
    except PlaywrightTimeoutError:
        return handle_holder["comments"]
    time.sleep(random.uniform(2.0, 3.5))

    last, stale = -1, 0
    for _ in range(max_scrolls):
        try:
            page.evaluate(
                """() => {
                  const sels = ["[data-e2e='comment-list']",
                                "div[class*='CommentListContainer']",
                                "div[class*='DivCommentListContainer']"];
                  let c = null;
                  for (const s of sels) { c = document.querySelector(s); if (c) break; }
                  if (c) c.scrollTop = c.scrollHeight;
                  else window.scrollTo(0, document.body.scrollHeight);
                }"""
            )
        except Exception:
            pass
        time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))
        n = len(handle_holder["comments"])
        if n == last:
            stale += 1
            if stale >= 4:
                break
        else:
            stale, last = 0, n
    return handle_holder["comments"]


def main():
    ap = argparse.ArgumentParser(description="Scrape all posts (views/hearts/date/title) from TikTok and Instagram accounts.")
    ap.add_argument("urls", nargs="*", help="TikTok profile URLs (optional if --accounts / a default CSV is used).")
    ap.add_argument("--accounts", default="", help="Accounts CSV (default: newest results/unique_accounts_*.csv).")
    ap.add_argument("--platform", default="", choices=["", "tiktok", "instagram"],
                    help="Scrape only this site's accounts (default: both).")
    ap.add_argument("--out", default="", help="Output CSV path (default: append to the newest results/channel_videos_*.csv).")
    ap.add_argument("--resume", action="store_true", help="(Obsolete) — channels in the file are always scanned incrementally now.")
    ap.add_argument("--start-at", default="", metavar="HANDLE",
                    help="Begin at this account and skip everything before it in the list. Use it to "
                         "resume a run that stopped part way instead of re-walking the channels that "
                         "already finished. Accepts a handle, @handle or a full profile URL.")
    ap.add_argument("--rescan", nargs="?", const="*", default="",
                    help="Force a FULL re-scan instead of an incremental one, to recover videos an "
                         "earlier truncated scan never reached. Bare --rescan does every channel in "
                         "this run; --rescan handle1,handle2 does just those. Already-stored videos "
                         "are never re-written — only the missing older ones are added.")
    ap.add_argument("--comments", action="store_true",
                    help="ALSO scrape each video's comments (user/text/likes/date) → results/channel_comments_<ts>.csv. "
                         "Much slower: it opens every video.")
    ap.add_argument("--comment-scrolls", type=int, default=15,
                    help="Max scrolls of a video's comment panel (default 15).")
    args = ap.parse_args()

    accounts_file = args.accounts
    if not accounts_file and not args.urls:
        found = sorted(glob.glob(str(RESULTS_DIR / "unique_accounts_*.csv")))
        if not found:
            raise SystemExit("No --accounts given and no results/unique_accounts_*.csv found.")
        accounts_file = found[-1]
        print(f"Using accounts file: {accounts_file}")

    accounts = load_accounts(accounts_file, args.urls)
    if args.platform:
        before = len(accounts)
        accounts = [a for a in accounts if a["platform"] == args.platform]
        print(f"[*] --platform {args.platform}: {len(accounts)} of {before} account(s)")
    if not accounts:
        raise SystemExit("No accounts to scrape.")

    # --start-at: resume the list from one account onward. Applied here, before
    # anything else reads `accounts`, so the counts, the --rescan check and the
    # progress numbers all describe the run that will actually happen.
    if args.start_at:
        want = args.start_at.strip()
        # A full profile URL is fine too, from either site.
        m = HANDLE_RE.search(want) or IG_HANDLE_RE.search(want)
        want = (m.group(1) if m else want).lstrip("@").lower()
        idx = next((i for i, a in enumerate(accounts) if a["handle"].lower() == want), -1)
        if idx < 0:
            raise SystemExit(
                f"--start-at '{args.start_at}': no such account in this list. "
                f"({len(accounts)} loaded; first is @{accounts[0]['handle']})"
            )
        skipped = idx
        accounts = accounts[idx:]
        print(f"[*] --start-at @{accounts[0]['handle']}: skipping {skipped} earlier account(s), "
              f"{len(accounts)} to go.")

    # --rescan: "*" (bare flag) = every channel this run; otherwise a
    # comma-separated handle list. Leading "@" is tolerated.
    rescan_all = args.rescan == "*"
    rescan_handles = set()
    if args.rescan and not rescan_all:
        rescan_handles = {h.strip().lstrip("@").lower() for h in args.rescan.split(",") if h.strip()}
        unknown = rescan_handles - {a["handle"].lower() for a in accounts}
        if unknown:
            print(f"[!] --rescan named channel(s) not in this run: {', '.join(sorted(unknown))}")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    # ── Where rows go ────────────────────────────────────────────────────────
    # One file per site: TikTok keeps channel_videos_*.csv, Instagram gets its
    # own instagram_videos_*.csv. Routing is by the ROW's platform, never by how
    # the run was invoked — otherwise `--platform instagram` and a plain run
    # would put the same account in two different files, and each would then
    # look brand new to the other, re-scanning the whole profile and duplicating
    # every post.
    #
    # Within a file the behaviour is unchanged: append to the newest one that
    # exists, so incremental scans keep working, and only start a new file when
    # there is none. --out overrides both and puts everything in one file.
    FILE_PREFIX = {"tiktok": "channel_videos", "instagram": "instagram_videos"}

    def newest_or_new(prefix: str) -> Path:
        found = sorted(glob.glob(str(RESULTS_DIR / f"{prefix}_*.csv")))
        return Path(found[-1]) if found else (RESULTS_DIR / f"{prefix}_{ts}.csv")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    if args.out:
        forced = Path(args.out)
        forced.parent.mkdir(parents=True, exist_ok=True)
        sink_paths = {"tiktok": forced, "instagram": forced}
    else:
        sink_paths = {p: newest_or_new(pref) for p, pref in FILE_PREFIX.items()}

    # Only the files this run will actually write to — a TikTok-only run must not
    # create an empty Instagram file.
    live_platforms = {a["platform"] for a in accounts}
    open_paths: list[Path] = []
    for p in live_platforms:
        if sink_paths[p] not in open_paths:
            open_paths.append(sink_paths[p])

    # What is already on file: URLs per channel (for the incremental stop) and a
    # global set (so a duplicate is never written). Read from EVERY output file
    # this run touches, so a row cannot be written twice just because the two
    # sites are stored apart.
    existing_urls_by_handle: dict[str, set] = {}
    all_existing_urls: set = set()
    has_rows: dict[Path, bool] = {}
    for path in open_paths:
        has_rows[path] = path.exists() and path.stat().st_size > 0
        if not has_rows[path]:
            continue
        try:
            with open(path, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    u = (row.get("url") or "").strip()
                    h = (row.get("account") or "").strip().lower()
                    if not u:
                        continue
                    all_existing_urls.add(u)
                    # Keyed by platform+handle, read off the row's own URL: the
                    # same name exists on both sites.
                    existing_urls_by_handle.setdefault(
                        account_key(platform_of(u), h), set()).add(u)
        except Exception:
            pass

        # Some editors strip a file's trailing newline; without it our first
        # appended row would be glued onto the last existing one.
        try:
            with open(path, "rb") as fb:
                fb.seek(-1, 2)
                last_byte = fb.read(1)
            if last_byte not in (b"\n", b"\r"):
                with open(path, "a", encoding="utf-8", newline="") as fb:
                    fb.write("\r\n")
        except Exception:
            pass

    # How each channel's last scan ended (sidecar JSON, one per output file). A
    # channel whose previous scan did NOT finish cleanly is re-scanned in full
    # automatically — otherwise its truncated prefix would be frozen in place
    # forever.
    scan_states: dict[Path, dict] = {p: load_scan_state(p) for p in open_paths}

    def wants_full(acct: dict) -> tuple[bool, str]:
        """(force a full scan?, why) for this channel."""
        h = acct["handle"].lower()
        if rescan_all or h in rescan_handles:
            return True, "--rescan"
        state = scan_states.get(sink_paths[acct["platform"]], {})
        prev = (state.get(account_key(acct["platform"], h)) or {}).get("ended")
        if prev and prev not in COMPLETE_ENDINGS:
            return True, f"last scan ended '{prev}'"
        return False, ""

    # EVERY account is scraped. A channel already in the file is scanned
    # INCREMENTALLY: save only its new videos and stop at the first non-pinned
    # video that's already in the file. A brand-new channel — or one being
    # re-scanned — gets the normal CHANNEL_MAX_VIDEOS full scan. All saved rows
    # get state = "NEW".
    pending = accounts
    n_stored = [a for a in accounts
                if existing_urls_by_handle.get(account_key(a["platform"], a["handle"]))]
    n_forced = sum(1 for a in n_stored if wants_full(a)[0])
    n_existing = len(n_stored) - n_forced
    n_ig = sum(1 for a in accounts if a["platform"] == "instagram")
    print(f"{len(accounts)} account(s) — {n_existing} incremental, "
          f"{len(accounts) - len(n_stored)} full scan"
          + (f", {n_forced} FORCED re-scan" if n_forced else "")
          + (f"  ({len(accounts) - n_ig} TikTok, {n_ig} Instagram)" if n_ig else ""))
    for path in open_paths:
        sites = ", ".join(sorted(pl for pl in live_platforms if sink_paths[pl] == path))
        print(f"    {sites} → {path}" + ("" if has_rows.get(path) else "   (new file)"))
    print()

    total_videos = 0
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(Path(BROWSER_PROFILE_DIR).resolve()),
            headless=False,
            channel="chrome",
            args=["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
            viewport={"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
            locale="en-US",
        )
        time.sleep(4)
        page = context.pages[0] if context.pages else context.new_page()
        # Block heavy media (not the JSON XHR) to speed up scrolling.
        # Heavy media is dropped (never the JSON XHR) to make scrolling cheap.
        # TikTok's feed pages regardless; Instagram's grid does NOT — it loads
        # the next batch as thumbnails come into view, so blocking images stops
        # it after the first screenful. So the filter is turned off for the
        # Instagram accounts and back on for the TikTok ones.
        MEDIA_GLOB = "**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,webm}"
        blocking_media = False

        def block_media(on: bool):
            nonlocal blocking_media
            if on == blocking_media:
                return
            if on:
                page.route(MEDIA_GLOB, lambda r: r.abort())
            else:
                try:
                    page.unroute(MEDIA_GLOB)
                except Exception:
                    pass
            blocking_media = on

        block_media(True)

        handle_holder: dict = {}
        page.on("response", make_response_handler_shared(handle_holder))
        # ^ shared collected dict lives on the handler; see wrapper below.

        # Optional per-comment output (only with --comments).
        comment_f = None
        comment_writer = None
        total_comments = 0
        if args.comments:
            comments_path = RESULTS_DIR / f"channel_comments_{ts}.csv"
            comment_f = open(comments_path, "w", newline="", encoding="utf-8")
            comment_writer = csv.DictWriter(comment_f, fieldnames=COMMENT_FIELDS)
            comment_writer.writeheader()
            comment_f.flush()
            print(f"Comments → {comments_path}")

        # One open handle per output file. Both stay open for the whole run and
        # are flushed after every channel, so the file on disk is complete up to
        # the last channel that finished — kill the run at any point and nothing
        # already scraped is lost.
        files = {}
        writers = {}
        for path in open_paths:
            fh = open(path, "a", newline="", encoding="utf-8")
            # extrasaction='ignore' lets rows carry the internal 'is_pinned' flag
            # without it being written to the CSV.
            w = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore")
            if not has_rows.get(path):
                w.writeheader()
                fh.flush()
            files[path], writers[path] = fh, w

        try:
            for i, acct in enumerate(pending, 1):
                key = account_key(acct["platform"], acct["handle"])
                handle = acct["handle"].lower()
                existing_urls = existing_urls_by_handle.get(key)
                force_full, why = wants_full(acct)
                # A forced re-scan walks the whole profile again; already-stored
                # videos are filtered out below, so it only ADDS the missing ones.
                incremental = bool(existing_urls) and not force_full
                mode = "incremental" if incremental else ("FULL re-scan" if existing_urls else "full scan")
                site = "IG" if acct["platform"] == "instagram" else "TT"
                print(f"[{i}/{len(pending)}] {site} @{acct['handle']} — {mode}"
                      + (f"  ({why})" if force_full and existing_urls else ""))
                collected: dict = {}
                handle_holder["handle"] = acct["handle"]
                handle_holder["platform"] = acct["platform"]
                handle_holder["collected"] = collected                     # handler writes here
                handle_holder["existing_urls"] = existing_urls if incremental else None
                handle_holder["caught_up"] = False
                handle_holder["seen_count"] = 0
                block_media(acct["platform"] != "instagram")
                scrape = (scrape_instagram_profile if acct["platform"] == "instagram"
                          else scrape_profile)
                outcome = scrape(page, acct, handle_holder, incremental)

                # Keep only videos NOT already in the file; a full scan is still
                # capped at CHANNEL_MAX_VIDEOS. Every saved row is state = "NEW".
                new_rows = [v for v in collected.values() if v["url"] not in all_existing_urls]
                if not incremental:
                    new_rows = new_rows[:MAX_VIDEOS_PER_CHANNEL]
                out_path = sink_paths[acct["platform"]]
                for r in new_rows:
                    r["state"] = "NEW"
                    # Channel-level, so the same value lands on each of its links.
                    r["bio"] = outcome.get("bio", "")
                    writers[out_path].writerow(r)
                    all_existing_urls.add(r["url"])                        # no duplicates later this run
                    existing_urls_by_handle.setdefault(key, set()).add(r["url"])
                # This channel is finished: put it on disk now, rather than
                # leaving it in a buffer that a stopped run would throw away.
                files[out_path].flush()
                os.fsync(files[out_path].fileno())
                total_videos += len(new_rows)

                # Record how this scan ended so the next run knows whether the
                # stored rows are complete (incremental is safe) or truncated.
                have = len(existing_urls_by_handle.get(key) or ())
                scan_states[out_path][key] = {
                    "ended": outcome["ended"],
                    "collected": outcome["collected"],
                    "video_count": outcome["video_count"],
                    "stored": have,
                    "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
                save_scan_state(out_path, scan_states[out_path])

                vc = outcome["video_count"]
                shortfall = vc and have < vc
                print(f"    → {len(new_rows)} new video(s)"
                      + (f"; have {have} of {vc} on the channel" if vc else "")
                      + f"  [{outcome['ended']}]")
                if outcome["ended"] not in COMPLETE_ENDINGS:
                    site_name = "Instagram" if acct["platform"] == "instagram" else "TikTok"
                    print(f"    !! scan did NOT complete ({outcome['ended']}) — {site_name} likely "
                          f"stopped serving more. This channel will be re-scanned in full next run.")
                elif shortfall and vc - have > 5:
                    print(f"    !! only {have} of {vc} videos on file — run "
                          f"`python scrape_channels.py --rescan {acct['handle']}` to fill the gap.")

                # Optionally open each NEW video and scrape its comments.
                if args.comments and comment_writer is not None:
                    acct_comments = 0
                    for j, r in enumerate(new_rows, 1):
                        cs = scrape_video_comments(page, r["url"], handle_holder, args.comment_scrolls)
                        for c in cs:
                            comment_writer.writerow({
                                "account": r["account"], "video_url": r["url"], "video_title": r["title"],
                                "comment_user": c["user"], "comment_text": c["text"],
                                "comment_likes": c["likes"], "comment_date": c["date"],
                            })
                        comment_f.flush()
                        acct_comments += len(cs)
                        print(f"      · video {j}/{len(new_rows)}: {len(cs)} comment(s)")
                    total_comments += acct_comments
                    print(f"    → {acct_comments} comment(s) for @{acct['handle']}")

        finally:
            for fh in files.values():
                fh.close()

        if comment_f is not None:
            comment_f.close()
        context.close()

    print(f"\nDone. {total_videos} video(s) across {len(pending)} account(s):")
    for path in open_paths:
        print(f"    {path}")
    if args.comments:
        print(f"      {total_comments} comment(s) → results/channel_comments_{ts}.csv")


def make_response_handler_shared(handle_holder: dict):
    """One response handler that routes by URL:
      • /api/post/item_list  → video rows into handle_holder['collected']
      • /api/comment/list    → comment rows into handle_holder['comments']
    Both dicts/lists are swapped per account/video so we never re-register."""
    def on_response(resp):
        url = resp.url
        is_items = "/api/post/item_list" in url
        is_comments = "/api/comment/list" in url
        is_ig = any(bit in url for bit in IG_XHR_BITS)
        if not (is_items or is_comments or is_ig):
            return
        try:
            data = resp.json()
        except Exception:
            return
        if not isinstance(data, dict):
            return

        if is_ig:
            # Only while an Instagram channel is being scraped: the same page
            # fires these for its sidebar and suggestions too.
            if handle_holder.get("platform") != "instagram":
                return
            collected = handle_holder.get("collected")
            if collected is None:
                return
            existing_urls = handle_holder.get("existing_urls")
            want = (handle_holder.get("handle") or "").lower()
            nodes: list = []
            _ig_media_nodes(data, nodes)
            for node in nodes:
                # Only THIS account's posts. A profile page is not only the
                # profile: while it is open, Instagram also fetches suggested
                # reels and the signed-in user's own feed over the very same
                # /graphql/query endpoint, and those responses are post-shaped
                # too. Four strangers' posts landed in a 400-row scrape of
                # @laia.learning that way — filed under her name, carrying her
                # bio. Whose post it is, is in the post.
                if not ig_owned_by(node, want):
                    continue
                row = ig_row(node, handle_holder.get("handle") or "")
                if not row:
                    continue
                code = row["url"].rstrip("/").rsplit("/", 1)[-1]
                if code in collected:
                    continue
                handle_holder["seen_count"] = handle_holder.get("seen_count", 0) + 1
                pos = handle_holder["seen_count"]
                collected[code] = row
                # Instagram pins up to 3 posts to the top of a profile, out of
                # date order, exactly like TikTok — so an old pinned post must
                # never be read as "we have scrolled back to known content".
                pinned = bool(node.get("is_pinned") or node.get("timeline_pinned_user_ids")) \
                    or pos <= PINNED_SKIP_TOP
                if existing_urls is not None and not pinned and row["url"] in existing_urls:
                    handle_holder["caught_up"] = True
            return

        if is_items:
            collected = handle_holder.get("collected")
            if collected is None:
                return
            existing_urls = handle_holder.get("existing_urls")  # None = full scan
            for item in data.get("itemList") or []:
                vid = str(item.get("id") or "")
                if not vid:
                    continue
                # Position in the profile stream (1-based), across all batches — the
                # first few are the pinned posts.
                handle_holder["seen_count"] = handle_holder.get("seen_count", 0) + 1
                pos = handle_holder["seen_count"]
                author = ((item.get("author") or {}).get("uniqueId")
                          or handle_holder.get("handle") or "")
                stats = item.get("stats") or item.get("statsV2") or {}
                vurl = f"https://www.tiktok.com/@{author}/video/{vid}"
                # Pinned = TikTok's flag OR within the first PINNED_SKIP_TOP items.
                is_pinned = bool(item.get("isPinnedItem")) or pos <= PINNED_SKIP_TOP
                collected[vid] = {
                    "account": author,
                    "url": vurl,
                    "view_count": _int(stats.get("playCount")),
                    "heart_count": _int(stats.get("diggCount")),
                    "comment_count": _int(stats.get("commentCount")),
                    "share_count": _int(stats.get("shareCount")),
                    "posted_date": _fmt_date(item.get("createTime")),
                    "title": (item.get("desc") or "").replace("\n", " ").strip(),
                }
                # Incremental: a NON-PINNED video already in the file means we've
                # scrolled back to previously-scraped content → stop this channel.
                if existing_urls is not None and not is_pinned and vurl in existing_urls:
                    handle_holder["caught_up"] = True
        else:  # is_comments
            clist = handle_holder.get("comments")
            if clist is None:
                return
            seen = handle_holder.setdefault("comment_seen", set())
            for c in data.get("comments") or []:
                cid = str(c.get("cid") or "")
                if not cid or cid in seen:
                    continue
                seen.add(cid)
                clist.append({
                    "user": (c.get("user") or {}).get("unique_id") or "",
                    "text": (c.get("text") or "").replace("\n", " ").strip(),
                    "likes": _int(c.get("digg_count")),
                    "date": _fmt_date(c.get("create_time")),
                })
    return on_response


if __name__ == "__main__":
    main()
