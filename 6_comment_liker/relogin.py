#!/usr/bin/env python3
"""
Sign back in through Google when TikTok drops the session.

The cookies survive — sessionid, sid_tt and uid_tt are all still on disk and do
not expire until 2027 — but the server stops honouring them, so the page renders
a Log in button while the passport API still reports a user. When that happens
mid-run the account is dead for the rest of the list unless something signs it
back in.

The route is the one a person takes: Log in → Continue with Google → pick the
account in the popup. It works unattended only because the Chromium profile still
holds the GOOGLE session, so the chooser needs a single click and no password. If
Google asks for a password or a 2FA code there is nothing sensible to automate,
and this hands back to you instead.

Which Google account belongs to which profile is read from accounts.json:

    { "a": "someone@gmail.com", "b": "other@gmail.com" }

Without an entry it clicks the first account offered, which is right when a
profile only has one.

Usage:
    python relogin.py --profile a            # sign this profile back in
    python relogin.py --profile a --headed   # watch it happen
"""
import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

# Imported inside the functions, not here: like.py imports THIS module, so a
# top-level `from like import ...` is a cycle — it works when like.py is the
# entry point and breaks every other script that imports like.
def _like():
    import like
    return like

ACCOUNTS = Path(__file__).resolve().parent / "accounts.json"

# TikTok's "Log in" entry points, most specific first.
LOGIN_BUTTONS = [
    "#header-login-button",
    "[data-e2e='top-login-button']",
    "button:has-text('Log in')",
    "a:has-text('Log in')",
]
# The Google option inside the login modal.
GOOGLE_BUTTONS = [
    "div[role='link']:has-text('Continue with Google')",
    "div:has-text('Continue with Google')",
    "[data-e2e='channel-item']:has-text('Google')",
    "button:has-text('Continue with Google')",
]


def google_email_for(profile: str) -> str:
    try:
        return str(json.loads(ACCOUNTS.read_text(encoding="utf-8")).get(profile, "") or "")
    except Exception:  # noqa: BLE001
        return ""


def _click_first(page, selectors, timeout=4000) -> bool:
    for sel in selectors:
        try:
            el = page.wait_for_selector(sel, timeout=timeout, state="visible")
            if el:
                el.click()
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def pick_google_account(popup, email: str, timeout_ms: int = 20000) -> bool:
    """Choose the account in Google's chooser window.

    Matches on the email when we know it. Guessing on a profile with several
    Google accounts signed in would put the wrong identity on the TikTok account,
    which is worse than failing.
    """
    try:
        popup.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
    except Exception:  # noqa: BLE001
        pass
    popup.wait_for_timeout(1500)

    if email:
        for sel in (
            f"[data-identifier='{email}']",
            f"div:has-text('{email}')",
            f"li:has-text('{email}')",
        ):
            try:
                el = popup.wait_for_selector(sel, timeout=4000, state="visible")
                if el:
                    el.click()
                    return True
            except Exception:  # noqa: BLE001
                continue

    # No email configured: take the first account offered. Right for a profile
    # with one Google session, which is how these are set up.
    for sel in ("[data-identifier]", "ul li div[role='link']", "div[role='link']"):
        try:
            el = popup.wait_for_selector(sel, timeout=4000, state="visible")
            if el:
                el.click()
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def relogin(page, profile: str, headed: bool = False, wait_s: int = 120) -> bool:
    """Take a logged-out page back to signed in. True when it worked."""
    email = google_email_for(profile)
    print(f"    signing back in{' as ' + email if email else ''}…")

    if not _click_first(page, LOGIN_BUTTONS):
        # The button lives on the modal on some layouts; the login page always
        # has one.
        try:
            page.goto("https://www.tiktok.com/login", wait_until="domcontentloaded")
            page.wait_for_timeout(2000)
        except Exception:  # noqa: BLE001
            return False
    page.wait_for_timeout(1500)

    # Google opens a popup. Catch it as it is created, or the click returns and
    # the window is lost.
    try:
        with page.context.expect_page(timeout=15000) as popup_info:
            if not _click_first(page, GOOGLE_BUTTONS, timeout=6000):
                print("    could not find 'Continue with Google'")
                return False
        popup = popup_info.value
    except Exception as e:  # noqa: BLE001
        print(f"    no Google window appeared ({str(e)[:50]})")
        return False

    if not pick_google_account(popup, email):
        print("    could not pick the account in the Google window")
        if headed:
            print(f"    finish it by hand — waiting up to {wait_s}s")
        else:
            return False

    # Google closes its own window and TikTok reloads signed in.
    for _ in range(wait_s // 3):
        page.wait_for_timeout(3000)
        try:
            if popup.is_closed() and not _like().page_is_logged_out(page):
                page.wait_for_timeout(3000)  # let TikTok write the session
                print("    signed back in.")
                return True
        except Exception:  # noqa: BLE001
            if not _like().page_is_logged_out(page):
                print("    signed back in.")
                return True
    return not _like().page_is_logged_out(page)


def main() -> int:
    ap = argparse.ArgumentParser(description="Sign a profile back into TikTok via Google.")
    ap.add_argument("--profile", default="default")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--wait", type=int, default=120)
    args = ap.parse_args()

    pdir = Path(__file__).resolve().parent / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    if not (pdir / "Default").exists():
        print(f"No profile at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    with sync_playwright() as p:
        ctx = _like().launch_liker(p, args.profile, block_media=False, headed=args.headed)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto("https://www.tiktok.com/", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        if not _like().page_is_logged_out(page):
            print(f"{args.profile}: already signed in, nothing to do.")
            ctx.close()
            return 0

        ok = relogin(page, args.profile, headed=args.headed, wait_s=args.wait)
        ctx.close()
    print(f"{args.profile}: {'signed in' if ok else 'still signed out'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
