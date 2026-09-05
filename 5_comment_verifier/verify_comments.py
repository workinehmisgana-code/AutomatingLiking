#!/usr/bin/env python3
"""
TikTok comment verifier (local, Playwright).

Pulls the verify-list from the dashboard (each user's TikTok @username + the
TikTok sample links they submitted while reporting), opens each sample video in a
REAL persistent-profile browser (residential IP — the only way past TikTok's bot
wall), scrolls the comments, and if the user's own @username is found among the
commenters, marks that user valid for the next week via the dashboard.

Why local + headed: TikTok blocks datacenter IPs and unsigned API calls, and
serves a bot-challenge page to plain HTTP. A real browser on a home connection
(with a persistent profile that carries cookies) is what actually loads comments.
If a captcha appears, solve it in the window — the script waits and continues.

Config: copy .env.example to .env and fill in DASHBOARD_URL + VERIFY_SECRET.
Run:    python verify_comments.py            # check everyone
        python verify_comments.py --headless # no window (more likely to be blocked)
"""
import argparse
import os
import re
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

load_dotenv(Path(__file__).parent / ".env")

DASHBOARD = os.getenv("DASHBOARD_URL", "https://comments-delta-sand.vercel.app").rstrip("/")
SECRET = os.getenv("VERIFY_SECRET", "")
PROFILE_DIR = os.getenv("BROWSER_PROFILE_DIR", "./browser_profile")
VALID_DAYS = int(os.getenv("VALID_DAYS", "7"))
MAX_COMMENT_SCROLLS = int(os.getenv("MAX_COMMENT_SCROLLS", "25"))
COMMENTS_LOAD_TIMEOUT_MS = int(os.getenv("COMMENTS_LOAD_TIMEOUT_MS", "45000"))
PER_SCROLL_WAIT = float(os.getenv("PER_SCROLL_WAIT", "1.2"))

USERNAME_RE = re.compile(r"/@([A-Za-z0-9._]+)")

# Selectors are best-effort: TikTok hashes class names but keeps data-e2e hooks
# and /@username author links. We union several so a DOM tweak doesn't break us.
COMMENT_AUTHOR_SELECTORS = ",".join(
    [
        "[data-e2e^='comment'] a[href^='/@']",
        "div[class*='CommentList'] a[href^='/@']",
        "div[class*='DivCommentItemContainer'] a[href^='/@']",
        "[data-e2e='comment-username-1']",
    ]
)


def fetch_list():
    r = requests.get(
        f"{DASHBOARD}/api/admin/verify-list",
        headers={"x-verify-secret": SECRET},
        timeout=45,
    )
    r.raise_for_status()
    return r.json().get("users", [])


def report(user_id: str, valid: bool):
    try:
        r = requests.post(
            f"{DASHBOARD}/api/admin/verify-result",
            headers={"x-verify-secret": SECRET, "Content-Type": "application/json"},
            json={"userId": user_id, "valid": valid, "days": VALID_DAYS},
            timeout=45,
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        print(f"    ! failed to report result: {e}")


def looks_blocked(page) -> bool:
    """Heuristic: a captcha/verify wall is up."""
    try:
        html = page.content().lower()
        return ("verify to continue" in html or "captcha" in html) and "comment" not in html
    except Exception:  # noqa: BLE001
        return False


def collect_commenters(page) -> set:
    """Scroll the comment panel and gather every commenter @username found."""
    seen: set = set()
    last_count = -1
    stale = 0
    for _ in range(MAX_COMMENT_SCROLLS):
        try:
            hrefs = page.eval_on_selector_all(
                COMMENT_AUTHOR_SELECTORS,
                "els => els.map(e => e.getAttribute('href') || e.textContent || '')",
            )
        except Exception:  # noqa: BLE001
            hrefs = []
        for h in hrefs or []:
            m = USERNAME_RE.search(h or "")
            if m:
                seen.add(m.group(1).lower())
            else:
                t = (h or "").strip().lstrip("@").lower()
                if t and re.fullmatch(r"[a-z0-9._]+", t):
                    seen.add(t)

        if len(seen) == last_count:
            stale += 1
            if stale >= 4:
                break
        else:
            stale = 0
            last_count = len(seen)

        # Scroll the comment container (or the window as a fallback) to load more.
        try:
            page.evaluate(
                """() => {
                  const sel = [
                    "div[class*='DivCommentListContainer']",
                    "div[class*='CommentList']",
                    "[data-e2e='comment-list']",
                  ];
                  let c = null;
                  for (const s of sel) { c = document.querySelector(s); if (c) break; }
                  if (c) c.scrollTop = c.scrollHeight;
                  else window.scrollBy(0, 900);
                }"""
            )
        except Exception:  # noqa: BLE001
            pass
        time.sleep(PER_SCROLL_WAIT)
    return seen


def check_sample(page, url: str, username: str) -> bool:
    """Open one sample video and return True if `username` is among commenters."""
    try:
        page.goto(url, timeout=COMMENTS_LOAD_TIMEOUT_MS, wait_until="domcontentloaded")
    except PlaywrightTimeoutError:
        print("    · page load timed out")
        return False
    time.sleep(2.5)

    if looks_blocked(page):
        print("    · captcha/verify wall — solve it in the window, then it continues…")
        # Wait up to 2 min for a human to clear the wall.
        for _ in range(60):
            time.sleep(2)
            if not looks_blocked(page):
                break

    # Wait for the comment area to appear at all.
    try:
        page.wait_for_selector(COMMENT_AUTHOR_SELECTORS, timeout=COMMENTS_LOAD_TIMEOUT_MS)
    except PlaywrightTimeoutError:
        print("    · no comments loaded (private/removed video, or still walled)")
        return False

    commenters = collect_commenters(page)
    print(f"    · gathered {len(commenters)} commenter(s)")
    return username.lower() in commenters


def main():
    ap = argparse.ArgumentParser(description="Verify users commented on their TikTok sample links.")
    ap.add_argument("--headless", action="store_true", help="Run without a visible window (more likely blocked).")
    ap.add_argument("--limit", type=int, default=0, help="Only check the first N users (0 = all).")
    args = ap.parse_args()

    if not SECRET:
        sys.exit("VERIFY_SECRET is not set — copy .env.example to .env and fill it in (must match the dashboard).")

    print(f"Fetching verify-list from {DASHBOARD} …")
    try:
        users = fetch_list()
    except Exception as e:  # noqa: BLE001
        sys.exit(f"Could not fetch verify-list: {e}")
    if args.limit:
        users = users[: args.limit]
    print(f"{len(users)} user(s) to check.\n")
    if not users:
        return

    valid_count = 0
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(Path(PROFILE_DIR).resolve()),
            headless=args.headless,
            viewport={"width": 1280, "height": 900},
        )
        page = context.pages[0] if context.pages else context.new_page()

        for i, u in enumerate(users, 1):
            uid = u.get("userId")
            username = (u.get("username") or "").lower()
            samples = u.get("sampleUrls") or []
            print(f"[{i}/{len(users)}] @{username} · {len(samples)} sample link(s)")
            if not username or not samples:
                continue

            found = False
            for url in samples:
                print(f"  → {url}")
                try:
                    if check_sample(page, url, username):
                        found = True
                        break
                except Exception as e:  # noqa: BLE001
                    print(f"    ! error: {e}")

            if found:
                valid_count += 1
                print(f"  ✓ @{username} found in comments → valid for {VALID_DAYS} day(s)")
                report(uid, True)
            else:
                print(f"  ✗ @{username} NOT found in any sample's comments")
                report(uid, False)
            print()

        context.close()

    print(f"Done. {valid_count}/{len(users)} user(s) marked valid.")


if __name__ == "__main__":
    main()
