#!/usr/bin/env python3
"""
One-time sign-in for the liker, for whichever site you name. Run it once per
site and account; the likers run afterwards using the profile it leaves behind.

Each site gets its OWN profile directory (./profile, ./profile-ig, ./profile-yt)
because a Chromium user data directory is a whole logged-in browser, and sharing
one between sites means every refresh of one risks the others.

A visible browser opens on tiktok.com. Log in however you normally do — password,
QR code, or an existing SSO — and the script waits until it can see that you are
signed in, then closes. Everything TikTok sets (cookies, localStorage, the
device fingerprint it derives) stays in ./profile, which is a real Chromium user
data directory rather than a cookie dump: TikTok's request signing reads more
than cookies, so half a session is no session.

Usage:
    python login.py                       # TikTok  -> ./profile
    python login.py --site instagram      # -> ./profile-ig
    python login.py --site youtube        # -> ./profile-yt
    python login.py --check               # only report whether the stored session works
    python login.py --profile alt         # a second account, in ./profile-alt
    python login.py --site youtube --profile alt   # -> ./profile-yt-alt
"""
import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

import busy
import console
import notify

console.fix()

HERE = Path(__file__).resolve().parent
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


# One browser profile per SITE as well as per account. A Chromium user data
# directory is a whole logged-in browser, and mixing three sites' sessions in one
# would mean a re-login on any site the moment another one is refreshed. TikTok
# keeps the bare names it has always used, so every existing profile still works.
SITE_HOME = {
    "tiktok": "https://www.tiktok.com/",
    "instagram": "https://www.instagram.com/",
    "youtube": "https://www.youtube.com/",
}
SITE_PREFIX = {"tiktok": "profile", "instagram": "profile-ig", "youtube": "profile-yt"}


def profile_dir(name: str, site: str = "tiktok") -> Path:
    prefix = SITE_PREFIX.get(site, "profile")
    return HERE / (prefix if name == "default" else f"{prefix}-{name}")


def signed_in_instagram(page) -> tuple[bool, str]:
    """Instagram, from the page's own view of itself.

    No probing endpoint here: /api/v1/users/web_profile_info answers 429 even
    inside a live session. But a signed-in Instagram always renders the nav, and
    a signed-out one always renders the login form — and the username is on the
    profile link in the nav.
    """
    try:
        info = page.evaluate(
            """() => {
                const text = document.body.innerText || ''
                const wall = /log into instagram|forgot password\\?/i.test(text.slice(0, 600))
                // The nav's profile link is /<me>/ and carries the avatar.
                let me = ''
                for (const a of document.querySelectorAll('a[href^="/"]')) {
                    const href = a.getAttribute('href') || ''
                    const m = href.match(/^\\/([A-Za-z0-9._]{1,30})\\/$/)
                    if (m && a.querySelector('img')) { me = m[1]; break }
                }
                return {wall, me, hasNav: !!document.querySelector('nav, [role="navigation"]')}
            }"""
        )
    except Exception as e:  # noqa: BLE001
        return False, f"probe failed: {e}"
    if info.get("wall"):
        return False, "the login form is on screen"
    if info.get("me"):
        return True, info["me"]
    if info.get("hasNav"):
        # Signed in, but the avatar link was not where we looked.
        return True, "unknown"
    return False, "no nav and no login form — page may not have finished loading"


def signed_in_youtube(page) -> tuple[bool, str]:
    """YouTube, from the masthead.

    Two signals rather than one, because either alone is wrong at some point in
    the page's life: the avatar button appears only when signed in, and the
    "Sign in" button only when signed out — a page still hydrating can show
    neither, and must not be reported as signed out.
    """
    try:
        info = page.evaluate(
            """async () => {
                const btn = document.querySelector('#avatar-btn, ytd-topbar-menu-button-renderer img')
                const signIn = [...document.querySelectorAll('a, button')].some(
                    (e) => /^sign in$/i.test((e.textContent || '').trim()))
                let name = ''
                const img = document.querySelector('#avatar-btn img, ytd-topbar-menu-button-renderer img')
                if (img) name = img.getAttribute('alt') || ''
                return {hasAvatar: !!btn, signIn, name}
            }"""
        )
    except Exception as e:  # noqa: BLE001
        return False, f"probe failed: {e}"
    if info.get("hasAvatar") and not info.get("signIn"):
        return True, (info.get("name") or "signed in").replace("Avatar image", "").strip() or "signed in"
    return False, "the Sign in button is on screen"


# A SITE REFUSING TO ANSWER IS NOT THE SITE SAYING "SIGNED OUT".
#
# The passport endpoint returns 403 to a machine it has decided to throttle.
# Measured here after a seventeen-account run: three profiles answered 403 at
# once, and a page-level probe of the same profiles showed no login button and
# no other sign of being logged out — the sessions were fine. Reported as "not
# signed in" that sends somebody to re-login seventeen healthy accounts, which
# is worse than admitting the check did not get an answer.
#
# "probe failed" and "no JSON" are in here for the same reason: they are this
# code failing to ask, not the site answering no.
REFUSED = ("HTTP 4", "HTTP 5", "probe failed", "no JSON")


def is_refusal(reason: str) -> bool:
    """Did the site decline to answer, rather than answer "no"?"""
    return any(m in str(reason or "") for m in REFUSED)


def signed_in(page) -> tuple[bool, str]:
    """
    Is this profile logged in, and as whom?

    Asks TikTok rather than looking at the page: the DOM changes constantly and a
    logged-out visitor sees a very similar shell. This endpoint answers plainly.
    """
    try:
        info = page.evaluate(
            """async () => {
                const r = await fetch('/passport/web/account/info/?aid=1459', {
                    credentials: 'include',
                })
                if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status }
                const j = await r.json().catch(() => null)
                if (!j) return { ok: false, reason: 'no JSON' }
                const d = j.data || {}
                return {
                    ok: Boolean(d.user_id_str || d.user_id),
                    name: d.screen_name || d.username || '',
                    uid: String(d.user_id_str || d.user_id || ''),
                    reason: j.message || '',
                }
            }"""
        )
    except Exception as e:  # noqa: BLE001 - any failure here means "not signed in"
        return False, f"probe failed: {e}"
    if not info.get("ok"):
        return False, info.get("reason") or "not signed in"
    # The API answers from cookies and can report a user while the rendered page
    # shows a Log in button. Only the page's own view of it decides.
    try:
        logged_out = page.evaluate(
            """() => {
                const btns = Array.from(document.querySelectorAll('button, a'))
                const login = btns.some((b) => {
                    const t = (b.textContent || '').trim().toLowerCase()
                    return t === 'log in' || t === 'login' || t === 'sign up'
                })
                const me = document.querySelector(
                    '[data-e2e="profile-icon"], [data-e2e="nav-profile"], [data-e2e="inbox-icon"]'
                )
                return login && !me
            }"""
        )
    except Exception:  # noqa: BLE001
        logged_out = False
    if logged_out:
        return False, "cookies exist but the page renders logged out"
    who = info.get("name") or info.get("uid") or "unknown"
    return True, who


def elapsed(seconds: int) -> str:
    """How long we have been waiting, in something a person can read.

    Bare seconds stop being legible at about the four-minute mark, which is
    precisely when somebody is standing there wondering whether it has hung.
    """
    if seconds < 60:
        return f"{seconds}s"
    m, sec = divmod(seconds, 60)
    if m < 60:
        return f"{m}m {sec:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m"


def main() -> int:
    ap = argparse.ArgumentParser(description="Sign in to TikTok, Instagram or YouTube once for the liker.")
    ap.add_argument("--site", default="tiktok", choices=["tiktok", "instagram", "youtube"],
                    help="which site to sign in to (default: tiktok)")
    ap.add_argument("--profile", default="default", help="profile name (default: default)")
    ap.add_argument("--check", action="store_true", help="only check the stored session")
    # NO TIMEOUT BY DEFAULT.
    #
    # Signing in is a person typing a password, reading a code off a phone, and
    # sometimes solving a captcha. Five minutes was a guess at how long that
    # takes, and when the guess was wrong the window closed mid-sign-in and the
    # whole thing had to be started again — which is strictly worse than waiting.
    # Nothing is consumed by waiting: the script sits on one page and probes it
    # every three seconds.
    #
    # Ctrl+C, or closing the browser window, ends it. Both are noticed and both
    # leave the profile as it was.
    ap.add_argument("--timeout", type=int, default=0,
                    help="seconds to wait for sign-in (0 = wait indefinitely, the default)")
    args = ap.parse_args()

    pdir = profile_dir(args.profile, args.site)
    pdir.mkdir(parents=True, exist_ok=True)
    probe = {"tiktok": signed_in,
             "instagram": signed_in_instagram,
             "youtube": signed_in_youtube}[args.site]

    # Asking about a profile a browser already has open gets a confident wrong
    # answer: the cookie database is held by that browser, so this one sees no
    # session. Said plainly instead — and only for --check, because opening a
    # window to sign in is a different thing from reading one.
    if args.check and busy.is_busy(pdir):
        print(f"profile {pdir.name}: IN USE — cannot check")
        print("  " + busy.note(pdir).split("\n", 1)[1].strip())
        return 2

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(pdir),
            headless=args.check,
            user_agent=UA,
            locale="en-US",
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"]
            # Full size on the main screen, and only when there is a window at
            # all: somebody is about to type a password into this.
            + ([] if args.check else notify.screen_args()),
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        if not args.check:
            notify.show_window(page, f"sign in {pdir.name}")
        page.goto(SITE_HOME[args.site], wait_until="domcontentloaded")
        # Both of the newer sites hydrate after the document lands; probing the
        # instant it loads reports "signed out" for a session that is fine.
        page.wait_for_timeout(4000)

        ok, who = probe(page)
        if args.check:
            if ok:
                print(f"profile {pdir.name}: signed in as {who}")
            elif is_refusal(who):
                # Exit 2, not 1. A caller that treats every non-zero as "log
                # this account in again" would do exactly the wrong thing.
                print(f"profile {pdir.name}: NO ANSWER ({who}) — {args.site} would not "
                      f"answer the check")
                print("  A 4xx/5xx here is the site throttling this machine, which many")
                print("  browsers at once causes. It says nothing about the session.")
                print("  Wait a while and check again rather than signing in again.")
            else:
                print(f"profile {pdir.name}: NOT signed in ({who})")
            ctx.close()
            return 0 if ok else (2 if is_refusal(who) else 1)

        if ok:
            print(f"Already signed in as {who}. Nothing to do.")
            ctx.close()
            return 0

        print(f"Log in to {args.site} in the window that opened.")
        if args.timeout > 0:
            print(f"Waiting up to {args.timeout}s. Ctrl+C to give up.")
        else:
            print("Waiting for as long as it takes. Ctrl+C, or close the window, to give up.")
        waited = 0
        try:
            while args.timeout <= 0 or waited < args.timeout:
                try:
                    page.wait_for_timeout(3000)
                except Exception:  # noqa: BLE001
                    # The window is gone. With no deadline this is the normal way
                    # somebody abandons a sign-in, and it must not look like a
                    # crash: nothing was written, and saying so is the whole
                    # message.
                    print("\nThe browser window was closed. Nothing was saved \u2014 run this again "
                          "when you are ready.")
                    return 1
                waited += 3
                try:
                    ok, who = probe(page)
                except Exception:  # noqa: BLE001
                    print("\nThe browser window was closed. Nothing was saved \u2014 run this again "
                          "when you are ready.")
                    return 1
                if ok:
                    print(f"\nSigned in as {who}. Session saved to {pdir}")
                    # A moment on the page so TikTok finishes writing what it wants
                    # to storage; closing the instant the probe passes can leave the
                    # profile half-written.
                    page.wait_for_timeout(3000)
                    ctx.close()
                    return 0
                print(f"  \u2026still waiting ({elapsed(waited)})", end="\r", flush=True)
        except KeyboardInterrupt:
            # Closed deliberately, so the profile directory is left as it was
            # rather than half-written by a context torn down mid-flight.
            print("\nGiven up on. Nothing was saved.")
            try:
                ctx.close()
            except Exception:  # noqa: BLE001
                pass
            return 1

        print(f"\nGave up after {args.timeout}s.")
        ctx.close()
        return 1


if __name__ == "__main__":
    sys.exit(main())
