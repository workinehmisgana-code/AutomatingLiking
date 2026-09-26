#!/usr/bin/env python3
"""
Like TikTok comments programmatically, using the session login.py saved.

READING IS CHEAP, LIKING IS NOT
Finding the comments is a plain HTTP read of /api/comment/list/ — unsigned, no
browser, ~50 comments per request, and it runs at network speed.

Liking costs a page load. /api/comment/digg/ refuses an unsigned call outright
(403, Argus), and a call issued from inside the logged-in page is ACCEPTED and
then silently not applied — status_code 0, user_digged still false. That was
measured against comments confirmed un-liked beforehand; a probe that picks its
targets from the unauthenticated read will "prove" the opposite, because
user_digged reads 0 for everyone there and it ends up re-liking its own earlier
work. Clicking the heart is the only route that actually applies a like.

So a video costs one page load, and every matching comment on it is liked while
we are there. --mode fast is the request route, kept only so the claim can be
re-tested when TikTok changes something.

WHERE THE LINKS COME FROM
--from-dashboard pulls them out of the admin dashboard for the cluster selection
you choose: --cluster-by rank|date|combined with --clusters 1,2. The DASHBOARD
does the clustering, not this script. Clusters are relative — assigned by
splitting the sorted pool per platform — so they exist nowhere in the database,
and a script recomputing them would drift from what you see on screen.

That same call returns the ACTIVE comment products, so --products matches the set
switched on in the dashboard rather than a list hardcoded here.

--links still takes a plain file for anything ad hoc.

SELECTING WHAT TO LIKE
--products likes comments mentioning one of the active product names (matched
with punctuation and case stripped, so "purify text" and "purifytext" both
count). --users likes comments by specific @handles. --all likes every comment on
the video, which is rarely what you want.

Usage:
    python login.py                                              # once
    python like.py --from-dashboard --cluster-by rank --clusters 1,2 --products
    python like.py --from-dashboard --cluster-by date --clusters 1 --products --dry-run
    python like.py --links links.txt --products
    python like.py --links links.csv --users worker1,worker2 --delay 2,5
    python like.py --unlike --links links.txt --products

DASHBOARD_URL and LINKS_EXPORT_TOKEN are read from .env here, falling back to
../3_dashboard/.env so the token lives in one place.

Every like is written to done.csv as it happens, and rows already in there are
skipped, so a re-run resumes rather than repeating.
"""
import argparse
import csv
import hashlib
import json
import random
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse

from playwright.sync_api import sync_playwright

import busy
import captcha
import notify
import relogin
from login import is_refusal, profile_dir

import console

console.fix()

HERE = Path(__file__).resolve().parent

# The Windows console is cp1252 and comment text is not: the generator now ends
# every comment with an emoji, so printing one crashes the whole run on the first
# line it reaches. Every other script here imports this module, so setting it
# once covers all of them.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older or redirected streams simply keep theirs
        pass


# Chromium flags that matter when several of these share one machine.
#
# The first group keeps a backgrounded window working; the second is about
# MEMORY, which is the binding constraint once more than a handful of accounts
# run at once — a Chromium is seven processes, and nine accounts is sixty-three.
#
# Nothing here changes what the page can do: the comment panel is text and DOM,
# and media, images and fonts are already blocked at the network layer (see
# BLOCKED_RESOURCES). These switch off machinery that only exists to make a
# browser pleasant to sit in front of.
LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--mute-audio",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    # One page at a time is all a worker ever has, so the extra renderers
    # Chromium keeps warm for other sites are pure cost.
    "--renderer-process-limit=1",
    # Nothing is ever rendered to a screen we look at, and the GPU process is a
    # process like any other.
    "--disable-gpu",
    "--disable-software-rasterizer",
    # Extensions, sync, field trials, crash upload, the component updater: all
    # of it is a browser being a product. None of it likes a comment.
    "--disable-extensions",
    "--disable-sync",
    "--disable-component-update",
    "--disable-background-networking",
    "--no-default-browser-check",
    "--no-first-run",
    "--metrics-recording-only",
    "--disable-breakpad",
    # Chromium keeps caches proportional to what it thinks it has. Told it is
    # small, it keeps less; the pages here are visited once each, so a cache
    # buys nothing anyway.
    "--disk-cache-size=1",
    "--media-cache-size=1",
]

# Resource types we never need. The comment panel is text and DOM.
BLOCKED_RESOURCES = {"media", "image", "font"}

# The video does NOT arrive as a "media" request — TikTok streams it through
# fetch, so filtering on resource type alone lets the largest thing on the page
# straight through. Measured on one video page: 9.37 MB total, of which 5.32 MB
# script, 3.08 MB fetch and only 0.86 MB media/image/font. These patterns catch
# the fetch traffic that carries the video.
VIDEO_URL_BITS = (
    "mime_type=video_mp4",
    "/video/tos/",
    "/obj/tos-",
    ".mp4",
    ".webm",
    "v16-webapp",
    "v19-webapp",
    "/aweme/v1/play/",
)


def _is_video_bytes(url: str) -> bool:
    """Video payload, as opposed to an API call we depend on.

    /api/ is excluded explicitly: the comment list and the like both live there
    and blocking either would break the whole thing.
    """
    if "/api/" in url:
        return False
    return any(bit in url for bit in VIDEO_URL_BITS)


def raise_window(ctx, profile: str) -> None:
    """Bring a just-opened browser window to the front.

    Matched by TITLE, because that is all EnumWindows can see, and the title is
    made unique first — several accounts on about:blank otherwise share one and
    the wrong window comes forward. It is replaced by the page's own title on
    the first navigation, a second later, which is fine: this is only needed
    now.

    A courtesy, not the job: every failure here is swallowed.
    """
    try:
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        notify.show_window(page, f"liker {profile}")
    except Exception:  # noqa: BLE001
        pass


def launch_liker(
    p,
    profile: str,
    block_media: bool = True,
    headed: bool = False,
    slot: int = 0,
    slots: int = 1,
):
    """A browser tuned for running several at once.

    The default context downloads and PLAYS the video on every page. With five
    of those on one machine the browsers starve each other, the page never
    paints, and the run fails with "comment panel did not open" — which reads
    like a selector problem and is really a CPU one. Blocking media, images and
    fonts leaves the DOM we need and removes almost all of the cost.
    """
    pdir = HERE / ("profile" if profile == "default" else f"profile-{profile}")
    args = list(LAUNCH_ARGS)
    if headed:
        # FULL SIZE, ON THE MAIN SCREEN, EVERY TIME.
        #
        # These used to be tiled: the screen divided into `slots` boxes, one per
        # account. With seventeen accounts that is three columns and six rows of
        # a screen that has one, so most windows were positioned hundreds of
        # pixels below the bottom edge — off-screen, un-clickable, and looking
        # for all the world like the browser never opened. A window that opens
        # where a captcha can actually be solved is worth more than a mosaic.
        #
        # The size comes from the main monitor's WORK area, so the bottom of the
        # page is not under the taskbar — on TikTok that bottom strip is the
        # comment box.
        x, y, w, h = notify.primary_screen()
        args += [f"--window-size={w},{h}", f"--window-position={x},{y}"]
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(pdir),
        # Headed costs more CPU per browser, so it works against running several
        # at once — but it is the path TikTok actually expects, and you can watch
        # what the page does. Worth trying when headless behaves oddly.
        headless=not headed,
        user_agent=UA,
        locale="en-US",
        # None in headed mode, so the page follows the real window size.
        viewport=None if headed else {"width": 1280, "height": 900},
        args=args,
    )
    if headed:
        # Opening it is not the same as being able to find it. Chrome does not
        # reliably take the foreground when it is started by a script, so the
        # window can be full-size on the right monitor and still be behind
        # everything else.
        raise_window(ctx, profile)
    if block_media:
        def _filter(route):
            # Wrapped: an exception in a route handler leaves that request
            # hanging forever, and the page then never finishes loading — which
            # looks exactly like "page did not render in time".
            try:
                req = route.request
                if req.resource_type in BLOCKED_RESOURCES or _is_video_bytes(req.url):
                    route.abort()
                else:
                    route.continue_()
            except BaseException:  # noqa: BLE001
                # BaseException, not Exception: when the page is torn down under
                # a handler that is mid-continue_(), Playwright raises
                # asyncio.CancelledError, and CancelledError has not inherited
                # from Exception since 3.8. Catching Exception here let it out
                # of the handler, where it surfaced as a stray traceback from a
                # thread nobody owns.
                try:
                    route.continue_()
                except BaseException:  # noqa: BLE001
                    pass

        ctx.route("**/*", _filter)
        # Kept so solve_captcha_here() can lift the blocking while a captcha is
        # up. Not for the puzzle images — those are data: URIs and no network
        # filter can touch them — but for whatever else the widget pulls in.
        ctx._liker_filter = _filter
    return ctx


def solve_captcha_here(page, verbose: bool = True) -> bool:
    """Solve the captcha with resource blocking lifted for the duration.

    The puzzle images turn out to be data: URIs, so the blocking never touched
    them and the earlier theory about it was wrong. The widget around them does
    load its own assets though, and a captcha is the one moment in a run where a
    few hundred kilobytes is not worth arguing about.
    """
    ctx = page.context
    handler = getattr(ctx, "_liker_filter", None)
    lifted = False
    if handler is not None:
        try:
            ctx.unroute("**/*", handler)
            lifted = True
        except Exception:  # noqa: BLE001
            lifted = False
    try:
        return captcha.solve(page, verbose=verbose)
    except Exception as e:  # noqa: BLE001
        if verbose:
            print(f"     solver error: {str(e)[:70]}")
        return False
    finally:
        if lifted:
            try:
                ctx.route("**/*", handler)
            except Exception:  # noqa: BLE001
                pass


def safe_eval(page, js, arg=None, tries=3):
    """page.evaluate that survives a navigation landing mid-call.

    TikTok's SPA re-routes on its own, and with several browsers competing for
    one machine it happens often enough to kill a run: "Execution context was
    destroyed" is not a bug in the script, it is the page moving while we were
    reading it. Retry rather than crash.

    And when the retries run out on a navigation, return None rather than
    raising. Every caller already reads the result as `or {}` / `or []`, so a
    None costs ONE video, recorded as a failure. Raising cost the whole shard:
    nothing between here and sys.exit(main()) catches it, so the worker died
    and left its remaining links untouched.
    """
    for attempt in range(tries):
        try:
            return page.evaluate(js, arg) if arg is not None else page.evaluate(js)
        except Exception as e:  # noqa: BLE001
            transient = "Execution context was destroyed" in str(e) or "navigating" in str(e)
            if transient:
                if attempt + 1 < tries:
                    try:
                        page.wait_for_timeout(1500)
                    except Exception:  # noqa: BLE001 - page gone; nothing to retry on
                        return None
                    continue
                return None
            raise
    return None


# Consecutive videos that would not render. Not a count of failures — a count
# of failures IN A ROW, because one is a bad link and six is a machine that
# cannot keep up.
_render_streak = 0
_render_diagnosed = False


def render_failed(window_count: int) -> None:
    """Report a video that never rendered, and after a few, say why.

    "page did not render, skipping" is true and useless. The message is almost
    always the same story: open_video waits 30s for the comment icon, and with
    enough browsers on one machine the page genuinely has not painted yet.
    Measured on a real 17-account run: the accounts that started LAST hit it
    within ten lines of output, the ones that started first got through thirty,
    and throughput fell from 0.32 to 0.02 videos a second — a sixteenfold
    slowdown, on a machine doing the same work.

    So the count is the diagnosis, and it is printed once per run rather than
    per video: the run is already drowning in output when this happens.
    """
    global _render_streak, _render_diagnosed
    _render_streak += 1
    print("     page did not render, skipping")
    if _render_streak < 3 or _render_diagnosed:
        return
    _render_diagnosed = True
    print(
        f"\n  {_render_streak} videos in a row would not finish loading.\n"
        "  This is nearly always the machine rather than the links: a page is given\n"
        "  30 seconds to show its comment icon, and enough browsers at once means it\n"
        "  genuinely has not painted yet."
        + (f"\n  This run has {window_count} accounts going at the same time."
           if window_count > 1 else "")
        + "\n  Fewer at once finishes the same list faster:\n"
          "    run_parallel.py --at-once 4 ...    (or 'Browsers at once' on the dashboard)\n"
    )


# Hearts pressed whose like TikTok did not keep. Not a count of failures — a
# count of CLICKS THAT WORKED and changed nothing on the server.
_clicked_nothing = 0
_ever_landed = False
_discard_said = False


def clicked_but_not_kept(profile: str, account: str) -> bool:
    """Report a like that was pressed and not kept, and say what it means.

    THE CLICK IS NOT THE LIKE. The heart fills in immediately — that is the page
    being optimistic, not the server agreeing — and every like here is confirmed
    by reading user_digged back from TikTok afterwards. When the click reports
    success and the read-back says nothing happened, the like was discarded.

    Measured on profiles k, m and p, on the same video and the same comment as
    three healthy accounts:

        k  user3995128760667   product comments 1   liked by it 0
        m  user7251079252826                    1               0
        p  Hailu8692                            1               0
        n  user739216320986                     1               1
        q  Abel9749                             1               1
        a  Misgana a                            1               1

    k had just pressed that heart and watched it fill. A full page reload, and a
    read past any cache, both still said user_digged=false. Those three accounts
    have never landed a single like in their entire ledger.

    Nothing in this tool can fix that: it is the account, not the click, and a
    run that keeps going is spending an hour to write failures. Said once, with
    the account name, because that is what somebody has to go and look at.

    Returns True when the run should stop this profile. IT SHOULD. --keep-going
    means "a bad video is not a reason to stop", which is about videos; an
    account whose every like is discarded is not a run having a bad patch.
    Measured on the run this came from: k, m and p wrote 384, 379 and 391
    failure rows and landed nothing, while taking a third of a machine the five
    working accounts were starving on — their render failures are partly the
    price of these three.
    """
    global _clicked_nothing, _discard_said
    _clicked_nothing += 1
    if _ever_landed or _clicked_nothing < 8:
        return False
    if _discard_said:
        return True
    _discard_said = True
    print(
        f"\n  {_clicked_nothing} hearts pressed on profile '{profile}'"
        f"{f' (@{account})' if account else ''} and not one like was kept.\n"
        "  The heart fills in on screen — that is the page being optimistic — but\n"
        "  TikTok reports the comment as un-liked afterwards, even after a reload.\n"
        "  This account's likes are being discarded. Nothing here can change that:\n"
        "  open it by hand, like something, reload, and see for yourself:\n"
        f"    python open_profile.py --profile {profile}\n"
        "  Stopping this profile: there is nothing here to keep going for, and the\n"
        "  browser it is using is one the working accounts need.\n"
    )
    return True


def like_landed() -> None:
    """A like TikTok kept. Whatever the last few did, the account works."""
    global _clicked_nothing, _ever_landed
    _clicked_nothing = 0
    _ever_landed = True


def render_ok() -> None:
    """A video that did render. Breaks the streak."""
    global _render_streak
    _render_streak = 0


# --debug. Off by default: a stamp and a page dump on two thousand videos is
# noise, and the ordinary log is meant to be readable.
DEBUG = False


def dbg(msg: str) -> None:
    """A line that only exists when somebody is debugging."""
    if DEBUG:
        print(f"       · {msg}")


# What a page looks like when it will not do what it is told.
#
# "page did not render, skipping" names the symptom and nothing else, and by the
# time anybody reads it the browser is gone. This asks the page the questions
# somebody would ask by hand — where did it end up, what is on it, is it signed
# in, is there a puzzle over it — in one evaluate, so it costs one round trip
# even when a machine is struggling.
PAGE_STATE_JS = """() => {
    const has = (s) => Boolean(document.querySelector(s))
    const btns = Array.from(document.querySelectorAll('button, a'))
    return {
        url: location.href,
        title: (document.title || '').slice(0, 70),
        ready: document.readyState,
        nodes: document.getElementsByTagName('*').length,
        icon: has('[data-e2e="comment-icon"]'),
        video: has('video'),
        rows: document.querySelectorAll('[data-e2e="comment-level-1"]').length,
        panel: has('[data-e2e="comment-list"], [data-e2e="search-comment-container"]'),
        login: btns.some((b) => {
            const t = (b.textContent || '').trim().toLowerCase()
            return t === 'log in' || t === 'login' || t === 'sign up'
        }),
        me: has('[data-e2e="profile-icon"], [data-e2e="nav-profile"], [data-e2e="inbox-icon"]'),
        // TikTok's own words for it, when it has any.
        notice: (document.body ? (document.body.innerText || '') : '')
            .split('\\n').map((x) => x.trim())
            .filter((x) => /not available|removed|violat|try again|too many|unavailable|error/i.test(x))
            .slice(0, 2),
    }
}"""


def page_state(page) -> dict:
    """Everything worth knowing about the page right now, or why not."""
    try:
        return safe_eval(page, PAGE_STATE_JS) or {"error": "no answer"}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e).splitlines()[0][:80]}


def why_stuck(page, waited: float = 0.0) -> str:
    """One line naming what is actually wrong, for the log AND for the ledger.

    Goes into the ledger note as well as the terminal, because a failure is
    usually read the next morning out of done-x.csv, long after the browser it
    happened in was closed.
    """
    st = page_state(page)
    if st.get("error"):
        return f"the page could not be asked: {st['error']}"
    bits = [
        f"url={str(st.get('url', ''))[-46:]}",
        f"ready={st.get('ready')}",
        f"nodes={st.get('nodes')}",
        f"icon={'yes' if st.get('icon') else 'NO'}",
        f"video={'yes' if st.get('video') else 'no'}",
        f"rows={st.get('rows')}",
    ]
    if st.get("login") and not st.get("me"):
        bits.append("LOGGED OUT")
    if captcha_present(page):
        bits.append("CAPTCHA on screen")
    for n in (st.get("notice") or []):
        bits.append(f'page says "{n[:60]}"')
    if waited:
        bits.append(f"waited={waited:.1f}s")
    return ", ".join(bits)


def open_video(page, url: str, timeout_ms: int = 30000) -> bool:
    """Load a video and wait until it has really rendered.

    Waits for the comment icon rather than sleeping a fixed 3.5s. That fixed
    wait was fine for one browser and useless for five: they share one CPU, the
    page had not painted yet, and every account reported "no comment-icon on the
    page" for what was only slowness. One reload before giving up, because a
    first load that stalls often succeeds second time.
    """
    started = time.time()
    for attempt in range(2):
        try:
            page.goto(url, wait_until="domcontentloaded")
            dbg(f"document in {time.time() - started:.1f}s (try {attempt + 1})")
        except Exception as e:  # noqa: BLE001 - a timeout here is still worth waiting out
            dbg(f"goto raised after {time.time() - started:.1f}s: "
                f"{str(e).splitlines()[0][:80]}")
        try:
            page.wait_for_selector('[data-e2e="comment-icon"]', timeout=timeout_ms)
            # A breath after it appears: the icon renders slightly before its
            # click handler is attached.
            page.wait_for_timeout(400)
            dbg(f"rendered in {time.time() - started:.1f}s")
            return True
        except Exception:  # noqa: BLE001
            dbg(f"no comment icon after {time.time() - started:.1f}s"
                + (" — reloading once" if attempt == 0 else ""))
            if attempt == 0:
                page.wait_for_timeout(2000)
    return False


def captcha_present(page) -> bool:
    """Is TikTok showing its slider puzzle?

    It blocks the comment list behind grey placeholders while the account stays
    signed in and the panel sits on the right tab — so every symptom points at
    the DOM and none of them is the cause. Worth naming explicitly rather than
    reporting "comment panel did not open" for the rest of the run.
    """
    try:
        return bool(
            page.evaluate(
                """() => {
                    const sel = [
                        '#captcha-verify-image',
                        '[class*="captcha" i]',
                        '[id*="captcha" i]',
                        '[class*="secsdk-captcha" i]',
                    ]
                    for (const s of sel) {
                        const el = document.querySelector(s)
                        if (!el) continue
                        const r = el.getBoundingClientRect()
                        if (r.width > 0 && r.height > 0) return true
                    }
                    return false
                }"""
            )
        )
    except Exception:  # noqa: BLE001
        return False


# Window swaps that opened onto no puzzle at all. Two of those and the run stops
# opening windows: see show_for_captcha.
_fruitless_swaps = 0
_window_pointless = False
# Puzzles that simply went away on a reload, no window involved.
_captchas_faded = 0


def captcha_faded(page, url: str, wait_s: int = 8) -> bool:
    """Wait a moment, load the video again, and see if the puzzle is still there.

    TikTok's slider is triggered by RATE, not by the account: it shows up when a
    machine asks for too much too quickly, and it stops being asked for when the
    asking stops. Measured on one browser doing exactly what a run does — load a
    video, open the comments — across eight videos on a profile that had been
    challenged repeatedly during a seventeen-account run: not one puzzle.

    Which is why this is tried FIRST. Eight seconds of doing nothing, then a
    reload, against thirty seconds of closing a browser and starting another one.
    """
    global _captchas_faded
    try:
        page.wait_for_timeout(wait_s * 1000)
        if not open_video(page, url):
            return False
        # The comments are what summons it, so ask for them before believing it
        # is gone (see show_for_captcha).
        if not captcha_present(page):
            open_comments(page)
            page.wait_for_timeout(1000)
        if not captcha_present(page):
            _captchas_faded += 1
            return True
    except Exception:  # noqa: BLE001
        pass
    return False


def show_for_captcha(pw, ctx, page, args, url: str, tried_api: bool):
    """Clear a captcha a headless run cannot drag a slider for.

    Two ways, cheapest first.

    WAIT IT OUT. The puzzle is rate-triggered, and a browser that pauses for
    eight seconds and reloads is usually not asked again. Costs eight seconds
    and no browser.

    OPEN A WINDOW. A HEADLESS BROWSER CANNOT BE MADE HEADED: Playwright decides
    at launch, and headless is a different binary (headless_shell.exe, not
    chrome.exe). So the browser is closed and the same profile is opened again
    with a window — the session lives in the profile directory, not in the
    process, so it is the same account either way. That also means the directory
    has to be released first: two Chromiums cannot share one. About thirty
    seconds, against a headless run that otherwise gives up on the account.

    WHAT THIS GOT WRONG, and it showed as one line printed on video after video
    — "the captcha was gone by the time the window opened":

      * It went straight to the window. By the time one was up, thirty seconds
        of not asking TikTok for anything had already cleared the puzzle, so the
        window had nothing in it and the same thing happened on the next video.
      * It checked the wrong moment. The puzzle is gated on the ACTION: it
        appears when the comments are opened. A fresh window sitting on a
        freshly loaded video is not being asked anything yet, so "no captcha
        here" was never evidence of anything. The window now opens the comments.

    Returns (ctx, page, solved) — the caller must rebind both, because neither
    survives.
    """
    global _fruitless_swaps, _window_pointless
    # Cheapest first, and on the evidence usually enough.
    if captcha_faded(page, url):
        print("     the puzzle cleared on its own after a pause")
        return ctx, page, True
    if _window_pointless:
        # Two windows have already opened onto nothing. A third costs thirty
        # seconds to learn the same thing.
        return ctx, page, False

    print("     captcha — opening a window so it can be solved")
    try:
        ctx.close()
    except Exception:  # noqa: BLE001
        pass

    solved = False
    found = False
    # Did a window actually open? A swap that failed to launch proves nothing
    # about what a window would have been shown.
    window_ok = False
    try:
        ctx = launch_liker(pw, args.profile, block_media=not args.with_media,
                           headed=True, slot=args.window_slot, slots=args.window_count)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        window_ok = True
        if open_video(page, url):
            if not captcha_present(page):
                # Do the thing that summoned it.
                open_comments(page)
                page.wait_for_timeout(1000)
            if captcha_present(page):
                found = True
                solved = wait_out_captcha(page, args.profile, True, tried_api=tried_api)
            else:
                print("     no puzzle in the window, even with the comments open")
                solved = True
        else:
            print("     the window opened but the video would not load")
    except Exception as e:  # noqa: BLE001
        print(f"     could not open a window: {str(e).splitlines()[0][:110]}")

    if window_ok and not found:
        _fruitless_swaps += 1
        if _fruitless_swaps >= 2:
            _window_pointless = True
            print(
                "  Twice now a window has opened onto no puzzle. These are clearing\n"
                "  themselves while the browser restarts, so this run will stop opening\n"
                "  windows and just pause instead — it is the same result, thirty seconds\n"
                "  cheaper. They are triggered by how fast this machine is asking, so\n"
                "  fewer accounts at once (--at-once) is what stops them."
            )

    # Back to headless. Staying headed would quietly double the memory of a run
    # somebody chose headless for, for the rest of its life.
    try:
        ctx.close()
    except Exception:  # noqa: BLE001
        pass
    ctx = launch_liker(pw, args.profile, block_media=not args.with_media,
                       headed=False, slot=args.window_slot, slots=args.window_count)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    if solved:
        open_video(page, url)
        print("     back to headless, carrying on")
    return ctx, page, solved


def wait_out_captcha(page, profile: str, headed: bool, timeout_s: int = 240,
                     tried_api: bool = False) -> bool:
    """Sound the alarm and give a person the chance to solve it.

    This is the DEFAULT path now, not the fallback. The solving API is opt-in
    (--solve-captcha) because trying it first buys half a minute of silence
    before anyone is told there is anything to look at.

    Headed: alert, then wait for the puzzle to disappear. Solving it once usually
    settles the device for a while, so this is a pause rather than a per-video
    toll.
    Headless: there is nobody to drag the slider, so say what to run instead.
    """
    if not headed:
        # No window to drag anything in, but the run is still stuck and worth
        # knowing about — it will now skip every remaining link for this account.
        notify.alert(
            f"Captcha blocking profile {profile}",
            f"Headless run is stuck. Run: python solve_captcha.py --profile {profile}",
        )
        return False

    # This is the one moment in a run of hours that needs a person, and it gives
    # up in four minutes whether anyone noticed or not. A line of terminal output
    # is not enough when the window is behind something else.
    print(
        f"\n  CAPTCHA on profile '{profile}' — drag the slider in the browser window."
        # Only say the service failed when the service was actually asked. By
        # default it is not, and claiming otherwise sends you looking at an API
        # that never ran.
        + (f"\n  The solving service could not clear it in {captcha.MAX_ATTEMPTS} attempts."
           if tried_api else "")
        + f"\n  Waiting up to {timeout_s}s…"
    )
    # Bring THIS account's window forward, even if it is minimised behind the
    # other eight. The title is made unique first: nine accounts on the same
    # video otherwise share one title and the wrong window would be raised. It
    # doubles as a taskbar label saying which account is stuck.
    marker = f"CAPTCHA profile {profile}"
    original_title = ""
    try:
        original_title = page.title()
        page.evaluate("(t) => { document.title = t }", marker)
        # Raises the TAB inside its own browser; focus_window raises the WINDOW,
        # which is the half that also un-minimises it.
        page.bring_to_front()
    except Exception:  # noqa: BLE001 - focusing is a courtesy, not the job
        pass
    notify.focus_window(marker)

    try:
        with notify.nagging(
            f"Captcha — profile {profile}",
            f"Drag the slider in the browser window. The run stops in {timeout_s // 60} minutes.",
            every=20,
        ):
            for waited in range(0, timeout_s, 3):
                page.wait_for_timeout(3000)
                if not captcha_present(page):
                    print(f"  solved after {waited + 3}s, carrying on.\n")
                    return True
                # One more attempt a minute in, in case the first was missed.
                # NOT on every nag: stealing focus every 20 seconds from someone
                # working in another window is worse than the missed captcha.
                if waited + 3 == 60:
                    notify.focus_window(marker)
    finally:
        # Put the title back, so the window stops claiming to be a captcha once
        # it is not one and a later match cannot hit a stale marker.
        try:
            if original_title:
                page.evaluate("(t) => { document.title = t }", original_title)
        except Exception:  # noqa: BLE001
            pass
    print("  still there — giving up on this run.")
    return False


def page_is_logged_out(page) -> bool:
    """Is the PAGE showing a logged-out UI, whatever the API says?

    The passport endpoint answers from cookies and will happily report a user
    while the rendered page shows a Log in button — and a logged-out TikTok pins
    the side panel to "You may like" and never renders a comment. That looked
    for days like a tab bug, then a timing bug, then a contention bug. It was a
    dead session the whole time.
    """
    try:
        return bool(
            page.evaluate(
                """() => {
                    // A real login button, not the word "login" in some caption.
                    const btns = Array.from(document.querySelectorAll('button, a'))
                    const login = btns.some((b) => {
                        const t = (b.textContent || '').trim().toLowerCase()
                        return t === 'log in' || t === 'login' || t === 'sign up'
                    })
                    // Being signed in puts these in the nav; either is enough.
                    const me = document.querySelector(
                        '[data-e2e="profile-icon"], [data-e2e="nav-profile"], [data-e2e="inbox-icon"]'
                    )
                    return login && !me
                }"""
            )
        )
    except Exception:  # noqa: BLE001
        return False


# ── A logged-out page that is not a logged-out session ───────────────────────
#
# TikTok sometimes serves a logged-out shell part-way through a run: the page
# renders a Log in button, the side panel pins itself to "You may like", and no
# comment is ever shown. The cookies on disk are fine. A HARD REFRESH brings the
# session straight back.
#
# That matters because the old response was to run the whole Google re-login
# flow — minutes of navigation, a real risk of tripping a captcha, and on a
# profile that simply needed reloading. Reload first; re-login is the fallback,
# not the reflex.

# How many hard refreshes before a logged-out page is believed.
SESSION_RELOAD_TRIES = 3

# Recoveries this run, for the closing summary: a profile that needs reloading
# on every other video is not healthy, and one line at the end says so where a
# scroll-back through the log would not.
_recovered = 0


def hard_reload(page, url: str, timeout_ms: int = 30000) -> bool:
    """Reload ignoring the cache, and wait until the video has really rendered.

    Ignoring the cache is the point: a plain reload can be answered from the
    same cached logged-out shell that caused the problem. Chromium will only do
    that through CDP, so that is tried first and an ordinary reload is the
    fallback for when the CDP session cannot be opened.
    """
    done = False
    try:
        cdp = getattr(page, "_liker_cdp", None)
        if cdp is None:
            cdp = page.context.new_cdp_session(page)
            page._liker_cdp = cdp
        cdp.send("Page.reload", {"ignoreCache": True})
        done = True
    except Exception:  # noqa: BLE001
        try:
            page.reload(wait_until="domcontentloaded")
            done = True
        except Exception:  # noqa: BLE001
            done = False
    if done:
        try:
            page.wait_for_selector('[data-e2e="comment-icon"]', timeout=timeout_ms)
            page.wait_for_timeout(400)
            return True
        except Exception:  # noqa: BLE001
            pass
    # Neither reload got us a rendered page. Navigate to it outright, which is
    # also what recovers a tab that the reload left somewhere else entirely.
    return open_video(page, url, timeout_ms)


def recover_session(page, url: str, tries: int = SESSION_RELOAD_TRIES, verbose: bool = True) -> bool:
    """Is this page signed in — and if it does not look it, can a refresh fix it?

    Returns True when the page is (or becomes) signed in, False when it stays
    logged out through every refresh, which is when the session really is gone
    and a re-login is worth its cost.
    """
    global _recovered
    if not page_is_logged_out(page):
        return True
    for attempt in range(max(1, tries)):
        if verbose:
            print(f"     looks logged out — hard refresh {attempt + 1}/{tries}")
        hard_reload(page, url)
        try:
            page.wait_for_timeout(1200)
        except Exception:  # noqa: BLE001
            return False
        if not page_is_logged_out(page):
            _recovered += 1
            if verbose:
                print("     signed in again after the refresh")
            return True
    return False


def current_url(page) -> str:
    """Where the tab actually is, or '' when it cannot be asked."""
    try:
        return page.url or ""
    except Exception:  # noqa: BLE001
        return ""


def recovered_note() -> str:
    """A closing word about refreshes, when there were any.

    A profile that needed reloading on every other video is not healthy even if
    every like landed, and one line at the end says so where a scroll back
    through a nine-way parallel log would not.
    """
    return (
        (f", {_recovered} session refresh(es)" if _recovered else "")
        # Captchas that went away on their own are worth a number too: a run
        # that cleared nine of them was being rate-limited nine times, and that
        # is a reason to run fewer at once even though every like landed.
        + (f", {_captchas_faded} captcha(s) waited out" if _captchas_faded else "")
    )


def has_comment_rows(page) -> bool:
    """Are comment rows on the page right now?

    Guarded, because this is asked while the page is free to navigate under us:
    a query_selector that lands during a re-route raises "Execution context was
    destroyed", and unguarded it took the whole run with it. A page that is
    moving has no comment rows we can use, which is exactly False.
    """
    try:
        return bool(page.query_selector('[data-e2e="comment-level-1"]'))
    except Exception:  # noqa: BLE001
        return False


def open_comments(page, timeout_ms: int = 12000) -> bool:
    """Open the comment panel and wait for rows to exist.

    Done from Python rather than inside CLICK_JS because Playwright's waiting is
    patient and reliable, while a JS poll loop with a fixed budget just reports
    "comment panel did not open" the moment the machine is busy — which is what
    four accounts did while the fifth, with the CPU briefly to itself, got in.

    The icon click is retried: it renders slightly before its handler attaches,
    so the first press is sometimes swallowed.
    """
    if has_comment_rows(page):
        return True
    for attempt in range(3):
        # Anything modal — a consent banner, an app-install prompt — sits over
        # the icon. A JS .click() fires on a covered element and achieves
        # nothing, which is how one account can fail every video while another
        # succeeds on all of them.
        try:
            page.keyboard.press("Escape")
        except Exception:  # noqa: BLE001
            pass
        try:
            # A REAL click first: Playwright scrolls it into view, waits for it
            # to be stable and visible, and produces a trusted event. The JS
            # fallback covers the case where something invisible overlaps it.
            page.click('[data-e2e="comment-icon"]', timeout=8000)
        except Exception:  # noqa: BLE001
            try:
                page.evaluate(
                    """() => {
                        const i = document.querySelector('[data-e2e="comment-icon"]')
                        if (i) (i.closest('button, [role="button"], a') || i).click()
                    }"""
                )
            except Exception:  # noqa: BLE001
                return False
        # The side panel has TWO tabs — "Comments" and "You may like" — and which
        # one an account lands on differs per account. Opening the panel does not
        # select a tab, so an account defaulted to "You may like" renders a grid
        # of recommendations and zero comment rows, forever.
        #
        # Polled rather than clicked once: the tabs do not exist the instant the
        # icon is pressed, so a single attempt right after the click finds
        # nothing and then waits out the whole timeout on the wrong tab.
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            if has_comment_rows(page):
                return True
            select_comments_tab(page)
            try:
                page.wait_for_timeout(700)
            except Exception:  # noqa: BLE001
                return False
    return False


def select_comments_tab(page) -> bool:
    """Switch the side panel to its Comments tab, if it is not already there."""
    try:
        return bool(
            page.evaluate(
                """() => {
                    if (document.querySelector('[data-e2e="comment-level-1"]')) return true
                    const press = (el) => {
                        if (!el) return false
                        ;(el.closest('button, [role="tab"], [role="button"], a') || el).click()
                        return true
                    }
                    // TikTok's own handle for the tab, when it is present.
                    if (press(document.querySelector('[data-e2e="comments"]'))) return true
                    // Otherwise find it by its label. Exact match, so "Comments"
                    // wins and "180 comments" on the video's own counter does not.
                    const nodes = Array.from(
                        document.querySelectorAll('button, [role="tab"], span, p, div')
                    )
                    const tab = nodes.find((e) => {
                        const t = (e.textContent || '').trim()
                        if (t !== 'Comments' && t !== 'Comment') return false
                        const r = e.getBoundingClientRect()
                        return r.width > 0 && r.height > 0
                    })
                    return press(tab)
                }"""
            )
        )
    except Exception:  # noqa: BLE001
        return False


def load_more_comments(page, rounds: int) -> int:
    """Scroll the comment list until it stops growing. Returns rows loaded.

    Scrolls the LAST ROW into view rather than setting scrollTop on a container:
    the container selector is a guess that changes with every TikTok build, and
    setting scrollTop on the wrong element silently does nothing — which is why
    a 121-comment video kept reporting the same 19 rows however many times it
    "scrolled".
    """
    last = 0
    stalls = 0
    for _ in range(max(1, rounds)):
        # safe_eval, not page.evaluate: scrolling is the moment TikTok is most
        # likely to re-route under us, and this call raising took down the whole
        # worker rather than costing one video.
        count = safe_eval(
            page,
            """() => {
                const rows = document.querySelectorAll('[data-e2e="comment-level-1"]')
                if (!rows.length) return 0
                const tail = rows[rows.length - 1]
                tail.scrollIntoView({ block: 'end' })
                // scrollIntoView alone is not always enough: a list that loads on
                // a scroll EVENT sees no event when the browser jumps the
                // position. Nudge every scrollable ancestor as well.
                let el = tail.parentElement
                for (let up = 0; up < 10 && el; up++) {
                    if (el.scrollHeight > el.clientHeight + 40) {
                        el.scrollTop = el.scrollHeight
                        el.dispatchEvent(new Event('scroll', { bubbles: true }))
                    }
                    el = el.parentElement
                }
                return rows.length
            }""",
        )
        if count is None:
            # The page moved while we were reading it. Nothing more will load
            # from here, so stop rather than spend the remaining rounds on a
            # context that no longer exists.
            break
        if count == last:
            # Give it two more tries before believing the list is exhausted:
            # one quiet round usually means slow loading, not the end.
            stalls += 1
            if stalls >= 3:
                break
        else:
            stalls = 0
            last = count
        try:
            page.wait_for_timeout(1500)
        except Exception:  # noqa: BLE001
            break
    return last


def done_path(profile: str) -> Path:
    """One ledger per account.

    Two reasons, and both matter once accounts run in parallel: separate files
    cannot interleave each other's appends, and "already liked" is a fact about
    an ACCOUNT, not about a comment — account B skipping what account A liked
    would be wrong.
    """
    return HERE / ("done.csv" if profile == "default" else f"done-{profile}.csv")


# Rebound in main() once the profile is known. The default keeps every existing
# path — verify.py, ad-hoc reads — working unchanged.
DONE = done_path("default")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Fallback only. The live set arrives from the dashboard alongside the links, so
# a product switched off there stops being liked here without an edit.
#
# cohumanly is in this list but NOT in the dashboard's, so --all-products picks
# it up from here (the two are unioned) while --products alone would not see it
# on a run that reaches the dashboard. Add it there too if its comments are
# meant to be served as well as liked.
PRODUCTS = [
    "purifytext",
    "acoustictext",
    "prohumanly",
    "humlexic",
    "kinprose",
    "tintfolio",
    "cohumanly",
]

VIDEO_ID_RE = re.compile(r"tiktok\.com/@[^/]+/(?:video|photo)/(\d+)", re.I)


def norm(s: str) -> str:
    """Lowercase, strip everything but letters and digits.

    Comment text is matched this way so "purify text", "Purify-Text" and
    "purifytext" are one and the same — the comment pool deliberately varies
    that spelling, and a literal match would miss most of its own output.
    """
    return re.sub(r"[^a-z0-9]", "", s.lower())


NORM_PRODUCTS = [norm(p) for p in PRODUCTS]


def load_env() -> dict:
    """Config from .env here, falling back to the dashboard's own .env.

    Reading the dashboard's file directly means there is one place to rotate the
    token rather than two copies drifting apart.
    """
    out: dict[str, str] = {}
    for path in (HERE / ".env", HERE.parent / "3_dashboard" / ".env"):
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out.setdefault(k.strip(), v.strip().strip("'\""))
    return out


def from_dashboard(cluster_by: str, clusters: str, extra: dict) -> tuple[list[str], list[str]]:
    """
    Links for one cluster selection, plus the active products, from the dashboard.

    The dashboard does the clustering, not this script. Clusters are RELATIVE —
    assigned by splitting the sorted pool per platform — so they live nowhere in
    the database, and a script recomputing them would drift from what you see on
    screen. Asking the dashboard is the only way for the two to agree.

    Raises with a readable message on any failure: a silent empty list here looks
    exactly like "nothing matched", which sends you hunting in the wrong place.
    """
    env = load_env()
    base = (env.get("DASHBOARD_URL") or "").rstrip("/")
    token = env.get("LINKS_EXPORT_TOKEN") or ""
    if not base:
        raise SystemExit("DASHBOARD_URL is not set in .env")
    if not token:
        raise SystemExit("LINKS_EXPORT_TOKEN is not set in .env")

    params = {"token": token, "clusterBy": cluster_by, "clusters": clusters}
    params.update({k: v for k, v in extra.items() if v})
    url = base + "/api/links/clusters?" + urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:200]
        raise SystemExit(f"dashboard returned HTTP {e.code}: {detail}")
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"could not reach the dashboard: {e}")

    if not data.get("ok"):
        raise SystemExit(f"dashboard error: {data.get('error') or data}")
    links = [str(x.get("url") or "") for x in data.get("links") or []]
    products = [str(p) for p in (data.get("products") or []) if str(p).strip()]
    print(
        f"dashboard: {data.get('matched', 0)} link(s) match {cluster_by} "
        f"cluster(s) {clusters or 'all'}, taking {len(links)}"
    )
    # Only sent back when the caller asked for withoutOurs, and only by a
    # dashboard new enough to know the parameter — an older one ignores it and
    # answers with everything, which the per-video check still handles.
    dropped = int(data.get("droppedWithOurs") or 0)
    if dropped:
        print(f"  {dropped} link(s) already carry one of our comments — not pulled")
    elif extra.get("withoutOurs") == "1" and "droppedWithOurs" not in data:
        print("  (this dashboard does not know the withoutOurs filter yet — every "
              "link was pulled, and each video is checked before anything is written)")
    if products:
        print(f"active products: {', '.join(products)}")
    return links, products


def comment_from_dashboard(url: str, product: str = "") -> tuple[str, str]:
    """One comment to post on this link, and the product it belongs to.

    The same set the Android app hands its workers, from the same store — asking
    the dashboard rather than keeping a copy here is what stops the two drifting
    apart, and it means a product switched off or regenerated there takes effect
    without an edit.

    Returns ("", "") when the dashboard has nothing to offer, which is a reason
    to skip the video rather than to stop the run.
    """
    env = load_env()
    base = (env.get("DASHBOARD_URL") or "").rstrip("/")
    token = env.get("LINKS_EXPORT_TOKEN") or ""
    if not base or not token:
        return "", ""
    params = {"token": token, "url": url}
    if product:
        params["product"] = product
    req = urllib.request.Request(
        base + "/api/links/comment?" + urlencode(params), headers={"User-Agent": UA}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:120]
        print(f"     dashboard would not give a comment: HTTP {e.code} {detail}")
        return "", ""
    except Exception as e:  # noqa: BLE001
        print(f"     could not reach the dashboard for a comment: {e}")
        return "", ""
    return str(data.get("comment") or ""), str(data.get("product") or "")


# Rival names, from the dashboard rather than from a copy kept here. Fetched
# once per run: two lists of competitor brands in two projects is one list that
# is wrong within a month.
_RIVALS: list[str] | None = None


def rival_brands() -> list[str]:
    global _RIVALS
    if _RIVALS is not None:
        return _RIVALS
    _RIVALS = []
    env = load_env()
    base = (env.get("DASHBOARD_URL") or "").rstrip("/")
    token = env.get("LINKS_EXPORT_TOKEN") or ""
    if not base or not token:
        return _RIVALS
    try:
        req = urllib.request.Request(
            base + "/api/links/mimic?" + urlencode({"token": token}),
            headers={"User-Agent": UA},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace"))
        _RIVALS = [str(b) for b in (data.get("brands") or [])]
    except Exception as e:  # noqa: BLE001
        print(f"     could not fetch the rival list: {str(e)[:70]}")
    return _RIVALS


def flatten(text: str) -> str:
    """Lowercase, letters and digits only — how a brand is matched.

    "Walter Writes", "walterwrites" and "#WalterWrites!" are one name, and a
    comment recommending a rival spells it however it feels like.
    """
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def rival_comment(comments: list[dict]) -> tuple[str, str]:
    """The comment under this video that recommends somebody else's tool.

    Returns (text, brand), or ("", "") when the thread mentions no rival. The
    LONGEST match wins: a one-liner gives the model almost nothing to match,
    and "walterwrites 🔥" and "ngl walterwrites got me through finals, tried
    everything else first" are not equally useful as a style reference.
    """
    brands = rival_brands()
    if not brands:
        return "", ""
    best, best_brand = "", ""
    for c in comments:
        text = str(c.get("text") or "")
        flat = flatten(text)
        for b in brands:
            if b in flat:
                if len(text) > len(best):
                    best, best_brand = text, b
                break
    return best, best_brand


def mimic_from_dashboard(url: str, sample: str, product: str = "") -> tuple[str, str, str]:
    """Ask the dashboard for a comment in the same vein as `sample`.

    Returns (comment, product, rival). ("", "", "") means nothing usable came
    back, which is a reason to post a stored comment instead — never a reason to
    post something that has not been through the dashboard's filters.
    """
    env = load_env()
    base = (env.get("DASHBOARD_URL") or "").rstrip("/")
    token = env.get("LINKS_EXPORT_TOKEN") or ""
    if not base or not token:
        return "", "", ""
    payload = {"url": url, "sample": sample}
    if product:
        payload["product"] = product
    req = urllib.request.Request(
        base + "/api/links/mimic?" + urlencode({"token": token}),
        data=json.dumps(payload).encode("utf-8"),
        headers={"User-Agent": UA, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        # Longer than the other calls: there is a language model at the other
        # end of it, and the alternative to waiting is a worse comment.
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:110]
        print(f"     dashboard would not write one: HTTP {e.code} {detail}")
        return "", "", ""
    except Exception as e:  # noqa: BLE001
        print(f"     could not reach the dashboard to write one: {str(e)[:70]}")
        return "", "", ""
    return (
        str(data.get("comment") or ""),
        str(data.get("product") or ""),
        str(data.get("rival") or ""),
    )


# THE PRODUCT NAME AS ORDINARY WORDS. The same table as PRODUCT_WORDS in the
# dashboard's lib/config.ts, and the same reason: a name written as one word,
# capitalised or in quotes, reads as an advert to a person and as a brand mention
# to a filter. Twenty-one comments posted that way reached no other account at
# all (verify_comments.py).
#
# THIS IS THE SAFETY NET, not the mechanism. The comments are written by the
# dashboard, and the prompt there now asks for the spaced form. A prompt is a
# request; this is the last thing that touches the text before it is typed, and
# it does not depend on a deploy having happened or on a model having listened.
#
# THE STEM IS NEVER TOUCHED. Every product matcher in this project and in the
# dashboard flattens text to letters and digits and then asks whether the
# product name is a SUBSTRING, so "purify text" and "purify texting" both still
# resolve to purifytext — the suffix lands after the whole name. "purity
# texting" would read just as naturally and would be invisible to every check we
# have, including the admin's own "does this comment exist" read, so the seam and
# the tail are all that move.
PRODUCT_WORDS = {
    "purifytext": "purify text",
    "acoustictext": "acoustic text",
    "prohumanly": "pro humanly",
    "humlexic": "hum lexic",
    "kinprose": "kin prose",
    "tintfolio": "tint folio",
    "cohumanly": "co humanly",
}

_BRAND_RES: list[tuple[re.Pattern, str]] | None = None


def brand_forms() -> list[tuple[re.Pattern, str]]:
    """One pattern per product, matching however a model chose to write it.

    Matches purifytext, Purify Text, purify-text, #PurifyText and "purify text",
    and leaves any inflection where it is: the pattern covers the NAME only, so
    "purifytexted" matches on its first ten letters and the "ed" stays put.
    """
    global _BRAND_RES
    if _BRAND_RES is None:
        _BRAND_RES = []
        for name, words in PRODUCT_WORDS.items():
            body = r"[\s._\-]*".join(re.escape(w) for w in words.split(" "))
            _BRAND_RES.append((
                re.compile("[#\"\u201c\u2018]?" + body + "[\"\u201d\u2019]?", re.I),
                words,
            ))
    return _BRAND_RES


def debrand(text: str) -> tuple[str, str]:
    """(text, note). The note is '' when nothing needed changing.

    The note is printed, because a comment that was silently rewritten before
    posting is a comment nobody can explain afterwards.
    """
    out = str(text or "")
    changed = []
    for pat, words in brand_forms():
        m = pat.search(out)
        if not m or m.group(0) == words:
            continue
        changed.append(f"{m.group(0).strip()} -> {words}")
        out = pat.sub(words, out)
    return out, "; ".join(changed)


def comment_for(url: str, aweme_comments: list[dict], args) -> tuple[str, str, str]:
    """The comment to post under this video, and where it came from.

    IN ORDER, and the order is the feature:

      1. If --mimic-comments is on and somebody under this video is recommending
         a rival tool, a comment in that same vein. A stored comment is written
         to be good anywhere, which is what makes it read as imported when it
         lands in a thread that is all about one particular tool.
      2. Otherwise the dashboard's stored set — the same comments the Android
         app hands its workers.

    Returns (text, product, source) where source is 'mimic' or 'bank', for the
    log and the ledger: a comment nobody can explain later is worse than none.
    """
    text, prod, source = "", "", "bank"
    if getattr(args, "mimic_comments", False):
        sample, brand = rival_comment(aweme_comments)
        if sample:
            print(f"     thread mentions {brand or 'a rival'} — writing to match it")
            text, prod, rival = mimic_from_dashboard(url, sample, args.comment_product)
            if text:
                source = f"mimic:{rival or brand}"
            else:
                print("     nothing usable came back — using a stored comment")
    if not text:
        text, prod = comment_from_dashboard(url, args.comment_product)
    # LAST STOP BEFORE IT IS TYPED. Whatever wrote it, the name goes in as words.
    if text:
        fixed, note = debrand(text)
        if note:
            print(f"     written as words, not a brand: {note}")
            text = fixed
    return text, prod, source


# Where the comment goes, and what sends it.
#
# TikTok's box is a contenteditable div, not an input, so its value cannot be
# set: React listens for real key events and a programmatic .textContent leaves
# the Post button disabled. Playwright's type() produces real events, which is
# why this is done from Python rather than in one evaluate().
COMMENT_BOX = (
    '[data-e2e="comment-input"] [contenteditable="true"], '
    '[data-e2e="comment-input"], '
    'div[role="textbox"][contenteditable="true"], '
    '[contenteditable="true"][data-e2e*="comment"]'
)
COMMENT_POST = '[data-e2e="comment-post"], [data-e2e="comment-post-btn"]'


def post_comment(page, text: str, timeout_ms: int = 15000) -> tuple[bool, str]:
    """Type a comment into the open panel and send it. Returns (posted, note).

    VERIFIED, not assumed. A click on a disabled Post button does nothing and
    looks identical to success from here, so the comment list is read back
    afterwards and the comment is only reported as posted once it is actually
    on the page. An unverified selector therefore fails loudly instead of
    silently recording comments that were never made.
    """
    box = None
    for sel in COMMENT_BOX.split(", "):
        box = page.query_selector(sel.strip())
        if box:
            break
    if not box:
        return False, "no comment box on the page"

    # THE BOX CANNOT BE CLICKED, and every comment failed on it:
    #
    #   NOT posted - could not type: ElementHandle.click: Timeout 30000ms exceeded
    #
    # TikTok's editor is Draft.js, and its placeholder ("Add comment...") sits
    # ON TOP of the contenteditable. Measured: a click at the centre of the box
    # lands on DIV.public-DraftEditorPlaceholder-inner, so Playwright waits for
    # the element to start receiving pointer events, and waits, and gives up
    # thirty seconds later — three times a video, on every video.
    #
    # Focus is what typing actually needs, and there are three ways to get it.
    # The wrapper is a real trusted click, which is the closest to what a person
    # does; the others are there because the panel does not always render the
    # wrapper. Short timeouts: a route that is not going to work should cost
    # three seconds, not thirty.
    focused = False
    try:
        page.click('[data-e2e="comment-input"]', timeout=3000)
        focused = True
    except Exception:  # noqa: BLE001
        pass
    if not focused:
        try:
            box.click(force=True, timeout=3000)
            focused = True
        except Exception:  # noqa: BLE001
            pass
    if not focused:
        # Last resort, and the one that always works: focus it outright. The
        # keys that follow are real key events either way — it is the click
        # that was never possible, not the typing.
        try:
            box.evaluate("el => el.focus()")
            focused = True
        except Exception as e:  # noqa: BLE001
            return False, f"could not focus the box: {str(e)[:50]}"

    try:
        page.wait_for_timeout(250)
        # Typed, not pasted: the Post button stays disabled until React has seen
        # input events, and a paste does not always produce them.
        page.keyboard.type(text, delay=random.uniform(18, 45))
        page.wait_for_timeout(400)
    except Exception as e:  # noqa: BLE001
        return False, f"could not type: {str(e)[:60]}"

    sent = False
    for sel in COMMENT_POST.split(", "):
        el = page.query_selector(sel.strip())
        if el:
            try:
                el.click()
                sent = True
                break
            except Exception:  # noqa: BLE001
                pass
    if not sent:
        # Enter posts when the button cannot be found or clicked.
        try:
            page.keyboard.press("Enter")
            sent = True
        except Exception as e:  # noqa: BLE001
            return False, f"could not send: {str(e)[:60]}"

    # Read it back. Our own comment appears at the top of the list once accepted.
    needle = norm(text)[:40]
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        page.wait_for_timeout(700)
        try:
            found = page.evaluate(
                """(needle) => {
                  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
                  for (const el of document.querySelectorAll('[data-e2e="comment-level-1"]')) {
                    if (norm(el.innerText).includes(needle)) return true
                  }
                  return false
                }""",
                needle,
            )
        except Exception:  # noqa: BLE001
            found = False
        if found:
            return True, "verified on the page"
    return False, "sent but the comment did not appear"


def video_id(url: str) -> str | None:
    m = VIDEO_ID_RE.search(url)
    return m.group(1) if m else None


def read_links(path: Path) -> list[str]:
    """URLs from a .txt (one per line) or a .csv (a url/link column)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() == ".csv":
        rows = list(csv.DictReader(text.splitlines()))
        if rows:
            for key in ("url", "link", "video_url", "Url", "URL"):
                if key in rows[0]:
                    return [r[key].strip() for r in rows if r.get(key, "").strip()]
        # No header we recognise — fall through and treat it as a plain list.
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]


def fetch_comments(aweme_id: str, max_pages: int = 3, timeout: int = 20) -> list[dict]:
    """
    Every comment we can read on a video, via the unsigned public endpoint.

    No browser and no session: this endpoint is open, which is why the whole
    discovery half of this tool costs one HTTP request per 50 comments.
    """
    out: list[dict] = []
    seen: set[str] = set()
    cursor = 0
    for _ in range(max_pages):
        url = (
            f"https://www.tiktok.com/api/comment/list/?aweme_id={aweme_id}"
            f"&count=50&cursor={cursor}&aid=1988"
        )
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": UA,
                "Referer": f"https://www.tiktok.com/@x/video/{aweme_id}",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read().decode("utf-8", errors="replace")
        except Exception:
            break
        # A throttled request answers 200 with an empty body rather than an error.
        if not body.strip():
            break
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            break
        page = data.get("comments") or []
        for c in page:
            cid = str(c.get("cid") or "")
            if not cid or cid in seen:
                continue
            seen.add(cid)
            out.append(
                {
                    "cid": cid,
                    "text": str(c.get("text") or ""),
                    "user": str((c.get("user") or {}).get("unique_id") or "").lower(),
                    "likes": int(c.get("digg_count") or 0),
                    "already": bool(c.get("user_digged")),
                }
            )
        if not data.get("has_more") or not page:
            break
        cursor = int(data.get("cursor") or cursor + len(page))
    return out


def wanted(c: dict, products: list[str], users: set[str], take_all: bool) -> bool:
    """`products` is already normalised — the live set when the dashboard
    supplied one, the compiled fallback otherwise."""
    if take_all:
        return True
    if users and c["user"] in users:
        return True
    if products:
        hay = norm(c["text"])
        return any(p in hay for p in products)
    return False


def dom_cid(aweme: str, user: str, text: str) -> str:
    """A stable id for a comment we only ever saw in the DOM.

    The ledger is keyed by cid, and that is also the skip list — without an id
    these comments would be re-liked on every run and could never be told apart
    in done.csv. The API never gave us one, so this stands in: a hash of the
    video, the handle and the text, which is the same on every run and different
    for every comment. Prefixed so it is obvious in the ledger that this row
    came from the panel rather than the endpoint.
    """
    key = f"{aweme}|{norm(user)}|{norm(text)[:120]}"
    return "dom:" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def dom_extras(
    rows: list[dict],
    aweme: str,
    products: list[str],
    users: set[str],
    handled: list[dict],
    done: set[str],
) -> list[dict]:
    """Product comments in the panel that the API list never returned.

    `handled` is every comment the API DID return for this video — not just the
    ones we liked. A comment it listed has already been through the normal path,
    including the ones it said were liked already, and pressing those again
    would UNLIKE them.

    Rows whose like count cannot be read are dropped. The heart is a toggle and
    these comments have no cid, so the count is the only way to find out what a
    press did; without it there is no safe way to press at all. That covers a
    count TikTok abbreviates ("1.2K"), where a +1 would be invisible.

    NOTE that --all is deliberately not honoured here. It means "like every
    comment the API listed", which is a bounded set an operator chose; applied
    to whatever the panel happens to render it would like the entire comment
    section of every video. The sweep only ever adds comments that name a
    product or a watched handle.
    """
    known: list[tuple[str, str]] = [
        (norm(c.get("user", "")), norm(c.get("text", ""))[:30]) for c in handled
    ]
    out: list[dict] = []
    for r in rows:
        user = str(r.get("user") or "")
        text = str(r.get("text") or "")
        if not text.strip():
            continue
        if not r.get("heart"):
            # No heart in the row means nothing to press — a deleted comment's
            # placeholder, or a build we cannot read. Not a failure to report.
            continue
        if r.get("likes") is None:
            # Unreadable or abbreviated count. See the docstring.
            continue
        c = {"cid": dom_cid(aweme, user, text), "text": text, "user": norm(user),
             "likes": 0, "already": False}
        if not wanted(c, products, users, False):
            continue
        if c["cid"] in done:
            continue
        hay = norm(text)
        # Matched on handle AND text, and the text must be non-empty. About one
        # comment in ten comes back from the API with `text` empty — measured at
        # 13 of 116 across six real videos — and those can never match a product
        # name, so extraction has always been blind to them. The panel renders
        # what they actually say. Suppressing a row because its author appears
        # somewhere in the API list with no text would throw exactly those away.
        if any(u == c["user"] and t and t in hay for u, t in known):
            continue
        out.append(c)
    return out


def load_done() -> set[str]:
    if not DONE.exists():
        return set()
    with DONE.open(encoding="utf-8") as f:
        return {row["cid"] for row in csv.DictReader(f) if row.get("cid")}


COLUMNS = ["when", "url", "aweme_id", "cid", "user", "text", "status", "note"]


def purge_failures(path: Path | None = None) -> dict[str, int]:
    """Drop every failed row from the ledger, so the next run retries them.

    The ledger doubles as the skip list — load_done() returns every cid in it,
    failures included — so a comment that failed once was never attempted again.
    That is exactly backwards for the failures we actually get: 'fail:dom' is a
    comment button that never appeared, 'fail:load' a page that did not render
    in time, 'fail:deep' a like that would not stick. All three are about the
    moment, not the comment, and nearly all of them succeed on a later pass.

    Only failures go. A cid that failed once and succeeded later keeps its 'ok'
    row and stays skipped, so nothing is liked twice.

    Returns the counts removed, by status, for the run to report.
    """
    path = path or DONE
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return {}

    kept: list[dict] = []
    counts: dict[str, int] = {}
    for r in rows:
        status = (r.get("status") or "").strip()
        if status.startswith("ok"):
            kept.append(r)
        else:
            counts[status or "(blank)"] = counts.get(status or "(blank)", 0) + 1
    if not counts:
        return {}

    # Written beside the real file and moved into place: a run interrupted
    # mid-rewrite would otherwise leave a truncated ledger, and the ledger is
    # the only record of what has already been liked.
    tmp = path.with_suffix(".csv.tmp")
    try:
        with tmp.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(COLUMNS)
            for r in kept:
                w.writerow([r.get(c, "") for c in COLUMNS])
        tmp.replace(path)
    except OSError as e:
        # Windows refuses to replace a file another process holds open, which is
        # what a second run against the same profile looks like. Not worth
        # stopping for: the failures simply stay, and the run goes ahead.
        tmp.unlink(missing_ok=True)
        print(f"{path.name}: could not clear failed rows ({e}); leaving them in place")
        return {}
    return counts


def report_purge(counts: dict[str, int], name: str) -> str:
    """One line naming what was cleared, or empty when nothing was."""
    if not counts:
        return ""
    detail = ", ".join(f"{n} {s}" for s, n in sorted(counts.items(), key=lambda x: -x[1]))
    return (f"{name}: cleared {sum(counts.values())} failed row(s) — {detail}. "
            "Those comments will be tried again.")


def open_done():
    """Open the ledger for appending, migrating an older one in place.

    Columns have been added since the first runs, and appending wide rows under
    a narrow header would quietly corrupt the file. So a file whose header does
    not match is rewritten once, with the new fields left blank on old rows.
    """
    if DONE.exists():
        with DONE.open(encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        header_ok = rows == [] or all(c in rows[0] for c in COLUMNS)
        if not header_ok:
            with DONE.open("w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(COLUMNS)
                for r in rows:
                    w.writerow([r.get(c, "") for c in COLUMNS])
            print(f"done.csv: migrated {len(rows)} existing row(s) to the new columns")

    fresh = not DONE.exists()
    f = DONE.open("a", newline="", encoding="utf-8")
    w = csv.writer(f)
    if fresh:
        w.writerow(COLUMNS)
        f.flush()
    return f, w


# The like itself, run in page context so TikTok's own SDK signs it on the way
# out — that is the whole reason a browser is involved.
#
# Two requests, because that is what the real client does (see capture.json):
#
#   1. HEAD with x-secsdk-csrf-request: 1  → the response carries a CSRF token
#      in x-ware-csrf-token.
#   2. POST with that token in x-secsdk-csrf-token.
#
# Skipping step 1 is what made the first attempts silently useless. The POST was
# signed, well-formed and accepted — status_code 0 — and applied nothing, which
# is exactly how secsdk rejects a request that never did the handshake. Nothing
# in the response says so.
#
# Same-origin, so the response headers are readable; a cross-origin fetch would
# hide x-ware-csrf-token behind CORS and this would not work at all.
LIKE_JS = """
async ([awemeId, cid, type, baseParams]) => {
  const out = (http, code, msg) => ({ http, code, msg })
  const referrer = `https://www.tiktok.com/@x/video/${awemeId}`
  try {
    // Whatever capture.json recorded, with this comment's ids over the top.
    // digg_type, NOT type: `type` parses fine and answers status_code 5.
    const p = new URLSearchParams(baseParams || {})
    p.set('aweme_id', String(awemeId))
    p.set('cid', String(cid))
    p.set('digg_type', String(type))
    p.set('aid', '1988')
    const url = '/api/comment/digg/?' + p.toString()

    const head = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      referrer,
      headers: { 'x-secsdk-csrf-request': '1', 'x-secsdk-csrf-version': '1.2.22' },
    })
    const csrf = head.headers.get('x-ware-csrf-token')
    if (!csrf) return out(head.status, null, 'no csrf token in HEAD response')
    // The header is a comma-separated list; the token is the second field.
    const token = csrf.split(',')[1] || csrf

    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      referrer,
      headers: {
        'x-secsdk-csrf-token': token,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })
    const body = await r.text()
    if (!body.trim()) return out(r.status, null, 'empty body')
    try {
      const j = JSON.parse(body)
      return out(r.status, j.status_code, j.status_msg || '')
    } catch {
      return out(r.status, null, body.slice(0, 120))
    }
  } catch (e) {
    return out(0, null, String(e).slice(0, 120))
  }
}
"""

# ── DOM mode ─────────────────────────────────────────────────────────────────
# Clicking the heart, because the API cannot be made to work.
#
# The like endpoint wants X-Gnarly, a per-request signature computed by TikTok's
# own bundle. A fetch or XHR issued from page context never passes through the
# code that adds it, so the request goes out unsigned — and TikTok answers
# status_code 0 and applies nothing, with no error anywhere. Three rounds of
# fixing real bugs (wrong param name, missing CSRF handshake, missing params)
# each ended at the same silent no-op.
#
# So the write is done the way a person does it. READS stay on the API: they are
# unsigned, instant, and authoritative about user_digged, which is the only
# reliable proof a like landed.
#
# Finding the heart: locate the comment by author and text, then climb ancestors
# until one also contains a like control, and click that. Matching on the
# container selector alone breaks whenever TikTok renames a class; this only
# needs the two to share a parent, which is a much safer assumption.
CLICK_JS = """
async ([targets, maxScrolls]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

  // The panel is opened and the list scrolled by the caller, in Python, where
  // Playwright can wait properly. By the time this runs the rows exist.
  if (!document.querySelector('[data-e2e="comment-level-1"]')) {
    return { _error: 'comment panel did not open' }
  }

  // The comment's own heart is DivLikeContainer. NOT [data-e2e=like-icon],
  // which is the VIDEO's like, and not aria-label either — TikTok labels both
  // "Like video", so matching on that presses the wrong control entirely.
  const heartIn = (row) => row.querySelector('[class*="DivLikeContainer"]')

  // Climb from the username until an ancestor holds exactly one heart. Which
  // wrapper carries data-e2e changes between builds; "the block that has both
  // the name and one heart" survives that.
  const rowFor = (userEl) => {
    let el = userEl
    for (let up = 0; up < 8 && el; up++) {
      if (el.querySelectorAll('[class*="DivLikeContainer"]').length === 1) return el
      el = el.parentElement
    }
    return null
  }

  // The username element holds the DISPLAY NAME ("Dwesk"), while the handle we
  // matched on lives only in the link: href="/@lfdwesk". The API gives us
  // unique_id, so comparing against the visible text never matches anyone whose
  // display name differs from their handle — which is most people.
  const handleOf = (u) => {
    const a = u.querySelector('a[href^="/@"]') || u.closest('a[href^="/@"]')
    if (!a) return norm(u.innerText)
    return norm((a.getAttribute('href') || '').replace(/^\\/@/, '').split('?')[0])
  }

  const findAll = () =>
    Array.from(document.querySelectorAll('[data-e2e="comment-username-1"], [data-e2e*="comment-username"]'))
      .map((u) => {
        const row = rowFor(u)
        return row ? { row, user: handleOf(u), text: norm(row.innerText) } : null
      })
      .filter(Boolean)

  const results = {}
  for (const t of targets) results[t.cid] = 'not found'

  let scrolls = 0
  for (;;) {
    const rows = findAll()
    let outstanding = 0

    for (const t of targets) {
      if (results[t.cid] === 'clicked') continue
      const wantUser = norm(t.user)
      const wantText = norm(t.text).slice(0, 30)
      const hit = rows.find(
        (n) => n.user === wantUser && wantText.length > 0 && n.text.includes(wantText)
      )
      if (!hit) { outstanding++; continue }
      const btn = heartIn(hit.row)
      if (!btn) { results[t.cid] = 'no heart in row'; continue }
      try {
        btn.scrollIntoView({ block: 'center' })
        await sleep(150)
        // The clickable element may be a parent of the container.
        ;(btn.closest('button, [role="button"]') || btn).click()
        results[t.cid] = 'clicked'
        await sleep(400)
      } catch (e) {
        results[t.cid] = 'click failed: ' + String(e).slice(0, 60)
      }
    }

    // Record what we could see, so "not found" can be told apart from "the row
    // was there and the match failed" without another round of guessing.
    results._seen = rows.length
    results._sample = rows.slice(0, 3).map((n) => n.user).join(',')
    // One pass only. Loading more rows is the caller's job now, because that
    // needs real waiting between scrolls and this cannot see whether the list
    // actually grew.
    break
  }
  return results
}
"""

# Reading a video's comments from inside the page, so user_digged is answered
# for THIS account. Used twice per video: to skip what is already liked, and to
# prove what the clicks actually did.
# ── the fast path ────────────────────────────────────────────────────────────
# One page load for the WHOLE run, then a signed request per like. No
# navigation, no DOM, no scrolling.
#
# Why this works, after a long detour into clicking hearts: window.fetch is not
# native on a TikTok page — their SDK wraps it, and the wrapper is what adds
# X-Gnarly. Our requests were being signed the entire time. What broke them was
# replaying 32 parameters out of capture.json, including a stale msToken and
# device_id, over a request the wrapper wanted to build itself. Send the four
# parameters that identify the action and let it fill in the rest, and the like
# applies — measured, by reading user_digged back.
#
# It also works for a video the browser is not on: proven on three comments
# across three videos from a single loaded page.
LIKE_ONE_JS = """
async ([awemeId, cid, type, referrer]) => {
  const url = `/api/comment/digg/?aweme_id=${awemeId}&cid=${cid}&digg_type=${type}&aid=1988`
  try {
    // The CSRF handshake TikTok's own client does before every like. Skipping it
    // gets a request that is accepted and silently dropped.
    const head = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      referrer,
      headers: { 'x-secsdk-csrf-request': '1', 'x-secsdk-csrf-version': '1.2.22' },
    })
    const csrf = head.headers.get('x-ware-csrf-token')
    if (!csrf) return { http: head.status, code: null, msg: 'no csrf token' }
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      referrer,
      headers: {
        'x-secsdk-csrf-token': csrf.split(',')[1] || csrf,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })
    const body = await r.text()
    if (!body.trim()) return { http: r.status, code: null, msg: '(empty)' }
    try {
      const j = JSON.parse(body)
      return { http: r.status, code: j.status_code, msg: j.status_msg || '' }
    } catch { return { http: r.status, code: null, msg: body.slice(0, 100) } }
  } catch (e) { return { http: 0, code: null, msg: String(e).slice(0, 100) } }
}
"""

# A video's comments read from INSIDE the session, so user_digged is answered for
# this account. Serves as discovery and as the already-liked check at once, which
# is one request instead of two.
READ_ALL_JS = """
async ([awemeId, pages]) => {
  const out = []
  const seen = new Set()
  let cursor = 0
  for (let i = 0; i < pages; i++) {
    const r = await fetch(
      `/api/comment/list/?aweme_id=${awemeId}&count=50&cursor=${cursor}&aid=1988`,
      { credentials: 'include', referrer: `https://www.tiktok.com/@x/video/${awemeId}` }
    )
    const body = await r.text()
    if (!body.trim()) break
    let j
    try { j = JSON.parse(body) } catch { break }
    const list = j.comments || []
    for (const c of list) {
      const cid = String(c.cid || '')
      if (!cid || seen.has(cid)) continue
      seen.add(cid)
      out.push({
        cid,
        text: String(c.text || ''),
        user: String((c.user || {}).unique_id || '').toLowerCase(),
        likes: Number(c.digg_count) || 0,
        already: !!c.user_digged,
      })
    }
    if (!j.has_more || !list.length) break
    cursor = Number(j.cursor) || cursor + list.length
  }
  return out
}
"""


READ_MINE_JS = """
async ([awemeId, pages]) => {
  const out = {}
  let cursor = 0
  for (let i = 0; i < pages; i++) {
    const r = await fetch(
      `/api/comment/list/?aweme_id=${awemeId}&count=50&cursor=${cursor}&aid=1988`,
      { credentials: 'include', referrer: `https://www.tiktok.com/@x/video/${awemeId}` }
    )
    const body = await r.text()
    if (!body.trim()) break
    let j
    try { j = JSON.parse(body) } catch { break }
    const list = j.comments || []
    for (const c of list) out[String(c.cid)] = { mine: !!c.user_digged, digg: c.digg_count }
    if (!j.has_more || list.length === 0) break
    cursor = Number(j.cursor) || cursor + list.length
  }
  return out
}
"""


# ── what the panel shows that the API never returned ─────────────────────────
#
# /api/comment/list/ is not the whole comment section. Three things live in the
# panel and not in that response:
#
#   * REPLIES. The list endpoint returns top-level comments; a reply naming a
#     product is a comment on the video as far as anyone reading it is
#     concerned, and it was invisible to us.
#   * anything past --pages. Three pages is 150 comments, and a busy video has
#     more.
#   * whatever the endpoint simply omits on the day — it throttles by answering
#     200 with a short list rather than an error.
#
# So once the panel is open and scrolled, read the rows themselves and like any
# product comment the API never mentioned. The panel is already open at that
# point; this costs one evaluate per video, not a page load.
DOM_SCAN_JS = """
() => {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const heartIn = (row) => row.querySelector('[class*="DivLikeContainer"]')

  // Climb from the username until an ancestor holds exactly one heart — the
  // same rule CLICK_JS uses, and for the same reason: which wrapper carries
  // data-e2e changes between builds, "the block with the name and one heart"
  // does not.
  const rowFor = (userEl) => {
    let el = userEl
    for (let up = 0; up < 8 && el; up++) {
      if (el.querySelectorAll('[class*="DivLikeContainer"]').length === 1) return el
      el = el.parentElement
    }
    return null
  }

  // The handle, from the link. The visible text is the DISPLAY name, which for
  // most people is not the handle.
  const handleOf = (u) => {
    const a = u.querySelector('a[href^="/@"]') || u.closest('a[href^="/@"]')
    if (!a) return norm(u.innerText)
    return norm((a.getAttribute('href') || '').replace(/^\\/@/, '').split('?')[0])
  }

  // The comment BODY, not the whole row. row.innerText also carries the
  // username, the timestamp, "Reply" and the like count — matching a product
  // name against those would like a comment for saying nothing.
  const bodyOf = (row) => {
    const el = row.querySelector('[data-e2e^="comment-level-"]')
    return ((el ? el.innerText : row.innerText) || '').trim()
  }

  // THE LIKE COUNT BESIDE THE HEART — the only honest signal there is.
  //
  // This was the heart's rendered colour, tested for "looks red". On the live
  // build neither state reads as red, so a comment we had just successfully
  // liked looked unliked, the caller concluded it had been ours all along, and
  // clicked again to "restore" it — undoing every like the sweep made. 52 real
  // product comments in one run.
  //
  // A count is semantic, not cosmetic: liking adds one, unliking removes one,
  // and no theme can change that. Returns null when the number cannot be read
  // or is abbreviated ("1.2K"), because a +1 is invisible in an abbreviation
  // and a row we cannot verify is a row we must not touch.
  const likesOf = (row) => {
    const h = heartIn(row)
    if (!h) return null
    const box = h.closest('[class*="DivLikeInfo"]') || h.parentElement
    if (!box) return null
    const t = (box.innerText || '').trim()
    if (/[KMkm]/.test(t)) return null
    const m = t.match(/\\d[\\d,]*/)
    if (!m) return null
    const n = Number(m[0].replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }

  const seen = new Set()
  const out = []
  const users = document.querySelectorAll(
    '[data-e2e="comment-username-1"], [data-e2e*="comment-username"]'
  )
  for (const u of users) {
    const row = rowFor(u)
    if (!row) continue
    const user = handleOf(u)
    const text = bodyOf(row)
    const key = user + '|' + norm(text).slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ user, text, likes: likesOf(row), heart: !!heartIn(row) })
  }
  return out
}
"""

# Press the heart of ONE row found by handle + the start of its text, and report
# whether the heart's paint changed.
#
# The paint IS the confirmation here. Every other like in this tool is confirmed
# by reading user_digged back from the API, and that is not available for a
# comment the API never returned — asking about a cid we do not have is not a
# question that can be asked. A heart that looks identical after the click was
# not pressed, which is the failure that mattered.
DOM_LIKE_JS = """
async ([wantUser, wantText]) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const heartIn = (row) => row.querySelector('[class*="DivLikeContainer"]')
  const rowFor = (userEl) => {
    let el = userEl
    for (let up = 0; up < 8 && el; up++) {
      if (el.querySelectorAll('[class*="DivLikeContainer"]').length === 1) return el
      el = el.parentElement
    }
    return null
  }
  const handleOf = (u) => {
    const a = u.querySelector('a[href^="/@"]') || u.closest('a[href^="/@"]')
    if (!a) return norm(u.innerText)
    return norm((a.getAttribute('href') || '').replace(/^\\/@/, '').split('?')[0])
  }
  const bodyOf = (row) => {
    const el = row.querySelector('[data-e2e^="comment-level-"]')
    return ((el ? el.innerText : row.innerText) || '').trim()
  }
  const likesOf = (row) => {
    const h = heartIn(row)
    if (!h) return null
    const box = h.closest('[class*="DivLikeInfo"]') || h.parentElement
    if (!box) return null
    const t = (box.innerText || '').trim()
    if (/[KMkm]/.test(t)) return null
    const m = t.match(/\\d[\\d,]*/)
    if (!m) return null
    const n = Number(m[0].replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }

  const want = norm(wantText).slice(0, 40)
  let row = null
  for (const u of document.querySelectorAll(
    '[data-e2e="comment-username-1"], [data-e2e*="comment-username"]'
  )) {
    const r = rowFor(u)
    if (!r) continue
    if (handleOf(u) !== norm(wantUser)) continue
    if (want.length && !norm(bodyOf(r)).includes(want)) continue
    row = r
    break
  }
  if (!row) return { found: false }

  const btn = heartIn(row)
  if (!btn) return { found: true, clicked: false, why: 'no heart in row' }
  const before = likesOf(row)
  // No readable count means no way to tell afterwards what the click did, and a
  // heart is a toggle. Refuse rather than guess.
  if (before === null) return { found: true, clicked: false, why: 'like count not readable' }
  try {
    btn.scrollIntoView({ block: 'center' })
    await sleep(200)
    ;(btn.closest('button, [role="button"]') || btn).click()
  } catch (e) {
    return { found: true, clicked: false, why: String(e).slice(0, 60) }
  }
  await sleep(900)
  const after = likesOf(row)
  return {
    found: true,
    clicked: true,
    before,
    after,
    // +1 the like landed. -1 it was already ours and the press removed it.
    // 0 or null: the press did nothing, or the row stopped being readable.
    delta: after === null ? null : after - before,
  }
}
"""


# Per-request signatures. Stale ones are worse than none — they are computed over
# the exact URL, and ours differs by cid — so they are dropped and left to the
# page's own fetch hook to re-add.
VOLATILE = {"X-Gnarly", "X-Bogus", "_signature", "verifyFp"}


def load_template() -> dict:
    """Query params from a captured real request, if capture.py has run.

    The genuine like carries about thirty params — device_id, odinId, msToken,
    region and so on — that identify the browser and session. They cannot be
    invented, but they are stable for this profile, so reusing the captured set
    makes our request look like the one that works.
    """
    cap = HERE / "capture.json"
    if not cap.exists():
        return {}
    try:
        entries = json.loads(cap.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    for e in entries:
        if str(e.get("method", "")).upper() != "POST":
            continue
        query = urlparse(str(e.get("url", ""))).query
        if not query:
            continue
        params = {k: v for k, v in parse_qsl(query) if k not in VOLATILE}
        params.pop("aweme_id", None)
        params.pop("cid", None)
        return params
    return {}


def main() -> int:
    ap = argparse.ArgumentParser(description="Like TikTok comments with a saved session.")
    ap.add_argument("--links", type=Path, help="file of video URLs (.txt or .csv)")
    ap.add_argument("--from-dashboard", action="store_true", help="pull links from the admin dashboard")
    ap.add_argument("--cluster-by", default="rank", choices=["rank", "date", "combined"],
                    help="which clustering the dashboard should apply (default: rank)")
    ap.add_argument("--clusters", default="", help="cluster numbers, e.g. 1,2 (blank = every cluster)")
    ap.add_argument("--platform", default="tiktok", help="platform filter for the dashboard query")
    ap.add_argument("--category", default="", help="link category: competitors|ai_detector|generic")
    ap.add_argument("--max-links", type=int, default=500,
                    help="most links to pull; raise it to cover a whole cluster")
    ap.add_argument("--keep-going", action="store_true",
                    help="do not stop on repeated video failures — work the list to the end")
    ap.add_argument("urls", nargs="*", help="video URLs, if you'd rather pass them inline")
    ap.add_argument("--products", action="store_true",
                    help="like comments naming one of the ACTIVE products")
    ap.add_argument("--all-products", action="store_true",
                    help="like comments naming ANY product, including deactivated ones")
    ap.add_argument("--users", default="", help="comma-separated @handles whose comments to like")
    ap.add_argument("--all", action="store_true", help="like EVERY comment on each video")
    ap.add_argument("--profile", default="default", help="which login.py profile to use")
    ap.add_argument("--delay", default="1,3",
                    help="seconds between videos, 'min,max' (default 1,3)")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many likes (0 = no cap)")
    ap.add_argument("--pages", type=int, default=3, help="comment pages to read per video")
    ap.add_argument("--mode", default="dom", choices=["dom", "fast", "api"],
                    help="dom: click the heart. The only mode that works. "
                         "fast/api: signed requests — accepted by TikTok and "
                         "silently not applied. Kept for re-testing, not for use")
    ap.add_argument("--scrolls", type=int, default=6, help="comment scrolls per video in dom mode")
    ap.add_argument("--no-dom-sweep", action="store_true",
                    help="do not read the open comment panel for product comments the "
                         "api list never returned (replies, anything past --pages). "
                         "The sweep is on by default and costs no extra page load")
    ap.add_argument("--headed", action="store_true",
                    help="show the browser window instead of running headless")
    ap.add_argument("--mimic-comments", action="store_true",
                    help="when commenting, first look at the comments already under "
                         "the video. If one of them recommends a rival tool, write ours "
                         "in the same vein instead of taking a stored comment. Falls "
                         "back to the stored set when the thread mentions no rival")
    ap.add_argument("--no-like", action="store_true",
                    help="do not like anything — only post comments. For a run whose "
                         "job is to seed comments on links that carry none of ours; "
                         "pointless without --comment-empty, which is what posts them")
    ap.add_argument("--debug", action="store_true",
                    help="say far more, for debugging: elapsed time on every line, "
                         "how long each page took, what a failed page actually "
                         "contained, and the same detail written into the ledger's "
                         "note column so a failure can be read the next morning")
    ap.add_argument("--no-captcha-window", action="store_true",
                    help="headless only: do NOT open a window when a captcha appears. "
                         "By default one is opened so the puzzle can be solved and the "
                         "run carries on; with this, the account is given up on as it "
                         "used to be. For a run nobody is sitting in front of")
    ap.add_argument("--solve-captcha", action="store_true",
                    help="try the solving API before asking you. OFF by default: a "
                         "captcha now sounds and notifies straight away so you can "
                         "solve it yourself")
    ap.add_argument("--no-relogin", action="store_true",
                    help="do not try to sign back in when TikTok drops the session")
    ap.add_argument("--window-slot", type=int, default=0,
                    help="which screen position to take in headed mode")
    ap.add_argument("--window-count", type=int, default=1,
                    help="how many windows to tile for, in headed mode")
    ap.add_argument("--with-media", action="store_true",
                    help="let the page load video/images — slower, only for debugging")
    ap.add_argument("--unlike", action="store_true", help="remove the like instead of adding it")
    ap.add_argument("--dry-run", action="store_true", help="find targets, like nothing")
    ap.add_argument("--comment-empty", action="store_true",
                    help="on a video carrying NONE of our product comments, post one "
                         "from the dashboard. OFF by default: it is the only thing here "
                         "that writes something public")
    ap.add_argument("--comment-product", default="purifytext",
                    help="which product's comment to post with --comment-empty "
                         "(default purifytext; blank = let the dashboard choose)")
    ap.add_argument("--keep-failures", action="store_true",
                    help="leave failed rows in done.csv, so failed comments are "
                         "never retried (by default they are dropped and tried again)")
    args = ap.parse_args()
    # A SECOND BROWSER ON A HELD PROFILE IS NOT A SECOND BROWSER.
    #
    # It starts, it renders TikTok, and it reports the account as signed out,
    # because the first browser holds the cookie database and this one reads
    # nothing. Then the run stops with "Not signed in on profile 'a'" about a
    # profile that is signed in and working in the window next to it.
    pdir = profile_dir(args.profile, "tiktok")
    if busy.is_busy(pdir):
        print(busy.note(pdir))
        return 1
    if args.debug:
        # Both of them: dbg() lines are worthless without knowing when.
        global DEBUG
        DEBUG = True
        console.stamp()
        print("debug on — elapsed time on every line, and failures say what was "
              "on the page")

    global DONE
    DONE = done_path(args.profile)

    users = {u.strip().lstrip("@").lower() for u in args.users.split(",") if u.strip()}
    if not (args.products or args.all_products or users or args.all):
        print("Nothing selected. Pass --products, --all-products, --users or --all.")
        return 2

    links = list(args.urls)
    # --all-products implies --products; asking for every product and then not
    # matching any would be a silent no-op.
    want_products = args.products or args.all_products
    products = NORM_PRODUCTS if want_products else []
    # COMMENTING NEEDS THE PRODUCT LIST, even when nothing is being liked.
    #
    # "Post on a video that carries none of our comments" is decided by counting
    # the comments that name one of our products. With the product list empty
    # that count is zero on every video in the world, so the run would comment
    # under videos we have already commented under — in public, repeatedly, from
    # accounts that are trying not to look automated.
    #
    # It is a likely combination, too: switching off liking and switching off
    # "active products only" both feel like ways of saying "do not like things".
    if args.comment_empty and not want_products:
        print(
            "--comment-empty needs --products (or --all-products), even with --no-like.\n"
            "  Whether a video already carries one of our comments is decided by looking\n"
            "  for our product names in its comments. With no product list that check\n"
            "  finds nothing on every video, and the run would comment under videos it\n"
            "  has already commented under.\n"
            "  On the dashboard: tick 'Active products only'."
        )
        return 2
    if args.from_dashboard:
        pulled, live = from_dashboard(
            args.cluster_by,
            args.clusters,
            {
                "platform": args.platform,
                "category": args.category,
                "limit": str(args.max_links),
                # Ask the dashboard for the full list, deactivated included, so
                # this stays right if a product is ever added there.
                "allProducts": "1" if args.all_products else "",
                # ONLY THE LINKS THAT CARRY NONE OF OURS — but ONLY for a run
                # that is doing nothing else.
                #
                # --comment-empty on its own means "like what is there, and
                # write on the videos that have nothing of ours", which is every
                # link addressed one way or the other. Dropping the links that
                # already carry our comments would throw away exactly the ones
                # with something to like, and the run would like nothing at all.
                #
                # With --no-like there is nothing to lose: those links have no
                # work left on them, and skipping them saves opening the ~50%
                # the dashboard already knows about — 669 videos out of 1,381 on
                # a real cluster, which is most of an hour of page loads.
                #
                # A link nobody has scanned is NOT known to be clean and still
                # comes back; the per-video check is what decides either way.
                "withoutOurs": "1" if (args.comment_empty and args.no_like) else "",
            },
        )
        links += pulled
        if want_products and live:
            if args.all_products:
                # UNION, not replacement. The dashboard's list is the products
                # switched on for comment generation, which is a smaller set
                # than the products that have comments already out there — and
                # a deployment that predates the allProducts parameter simply
                # ignores it and answers with the active three regardless.
                # Taking its answer as the whole truth is how --all-products
                # silently did nothing.
                products = sorted(set(NORM_PRODUCTS) | {norm(p) for p in live})
            else:
                # Whatever the dashboard sent wins over the compiled fallback.
                products = [norm(p) for p in live]
    if args.links:
        links += read_links(args.links)
    if not links:
        print("No links. Pass --from-dashboard, --links, or URLs directly.")
        return 2
    if want_products:
        # Say what will actually be matched. "active products" above is what the
        # dashboard reports, which is not the same list once --all-products is
        # in play, and the difference is worth seeing before a long run.
        # What the run will actually do. Under --no-like it likes nothing, and a
        # banner saying "liking comments for" is the run describing work it is
        # not going to do.
        if args.no_like:
            print(f"NOT liking anything. Looking for videos with no comment of ours: "
                  f"{', '.join(products)}")
        else:
            print(f"liking comments for: {', '.join(products)}")
    ids = [(u, video_id(u)) for u in links]
    targets_videos = [(u, i) for u, i in ids if i]
    if not targets_videos:
        print("No TikTok video URLs found in the input.")
        return 2
    skipped_urls = len(ids) - len(targets_videos)

    try:
        lo, hi = (float(x) for x in args.delay.split(","))
    except ValueError:
        print("--delay wants 'min,max', e.g. 2,5")
        return 2

    # Clear last run's failures BEFORE reading the skip list, or they would be
    # skipped for the rest of the ledger's life. A dry run leaves the file
    # alone — it likes nothing, so it has no business editing the record.
    if not args.keep_failures and not args.dry_run:
        line = report_purge(purge_failures(), DONE.name)
        if line:
            print(line)

    done = load_done()
    print(
        f"{len(targets_videos)} video(s)"
        + (f", {skipped_urls} input line(s) were not TikTok video URLs" if skipped_urls else "")
        + f". {len(done)} comment(s) already done."
    )

    # ── one link at a time ───────────────────────────────────────────────────
    # Reading the comments for a link and liking them happen together, link by
    # link. Doing every read first meant a 500-link run spent eight minutes
    # building a list before it liked anything, and a run stopped early had
    # nothing to show for that time. Now the first like lands within seconds.
    def targets_for(aweme: str) -> tuple[list[dict], int, int, int, list[dict]]:
        """Comments on this video worth liking.

        Returns (todo, matched, already, product_hits, all_comments). The
        fourth counts ONLY
        comments naming a product, which is what "this video carries none of
        ours" means — `matched` also includes --users and --all matches, and a
        video full of a watched handle's comments is not an empty one.
        """
        comments = fetch_comments(aweme, args.pages)
        # --no-like empties the like list and nothing else. Everything below
        # still runs: `hits` is what decides whether this video carries a
        # comment of ours, and that question is the whole basis of the
        # commenting path.
        picks = ([] if args.no_like
                 else [c for c in comments if wanted(c, products, users, args.all)])
        fresh = [c for c in picks if c["cid"] not in done and not c["already"]]
        hits = sum(1 for c in comments if products and wanted(c, products, set(), False))
        # The whole list comes back too: the dom sweep needs to know what the
        # API DID return, so it can report only what it did not.
        return fresh, len(picks), len(picks) - len(fresh), hits, comments

    if args.dry_run:
        found = 0
        would_post = 0
        for url, aweme in targets_videos:
            todo, matched, already, hits, all_comments = targets_for(aweme)
            # The same test the real run makes, so a dry run shows exactly which
            # videos would be written on before any of them are — and, with
            # --mimic-comments, the comment it would actually write rather than
            # the stored one it would not have used.
            if args.comment_empty and not todo and hits == 0:
                text, prod, source = comment_for(url, all_comments, args)
                if text:
                    would_post += 1
                    print(f"  {url}")
                    print(f"      WOULD COMMENT ({prod}, {source}): {text[:70]}")
            if not todo:
                continue
            print(f"  {url}")
            for c in todo:
                print(f"      @{c['user']:<20} {c['text'][:60]}")
            found += len(todo)
            if args.limit and found >= args.limit:
                break
        print(f"\n{found} comment(s) would be liked.")
        return 0

    pdir = HERE / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    # "Default" is the profile Chromium actually writes into. The directory
    # itself proves nothing: login.py creates it before launching, so it exists
    # even when the sign-in was abandoned halfway.
    if not (pdir / "Default").exists():
        print(f"No session at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    f, w = open_done()
    ok = failed = commented = 0
    try:
        with sync_playwright() as p:
            ctx = launch_liker(
                p,
                args.profile,
                block_media=not args.with_media,
                headed=args.headed,
                slot=args.window_slot,
                slots=args.window_count,
            )
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            # The home page is only where the session gets confirmed. In dom mode
            # each video is then opened in turn; in api mode this stays the one
            # and only navigation.
            #
            # AND A SLOW HOME PAGE IS NOT A REASON TO DIE. Unguarded, this one
            # line ended a whole worker:
            #
            #   playwright._impl._errors.TimeoutError: Page.goto: Timeout
            #   30000ms exceeded. navigating to "https://www.tiktok.com/"
            #
            # Thirty seconds is nothing unusual with several browsers competing
            # for one machine — the same slowness that makes videos miss their
            # render deadline — and the cost there is one video, while the cost
            # here was every video the profile had left.
            for attempt in range(3):
                try:
                    page.goto("https://www.tiktok.com/", wait_until="domcontentloaded",
                              timeout=45000)
                    break
                except Exception as e:  # noqa: BLE001
                    print(f"  the home page did not load ({str(e).splitlines()[0][:70]})"
                          + (" — trying again" if attempt < 2 else ""))
                    if attempt == 2:
                        print(
                            "  Three tries, so this is the machine rather than the site.\n"
                            "  Run fewer browsers at once (--at-once, or 'Browsers at once')."
                        )
                        ctx.close()
                        return 1
                    page.wait_for_timeout(5000)
            page.wait_for_timeout(2500)

            # Confirm the session BEFORE spending the queue. An expired login
            # fails every like with the same opaque code, and finding that out
            # twenty rows into done.csv wastes both the run and the evidence.
            # The reason comes back too, because "no" and "would not say" are
            # different answers with opposite responses — see is_refusal().
            ACCOUNT_JS = """async () => {
                    const r = await fetch('/passport/web/account/info/?aid=1459', {
                        credentials: 'include',
                    })
                    if (!r.ok) return { reason: 'HTTP ' + r.status }
                    const j = await r.json().catch(() => null)
                    if (!j) return { reason: 'no JSON' }
                    const d = j.data || {}
                    return d.user_id_str || d.user_id
                        ? { who: (d.screen_name || d.username || String(d.user_id_str || d.user_id)) }
                        : { reason: j.message || 'not signed in' }
                }"""

            def ask_who():
                return safe_eval(page, ACCOUNT_JS) or {"reason": "probe failed"}

            acct = ask_who()
            who = acct.get("who")
            if not who and is_refusal(acct.get("reason")):
                # A REFUSAL IS NOT A REASON TO ABANDON THE SHARD.
                #
                # 403 here is the site throttling this machine — seventeen
                # browsers all asking the same endpoint within a few seconds of
                # launch is enough to earn one. Stopping costs the whole
                # profile's list (1,363 links, in the run this was written for)
                # over a question that has a second, better source: the page
                # itself. A logged-out TikTok renders a Log in button, and this
                # one does not.
                #
                # So: wait it out, ask again, and if it still will not answer,
                # let the PAGE decide. Only a page that genuinely renders
                # logged out stops the run.
                print(f"TikTok would not answer who profile '{args.profile}' is "
                      f"({acct.get('reason')}) — waiting, then asking again")
                for wait_s in (10, 30, 60):
                    page.wait_for_timeout(wait_s * 1000)
                    # Straight to the home page, not hard_reload(): that one
                    # waits for a comment icon, which a home page does not have,
                    # so it would spend a minute timing out on every attempt.
                    try:
                        page.goto("https://www.tiktok.com/", wait_until="domcontentloaded")
                        page.wait_for_timeout(2500)
                    except Exception:  # noqa: BLE001
                        pass
                    acct = ask_who()
                    who = acct.get("who")
                    if who or not is_refusal(acct.get("reason")):
                        break
                    print(f"     still {acct.get('reason')} after {wait_s}s")
                if not who and is_refusal(acct.get("reason")):
                    if page_is_logged_out(page):
                        print(
                            f"The check was refused AND the page renders logged out on "
                            f"'{args.profile}'.\n"
                            f"  Run: python login.py --profile {args.profile}"
                        )
                        ctx.close()
                        return 1
                    # Throttled, and the page says the session is fine. Carrying
                    # on is the right call: nothing has said otherwise, and the
                    # likes themselves will say if it is wrong.
                    who = "unknown — TikTok would not say, but the page is signed in"
                    print(
                        "  TikTok still will not answer, but the page shows no Log in\n"
                        "  button, so the session is there. Carrying on.\n"
                        f"  This is throttling, from {args.window_count} accounts at once —\n"
                        "  fewer at a time (--at-once, or 'Browsers at once') avoids it.\n"
                        "  Do NOT sign this profile in again on the strength of it."
                    )
            if not who:
                print(
                    f"Not signed in on profile '{args.profile}'. "
                    f"Run: python login.py --profile {args.profile}"
                )
                ctx.close()
                return 1
            template = load_template()
            if template:
                print(f"signed in as {who} · using {len(template)} param(s) from capture.json\n")
            else:
                print(
                    f"signed in as {who}\n"
                    "  no capture.json — sending the minimal parameter set. If likes come back\n"
                    "  ok but verify.py says otherwise, run capture.py first.\n"
                )

            digg_type = 0 if args.unlike else 1
            # Set when this account's likes turn out to be discarded — see
            # clicked_but_not_kept(). Ends the profile even under --keep-going.
            dead_account = False
            started = time.time()

            def record_post(url, aweme, key, prod, text, status, note):
                """A POSTED comment, in the same ledger as the likes.

                Keyed "post:<aweme>" rather than a comment id: TikTok gives the
                new comment one only after it appears, and the key is needed
                before that to stop a re-run commenting twice on the same video.
                """
                w.writerow([
                    time.strftime("%Y-%m-%dT%H:%M:%S"), url, aweme, key,
                    prod or args.comment_product, text[:200], status, note[:120],
                ])
                f.flush()

            def record(url, aweme, c, status, note):
                w.writerow(
                    [
                        time.strftime("%Y-%m-%dT%H:%M:%S"),
                        url,
                        aweme,
                        c["cid"],
                        c["user"],
                        c["text"][:200],
                        status,
                        # 120 characters is a note; a diagnosis needs room.
                        # Only when it was asked for: an ordinary run's notes
                        # are short and the file is read by eye.
                        note[:600 if DEBUG else 120],
                    ]
                )
                f.flush()

            if args.mode == "fast":
                # ONE page load already happened above. Everything from here is
                # requests: read a video's comments, like the matches, read back
                # to confirm. No navigation, so a video costs well under a second
                # instead of the eight a page load took.
                total_videos = len(targets_videos)
                digg = 0 if args.unlike else 1

                # Stand on a VIDEO page, not the home page. Measured: from the
                # home page every like is accepted and silently dropped; from a
                # video page the same request applies, including for comments on
                # OTHER videos. One load, then never navigate again.
                if not open_video(page, targets_videos[0][0]):
                    print("could not load a video page to work from")
                    ctx.close()
                    f.close()
                    return 1
                page.wait_for_timeout(1500)

                for vn, (url, aweme) in enumerate(targets_videos, 1):
                    # One authenticated read serves as discovery AND as the
                    # already-liked check, because user_digged comes with it.
                    comments = safe_eval(page, READ_ALL_JS, [aweme, args.pages]) or []
                    picks = [c for c in comments if wanted(c, products, users, args.all)]
                    todo = [c for c in picks if c["cid"] not in done and not c["already"]]
                    if not todo:
                        if picks:
                            print(f"  [{vn}/{total_videos}] {aweme}: {len(picks)} match, all done")
                        continue

                    # A refresh first: the page renders logged out far more
                    # often than the session actually dies, and stopping the
                    # whole run on a bad render costs the rest of the list.
                    if not recover_session(page, url):
                        print(
                            f"\n  THIS PROFILE IS LOGGED OUT and would not come back"
                            f" after {SESSION_RELOAD_TRIES} refreshes. Sign in again:\n"
                            f"    python login.py --profile {args.profile}"
                        )
                        break

                    sent = []
                    for c in todo:
                        res = safe_eval(page, LIKE_ONE_JS, [aweme, c["cid"], digg, url]) or {}
                        if res.get("code") == 0:
                            sent.append(c)
                        else:
                            record(url, aweme, c, "fail:api",
                                   f"{res.get('http')}/{res.get('code')} {res.get('msg') or ''}")
                            failed += 1
                        time.sleep(random.uniform(lo, hi))

                    # Confirm by reading back. The endpoint answers status_code 0
                    # for likes it never applies, so its word is worth nothing —
                    # that mistake cost four rounds of debugging.
                    after = safe_eval(page, READ_MINE_JS, [aweme, args.pages]) or {}
                    landed = 0
                    for c in sent:
                        state = after.get(c["cid"]) or {}
                        if state.get("mine"):
                            record(url, aweme, c, "ok", f"digg_count={state.get('digg')}")
                            ok += 1
                            landed += 1
                        else:
                            record(url, aweme, c, "fail:silent", "accepted but not applied")
                            failed += 1
                    rate = vn / max(0.001, time.time() - started)
                    print(
                        f"  [{vn}/{total_videos}] {aweme}: {landed}/{len(todo)} liked"
                        f"   {rate:.2f} video/s",
                        flush=True,
                    )
                    if args.limit and ok >= args.limit:
                        print(f"\n  reached --limit {args.limit}")
                        break
                    if failed >= 5 and ok == 0:
                        print("\nEvery like has failed — stopping. Check done.csv.")
                        break
                ctx.close()
                f.close()
                print(f"\n{ok} liked, {failed} failed{recovered_note()}. Log: {DONE}")
                return 0 if failed == 0 else 1

            if args.mode == "dom":
                # One page load per video, every matching comment on it liked
                # while we are there. Then the API says whether it worked — the
                # click reports nothing useful, and the endpoint lies.
                total_videos = len(targets_videos)
                for vn, (url, aweme) in enumerate(targets_videos, 1):
                    # Everything a video needs is inside this try.
                    #
                    # TikTok re-routes on its own, and with nine browsers on one
                    # machine a page can be torn down while we are reading it.
                    # Nothing between here and sys.exit(main()) caught that, so one
                    # destroyed execution context ended the whole worker and left
                    # the rest of its shard unworked while the other profiles
                    # carried on. A video is the right unit of loss.
                    try:
                        # Read THIS link's comments now, not all of them up front.
                        wants, matched, already_liked, product_hits, api_comments = targets_for(aweme)
                        # A video carrying NONE of our comments is the one worth
                        # writing on, and with --comment-empty that is what happens:
                        # the dashboard hands over one of its stored comments (the
                        # same set the Android app gives its workers) and it is
                        # posted here. Off by default — it is the only thing in this
                        # script that writes something public.
                        if not wants and args.comment_empty and product_hits == 0:
                            key = f"post:{aweme}"
                            if key in done:
                                print(f"  [{vn}/{total_videos}] {aweme}: already commented on")
                                continue
                            text, prod, source = comment_for(url, api_comments, args)
                            if not text:
                                print(f"  [{vn}/{total_videos}] {aweme}: no comment to post")
                                continue
                            print(
                                f"  [{vn}/{total_videos}] {aweme}: none of ours — "
                                f"commenting as {prod or args.comment_product} ({source})"
                            )
                            print(f"       {text[:70]}")
                            if not open_video(page, url):
                                render_failed(args.window_count)
                                time.sleep(random.uniform(lo, hi))
                                continue
                            if not recover_session(page, url):
                                print("     logged out — skipping the comment")
                                continue
                            if captcha_present(page):
                                if not wait_out_captcha(page, args.profile, args.headed,
                                                        tried_api=args.solve_captcha):
                                    break
                            if not open_comments(page):
                                record_post(url, aweme, key, prod, text,
                                            "fail:dom", "comment panel did not open")
                                print("     comment panel did not open")
                                time.sleep(random.uniform(lo, hi))
                                continue
                            posted, note = post_comment(page, text)
                            record_post(url, aweme, key, prod, text,
                                        "ok" if posted else "fail:post", note)
                            done.add(key)
                            commented += 1 if posted else 0
                            print(f"     {'commented' if posted else 'NOT posted'} - {note}")
                            # A comment is a much bigger action than a like, so the
                            # pause after one is longer than the like delay.
                            time.sleep(random.uniform(lo * 2, hi * 2))
                            continue

                        if not wants:
                            # Nothing to do here, so the page is never even loaded —
                            # which is most of the list and costs nothing.
                            if matched:
                                print(f"  [{vn}/{total_videos}] {aweme}: {matched} match, all done already")
                            continue
                        print(
                            f"  [{vn}/{total_videos}] {aweme}: {matched} match, {len(wants)} to like"
                            + (f" ({already_liked} already)" if already_liked else "")
                        )
                        if not open_video(page, url):
                            # The page never rendered. That is not the same as the
                            # comments being unopenable, and it must not count
                            # towards the three-strikes stop.
                            #
                            # WHAT was on it goes into the ledger, not only the
                            # terminal: a failure is usually read out of
                            # done-x.csv the next morning, when the browser it
                            # happened in is long gone. "page did not render in
                            # time" is a symptom shared by a busy machine, a
                            # deleted video, a logged-out session and a captcha,
                            # and those want four different responses.
                            why = why_stuck(page) if DEBUG else ""
                            note = "page did not render in time" + (f" — {why}" if why else "")
                            for c in wants:
                                record(url, aweme, c, "fail:load", note)
                            if why:
                                print(f"     {why}")
                            render_failed(args.window_count)
                            time.sleep(random.uniform(lo, hi))
                            continue

                        # The page rendered, so whatever the last few did, the
                        # machine is keeping up again.
                        render_ok()
                        before = safe_eval(page, READ_MINE_JS, [aweme, 4]) or {}
                        todo = [c for c in wants if not (before.get(c["cid"]) or {}).get("mine")]
                        # A HARD REFRESH FIRST. Most of the time the cookies are
                        # still good and the page merely rendered signed-out, and a
                        # reload brings it back in a couple of seconds. Only when it
                        # does not is the session really gone — and only then is the
                        # Google re-login, which is minutes of navigation and a good
                        # chance of a captcha, worth running.
                        if todo and not recover_session(page, url):
                            # TikTok drops sessions mid-run while the cookies stay on
                            # disk, so this is not rare and not fatal — sign back in
                            # through Google and carry on rather than losing the rest
                            # of the list.
                            print(f"     session dropped by TikTok")
                            back = False
                            if not args.no_relogin:
                                try:
                                    back = relogin.relogin(
                                        page, args.profile, headed=args.headed
                                    )
                                except Exception as e:  # noqa: BLE001
                                    print(f"     re-login error: {str(e)[:70]}")
                            if not back:
                                print(
                                    "\n  Could not sign back in. Do it once by hand:\n"
                                    f"    python login.py --profile {args.profile}"
                                )
                                break
                            # Signed in again, but on whatever page Google left us —
                            # get back to this video before carrying on.
                            if not open_video(page, url):
                                print("     back in, but this video would not reload")
                                time.sleep(random.uniform(lo, hi))
                                continue
                            before = safe_eval(page, READ_MINE_JS, [aweme, 4]) or {}
                            todo = [
                                c for c in wants
                                if not (before.get(c["cid"]) or {}).get("mine")
                            ]
                            if not todo:
                                continue
                        elif todo and aweme not in current_url(page):
                            # A refresh that recovered the session can leave the tab
                            # on a different video — TikTok re-routes on its own, and
                            # a reload lands wherever it decides. Everything below
                            # reads THIS one, so go back to it before doing so; the
                            # alternative is liking a stranger's comments under this
                            # link.
                            if not open_video(page, url):
                                print("     refreshed, but this video would not reload")
                                time.sleep(random.uniform(lo, hi))
                                continue
                            before = safe_eval(page, READ_MINE_JS, [aweme, 4]) or {}
                            todo = [
                                c for c in wants
                                if not (before.get(c["cid"]) or {}).get("mine")
                            ]
                            if not todo:
                                continue
                        # A captcha hides the comments behind placeholders while
                        # everything else looks healthy. Check before blaming the
                        # panel, or the whole run reads as a DOM problem.
                        if todo and captcha_present(page):
                            # Straight to the alarm. The solving API is opt-in
                            # (--solve-captcha) because trying it first costs half a
                            # minute of silence before anyone is told there is
                            # anything to look at, and it does not reliably clear
                            # TikTok's puzzle anyway.
                            solved = False
                            if args.solve_captcha:
                                print("     captcha - attempting to solve")
                                solved = solve_captcha_here(page)
                            if not solved and not args.headed and not args.no_captcha_window:
                                # Headless has nobody to drag the slider. Rather
                                # than give up on the account, put a window on
                                # screen for as long as it takes, then go back.
                                ctx, page, solved = show_for_captcha(
                                    p, ctx, page, args, url, args.solve_captcha
                                )
                            if not solved and not wait_out_captcha(
                                page, args.profile, args.headed, tried_api=args.solve_captcha
                            ):
                                print(
                                    f"\n  TikTok is showing its slider captcha to profile "
                                    f"'{args.profile}'.\n"
                                    "  Solve it once by hand and it usually stays quiet for a while:\n"
                                    f"    python solve_captcha.py --profile {args.profile}"
                                )
                                break
                        panel = True
                        if todo:
                            panel = open_comments(page)
                            if not panel and captcha_present(page):
                                # Opening the comments is itself a common trigger, so
                                # the check above passes and the puzzle appears in
                                # response to the click. Checking only beforehand
                                # meant the solver never ran once.
                                print("     captcha appeared on opening the comments")
                                cleared = False
                                if args.solve_captcha:
                                    cleared = solve_captcha_here(page)
                                if not cleared and not args.headed and not args.no_captcha_window:
                                    ctx, page, cleared = show_for_captcha(
                                        p, ctx, page, args, url, args.solve_captcha
                                    )
                                if not cleared:
                                    cleared = wait_out_captcha(
                                        page, args.profile, args.headed,
                                        tried_api=args.solve_captcha,
                                    )
                                if cleared:
                                    panel = open_comments(page)
                        if todo and not panel:
                            note = (
                                "captcha blocked the comments"
                                if captcha_present(page)
                                else "comment panel did not open"
                            )
                            if DEBUG:
                                why = why_stuck(page)
                                print(f"     {why}")
                                note = f"{note} — {why}"
                            for c in todo:
                                record(url, aweme, c, "fail:dom", note)
                                failed += 1
                            print(f"     {note}")
                            time.sleep(random.uniform(lo, hi))
                            continue
                        skipped_already = len(wants) - len(todo)
                        if not todo:
                            for c in wants:
                                record(url, aweme, c, "ok", "already liked before this run")
                                ok += 1
                            print(f"     all {len(wants)} already liked")
                            continue

                        payload = [{"cid": c["cid"], "user": c["user"], "text": c["text"]} for c in todo]
                        clicks = safe_eval(page, CLICK_JS, [payload, args.scrolls]) or {}

                        # Scroll ONLY if something was not on screen. Most videos hold
                        # fewer comments than the panel renders, so scrolling every
                        # one of them spent ~13 seconds a video finding nothing new.
                        if not clicks.get("_error"):
                            missing = [c for c in todo if str(clicks.get(c["cid"], "")) == "not found"]
                            if missing:
                                load_more_comments(page, args.scrolls)
                                again = safe_eval(
                                    page,
                                    CLICK_JS,
                                    [[{"cid": c["cid"], "user": c["user"], "text": c["text"]} for c in missing],
                                     args.scrolls],
                                ) or {}
                                clicks.update(again)
                        if clicks.get("_error"):
                            # The panel never opened, so nothing was pressed. Say so
                            # rather than reporting every target as a failed like.
                            print(f"     {clicks['_error']}")
                            for c in todo:
                                record(url, aweme, c, "fail:dom", clicks["_error"])
                                failed += 1
                            if failed >= 5 and ok == 0 and not args.keep_going:
                                print(
                                    "\nEvery video so far has failed to open its comments. "
                                    "Stopping — inspect this profile in a headed browser:\n"
                                    f"  python inspect_dom.py --headed --profile {args.profile}\n"
                                    "  (or pass --keep-going to work the list regardless)"
                                )
                                break
                            time.sleep(random.uniform(lo, hi))
                            continue
                        page.wait_for_timeout(1200)
                        after = safe_eval(page, READ_MINE_JS, [aweme, 4]) or {}

                        seen = clicks.get("_seen")
                        sample = clicks.get("_sample") or ""
                        landed = 0
                        # "Not found" is a property of ONE video — our comment sits
                        # below what the list will render — not a sign the run is
                        # broken. Counting it towards the three-strikes stop killed
                        # an account whose first video happened to be a busy one.
                        unreachable = 0
                        for c in todo:
                            state = after.get(c["cid"]) or {}
                            note = str(clicks.get(c["cid"], "?"))
                            if note == "not found" and seen is not None:
                                note = f"not found among {seen} row(s) [{sample}]"
                            # Only the re-read counts. A click that reported success
                            # and changed nothing is exactly what the API did for
                            # three rounds, and it must not reach done.csv as "ok".
                            if state.get("mine"):
                                record(url, aweme, c, "ok", f"digg_count={state.get('digg')}")
                                ok += 1
                                landed += 1
                                like_landed()
                            elif note.startswith("not found"):
                                record(url, aweme, c, "fail:deep", note)
                                unreachable += 1
                            else:
                                # The click result distinguishes "never found the
                                # comment" from "pressed it and nothing happened",
                                # which need completely different fixes.
                                record(url, aweme, c, "fail:dom", note)
                                failed += 1
                                if note.startswith("clicked"):
                                    # Pressed, and not kept. Eight of those in a
                                    # row with nothing ever landing is an account
                                    # whose likes are being thrown away.
                                    if clicked_but_not_kept(args.profile, str(who or "")):
                                        dead_account = True

                        if dead_account:
                            # Not `continue`: every remaining video would press a
                            # heart TikTok throws away, and write a row saying so.
                            break

                        # ── the panel is open and scrolled: read it ──────────────
                        # The API list is not the whole comment section (see
                        # DOM_SCAN_JS). Anything it missed is on screen right now,
                        # and this is the only moment in the run when that is true.
                        extra_ok = extra_fail = 0
                        # AND NOT UNDER --no-like. Unreachable today — an empty
                        # like list makes the loop skip this video long before
                        # here — but this is the second path that can press a
                        # heart, and a switch that means 'like nothing' should
                        # not depend on control flow three screens away.
                        if not args.no_dom_sweep and not args.no_like:
                            rows = safe_eval(page, DOM_SCAN_JS) or []
                            extras = dom_extras(rows, aweme, products, users, api_comments, done)
                            for c in extras:
                                res = safe_eval(page, DOM_LIKE_JS, [c["user"], c["text"]]) or {}
                                if not res.get("found"):
                                    # It was in the scan a moment ago, so the list
                                    # re-rendered under us. Not worth a ledger row.
                                    continue
                                delta = res.get("delta")
                                if delta == 1:
                                    # The count went up by one. That is the like.
                                    record(url, aweme, c, "ok", "dom sweep: not in the api list")
                                    done.add(c["cid"])
                                    ok += 1
                                    extra_ok += 1
                                elif delta == -1:
                                    # It was already ours and the press removed it.
                                    # Put it back, and check that it went back.
                                    undo = safe_eval(page, DOM_LIKE_JS, [c["user"], c["text"]]) or {}
                                    if undo.get("delta") == 1:
                                        # Nothing was lost, and nothing is owed: it
                                        # was liked before we arrived and it is
                                        # liked now. Recorded as DONE rather than
                                        # failed, so the sweep never presses it
                                        # again \u2014 a failure row is dropped on the
                                        # next run and retried forever.
                                        record(url, aweme, c, "ok", "dom sweep: was already liked")
                                        done.add(c["cid"])
                                        ok += 1
                                    else:
                                        # The restore did not land. Say so loudly:
                                        # this is the one outcome that leaves a
                                        # comment worse than we found it.
                                        record(url, aweme, c, "fail:dom",
                                               "dom sweep: UNLIKED and could not restore")
                                        failed += 1
                                        extra_fail += 1
                                else:
                                    # 0, null, or never clicked. The press achieved
                                    # nothing, so there is nothing to undo \u2014 and
                                    # pressing again to find out is exactly the bug
                                    # this replaced.
                                    why = res.get("why") or (
                                        f"like count did not move ({res.get('before')} -> {res.get('after')})"
                                        if res.get("clicked")
                                        else "not clicked"
                                    )
                                    record(url, aweme, c, "fail:dom", f"dom sweep: {why}")
                                    failed += 1
                                    extra_fail += 1
                                time.sleep(random.uniform(lo, hi))

                        rate = vn / max(0.001, time.time() - started)
                        print(
                            f"     {landed}/{len(todo)} liked"
                            + (f", {skipped_already} already" if skipped_already else "")
                            + (f", {unreachable} too deep to reach" if unreachable else "")
                            + (f", +{extra_ok} from the panel" if extra_ok else "")
                            + (f", {extra_fail} panel fail" if extra_fail else "")
                            + f"   {rate:.2f} video/s",
                            flush=True,
                        )
                        if args.limit and ok >= args.limit:
                            print(f"\n  reached --limit {args.limit}")
                            break
                        if failed >= 3 and ok == 0 and not args.keep_going:
                            print(
                                "\nFirst three all failed — stopping. Check done.csv, "
                                "or pass --keep-going to work the list regardless."
                            )
                            break
                        time.sleep(random.uniform(lo, hi))
                    except Exception as e:  # noqa: BLE001
                        # Nothing is written to the ledger: whatever was not
                        # recorded before the error is simply not recorded, so
                        # the next run tries it again. Writing a failure row here
                        # would claim to know something about comments this pass
                        # never reached.
                        why = str(e).splitlines()[0][:120]
                        print(f"     error on this video: {why}")
                        if "has been closed" in why or "Target page" in why:
                            # The browser itself is gone. Every remaining video
                            # would fail the same way.
                            print("     browser is gone — stopping this profile")
                            break
                        time.sleep(random.uniform(lo, hi))
                        continue
                ctx.close()
                f.close()
                print(f"\n{ok} liked, {failed} failed{recovered_note()}. Log: {DONE}")
                return 0 if failed == 0 else 1

            # ── api mode: kept for the day TikTok changes its mind ────────────
            plan = []
            for url, aweme in targets_videos:
                for c in targets_for(aweme)[0]:
                    plan.append((aweme, url, c))
                if args.limit and len(plan) >= args.limit:
                    plan = plan[: args.limit]
                    break
            for n, (aweme, url, c) in enumerate(plan, 1):
                res = safe_eval(page, LIKE_JS, [aweme, c["cid"], digg_type, template])
                code, msg, http = res.get("code"), res.get("msg") or "", res.get("http")
                good = code == 0
                if good:
                    ok += 1
                else:
                    failed += 1
                record(url, aweme, c, "ok" if good else f"fail:{http}/{code}", msg)
                rate = n / max(0.001, time.time() - started)
                print(
                    f"  [{n}/{len(plan)}] @{c['user']:<18} "
                    f"{'liked' if good else 'FAILED ' + str(http) + '/' + str(code) + ' ' + msg[:60]}"
                    f"   {rate:.2f}/s",
                    flush=True,
                )
                # Three failures in a row is not bad luck — the session is dead,
                # the endpoint changed, or the account is being refused. Stopping
                # beats burning the whole queue against a wall.
                if failed >= 3 and ok == 0:
                    print("\nFirst three likes all failed — stopping. Check the note column in done.csv.")
                    break
                if n < len(plan):
                    time.sleep(random.uniform(lo, hi))
            ctx.close()
    finally:
        f.close()

    print(f"\n{ok} liked, {failed} failed{recovered_note()}. Log: {DONE}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
