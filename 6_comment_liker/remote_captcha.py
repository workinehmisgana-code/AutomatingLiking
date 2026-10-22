#!/usr/bin/env python3
"""
Solve a captcha from your phone, from any network.

THE PROBLEM. The liker runs headless on one machine. When TikTok puts a puzzle in
front of an account the run stops dead — the comment list renders as grey
placeholders, the account stays signed in, and every symptom points at the DOM
while none of them is the cause. Somebody has to drag a slider, the wait gives up
in a few minutes, and until now that somebody had to be sitting at that machine.
A run lasts hours and nobody watches a terminal for hours.

THE RELAY. The dashboard (3_dashboard) is already deployed, already on HTTPS and
already refuses anyone who is not the admin. So the puzzle goes there:

    worker  --POST /api/captcha-->  dashboard  <--/admin/captcha--  your phone
    worker  <--GET  /api/captcha--  (the answer)

The worker polls for the answer and applies it in its own browser. Nothing here
listens on a port, so there is no tunnel to run, no port to forward on the router
and no new door into the house. The liker's own control panel stays on localhost,
which is where a thing that can start signed-in browsers belongs.

WHAT GOES OVER THE WIRE

  rotate      the two images TikTok sent, as base64, exactly as the widget got
              them. The phone composites them and really turns the disc, so the
              judgement is the same one you would make at the keyboard. One angle
              comes back and drag_angle() applies it.

  everything  a PNG of the widget. There is no number that answers "select the
  else        two objects of the same shape", so taps come back instead, as
              fractions of the picture, and tap_points() clicks them.

FOUR THINGS THE PHONE CAN SAY: an angle, some taps, "give me a different puzzle",
or "skip this account". The last one matters — an account nobody can free should
release the other eight rather than hold a barrier for four minutes.

Configured by the two variables the liker already reads for everything else:

    DASHBOARD_URL=https://…
    LINKS_EXPORT_TOKEN=…

Try it without a run, once a puzzle is up somewhere:

    python remote_captcha.py --selftest        # is the relay reachable?
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import captcha

# How often the worker asks whether an answer has arrived. Two seconds is a
# person-scale interval: it costs a couple of dozen requests over a puzzle's
# life, and only while a run is actually blocked.
POLL_S = 2.0

# Rounds of publish-and-wait before giving up. More than one because "give me a
# different puzzle" is a real answer, and a refreshed puzzle needs republishing.
MAX_ROUNDS = 3

UA = "comment-liker/remote-captcha"


def config() -> tuple[str, str]:
    """(base url, token), either empty when the relay is not set up.

    A REAL environment variable wins over .env, which is what makes it possible
    to point a test at a dev server without editing the file every run:

        DASHBOARD_URL=http://127.0.0.1:3000 python remote_captcha.py --selftest
    """
    env = captcha._load_env()
    base = (os.environ.get("DASHBOARD_URL") or env.get("DASHBOARD_URL") or "").rstrip("/")
    token = os.environ.get("LINKS_EXPORT_TOKEN") or env.get("LINKS_EXPORT_TOKEN") or ""
    return base, token


def available() -> bool:
    """Is the relay configured at all? Nothing here works without both halves."""
    base, token = config()
    return bool(base and token)


def _post(url: str, payload: dict, timeout: int = 30) -> dict:
    body = json.dumps(payload).encode("utf-8")
    # The token goes in the HEADER as well as the body. The dashboard accepts
    # either, and a header keeps it out of anything that logs a URL.
    headers = {"Content-Type": "application/json", "User-Agent": UA}
    if payload.get("token"):
        headers["Authorization"] = f"Bearer {payload['token']}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", errors="replace") or "{}")


def _get(url: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", errors="replace") or "{}")


def _delete(url: str, timeout: int = 15) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": UA}, method="DELETE")
    try:
        urllib.request.urlopen(req, timeout=timeout).close()
    except Exception:  # noqa: BLE001
        # A row left behind is pruned within the hour and shows on the page as a
        # stale card. Not worth failing a run over.
        pass


def publish(page, profile: str, verbose: bool = True):
    """Put the puzzle on the phone. Returns (id, widget, box) or (None, None, None).

    `widget` is kept HERE rather than sent: the answer is applied in this
    browser, and the handle and track boxes are this side's business. `box` is
    the widget's rectangle, needed to turn a tap fraction back into a click.
    """
    base, token = config()
    if not (base and token):
        if verbose:
            print("     remote captcha: DASHBOARD_URL or LINKS_EXPORT_TOKEN missing")
        return None, None, None

    what = captcha.kind(page)
    payload: dict = {
        "token": token,
        "profile": profile,
        "kind": what,
        "instruction": captcha.instruction(page)[:300],
    }
    widget = None
    box = None
    if what == "rotate":
        widget = captcha.find_widget(page)
        if widget:
            payload["outer"] = widget["outer"]
            payload["inner"] = widget["inner"]
    # A photograph as well as (or instead of) the images. For a rotation it is
    # not needed; for anything else it is the only thing a person can work from,
    # and for a rotation whose images would not come out it is the fallback.
    if not widget:
        b64, box = captcha.shot(page)
        if not b64:
            if verbose:
                print("     remote captcha: could not photograph the widget")
            return None, None, None
        payload["shot"] = b64
        payload["boxW"] = round(box["width"], 1)
        payload["boxH"] = round(box["height"], 1)

    try:
        d = _post(base + "/api/captcha", payload)
    except urllib.error.HTTPError as e:
        if verbose:
            print(f"     remote captcha: dashboard said HTTP {e.code}")
        return None, None, None
    except Exception as e:  # noqa: BLE001
        if verbose:
            print(f"     remote captcha: could not reach the dashboard ({str(e)[:60]})")
        return None, None, None

    rid = str(d.get("id") or "")
    if not rid:
        if verbose:
            print(f"     remote captcha: no id back ({str(d)[:80]})")
        return None, None, None
    if verbose:
        print(
            f"     captcha sent to your phone — open {base}/admin/captcha"
            f" (profile {profile}, {what})"
        )
    return rid, widget, box


def peek(rid: str):
    """One non-blocking look. An answer dict, None for "not yet", 'gone' for gone.

    Separate from the waiting loop because the caller often has its own loop to
    run alongside: like.py watches for the puzzle being solved AT THE KEYBOARD
    at the same time as waiting for the phone, and whichever happens first wins.
    """
    base, token = config()
    url = (
        f"{base}/api/captcha?token={urllib.parse.quote(token)}"
        f"&id={urllib.parse.quote(rid)}"
    )
    try:
        d = _get(url)
    except Exception:  # noqa: BLE001
        # A blip is not an answer and not a disappearance. The caller keeps
        # asking; the run is stuck either way.
        return None
    if not d.get("found"):
        # Pruned after an hour, or replaced by a newer puzzle for this same
        # account. Nobody is going to answer this one.
        return "gone"
    return d.get("answer") or None


def wait_for_answer(rid: str, timeout_s: float, stop=None, tick=None, verbose: bool = True):
    """Poll until somebody answers, the puzzle is dropped, or time runs out.

    `stop()` is checked every poll and truthy means the puzzle has gone away by
    itself — solved at the machine, or abandoned by TikTok. It returns the string
    'stopped' for that, which is a success the caller reports differently.
    `tick(waited)` is called each poll for whatever else the caller does while
    waiting, such as nagging whoever is at the desk.
    """
    deadline = time.time() + timeout_s
    said = False
    waited = 0.0
    while time.time() < deadline:
        if stop is not None:
            try:
                if stop():
                    return "stopped"
            except Exception:  # noqa: BLE001
                pass
        got = peek(rid)
        if got == "gone":
            if verbose:
                print("     remote captcha: the request is gone")
            return None
        if got:
            return got
        if not said and verbose:
            print(f"     waiting for an answer from your phone (up to {int(timeout_s)}s)…")
            said = True
        time.sleep(POLL_S)
        waited += POLL_S
        if tick is not None:
            try:
                tick(waited)
            except Exception:  # noqa: BLE001
                pass
    if verbose:
        print("     remote captcha: nobody answered in time")
    return None


def close(rid: str) -> None:
    """The answer has been used, so the card comes off the page."""
    base, token = config()
    if base and token and rid:
        _delete(
            f"{base}/api/captcha?token={urllib.parse.quote(token)}"
            f"&id={urllib.parse.quote(rid)}"
        )


def apply(page, widget, box, answer: dict, verbose: bool = True) -> str:
    """Do what the phone said. Returns what happened, in one word.

    'solved'  the puzzle is gone.
    'again'   the answer was applied and the puzzle is still up.
    'refresh' a different puzzle was asked for, and asked for.
    'giveup'  skip this account.
    'bad'     an answer this puzzle cannot use.
    """
    if answer.get("give_up"):
        if verbose:
            print("     phone says skip this account")
        return "giveup"

    if answer.get("refresh"):
        if verbose:
            print("     phone asked for a different puzzle")
        captcha.refresh(page)
        return "refresh"

    if "angle" in answer and widget:
        try:
            angle = float(answer["angle"])
        except (TypeError, ValueError):
            return "bad"
        if verbose:
            print(f"     phone says {angle:.0f} deg")
        captcha.drag_angle(page, widget, angle, verbose=verbose)
    elif answer.get("points") and box:
        n = captcha.tap_points(page, box, answer["points"], verbose=verbose)
        if verbose:
            print(f"     replayed {n} tap(s) from your phone")
        if n == 0:
            return "bad"
    else:
        # An answer of the wrong shape for this puzzle — a slider angle for a
        # pick-the-shapes one, say. Said here rather than three screens later as
        # a failed drag.
        if verbose:
            print(f"     phone sent {sorted(answer)}, which does not fit this puzzle")
        return "bad"

    page.wait_for_timeout(2500)
    if not captcha.present(page):
        page.wait_for_timeout(1200)
        return "solved"
    captcha.dump(page, "remote-miss")
    return "again"


def solve(page, profile: str, timeout_s: float = 240.0, stop=None, tick=None,
          verbose: bool = True) -> bool:
    """Clear the captcha with help from a phone. True once it is gone.

    False when the relay is not configured, nobody answers, or the person says to
    skip the account — all of which leave like.py to report the account as
    blocked, exactly as it did before any of this existed.

    `stop` and `tick` are passed through to wait_for_answer, so a caller with a
    window open at the machine can have both routes live at once.
    """
    if not available():
        return False
    deadline = time.time() + timeout_s
    for round_no in range(1, MAX_ROUNDS + 1):
        if not captcha.present(page):
            return True
        left = deadline - time.time()
        if left < POLL_S * 2:
            return False

        rid, widget, box = publish(page, profile, verbose=verbose)
        if not rid:
            return False
        answer = wait_for_answer(rid, left, stop=stop, tick=tick, verbose=verbose)
        close(rid)
        if answer == "stopped":
            # Solved at the keyboard while the phone was still being waited on.
            return True
        if not answer:
            return False

        what = apply(page, widget, box, answer, verbose=verbose)
        if what == "solved":
            if verbose:
                print(f"     captcha cleared from your phone (round {round_no})")
            return True
        if what in ("giveup", "bad"):
            return False
        # 'refresh' or 'again': a new puzzle is on screen, so publish that one.
        if verbose and what == "again":
            print(f"     still there after round {round_no}")
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--selftest", action="store_true",
                    help="publish a fake puzzle and wait for you to answer it")
    ap.add_argument("--wait", type=int, default=120, help="seconds to wait in --selftest")
    args = ap.parse_args()

    base, token = config()
    print(f"DASHBOARD_URL      {base or '(missing)'}")
    print(f"LINKS_EXPORT_TOKEN {'set' if token else '(missing)'}")
    if not (base and token):
        print("\nBoth are needed. They live in .env here or in ../3_dashboard/.env.")
        return 2
    print(f"phone page         {base}/admin/captcha")
    if not args.selftest:
        print("\nPass --selftest to send a test puzzle to that page.")
        return 0

    # A 1x1 PNG. Enough to prove the round trip: publish, appear on the phone,
    # answer, and be read back here. Nothing about the browser is involved.
    ONE_PX = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAF"
        "AAH/q842iQAAAABJRU5ErkJggg=="
    )
    try:
        d = _post(base + "/api/captcha", {
            "token": token,
            "profile": "selftest",
            "kind": "other",
            "instruction": "Self test — tap anywhere and press Send taps.",
            "shot": ONE_PX,
            "boxW": 300,
            "boxH": 300,
        })
    except Exception as e:  # noqa: BLE001
        print(f"\nPublish failed: {e}")
        return 1
    rid = str(d.get("id") or "")
    if not rid:
        print(f"\nNo id came back: {d}")
        return 1
    print(f"\npublished as {rid}")
    print(f"open {base}/admin/captcha on your phone and answer it…")
    answer = wait_for_answer(rid, args.wait)
    close(rid)
    if answer is None:
        print("\nNo answer. The relay published fine, so the page or the login is the thing to check.")
        return 1
    print(f"\ngot: {answer}")
    print("The round trip works. A real puzzle will reach the same page.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
