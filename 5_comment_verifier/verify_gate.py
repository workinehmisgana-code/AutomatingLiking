#!/usr/bin/env python3
"""
Verification-gate checker.

Every user must comment something harmless on ONE designated video before they
are allowed to work (see VERIFY_VIDEO_URL in the dashboard's lib/config.ts).
This script opens that single video, reads everyone who commented on it, and
marks each matching user valid on the dashboard.

Why one video instead of per-user sample links: it is a single page load rather
than one per user, so the whole roster is checked in one pass without hammering
TikTok — and it proves the same thing, that the registered account can post.

Reuses the plumbing in verify_comments.py (dashboard auth, the comment-scroll
collector, the captcha wait) so both checkers behave identically against TikTok.

Config: .env next to this file — DASHBOARD_URL, VERIFY_SECRET, and optionally
VERIFY_VIDEO_URL (must match the dashboard's).

Run:    python verify_gate.py
        python verify_gate.py --video https://www.tiktok.com/@x/video/123
        python verify_gate.py --dry-run     # report, mark nobody
"""
import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

import verify_comments as vc

DEFAULT_VIDEO = "https://www.tiktok.com/@drnardime/video/7596784835159444767"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    ap = argparse.ArgumentParser(description="Check who commented on the verification video.")
    ap.add_argument("--video", default="", help="Verification video URL (default: env or built-in).")
    ap.add_argument("--dry-run", action="store_true", help="Report only; do not mark anyone valid.")
    ap.add_argument("--headless", action="store_true", help="No window (more likely to be blocked).")
    args = ap.parse_args()

    import os

    video = args.video or os.getenv("VERIFY_VIDEO_URL", "") or DEFAULT_VIDEO
    if not vc.SECRET:
        sys.exit("VERIFY_SECRET is not set — copy .env.example to .env and fill it in.")

    print(f"Verification video: {video}")
    print(f"Fetching verify-list from {vc.DASHBOARD} …")
    try:
        users = vc.fetch_list()
    except Exception as e:  # noqa: BLE001
        sys.exit(f"Could not fetch verify-list: {e}")

    # username -> [users], since two people could register the same handle.
    by_handle: dict[str, list[dict]] = {}
    for u in users:
        h = (u.get("username") or "").strip().lstrip("@").lower()
        if h:
            by_handle.setdefault(h, []).append(u)
    print(f"{len(users)} user(s) on the list, {len(by_handle)} distinct TikTok handle(s).\n")
    if not by_handle:
        sys.exit("Nobody has a TikTok profile link yet — nothing to check.")

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(Path(vc.PROFILE_DIR).resolve()),
            headless=args.headless,
            channel="chrome",
            args=["--disable-blink-features=AutomationControlled", "--no-first-run"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(video, timeout=vc.COMMENTS_LOAD_TIMEOUT_MS, wait_until="domcontentloaded")
        except Exception as e:  # noqa: BLE001
            context.close()
            sys.exit(f"Could not open the video: {e}")
        time.sleep(2.5)

        if vc.looks_blocked(page):
            print("Captcha/verify wall — solve it in the window; waiting up to 2 minutes…")
            for _ in range(60):
                time.sleep(2)
                if not vc.looks_blocked(page):
                    break

        print("Reading commenters (scrolling the comment panel)…")
        commenters = vc.collect_commenters(page)
        context.close()

    print(f"\n{len(commenters)} distinct commenter(s) found on the video.\n")
    if not commenters:
        sys.exit(
            "No commenters were read — TikTok probably blocked the page. "
            "Nobody was marked, so no user is wrongly failed."
        )

    found, missing = [], []
    for handle, group in sorted(by_handle.items()):
        if handle in commenters:
            found.extend(group)
            print(f"  ✓ @{handle}" + (f"  ({len(group)} users)" if len(group) > 1 else ""))
        else:
            missing.extend(group)

    print(f"\n{len(found)} verified, {len(missing)} still waiting.")
    if args.dry_run:
        print("(--dry-run: nobody was marked)")
        return

    for u in found:
        vc.report(u["userId"], True)
    print(f"Marked {len(found)} user(s) valid for {vc.VALID_DAYS} day(s).")

    if missing:
        print("\nStill waiting (no comment found on the video):")
        for u in missing[:40]:
            print(f"  · {u.get('name') or '(no name)'} @{u.get('username')}")
        if len(missing) > 40:
            print(f"  … and {len(missing) - 40} more")


if __name__ == "__main__":
    main()
