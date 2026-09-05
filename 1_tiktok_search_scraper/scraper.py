"""
TikTok / YouTube Search Scraper
Reads config from .env, searches TikTok or YouTube for one or more phrases
(comma-separated in SEARCH_QUERY), and saves all unique video URLs with
like/view counts to a single CSV.

Usage:
    python scraper.py
    python scraper.py --query humanizer "ai writing" --max 100
    python scraper.py --platform youtube --query "ai writing" --content shorts
"""

import argparse
import csv
import os
import time
import random
import re
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

load_dotenv()

# ── Config (read from .env, with sensible fallbacks) ──────────────────────────
# Comma-separated list of search phrases, e.g. "humanizer,ai writing,paraphrase"
DEFAULT_QUERIES      = [q.strip() for q in os.getenv("SEARCH_QUERY", "").split(",") if q.strip()]
DEFAULT_MIN_VIDEOS   = int(os.getenv("MIN_VIDEOS", "1"))
DEFAULT_MAX_VIDEOS   = int(os.getenv("MAX_VIDEOS", "50"))
DEFAULT_OUTPUT_FILE  = os.getenv("OUTPUT_FILE", "")
VIEWPORT_WIDTH       = int(os.getenv("VIEWPORT_WIDTH", "1280"))
VIEWPORT_HEIGHT      = int(os.getenv("VIEWPORT_HEIGHT", "800"))
POPUP_WAIT           = float(os.getenv("POPUP_WAIT", "3"))
SCROLL_DELAY_MIN     = float(os.getenv("SCROLL_DELAY_MIN", "1.5"))
SCROLL_DELAY_MAX     = float(os.getenv("SCROLL_DELAY_MAX", "3.0"))
MAX_SCROLL_ATTEMPTS  = int(os.getenv("MAX_SCROLL_ATTEMPTS", "120"))
MAX_STALE_SCROLLS    = int(os.getenv("MAX_STALE_SCROLLS", "6"))
SCROLL_STEP_PX       = int(os.getenv("SCROLL_STEP_PX", "600"))
REQUIRE_LOGIN        = os.getenv("REQUIRE_LOGIN", "false").lower() in ("true", "yes", "1", "on")
BROWSER_PROFILE_DIR  = os.getenv("BROWSER_PROFILE_DIR", "./browser_profile")
# Platform: "tiktok" (default) or "youtube"
DEFAULT_PLATFORM     = os.getenv("PLATFORM", "tiktok").lower()
# YouTube content filter: "all" (default), "videos", or "shorts"
DEFAULT_YT_CONTENT   = os.getenv("YOUTUBE_CONTENT", "all").lower()
# Seconds to wait after each scroll (and after the initial page load) before
# harvesting — gives TikTok time to render the like counts for visible cards.
CARD_SETTLE_WAIT_MIN  = float(os.getenv("CARD_SETTLE_WAIT_MIN", "3.0"))
CARD_SETTLE_WAIT_MAX  = float(os.getenv("CARD_SETTLE_WAIT_MAX", "5.0"))
# How long (ms) to wait for the first video cards to appear after navigating to a search page
CARDS_LOAD_TIMEOUT_MS = int(os.getenv("CARDS_LOAD_TIMEOUT_MS", "60000"))
# ──────────────────────────────────────────────────────────────────────────────

# ── TikTok ────────────────────────────────────────────────────────────────────
VIDEO_LINK_SELECTOR = "a[href*='/@'][href*='/video/']"
VIDEO_URL_RE        = re.compile(r"https://www\.tiktok\.com/@[^/]+/video/\d+")
# TikTok image/slideshow posts (the "Photo" search tab) use /@user/photo/<id>.
PHOTO_LINK_SELECTOR = "a[href*='/@'][href*='/photo/']"
PHOTO_URL_RE        = re.compile(r"https://www\.tiktok\.com/@[^/]+/photo/\d+")


def click_search_tab(page, label: str) -> bool:
    """Click one of TikTok's search result tabs (Top/Users/Videos/LIVE/Photo)
    by its visible text. Returns True if the tab was found and clicked."""
    try:
        tab = page.get_by_test_id("tux-web-text").filter(
            has_text=re.compile(rf"^{re.escape(label)}$", re.IGNORECASE)
        ).first
        tab.wait_for(state="visible", timeout=8000)
        tab.click()
        return True
    except Exception:
        return False

# ── YouTube ───────────────────────────────────────────────────────────────────
# YouTube A/B-tests the title anchor id between `video-title-link` and
# `video-title`; match both so search-result videos are always found.
YT_VIDEO_SELECTOR  = "ytd-video-renderer a#video-title-link, ytd-video-renderer a#video-title"
YT_SHORTS_SELECTOR = "ytd-search a[href*='/shorts/']"
YT_VIDEO_URL_RE    = re.compile(r"https://www\.youtube\.com/watch\?v=[\w-]+$")
YT_SHORTS_URL_RE   = re.compile(r"https://www\.youtube\.com/shorts/[\w-]+$")

# ── Instagram ─────────────────────────────────────────────────────────────────
# The hashtag search grid renders posts/reels as anchors to /p/<code>/ or
# /reel/<code>/. Like counts and dates are not shown on the grid.
IG_POST_LINK_SELECTOR = "a[href*='/p/'], a[href*='/reel/']"
IG_POST_URL_RE        = re.compile(r"https://www\.instagram\.com/(?:p|reel)/[\w-]+")

# ── Reddit ────────────────────────────────────────────────────────────────────
# Search results link to post permalinks: /r/<sub>/comments/<id>/<slug>/.
# (Public — no login required.)
REDDIT_POST_LINK_SELECTOR = "a[href*='/comments/']"
REDDIT_POST_URL_RE        = re.compile(r"^https://www\.reddit\.com/r/[^/]+/comments/")


def clean_title(text: str) -> str:
    """Normalise a scraped caption/title: collapse all whitespace to single
    spaces and trim. Kept in Python so the injected JS needs no regex escapes."""
    return " ".join((text or "").split())


def parse_count_text(text: str) -> int:
    """Convert TikTok count strings like '1.2K', '18.5M', '847' to integers."""
    text = text.strip().upper().replace(",", "")
    if not text:
        return 0
    m = re.match(r'^([\d.]+)\s*([KM]?)$', text)
    if not m:
        return 0
    num = float(m.group(1))
    suffix = m.group(2)
    if suffix == "K":
        return int(num * 1_000)
    if suffix == "M":
        return int(num * 1_000_000)
    return int(num)


def get_card_details(anchor) -> tuple[str, str, str]:
    """Instantly read (like_count_text, posted_date_text, title) from the card.
    Call only after a page-level settle wait so the counts have already loaded.

    The title is the video's caption. TikTok search cards expose it a few ways
    depending on the layout, so try each: the caption element, then the cover
    image's alt text (TikTok sets it to the caption), then the anchor's own
    title/aria-label."""
    try:
        result = anchor.evaluate("""el => {
            const myUrl = (el.href || '').split('?')[0];
            let card = null, node = el;
            for (let i = 0; i < 20; i++) {
                node = node.parentElement;
                if (!node) break;
                const hasOther = Array.from(node.querySelectorAll('a[href*="/video/"]'))
                    .some(a => { const h = (a.href || '').split('?')[0]; return h && h !== myUrl; });
                if (hasOther) break;
                card = node;
            }
            if (!card) return ['', '', ''];
            const likesEl = card.querySelector('[data-e2e="video-views"]');
            const dateEl  = card.querySelector('[class*="DivTimeTag"]');
            const capEl =
                card.querySelector('[data-e2e="search-card-video-caption"]') ||
                card.querySelector('[data-e2e*="video-desc"]') ||
                card.querySelector('[data-e2e*="caption"]');
            const img = card.querySelector('img[alt]');
            let title = capEl ? capEl.innerText : '';
            if (!title && img) title = img.getAttribute('alt') || '';
            if (!title) title = el.getAttribute('title') || el.getAttribute('aria-label') || '';
            return [
                likesEl ? likesEl.innerText.trim() : '',
                dateEl  ? dateEl.innerText.trim()  : '',
                title,
            ];
        }""")
        return result[0], result[1], clean_title(result[2])
    except Exception:
        return "", "", ""


def parse_yt_count_text(text: str) -> int:
    """Convert YouTube view-count strings like '1.2M views', '847K views' to int."""
    text = re.sub(r'(?i)\s*views?\s*$', '', text).strip().upper().replace(",", "")
    if not text:
        return 0
    m = re.match(r'^([\d.]+)\s*([KMB]?)$', text)
    if not m:
        return 0
    num = float(m.group(1))
    suffix = m.group(2)
    if suffix == "K": return int(num * 1_000)
    if suffix == "M": return int(num * 1_000_000)
    if suffix == "B": return int(num * 1_000_000_000)
    return int(num)


def get_yt_video_details(anchor) -> tuple[str, str, str]:
    """Read (view_count_text, posted_date_text, title) from a ytd-video-renderer
    card. The anchor IS usually a#video-title, whose `title` attribute holds the
    full untruncated title — preferred over the visible (ellipsised) text."""
    try:
        result = anchor.evaluate("""el => {
            let card = el;
            for (let i = 0; i < 15; i++) {
                if (!card) break;
                if ((card.tagName || '').toLowerCase() === 'ytd-video-renderer') break;
                card = card.parentElement;
            }
            if (!card) return ['', '', ''];
            const titleEl = card.querySelector('#video-title, a#video-title, yt-formatted-string#video-title');
            const title =
                (titleEl && (titleEl.getAttribute('title') || titleEl.innerText)) ||
                el.getAttribute('title') || el.getAttribute('aria-label') || '';
            const spans = Array.from(card.querySelectorAll(
                '#metadata-line span.inline-metadata-item, #video-info span'
            ));
            let viewText = '', dateText = '';
            for (const s of spans) {
                const t = s.innerText.trim();
                if (!viewText && /view/i.test(t))  { viewText = t; continue; }
                if (!dateText && /ago|year|month|week|day|hour/i.test(t)) { dateText = t; }
            }
            if (!viewText && spans[0]) viewText = spans[0].innerText.trim();
            if (!dateText && spans[1]) dateText = spans[1].innerText.trim();
            return [viewText, dateText, title];
        }""")
        return result[0], result[1], clean_title(result[2])
    except Exception:
        return "", "", ""


def get_yt_shorts_details(anchor) -> tuple[str, str, str]:
    """Read (view_count_text, posted_date_text, title) from a YouTube Shorts card.
    Shorts lockups don't use #video-title, so also try the lockup's metadata title
    element and the anchor's own title/aria-label."""
    try:
        result = anchor.evaluate("""el => {
            // Walk up to any known card container
            const CARD_TAGS = new Set([
                'ytd-reel-item-renderer',
                'ytd-video-renderer',
                'ytd-shorts-lockup-view-model-wiz',
                'ytd-rich-item-renderer',
            ]);
            let card = el;
            for (let i = 0; i < 20; i++) {
                if (!card) break;
                if (CARD_TAGS.has((card.tagName || '').toLowerCase())) break;
                card = card.parentElement;
            }
            if (!card) return ['', '', ''];

            const titleEl =
                card.querySelector('#video-title') ||
                card.querySelector('[class*="LockupViewModelHostMetadataTitle"] span') ||
                card.querySelector('[class*="LockupViewModelHostMetadataTitle"]') ||
                card.querySelector('h3 a, h3 span');
            const title =
                (titleEl && (titleEl.getAttribute('title') || titleEl.innerText)) ||
                el.getAttribute('title') || el.getAttribute('aria-label') || '';

            // Views and date are both span.inline-metadata-item inside ytd-video-meta-block
            const spans = Array.from(card.querySelectorAll('span.inline-metadata-item'));
            let viewText = '', dateText = '';
            for (const s of spans) {
                const t = s.innerText.trim();
                if (!viewText && /view/i.test(t))  { viewText = t; continue; }
                if (!dateText && /ago|year|month|week|day|hour/i.test(t)) { dateText = t; }
            }
            return [viewText, dateText, title];
        }""")
        return result[0], result[1], clean_title(result[2])
    except Exception:
        return "", "", ""


def scrape_youtube_search(queries: list[str], min_videos: int, max_videos: int,
                          output_file: str, content: str = "all"):
    """Search YouTube for each query and save video/Shorts URLs + view counts to CSV.

    content: 'all' | 'videos' | 'shorts'
    The like_count CSV column holds the YouTube view count.
    """
    all_urls: list[dict] = []
    seen: set[str] = set()  # global dedup: a video saved under one keyword is skipped later

    if content == "videos":
        link_selector = YT_VIDEO_SELECTOR
    elif content == "shorts":
        link_selector = YT_SHORTS_SELECTOR
    else:
        link_selector = f"{YT_VIDEO_SELECTOR}, {YT_SHORTS_SELECTOR}"

    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    def save_progress():
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["search_query", "search_rank", "url", "like_count", "posted_date", "title", "scraped_at"])
            writer.writeheader()
            writer.writerows(all_urls)

    save_progress()
    print(f"[+] Saving to '{output_path}' in real time...")

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(Path(BROWSER_PROFILE_DIR).resolve()),
            headless=False,
            channel="chrome",
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            viewport={"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )
        time.sleep(5)

        page = context.new_page()
        for tab in list(context.pages):
            if tab != page:
                try:
                    tab.close()
                except Exception:
                    pass

        page.route(
            "**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,webm}",
            lambda route: route.abort(),
        )

        for q_idx, query in enumerate(queries, 1):
            if q_idx > 1:
                min_videos = max(1, int(min_videos * 0.9))
                max_videos = max(1, int(max_videos * 0.9))
            print(f"\n{'=' * 60}")
            print(f"  Query {q_idx}/{len(queries)}: '{query}'  [YouTube – {content}]")
            print(f"  Target: min={min_videos}  max={max_videos}")
            print(f"{'=' * 60}")

            query_urls: list[dict] = []
            positioned: set[str] = set()  # feed slots already counted this keyword
            rank_counter = 0              # position in this keyword's result feed
            search_url = f"https://www.youtube.com/results?search_query={query.replace(' ', '+')}"
            print(f"[*] Navigating to: {search_url}")
            page.goto(search_url, wait_until="domcontentloaded", timeout=60000)
            time.sleep(POPUP_WAIT)

            # Dismiss cookie/consent dialog if shown
            for consent_sel in (
                'button[aria-label*="Accept"]',
                'button:has-text("Accept all")',
                'button:has-text("Reject all")',
            ):
                try:
                    btn = page.locator(consent_sel).first
                    if btn.is_visible(timeout=1500):
                        btn.click()
                        time.sleep(1)
                        break
                except Exception:
                    pass

            # Click the matching filter chip so we only see that content type
            # (Shorts → "Shorts" chip, Videos → "Videos" chip). Scoped to
            # #chip-bar to avoid matching the sidebar nav links.
            chip_label = {"shorts": "Shorts", "videos": "Videos"}.get(content)
            if chip_label:
                try:
                    chip_btn = page.locator(
                        "#chip-bar chip-shape button[role='tab']"
                    ).filter(has_text=re.compile(rf"^{chip_label}$", re.IGNORECASE)).first
                    chip_btn.wait_for(state="visible", timeout=8000)
                    chip_btn.click()
                    print(f"[*] Clicked {chip_label} tab.")
                    time.sleep(2)
                except Exception:
                    print(f"[!] {chip_label} tab not found – collecting from mixed results.")

            print("[*] Waiting for first video cards to appear...")
            cards_found = False
            elapsed_ms = 0
            while elapsed_ms < CARDS_LOAD_TIMEOUT_MS:
                try:
                    page.wait_for_selector(link_selector, timeout=3000)
                    cards_found = True
                    break
                except PlaywrightTimeoutError:
                    # Only scroll to trigger lazy-loading; tab was already clicked above
                    page.evaluate(f"window.scrollBy({{ top: {SCROLL_STEP_PX}, behavior: 'smooth' }})")
                    time.sleep(1.5)
                    elapsed_ms += 4500
            if not cards_found:
                print(f"[!] No cards after {CARDS_LOAD_TIMEOUT_MS // 1000}s – skipping query.")
                continue
            time.sleep(1)

            def settle():
                time.sleep(random.uniform(CARD_SETTLE_WAIT_MIN, CARD_SETTLE_WAIT_MAX))

            def harvest_urls() -> int:
                nonlocal rank_counter
                new = 0
                for anchor in page.locator(link_selector).all():
                    if len(query_urls) >= max_videos:
                        break
                    try:
                        href = anchor.get_attribute("href") or ""
                        if href.startswith("/"):
                            href = "https://www.youtube.com" + href
                        # Normalise: keep only ?v= for watch URLs
                        if "/watch" in href:
                            m_v = re.search(r'[?&]v=([\w-]+)', href)
                            if not m_v:
                                continue
                            href = f"https://www.youtube.com/watch?v={m_v.group(1)}"
                            is_short = False
                        elif "/shorts/" in href:
                            href = href.split("?")[0]
                            is_short = True
                        else:
                            continue

                        # Assign a feed position the first time this video is seen
                        # in the current keyword, whether or not it gets saved.
                        if href in positioned:
                            continue
                        positioned.add(href)
                        rank_counter += 1
                        rank = rank_counter

                        # Skip (leaving a rank gap) if already saved under a prior keyword
                        if href in seen:
                            continue
                        seen.add(href)

                        view_text, date_text, title = (
                            get_yt_shorts_details(anchor) if is_short
                            else get_yt_video_details(anchor)
                        )
                        view_count = parse_yt_count_text(view_text)
                        entry = {
                            "search_query": query,
                            "search_rank": rank,
                            "url": href,
                            "like_count": view_count,
                            "posted_date": date_text,
                            "title": title,
                            "scraped_at": datetime.now(timezone.utc).isoformat(),
                        }
                        query_urls.append(entry)
                        all_urls.append(entry)
                        count_display = f"{view_count:,}" if view_count else "?"
                        total = len(all_urls)
                        kind = "short" if is_short else "video"
                        print(f"  [{total:>4}] (rank {rank}) [{kind}] {href}  "
                              f"(views: {count_display}, posted: {date_text or '?'}"
                              f", title: {(title[:60] + '…') if len(title) > 60 else (title or '?')})")
                        new += 1
                    except Exception:
                        continue
                return new

            def at_page_bottom() -> bool:
                return page.evaluate(
                    "(window.innerHeight + Math.round(window.scrollY)) "
                    ">= document.body.scrollHeight - 200"
                )

            print(f"[*] Collecting up to {max_videos} URLs for this query...")

            settle()
            if harvest_urls():
                save_progress()

            scroll_attempts = 0
            stale_scrolls   = 0

            while len(query_urls) < max_videos and scroll_attempts < MAX_SCROLL_ATTEMPTS:
                page.mouse.move(VIEWPORT_WIDTH // 2, VIEWPORT_HEIGHT // 2)
                page.mouse.wheel(0, SCROLL_STEP_PX)
                scroll_attempts += 1

                if at_page_bottom():
                    wait = random.uniform(SCROLL_DELAY_MIN * 2, SCROLL_DELAY_MAX * 2)
                    print(f"  [down] Reached page bottom – waiting {wait:.1f}s...")
                    time.sleep(wait)
                    newly_found = harvest_urls()
                else:
                    time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))
                    settle()
                    newly_found = harvest_urls()

                if newly_found == 0:
                    stale_scrolls += 1
                    print(f"  [~] No new URLs (stale {stale_scrolls}/{MAX_STALE_SCROLLS})")
                    if stale_scrolls >= MAX_STALE_SCROLLS:
                        print("  [!] YouTube has no more results for this query.")
                        break
                else:
                    stale_scrolls = 0
                    save_progress()

            save_progress()

            if len(query_urls) < min_videos:
                print(
                    f"\n[!] Warning: collected {len(query_urls)} URLs for '{query}' "
                    f"but minimum target was {min_videos}."
                )
            else:
                print(f"[*] Query '{query}': {len(query_urls)} URLs collected.")

        context.close()

    print(f"\n[*] All queries done. Total unique URLs: {len(all_urls)}")
    save_progress()
    print(f"[+] Done! Saved {len(all_urls)} unique URLs to '{output_path}'")
    return output_path


def scrape_tiktok_search(queries: list[str], min_videos: int, max_videos: int, output_file: str):
    """Search TikTok for each query in order. Unique URLs are collected across all
    queries and saved to a single CSV. min/max_videos apply per query."""

    all_urls: list[dict] = []  # combined results across all queries
    seen: set[str] = set()     # global dedup: a video saved under one keyword is skipped later

    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    def save_progress():
        """Overwrite the CSV with the current state of all_urls."""
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["search_query", "search_rank", "url", "like_count", "posted_date", "title", "scraped_at"])
            writer.writeheader()
            writer.writerows(all_urls)

    # Create the file immediately so the user can see where data is going
    save_progress()
    print(f"[+] Saving to '{output_path}' in real time...")

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(Path(BROWSER_PROFILE_DIR).resolve()),
            headless=False,
            channel="chrome",
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            viewport={"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )
        # Give Chrome time to finish loading the real profile and create its initial tabs.
        time.sleep(5)

        # Open a fresh Playwright-controlled page first (keeps Chrome alive while we close
        # the session-restored tabs that Chrome opened on its own).
        page = context.new_page()
        for tab in list(context.pages):
            if tab != page:
                try:
                    tab.close()
                except Exception:
                    pass

        if REQUIRE_LOGIN:
            print("[*] Opening TikTok for manual login...")
            print(f"[*] Navigating to https://www.tiktok.com ...")
            page.bring_to_front()
            try:
                page.goto("https://www.tiktok.com", wait_until="commit", timeout=60000)
                print(f"[*] Page loaded. Current URL: {page.url}")
            except Exception as e:
                print(f"[!] Navigation error: {e}")
                raise
            print("\n" + "=" * 60)
            print("  Please log in to TikTok in the browser window.")
            print("")
            print("  Use email, phone number, or QR code login.")
            print("  Google login opens a popup that will not load")
            print("  correctly in an automated browser.")
            print("")
            print("  Once logged in, press Enter here to continue...")
            print("=" * 60)
            input()
            print("[+] Login confirmed – starting search...")

        # Block images/fonts/videos to speed up page loading (applied after login)
        page.route(
            "**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,webm}",
            lambda route: route.abort(),
        )

        # ── Iterate over each query ───────────────────────────────────────────
        for q_idx, query in enumerate(queries, 1):
            if q_idx > 1:
                min_videos = max(1, int(min_videos * 0.9))
                max_videos = max(1, int(max_videos * 0.9))
            print(f"\n{'=' * 60}")
            print(f"  Query {q_idx}/{len(queries)}: '{query}'")
            print(f"  Target: min={min_videos}  max={max_videos}")
            print(f"{'=' * 60}")

            search_url = f"https://www.tiktok.com/search/video?q={query.replace(' ', '%20')}"
            print(f"[*] Navigating to: {search_url}")
            page.goto(search_url, wait_until="domcontentloaded", timeout=60000)
            time.sleep(POPUP_WAIT)

            def dismiss_login_popup():
                try:
                    close_btn = page.locator('[data-e2e="modal-close-inner-button"]')
                    if close_btn.count() > 0:
                        close_btn.first.click()
                        time.sleep(1)
                except Exception:
                    pass

            dismiss_login_popup()

            def settle():
                """Wait a random interval so TikTok has time to render card details."""
                w = random.uniform(CARD_SETTLE_WAIT_MIN, CARD_SETTLE_WAIT_MAX)
                time.sleep(w)

            def at_page_bottom() -> bool:
                return page.evaluate(
                    "(window.innerHeight + Math.round(window.scrollY)) >= document.body.scrollHeight - 200"
                )

            def collect_tab(tab_label: str, link_selector: str, url_re) -> list[dict]:
                """Wait for the current tab's cards, then scroll-and-harvest up to
                max_videos links matching url_re. Each tab (Videos, Photo) is its
                own result feed, so search_rank restarts at 1 per tab. Returns the
                entries collected for this tab."""
                collected: list[dict] = []    # URLs saved in this tab (for counting)
                positioned: set[str] = set()  # feed slots already counted this tab
                rank_counter = 0              # position in this tab's result feed

                print(f"[*] [{tab_label}] Waiting for first cards to appear...")
                cards_found = False
                elapsed_ms = 0
                while elapsed_ms < CARDS_LOAD_TIMEOUT_MS:
                    try:
                        page.wait_for_selector(link_selector, timeout=3000)
                        cards_found = True
                        break
                    except PlaywrightTimeoutError:
                        # Scroll to trigger TikTok's IntersectionObserver lazy-load
                        page.evaluate(f"window.scrollBy({{ top: {SCROLL_STEP_PX}, behavior: 'smooth' }})")
                        time.sleep(1.5)
                        elapsed_ms += 4500  # 3 s wait + 1.5 s sleep
                if not cards_found:
                    print(f"[!] [{tab_label}] No cards after {CARDS_LOAD_TIMEOUT_MS // 1000}s – skipping.")
                    return collected
                time.sleep(1)

                def harvest_urls() -> int:
                    """Collect newly visible links matching url_re; skip URLs already
                    saved under any keyword/tab. Each distinct item in this tab's feed
                    consumes a rank slot, so previously-seen items leave rank gaps."""
                    nonlocal rank_counter
                    new = 0
                    for anchor in page.locator(link_selector).all():
                        if len(collected) >= max_videos:
                            break
                        try:
                            href = anchor.get_attribute("href") or ""
                            if href.startswith("/"):
                                href = "https://www.tiktok.com" + href
                            href = href.split("?")[0]
                            if not url_re.match(href):
                                continue

                            if href in positioned:
                                continue
                            positioned.add(href)
                            rank_counter += 1
                            rank = rank_counter

                            if href in seen:
                                continue
                            seen.add(href)

                            like_text, posted_date, title = get_card_details(anchor)
                            like_count = parse_count_text(like_text)
                            entry = {
                                "search_query": query,
                                "search_rank": rank,
                                "url": href,
                                "like_count": like_count,
                                "posted_date": posted_date,
                                "title": title,
                                "scraped_at": datetime.now(timezone.utc).isoformat(),
                            }
                            collected.append(entry)
                            all_urls.append(entry)
                            like_display = f"{like_count:,}" if like_count else "?"
                            print(f"  [{len(all_urls):>4}] [{tab_label}] (rank {rank}) {href}  "
                                  f"(likes: {like_display}, posted: {posted_date or '?'}"
                                  f", title: {(title[:60] + '…') if len(title) > 60 else (title or '?')})")
                            new += 1
                        except Exception:
                            continue
                    return new

                def refill_missing():
                    """Scroll back and fill in entries with missing like/date data."""
                    needs = {e["url"]: e for e in collected
                             if not e["like_count"] or not e["posted_date"]}
                    if not needs:
                        return
                    print(f"  [*] [{tab_label}] Refill pass: {len(needs)} entries missing data – scrolling back...")
                    page.evaluate("window.scrollTo(0, 0)")
                    time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))
                    refill_scroll = 0
                    stale = 0
                    while needs and refill_scroll < MAX_SCROLL_ATTEMPTS:
                        found_this_scroll = 0
                        for anchor in page.locator(link_selector).all():
                            if not needs:
                                break
                            try:
                                href = anchor.get_attribute("href") or ""
                                if href.startswith("/"):
                                    href = "https://www.tiktok.com" + href
                                href = href.split("?")[0]
                                if href in needs:
                                    like_text, posted_date, title = get_card_details(anchor)
                                    like_count = parse_count_text(like_text)
                                    entry = needs[href]
                                    if like_count and not entry["like_count"]:
                                        entry["like_count"] = like_count
                                    if posted_date and not entry["posted_date"]:
                                        entry["posted_date"] = posted_date
                                    if title and not entry.get("title"):
                                        entry["title"] = title
                                    if entry["like_count"] and entry["posted_date"]:
                                        print(f"  [+] Refilled {href}  "
                                              f"(likes: {like_count:,}, posted: {posted_date})")
                                        del needs[href]
                                        found_this_scroll += 1
                            except Exception:
                                continue
                        if not needs:
                            break
                        stale = 0 if found_this_scroll else stale + 1
                        if stale >= MAX_STALE_SCROLLS:
                            print(f"  [!] [{tab_label}] Refill stopping – remaining cards no longer in DOM.")
                            break
                        page.evaluate(f"window.scrollBy({{ top: {SCROLL_STEP_PX}, behavior: 'smooth' }})")
                        refill_scroll += 1
                        time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))
                    if needs:
                        print(f"  [!] [{tab_label}] {len(needs)} entries still missing after refill (virtualized).")

                print(f"[*] [{tab_label}] Collecting up to {max_videos} URLs...")

                settle()
                if harvest_urls():
                    save_progress()

                scroll_attempts = 0
                stale_scrolls   = 0

                while len(collected) < max_videos and scroll_attempts < MAX_SCROLL_ATTEMPTS:
                    # Mouse wheel fires real DOM scroll events that TikTok's
                    # IntersectionObserver picks up; window.scrollBy() does not.
                    page.mouse.move(VIEWPORT_WIDTH // 2, VIEWPORT_HEIGHT // 2)
                    page.mouse.wheel(0, SCROLL_STEP_PX)
                    scroll_attempts += 1

                    if at_page_bottom():
                        wait = random.uniform(SCROLL_DELAY_MIN * 2, SCROLL_DELAY_MAX * 2)
                        print(f"  [down] [{tab_label}] Reached page bottom – waiting {wait:.1f}s for next batch...")
                        time.sleep(wait)

                        for btn_text in ("Load more", "See more", "Show more"):
                            try:
                                btn = page.locator(f'button:has-text("{btn_text}")')
                                if btn.count() > 0:
                                    btn.first.click()
                                    print(f"  [*] Clicked '{btn_text}' button")
                                    time.sleep(2)
                                    break
                            except Exception:
                                pass
                        newly_found = harvest_urls()
                    else:
                        time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))
                        settle()
                        newly_found = harvest_urls()

                    if newly_found == 0:
                        stale_scrolls += 1
                        print(f"  [~] [{tab_label}] No new URLs (stale {stale_scrolls}/{MAX_STALE_SCROLLS})")
                        if stale_scrolls >= MAX_STALE_SCROLLS:
                            print(f"  [!] [{tab_label}] TikTok has no more results for this query.")
                            break
                    else:
                        stale_scrolls = 0
                        save_progress()

                refill_missing()
                save_progress()  # capture any data filled in by the refill pass
                return collected

            # 1) Videos tab (we navigated straight to it).
            video_entries = collect_tab("Videos", VIDEO_LINK_SELECTOR, VIDEO_URL_RE)

            # 2) Photo tab — click it, then scrape image/slideshow posts the same way.
            print("[*] Switching to the Photo tab...")
            switched = click_search_tab(page, "Photo")
            if not switched:
                # Fallback: the general search page always shows the full tab bar.
                gen_url = f"https://www.tiktok.com/search?q={query.replace(' ', '%20')}"
                print(f"[*] Photo tab not found here – trying general search: {gen_url}")
                try:
                    page.goto(gen_url, wait_until="domcontentloaded", timeout=60000)
                    time.sleep(POPUP_WAIT)
                    dismiss_login_popup()
                    switched = click_search_tab(page, "Photo")
                except Exception:
                    switched = False
            if switched:
                time.sleep(2)
                dismiss_login_popup()
                photo_entries = collect_tab("Photo", PHOTO_LINK_SELECTOR, PHOTO_URL_RE)
            else:
                print("[!] Could not open the Photo tab – skipping photos for this query.")
                photo_entries = []

            collected_q = len(video_entries) + len(photo_entries)
            if collected_q < min_videos:
                print(
                    f"\n[!] Warning: collected {collected_q} URLs for '{query}' "
                    f"({len(video_entries)} video + {len(photo_entries)} photo) "
                    f"but minimum target was {min_videos}."
                )
            else:
                print(f"[*] Query '{query}': {collected_q} URLs collected "
                      f"({len(video_entries)} video + {len(photo_entries)} photo).")

        context.close()

    print(f"\n[*] All queries done. Total unique URLs: {len(all_urls)}")

    save_progress()
    print(f"[+] Done! Saved {len(all_urls)} unique URLs to '{output_path}'")
    return output_path


def get_instagram_title(anchor) -> str:
    """Best-effort caption for an Instagram grid tile. The grid renders no caption
    element, but each tile's <img> carries it in `alt` (Instagram writes the
    caption there, sometimes prefixed with "Photo by ... on ..."). Falls back to
    the anchor's own aria-label."""
    try:
        raw = anchor.evaluate("""el => {
            const img = el.querySelector('img[alt]');
            const alt = img ? (img.getAttribute('alt') || '') : '';
            return alt || el.getAttribute('aria-label') || '';
        }""")
        return clean_title(raw)
    except Exception:
        return ""


def scrape_instagram_search(queries: list[str], min_videos: int, max_videos: int, output_file: str):
    """Search Instagram hashtags for each query. Always waits for a manual login
    first (Instagram search requires being logged in). Unique post/reel URLs are
    collected across all queries with their per-keyword search rank.

    Instagram's search grid does not expose like counts or posted dates, so those
    CSV columns are left blank (0 / '')."""

    all_urls: list[dict] = []  # combined results across all queries
    seen: set[str] = set()     # global dedup: a post saved under one keyword is skipped later

    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    def save_progress():
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["search_query", "search_rank", "url", "like_count", "posted_date", "title", "scraped_at"])
            writer.writeheader()
            writer.writerows(all_urls)

    save_progress()
    print(f"[+] Saving to '{output_path}' in real time...")

    with sync_playwright() as p:
        # NOTE: no custom user_agent here. channel="chrome" uses your real Chrome,
        # so forcing an old UA string (e.g. Chrome/124) mismatches the browser's
        # client-hints and makes Meta's reCAPTCHA checkpoint hang blank. Letting
        # Chrome send its native UA plus the stealth init script below avoids the
        # automated-browser challenge during login.
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(Path(BROWSER_PROFILE_DIR).resolve()),
            headless=False,
            channel="chrome",
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            viewport={"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
            locale="en-US",
        )

        # Light stealth: hide the tell-tale automation signals so the login
        # reCAPTCHA renders and can be solved.
        context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
            "window.chrome = window.chrome || { runtime: {} };"
            "Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});"
            "Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});"
        )
        time.sleep(5)

        page = context.new_page()
        for tab in list(context.pages):
            if tab != page:
                try:
                    tab.close()
                except Exception:
                    pass

        # Always wait for a manual Instagram login before searching.
        print("[*] Opening Instagram for manual login...")
        page.bring_to_front()
        try:
            page.goto("https://www.instagram.com", wait_until="commit", timeout=60000)
            print(f"[*] Page loaded. Current URL: {page.url}")
        except Exception as e:
            print(f"[!] Navigation error: {e}")
            raise
        print("\n" + "=" * 60)
        print("  Please log in to Instagram in the browser window.")
        print("")
        print("  Once you are logged in and your home feed is visible,")
        print("  press Enter here to continue...")
        print("=" * 60)
        input()
        print("[+] Login confirmed – starting search...")

        # Block fonts/media for speed, but keep images so the post grid renders.
        page.route(
            "**/*.{woff,woff2,ttf,mp4,webm}",
            lambda route: route.abort(),
        )

        for q_idx, query in enumerate(queries, 1):
            if q_idx > 1:
                min_videos = max(1, int(min_videos * 0.9))
                max_videos = max(1, int(max_videos * 0.9))
            print(f"\n{'=' * 60}")
            print(f"  Query {q_idx}/{len(queries)}: '{query}'  [Instagram]")
            print(f"  Target: min={min_videos}  max={max_videos}")
            print(f"{'=' * 60}")

            query_urls: list[dict] = []   # URLs saved in this query
            positioned: set[str] = set()  # feed slots already counted this keyword
            rank_counter = 0              # position in this keyword's result feed

            # Hashtag search: only the end keyword changes; %23 is the leading '#'.
            search_url = f"https://www.instagram.com/explore/search/keyword/?q={query.replace(' ', '%20')}"
            print(f"[*] Navigating to: {search_url}")
            page.goto(search_url, wait_until="domcontentloaded", timeout=60000)
            time.sleep(POPUP_WAIT)

            # Dismiss "Save login info?" / "Turn on notifications" dialogs.
            for label in ("Not Now", "Not now"):
                try:
                    btn = page.locator(f'button:has-text("{label}")')
                    if btn.count() > 0:
                        btn.first.click()
                        time.sleep(1)
                        break
                except Exception:
                    pass

            print("[*] Waiting for first post cards to appear...")
            cards_found = False
            elapsed_ms = 0
            while elapsed_ms < CARDS_LOAD_TIMEOUT_MS:
                try:
                    page.wait_for_selector(IG_POST_LINK_SELECTOR, timeout=3000)
                    cards_found = True
                    break
                except PlaywrightTimeoutError:
                    pass
                except Exception:
                    # Instagram's SPA is still redirecting/settling — the JS
                    # context gets destroyed mid-call. Wait and retry.
                    time.sleep(1.5)
                    elapsed_ms += 1500
                    continue
                # Nudge lazy-loading; ignore errors if the page navigates under us.
                try:
                    page.mouse.wheel(0, SCROLL_STEP_PX)
                except Exception:
                    pass
                time.sleep(1.5)
                elapsed_ms += 4500
            if not cards_found:
                print(f"[!] No posts after {CARDS_LOAD_TIMEOUT_MS // 1000}s – skipping this query.")
                continue
            time.sleep(1)

            def harvest_urls() -> int:
                """Collect post/reel links; each distinct post in this keyword's feed
                consumes a rank slot, so posts already saved under a previous keyword
                leave gaps in search_rank."""
                nonlocal rank_counter
                new = 0
                for anchor in page.locator(IG_POST_LINK_SELECTOR).all():
                    if len(query_urls) >= max_videos:
                        break
                    try:
                        href = anchor.get_attribute("href") or ""
                        if href.startswith("/"):
                            href = "https://www.instagram.com" + href
                        m = IG_POST_URL_RE.match(href.split("?")[0])
                        if not m:
                            continue
                        href = m.group(0) + "/"  # canonical, trailing slash

                        if href in positioned:
                            continue
                        positioned.add(href)
                        rank_counter += 1
                        rank = rank_counter

                        if href in seen:
                            continue
                        seen.add(href)

                        # No counts/date on the IG grid, but the tile image's alt
                        # text carries the caption — best available title here.
                        entry = {
                            "search_query": query,
                            "search_rank": rank,
                            "url": href,
                            "like_count": 0,     # not shown on the search grid
                            "posted_date": "",   # not shown on the search grid
                            "title": get_instagram_title(anchor),
                            "scraped_at": datetime.now(timezone.utc).isoformat(),
                        }
                        query_urls.append(entry)
                        all_urls.append(entry)
                        ig_title = entry["title"]
                        print(f"  [{len(all_urls):>4}] (rank {rank}) {href}  "
                              f"(title: {(ig_title[:60] + '…') if len(ig_title) > 60 else (ig_title or '?')})")
                        new += 1
                    except Exception:
                        continue
                return new

            def at_page_bottom() -> bool:
                try:
                    return page.evaluate(
                        "(window.innerHeight + Math.round(window.scrollY)) >= document.body.scrollHeight - 200"
                    )
                except Exception:
                    return False

            print(f"[*] Collecting up to {max_videos} URLs for this query...")
            if harvest_urls():
                save_progress()

            scroll_attempts = 0
            stale_scrolls   = 0
            while len(query_urls) < max_videos and scroll_attempts < MAX_SCROLL_ATTEMPTS:
                try:
                    page.mouse.move(VIEWPORT_WIDTH // 2, VIEWPORT_HEIGHT // 2)
                    page.mouse.wheel(0, SCROLL_STEP_PX)
                except Exception:
                    pass
                scroll_attempts += 1

                if at_page_bottom():
                    wait = random.uniform(SCROLL_DELAY_MIN * 2, SCROLL_DELAY_MAX * 2)
                    print(f"  [down] Reached page bottom – waiting {wait:.1f}s for next batch...")
                    time.sleep(wait)
                    newly_found = harvest_urls()
                else:
                    time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))
                    newly_found = harvest_urls()

                if newly_found == 0:
                    stale_scrolls += 1
                    print(f"  [~] No new URLs (stale {stale_scrolls}/{MAX_STALE_SCROLLS})")
                    if stale_scrolls >= MAX_STALE_SCROLLS:
                        print("  [!] Instagram has no more results for this query.")
                        break
                else:
                    stale_scrolls = 0
                    save_progress()

            save_progress()

            if len(query_urls) < min_videos:
                print(
                    f"\n[!] Warning: collected {len(query_urls)} URLs for '{query}' "
                    f"but minimum target was {min_videos}."
                )
            else:
                print(f"[*] Query '{query}': {len(query_urls)} URLs collected.")

        context.close()

    print(f"\n[*] All queries done. Total unique URLs: {len(all_urls)}")
    save_progress()
    print(f"[+] Done! Saved {len(all_urls)} unique URLs to '{output_path}'")
    return output_path


def get_reddit_details(anchor) -> tuple[str, str, str]:
    """Best-effort (score, created_date, title) for a Reddit post. Reddit renders posts
    as <shreddit-post> custom elements whose attributes carry the data; walk up
    (across shadow boundaries) to find it. Returns ('', '') if unavailable."""
    try:
        result = anchor.evaluate("""el => {
            let node = el;
            for (let i = 0; i < 25; i++) {
                if (!node) break;
                if ((node.tagName || '').toLowerCase() === 'shreddit-post') {
                    return [
                        node.getAttribute('score') || '',
                        node.getAttribute('created-timestamp') || '',
                        node.getAttribute('post-title') || (el.innerText || ''),
                    ];
                }
                node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
            }
            return ['', '', el.innerText || ''];
        }""")
        score, ts = result[0], result[1]
        # keep just the YYYY-MM-DD date
        return score, (ts[:10] if ts else ""), clean_title(result[2])
    except Exception:
        return "", "", ""


def scrape_reddit_search(queries: list[str], min_videos: int, max_videos: int, output_file: str):
    """Search Reddit for each query and save post permalinks with their per-keyword
    search rank. Reddit search is public, so no login is needed. Post score and
    date are read best-effort from the <shreddit-post> element when present."""

    all_urls: list[dict] = []  # combined results across all queries
    seen: set[str] = set()     # global dedup: a post saved under one keyword is skipped later

    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    def save_progress():
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["search_query", "search_rank", "url", "like_count", "posted_date", "title", "scraped_at"])
            writer.writeheader()
            writer.writerows(all_urls)

    save_progress()
    print(f"[+] Saving to '{output_path}' in real time...")

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(Path(BROWSER_PROFILE_DIR).resolve()),
            headless=False,
            channel="chrome",
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            viewport={"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
            locale="en-US",
        )
        context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
            "window.chrome = window.chrome || { runtime: {} };"
        )
        time.sleep(5)

        page = context.new_page()
        for tab in list(context.pages):
            if tab != page:
                try:
                    tab.close()
                except Exception:
                    pass

        # Block fonts/media for speed; keep images so cards render normally.
        page.route(
            "**/*.{woff,woff2,ttf,mp4,webm}",
            lambda route: route.abort(),
        )

        for q_idx, query in enumerate(queries, 1):
            if q_idx > 1:
                min_videos = max(1, int(min_videos * 0.9))
                max_videos = max(1, int(max_videos * 0.9))
            print(f"\n{'=' * 60}")
            print(f"  Query {q_idx}/{len(queries)}: '{query}'  [Reddit]")
            print(f"  Target: min={min_videos}  max={max_videos}")
            print(f"{'=' * 60}")

            query_urls: list[dict] = []   # URLs saved in this query
            positioned: set[str] = set()  # feed slots already counted this keyword
            rank_counter = 0              # position in this keyword's result feed

            search_url = f"https://www.reddit.com/search/?q={query.replace(' ', '%20')}&type=posts"
            print(f"[*] Navigating to: {search_url}")
            page.goto(search_url, wait_until="domcontentloaded", timeout=60000)
            time.sleep(POPUP_WAIT)

            # Dismiss common cookie / "continue" nags if present.
            for label in ("Accept all", "Reject non-essential", "Not now", "Close"):
                try:
                    btn = page.locator(f'button:has-text("{label}")')
                    if btn.count() > 0 and btn.first.is_visible(timeout=1000):
                        btn.first.click()
                        time.sleep(1)
                        break
                except Exception:
                    pass

            print("[*] Waiting for first post cards to appear...")
            cards_found = False
            elapsed_ms = 0
            while elapsed_ms < CARDS_LOAD_TIMEOUT_MS:
                try:
                    page.wait_for_selector(REDDIT_POST_LINK_SELECTOR, timeout=3000)
                    cards_found = True
                    break
                except PlaywrightTimeoutError:
                    pass
                except Exception:
                    time.sleep(1.5)
                    elapsed_ms += 1500
                    continue
                try:
                    page.mouse.wheel(0, SCROLL_STEP_PX)
                except Exception:
                    pass
                time.sleep(1.5)
                elapsed_ms += 4500
            if not cards_found:
                print(f"[!] No posts after {CARDS_LOAD_TIMEOUT_MS // 1000}s – skipping this query.")
                continue
            time.sleep(1)

            def harvest_urls() -> int:
                """Collect post permalinks; each distinct post in this keyword's feed
                consumes a rank slot, so posts already saved under a previous keyword
                leave gaps in search_rank."""
                nonlocal rank_counter
                new = 0
                for anchor in page.locator(REDDIT_POST_LINK_SELECTOR).all():
                    if len(query_urls) >= max_videos:
                        break
                    try:
                        href = anchor.get_attribute("href") or ""
                        if href.startswith("/"):
                            href = "https://www.reddit.com" + href
                        href = href.split("?")[0].split("#")[0]
                        if not REDDIT_POST_URL_RE.match(href):
                            continue

                        if href in positioned:
                            continue
                        positioned.add(href)
                        rank_counter += 1
                        rank = rank_counter

                        if href in seen:
                            continue
                        seen.add(href)

                        score_text, posted_date, title = get_reddit_details(anchor)
                        try:
                            like_count = int(score_text) if score_text else 0
                        except ValueError:
                            like_count = parse_count_text(score_text)

                        entry = {
                            "search_query": query,
                            "search_rank": rank,
                            "url": href,
                            "like_count": like_count,
                            "posted_date": posted_date,
                            "title": title,
                            "scraped_at": datetime.now(timezone.utc).isoformat(),
                        }
                        query_urls.append(entry)
                        all_urls.append(entry)
                        like_display = f"{like_count:,}" if like_count else "?"
                        print(f"  [{len(all_urls):>4}] (rank {rank}) {href}  "
                              f"(score: {like_display}, posted: {posted_date or '?'}"
                              f", title: {(title[:60] + '…') if len(title) > 60 else (title or '?')})")
                        new += 1
                    except Exception:
                        continue
                return new

            def at_page_bottom() -> bool:
                try:
                    return page.evaluate(
                        "(window.innerHeight + Math.round(window.scrollY)) >= document.body.scrollHeight - 200"
                    )
                except Exception:
                    return False

            print(f"[*] Collecting up to {max_videos} URLs for this query...")
            if harvest_urls():
                save_progress()

            scroll_attempts = 0
            stale_scrolls   = 0
            while len(query_urls) < max_videos and scroll_attempts < MAX_SCROLL_ATTEMPTS:
                try:
                    page.mouse.move(VIEWPORT_WIDTH // 2, VIEWPORT_HEIGHT // 2)
                    page.mouse.wheel(0, SCROLL_STEP_PX)
                except Exception:
                    pass
                scroll_attempts += 1

                if at_page_bottom():
                    wait = random.uniform(SCROLL_DELAY_MIN * 2, SCROLL_DELAY_MAX * 2)
                    print(f"  [down] Reached page bottom – waiting {wait:.1f}s for next batch...")
                    time.sleep(wait)
                    newly_found = harvest_urls()
                else:
                    time.sleep(random.uniform(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX))
                    newly_found = harvest_urls()

                if newly_found == 0:
                    stale_scrolls += 1
                    print(f"  [~] No new URLs (stale {stale_scrolls}/{MAX_STALE_SCROLLS})")
                    if stale_scrolls >= MAX_STALE_SCROLLS:
                        print("  [!] Reddit has no more results for this query.")
                        break
                else:
                    stale_scrolls = 0
                    save_progress()

            save_progress()

            if len(query_urls) < min_videos:
                print(
                    f"\n[!] Warning: collected {len(query_urls)} URLs for '{query}' "
                    f"but minimum target was {min_videos}."
                )
            else:
                print(f"[*] Query '{query}': {len(query_urls)} URLs collected.")

        context.close()

    print(f"\n[*] All queries done. Total unique URLs: {len(all_urls)}")
    save_progress()
    print(f"[+] Done! Saved {len(all_urls)} unique URLs to '{output_path}'")
    return output_path


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Scrape TikTok, YouTube, Instagram, or Reddit URLs by search query. "
            "Config is read from .env; CLI args override it."
        )
    )
    parser.add_argument(
        "--query", "-q", nargs="+", default=DEFAULT_QUERIES,
        help="One or more search phrases (overrides SEARCH_QUERY in .env)",
    )
    parser.add_argument("--min", type=int, default=DEFAULT_MIN_VIDEOS,
                        help="Minimum videos per query")
    parser.add_argument("--max", "-m", type=int, default=DEFAULT_MAX_VIDEOS,
                        help="Maximum videos per query")
    parser.add_argument("--output", "-o", default=DEFAULT_OUTPUT_FILE,
                        help="Output CSV file path")
    parser.add_argument(
        "--platform", "-p",
        choices=["tiktok", "youtube", "instagram", "reddit"], default=DEFAULT_PLATFORM,
        help="Platform to scrape: tiktok (default), youtube, instagram, or reddit",
    )
    parser.add_argument(
        "--content", "-c",
        choices=["all", "videos", "shorts"], default=DEFAULT_YT_CONTENT,
        help="YouTube content type: all (default), videos, or shorts",
    )
    args = parser.parse_args()

    queries = args.query if isinstance(args.query, list) else [args.query]
    queries = [q.strip() for q in queries if q.strip()]

    if not queries:
        parser.error("SEARCH_QUERY is not set in .env and --query was not provided.")
    if args.min > args.max:
        parser.error(f"MIN_VIDEOS ({args.min}) cannot be greater than MAX_VIDEOS ({args.max}).")

    if not args.output:
        safe_first = re.sub(r"[^a-zA-Z0-9_-]", "_", queries[0])[:30]
        suffix = f"_and_{len(queries) - 1}_more" if len(queries) > 1 else ""
        date_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        plat = args.platform
        args.output = f"results/{plat}_{safe_first}{suffix}_{date_str}.csv"

    print(f"[*] Platform    : {args.platform}")
    print(f"[*] Queries     : {queries}")
    print(f"[*] Min videos  : {args.min}  (per query)")
    print(f"[*] Max videos  : {args.max}  (per query)")
    print(f"[*] Output file : {args.output}")
    if args.platform == "youtube":
        print(f"[*] Content     : {args.content}")

    if args.platform == "youtube":
        scrape_youtube_search(queries, args.min, args.max, args.output, args.content)
    elif args.platform == "instagram":
        scrape_instagram_search(queries, args.min, args.max, args.output)
    elif args.platform == "reddit":
        scrape_reddit_search(queries, args.min, args.max, args.output)
    else:
        scrape_tiktok_search(queries, args.min, args.max, args.output)


if __name__ == "__main__":
    main()
