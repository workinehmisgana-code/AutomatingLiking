#!/usr/bin/env python3
"""
Open a browser so you can clear TikTok's slider captcha for one account.

TikTok shows a "drag the slider to fit the puzzle" challenge to accounts it is
unsure about. While it is up, the comment list renders as grey placeholders —
the account stays signed in, the panel sits on the right tab, and every symptom
points at the DOM while none of them is the cause. A headless run cannot clear
it, because there is nobody to drag the slider.

So: this opens a real window on a video, waits for you to solve it, confirms it
is gone, and closes. Solving it settles the device for a while, so this is
usually a once-per-account chore rather than a routine one.

Usage:
    python solve_captcha.py --profile e
    python solve_captcha.py --profile e --wait 600
    python solve_captcha.py --profile e <video-url>

Check every account in one go:
    python solve_captcha.py --check a,b,c,d,e
"""
import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

import notify

from like import (
    HERE,
    captcha_present,
    from_dashboard,
    launch_liker,
    open_video,
    page_is_logged_out,
    video_id,
)


def profile_ok(pdir: Path) -> bool:
    return (pdir / "Default").exists()


def one(profile: str, url: str, wait_s: int, check_only: bool) -> str:
    """Returns a one-word verdict for this profile."""
    pdir = HERE / ("profile" if profile == "default" else f"profile-{profile}")
    if not profile_ok(pdir):
        return "no-session"

    with sync_playwright() as p:
        # Headed unless we are only reporting: you cannot drag a slider you
        # cannot see.
        ctx = launch_liker(p, profile, block_media=False, headed=not check_only)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            if not open_video(page, url):
                return "no-render"
            page.wait_for_timeout(2500)

            if page_is_logged_out(page):
                return "logged-out"
            if not captcha_present(page):
                return "clear"
            if check_only:
                return "CAPTCHA"

            print(f"\n[{profile}] Drag the slider in the window that opened.")
            print(f"[{profile}] Waiting up to {wait_s}s…")
            with notify.nagging(
                f"Captcha — profile {profile}",
                "Drag the slider in the window that opened.",
                every=20,
            ):
                for waited in range(0, wait_s, 3):
                    page.wait_for_timeout(3000)
                    if not captcha_present(page):
                        # A moment for TikTok to write whatever it wants to the
                        # profile, so the next run inherits the cleared state.
                        page.wait_for_timeout(4000)
                        print(f"[{profile}] solved after {waited + 3}s.")
                        return "solved"
            return "still-blocked"
        finally:
            ctx.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Clear TikTok's captcha for an account.")
    ap.add_argument("--profile", default="default")
    ap.add_argument("--check", default="", help="comma-separated profiles: report only, headless")
    ap.add_argument("--wait", type=int, default=300, help="seconds to wait for you to solve it")
    ap.add_argument("url", nargs="?", default="")
    args = ap.parse_args()

    url = args.url
    if not url:
        pulled, _ = from_dashboard("date", "1", {"platform": "tiktok", "limit": "3"})
        url = next((u for u in pulled if video_id(u)), "")
    if not url:
        print("No video URL to open.")
        return 1

    if args.check:
        profiles = [p.strip() for p in args.check.split(",") if p.strip()]
        print(f"checking {len(profiles)} profile(s) against {url}\n")
        worst = 0
        for prof in profiles:
            verdict = one(prof, url, args.wait, check_only=True)
            note = {
                "clear": "ready to work",
                "CAPTCHA": f"blocked — run: python solve_captcha.py --profile {prof}",
                "logged-out": f"signed out — run: python login.py --profile {prof}",
                "no-session": f"never signed in — run: python login.py --profile {prof}",
                "no-render": "page would not load",
            }.get(verdict, "")
            print(f"  {prof:<10} {verdict:<14} {note}")
            if verdict != "clear":
                worst = 1
        return worst

    verdict = one(args.profile, url, args.wait, check_only=False)
    print(f"\n{args.profile}: {verdict}")
    return 0 if verdict in ("clear", "solved") else 1


if __name__ == "__main__":
    sys.exit(main())
