#!/usr/bin/env python3
"""Open a profile's browser and hand it to you.

A profile here is a whole signed-in Chromium — cookies, storage, and the device
fingerprint TikTok derives from it. Everything else in this project opens one,
does its own work and closes it. This one opens it and gets out of the way, so
you can change the account, edit a bio, clear a warning, solve a captcha, or
sign in where `login.py` cannot help because the profile is already signed in as
somebody else.

    python open_profile.py --profile d                # TikTok, profile-d
    python open_profile.py --profile l,o              # one after another
    python open_profile.py --profile d --url https://www.tiktok.com/setting
    python open_profile.py --site instagram --profile b

It opens, tells you who the profile is signed in as, and waits. Close the
browser window when you are done — or press Ctrl+C — and it reports who the
profile is signed in as NOW, so a change you made is confirmed rather than
assumed.

DO NOT RUN THIS AGAINST A PROFILE A LIKER IS USING. Chromium locks a user data
directory while it holds it, so the launch simply fails; that is caught and
said plainly rather than left as a traceback. Stop the run first.

WHY NOT JUST OPEN CHROME YOURSELF: these are Playwright's Chromium, not your
installed Chrome, and they are launched with the same user agent and flags the
liker uses. Opening the same directory with a different browser build or
different flags changes what the site fingerprints, which is the one thing these
profiles exist to keep stable.
"""
import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from login import SITE_HOME, UA, profile_dir
from sessions import IN_USE_MARKERS, PROBES, reason

import busy
import console
import notify

console.fix()

# How often the window is checked for having been closed. Short enough to feel
# immediate, long enough to cost nothing over an hour of sitting there.
POLL_MS = 500


def whoami(page, site: str) -> tuple[bool, str]:
    """Who this profile is signed in as, or why not. Never raises."""
    try:
        return PROBES[site](page)
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:120]


def open_one(pw, site: str, name: str, url: str) -> int:
    pdir = profile_dir(name, site)
    fresh = not (pdir / "Default").exists()
    pdir.mkdir(parents=True, exist_ok=True)

    print(f"\n── {name} ── {pdir.name}")
    if fresh:
        print("   no session here yet — this will be a new, empty browser")

    if busy.is_busy(pdir):
        print("   ALREADY OPEN in another browser — a liker is probably using it.")
        print("   Stop that run first: two browsers cannot share one profile.")
        return 1

    try:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(pdir),
            headless=False,
            user_agent=UA,
            locale="en-US",
            # None, so the window is a real resizable one rather than a page
            # pinned to a fixed viewport. This is for a person, not a script.
            viewport=None,
            args=["--disable-blink-features=AutomationControlled"]
            + notify.screen_args(),
        )
    except Exception as e:  # noqa: BLE001
        low = str(e).lower()
        if any(m in low for m in IN_USE_MARKERS):
            print("   ALREADY OPEN in another process — a liker is probably using it.")
            print("   Stop that run first; opening the same directory twice is how a")
            print("   profile gets corrupted.")
            return 1
        print(f"   could not open: {str(e).splitlines()[0][:150]}")
        return 1

    before = ("", False)
    try:
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(url, wait_until="domcontentloaded")
        # The newer sites hydrate after the document lands; asking who we are the
        # instant it loads reports "signed out" for a session that is fine.
        page.wait_for_timeout(4000)
        ok, who = whoami(page, site)
        before = (who, ok)
        print(f"   signed in as @{who}" if ok else f"   not signed in{f' ({reason(who)})' if reason(who) else ''}")
        print("   The window is yours. Close it when you are done (or press Ctrl+C).")

        # Wait for the person. The context has no pages left once every window
        # is closed, which is the signal that they are finished.
        while True:
            try:
                if not ctx.pages:
                    print("   window closed.")
                    break
                page.wait_for_timeout(POLL_MS)
            except KeyboardInterrupt:
                raise
            except Exception:  # noqa: BLE001
                # The page went away between the check and the wait — the same
                # thing as the window being closed, arriving a moment earlier.
                print("   window closed.")
                break
    except KeyboardInterrupt:
        print("\n   Ctrl+C — closing the browser.")
    finally:
        # What the profile is signed in as NOW. Asked before the context closes,
        # because after it there is nothing left to ask. This is the whole point
        # of the tool: a change you made is confirmed rather than assumed.
        after = None
        try:
            if ctx.pages:
                p = ctx.pages[0]
                p.goto(SITE_HOME[site], wait_until="domcontentloaded", timeout=20000)
                p.wait_for_timeout(3000)
                after = whoami(p, site)
        except Exception:  # noqa: BLE001
            after = None
        # Closed deliberately, and the only place it is closed: a context torn
        # down mid-write is how a user data directory ends up half-written.
        try:
            ctx.close()
        except Exception:  # noqa: BLE001
            pass

    if after is None:
        print("   (window was already gone, so the account could not be re-checked)")
        print(f"   Check it with: python login.py --site {site} --profile {name} --check")
        return 0

    ok_after, who_after = after
    if ok_after and not before[1]:
        print(f"   NOW SIGNED IN as @{who_after}. Saved to {pdir.name}.")
    elif ok_after and who_after != before[0]:
        print(f"   ACCOUNT CHANGED: @{before[0]} -> @{who_after}. Saved to {pdir.name}.")
    elif ok_after:
        print(f"   still signed in as @{who_after}.")
    elif before[1]:
        print(f"   NO LONGER SIGNED IN (was @{before[0]}). Sign in again with:")
        print(f"     python login.py --site {site} --profile {name}")
    else:
        print("   still not signed in.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Open a profile's browser window and leave it to you."
    )
    ap.add_argument("--site", default="tiktok", choices=["tiktok", "instagram", "youtube"])
    ap.add_argument("--profile", "--profiles", default="default", dest="profiles",
                    help="profile name, or several separated by commas (opened one at a time)")
    ap.add_argument("--url", default="",
                    help="where to start (default: the site's home page)")
    args = ap.parse_args()

    names = [p.strip() for p in args.profiles.split(",") if p.strip()]
    if not names:
        print("No profile named.")
        return 2
    url = args.url or SITE_HOME[args.site]

    if len(names) > 1:
        print(f"{len(names)} profile(s), one at a time: {', '.join(names)}")
        print("Close each window to move on to the next.")

    rc = 0
    with sync_playwright() as pw:
        for name in names:
            try:
                rc |= open_one(pw, args.site, name, url)
            except KeyboardInterrupt:
                # Ctrl+C inside open_one closes that browser; a second one here
                # means "stop altogether" rather than "next profile".
                print("\nStopped.")
                return 1

    if len(names) > 1 or args.site != "tiktok":
        print(f"\nRefresh the session list with: python sessions.py --site {args.site}")
    else:
        print(f"\nRefresh the session list with: python sessions.py --profiles {','.join(names)}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
