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


def main() -> int:
    ap = argparse.ArgumentParser(description="Sign in to TikTok, Instagram or YouTube once for the liker.")
    ap.add_argument("--site", default="tiktok", choices=["tiktok", "instagram", "youtube"],
                    help="which site to sign in to (default: tiktok)")
    ap.add_argument("--profile", default="default", help="profile name (default: default)")
    ap.add_argument("--check", action="store_true", help="only check the stored session")
    ap.add_argument("--timeout", type=int, default=300, help="seconds to wait for sign-in")
    args = ap.parse_args()

    pdir = profile_dir(args.profile, args.site)
    pdir.mkdir(parents=True, exist_ok=True)
    probe = {"tiktok": signed_in,
             "instagram": signed_in_instagram,
             "youtube": signed_in_youtube}[args.site]

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(pdir),
            headless=args.check,
            user_agent=UA,
            locale="en-US",
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(SITE_HOME[args.site], wait_until="domcontentloaded")
        # Both of the newer sites hydrate after the document lands; probing the
        # instant it loads reports "signed out" for a session that is fine.
        page.wait_for_timeout(4000)

        ok, who = probe(page)
        if args.check:
            print(f"profile {pdir.name}: {'signed in as ' + who if ok else 'NOT signed in (' + who + ')'}")
            ctx.close()
            return 0 if ok else 1

        if ok:
            print(f"Already signed in as {who}. Nothing to do.")
            ctx.close()
            return 0

        print(f"Log in to {args.site} in the window that opened. Waiting...")
        deadline = args.timeout
        waited = 0
        while waited < deadline:
            page.wait_for_timeout(3000)
            waited += 3
            ok, who = probe(page)
            if ok:
                print(f"Signed in as {who}. Session saved to {pdir}")
                # A moment on the page so TikTok finishes writing what it wants
                # to storage; closing the instant the probe passes can leave the
                # profile half-written.
                page.wait_for_timeout(3000)
                ctx.close()
                return 0
            print(f"  …still waiting ({waited}s)", end="\r", flush=True)

        print("\nTimed out waiting for sign-in.")
        ctx.close()
        return 1


if __name__ == "__main__":
    sys.exit(main())
