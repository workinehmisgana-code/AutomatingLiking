"""A page that navigates under us costs one video, never the whole shard.

The run this was written for: nine profiles working nine shards, and profile
`d` stopped after a few minutes with

    playwright._impl._errors.Error: Page.evaluate: Execution context was
    destroyed, most likely because of a navigation

raised out of load_more_comments. Nothing between that call and
`sys.exit(main())` catches anything, so the worker exited and left the rest of
its shard unworked while the other eight carried on — the loss looked like
"some links were never liked", hours later, with no note in any ledger.

TikTok re-routes on its own. With nine browsers on one machine it re-routes
often. That is not an error condition to be prevented; it is weather. What
matters is the unit of loss: ONE VIDEO, tried again on the next run, because
nothing was written to the ledger for it.

    python check_navigation.py
"""
import re
import sys
from pathlib import Path

import like

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


DESTROYED = "Page.evaluate: Execution context was destroyed, most likely because of a navigation"
CLOSED = "Target page, context or browser has been closed"


class FakePage:
    """A page whose every call can be made to fail the way a real one does."""

    def __init__(self, script, rows=True, sleep_error=None):
        # script: one entry per evaluate() — an Exception to raise, or a value.
        self.script = list(script)
        self.calls = 0
        self.rows = rows
        self.sleep_error = sleep_error
        self.slept = 0

    def evaluate(self, js, arg=None):
        self.calls += 1
        step = self.script.pop(0) if self.script else None
        if isinstance(step, BaseException):
            raise step
        return step

    def query_selector(self, sel):
        if isinstance(self.rows, BaseException):
            raise self.rows
        return object() if self.rows else None

    def wait_for_timeout(self, ms):
        self.slept += 1
        if self.sleep_error:
            raise self.sleep_error

    def keyboard_press(self, k):
        pass

    # open_comments uses these two as well.
    class _KB:
        def press(self, k):
            raise RuntimeError("no keyboard on a dead page")

    keyboard = _KB()

    def click(self, sel, timeout=None):
        raise RuntimeError("nothing to click on a dead page")


print("safe_eval: a navigation is weather, not a crash")
# Plain exceptions carrying the real message: safe_eval matches on the TEXT,
# not the type, because Playwright raises several types for the same event.
p = FakePage([RuntimeError(DESTROYED), RuntimeError(DESTROYED), RuntimeError(DESTROYED)])
check("  three destroyed contexts return None", like.safe_eval(p, "() => 1"), None)
check("  having actually retried", p.calls, 3)

p = FakePage([RuntimeError(DESTROYED), {"ok": True}])
check("  a retry that succeeds gives the answer", like.safe_eval(p, "() => 1"), {"ok": True})

# A real JS mistake must still be loud. Swallowing it would turn a broken
# selector into "this video had no comments", silently, on every video.
p = FakePage([RuntimeError("ReferenceError: rows is not defined")])
try:
    like.safe_eval(p, "() => rows")
    check("  a genuine JS error still raises", False, True)
except Exception as e:  # noqa: BLE001
    check("  a genuine JS error still raises", "ReferenceError" in str(e), True)

# The page can close BETWEEN the failure and the retry-sleep. That raised a
# second exception out of the except block, which was the same crash again.
p = FakePage([RuntimeError(DESTROYED)], sleep_error=RuntimeError(CLOSED))
check("  a page closing during the retry-wait returns None too",
      like.safe_eval(p, "() => 1"), None)

print("\nreading the panel: a moving page has no comment rows")
check("  rows present", like.has_comment_rows(FakePage([], rows=True)), True)
check("  rows absent", like.has_comment_rows(FakePage([], rows=False)), False)
check("  page navigating mid-read",
      like.has_comment_rows(FakePage([], rows=RuntimeError(DESTROYED))), False)

print("\nopen_comments returns False rather than raising")
# Every route through it is broken at once: the row check raises, the click
# raises, the JS fallback raises. It must still answer the question it was
# asked, which is "are there comments to work with" — no.
dead = FakePage([RuntimeError(DESTROYED)] * 20, rows=RuntimeError(DESTROYED))
check("  on a dead page", like.open_comments(dead, timeout_ms=10), False)

print("\nload_more_comments keeps what it had and stops")
p = FakePage([12, 19, RuntimeError(DESTROYED), RuntimeError(DESTROYED), RuntimeError(DESTROYED)])
check("  the rows it did load are returned", like.load_more_comments(p, 6), 19)
p = FakePage([RuntimeError(DESTROYED)] * 9)
check("  and nothing loaded is 0, not an exception", like.load_more_comments(p, 3), 0)

src = Path("like.py").read_text(encoding="utf-8")

print("\nthe route filter cannot leak an exception into Playwright's thread")
# CancelledError has not inherited from Exception since 3.8, so `except
# Exception` in a route handler does NOT catch the teardown, and it came out as
# a stray traceback from a thread nobody owns.
filt = src.split("def _filter(route):")[1].split("ctx.route(")[0]
check("  the handler catches BaseException", filt.count("except BaseException:"), 2)
check("  and never plain Exception", "except Exception" in filt, False)
check("  CancelledError is why, and it says so", "CancelledError" in filt, True)

print("\nthe per-video body is inside a try, so one video is the unit of loss")
body = src.split('if args.mode == "dom":')[1].split("# ── api mode")[0]
loop = body.split("for vn, (url, aweme) in enumerate(targets_videos, 1):")[1]
check("  the loop opens with a try", loop.lstrip().startswith("#") and "try:" in loop[:900], True)
check("  it catches per video", "except Exception as e:" in loop, True)
check("  and carries on to the next one", re.search(r"error on this video[\s\S]{0,700}continue", loop) is not None, True)
# A closed browser is the one error where continuing is pointless: every
# remaining video would fail identically, printing 2,000 lines of the same
# thing. That one stops the profile.
check("  a closed browser stops the profile instead",
      re.search(r'has been closed[\s\S]{0,400}break', loop) is not None, True)
# The ledger must not gain a row for a video the run never finished reading:
# "failed" would be a claim about comments nobody looked at, and purge_failures
# clears failures anyway, so the honest record is no record.
check("  and nothing is written to the ledger for it",
      re.search(r"except Exception as e:[\s\S]{0,700}?record\(", loop) is None, True)

print("\nvideos that never render say what is actually wrong")
# "page did not render, skipping" is true and useless: it names the symptom on
# a machine that has 2,000 other lines to print. The cause is nearly always the
# same one, and it is countable — a run of them in a row is a machine that
# cannot keep up, where one on its own is just a bad link.
#
# Measured on the seventeen-account run this came from: throughput fell from
# 0.32 to 0.02 videos a second, and the accounts that started LAST hit their
# first render failure within ten lines of output while the ones that started
# first got through thirty. That is starvation, not bad links.
import contextlib
import io as _io


def say(n, window=1):
    """Report n failures in a row and return everything printed."""
    like._render_streak = 0
    like._render_diagnosed = False
    buf = _io.StringIO()
    with contextlib.redirect_stdout(buf):
        for _ in range(n):
            like.render_failed(window)
    return buf.getvalue()


one = say(1, window=9)
check("  one failure still says so", "page did not render, skipping" in one, True)
# One video is a link, not a verdict on the machine. Saying "too many browsers"
# on the first one would be crying wolf on every run.
check("  and blames nothing", "in a row" in one, False)

many = say(3, window=9)
check("  three in a row is diagnosed", "3 videos in a row" in many, True)
check("  naming the real limit", "30 seconds" in many, True)
check("  and the lever that fixes it", "--at-once 4" in many, True)
check("  in the dashboard's words too", "Browsers at once" in many, True)
check("  saying how many are running", "9 accounts going at the same time" in many, True)

# A run drowning in failures must not also drown in explanations of them.
lots = say(30, window=9)
check("  said once, however many follow", lots.count("videos in a row"), 1)

# One account on its own cannot be starved by concurrency, so it must not be
# told it is: that would send somebody to fix a setting that is already right.
alone = say(5, window=1)
# Three is when it fires, so three is what it says however many follow.
check("  a lone account is still diagnosed", "3 videos in a row" in alone, True)
check("  but not blamed for concurrency", "at the same time" in alone, False)

# The streak is consecutive failures, not total ones. A page that renders means
# the machine is keeping up, whatever the last two did.
like._render_streak = 0
like._render_diagnosed = False
buf = _io.StringIO()
with contextlib.redirect_stdout(buf):
    like.render_failed(9)
    like.render_failed(9)
    like.render_ok()
    like.render_failed(9)
    like.render_failed(9)
check("  a render that works breaks the streak", "in a row" in buf.getvalue(), False)

# And the two places a failure is reported both go through it, or the count is
# of half the failures and the diagnosis never fires.
nav_src = Path("like.py").read_text(encoding="utf-8")
check("  both report sites count", nav_src.count("render_failed(args.window_count)"), 2)
check("  and none print the bare line themselves",
      nav_src.count('print("     page did not render, skipping")'), 1)

print("\nand a debugging run says what was on the page instead")
# "page did not render, skipping" is the same sentence for a busy machine, a
# deleted video, a logged-out session and a captcha — four problems with four
# different answers. Measured on a video id that does not exist:
#
#   why_stuck: url=…/video/1234567890123456789, ready=interactive, nodes=348,
#              icon=NO, video=no, rows=0, page says "Video currently unavailable"
#
# which is a diagnosis rather than a symptom.
check("  there is a switch", "--debug" in nav_src, True)
check("  off unless asked", like.DEBUG, False)
check("  it asks the page one question, not eight",
      nav_src.count("PAGE_STATE_JS"), 2)
check("  and reports what it found", "def why_stuck" in nav_src, True)
for want in ("url=", "ready=", "icon=", "rows=", "LOGGED OUT", "CAPTCHA on screen"):
    check(f"  it reports {want.strip('=')}", want in nav_src, True)
# TikTok's own words, when it has any: "Video currently unavailable" ends the
# argument about whose fault a failure was.
check("  including what the page itself says", "page says" in nav_src, True)
# The ledger is where a failure is read the next morning, by which time the
# browser it happened in is long gone.
check("  the diagnosis goes into the ledger too",
      'note = "page did not render in time" + (f" — {why}" if why else "")' in nav_src, True)
check("  which needs room for it", "note[:600 if DEBUG else 120]" in nav_src, True)
# An ordinary run must not pay for any of this: why_stuck() costs a round trip
# to the page, and 2,000 videos of them is a real cost.
check("  and nothing is asked when it is off",
      "why = why_stuck(page) if DEBUG else \"\"" in nav_src, True)
# When did it happen, and how long was the gap? A log without that cannot
# distinguish a 30-second wait from an instant failure.
check("  every line gets a clock", "console.stamp()" in nav_src, True)
check("  the clock only prefixes real lines", "if self._fresh and part.strip():"
      in Path("console.py").read_text(encoding="utf-8"), True)

print("\nan account whose likes are thrown away is named, not retried forever")
# THE CLICK IS NOT THE LIKE. The heart fills in immediately because the page is
# optimistic; the like is confirmed by reading user_digged back afterwards.
# Measured on one video and one comment, six accounts, the same moment:
#
#     k  user3995128760667   product comments 1   liked by it 0
#     m  user7251079252826                    1               0
#     p  Hailu8692                            1               0
#     n  user739216320986                     1               1
#     q  Abel9749                             1               1
#     a  Misgana a                            1               1
#
# k had just pressed that heart and watched it fill. A full reload and a
# cache-busted read both still said user_digged=false, and those three accounts
# have never landed a single like in their whole ledger. A run on one of them
# writes failures for an hour.
check("  a kept like is noticed", "def like_landed" in nav_src, True)
check("  and a discarded one counted", "def clicked_but_not_kept" in nav_src, True)
check("  only when the heart really was pressed",
      'if note.startswith("clicked"):' in nav_src, True)
check("  it says which account to go and look at", "open_profile.py --profile" in nav_src, True)
check("  and that the tool cannot fix it", "Nothing here can change that" in nav_src, True)


def discard(n, landed_first=False):
    """n pressed-and-not-kept, and return everything printed."""
    import contextlib
    import io as _io2
    like._clicked_nothing = 0
    like._ever_landed = False
    like._discard_said = False
    if landed_first:
        like.like_landed()
    buf = _io2.StringIO()
    with contextlib.redirect_stdout(buf):
        for _ in range(n):
            like.clicked_but_not_kept("k", "user3995128760667")
    return buf.getvalue()


# One or two is a slow page, not a dead account.
check("  a couple of them says nothing", "hearts pressed" in discard(3), False)
check("  eight is the diagnosis", "8 hearts pressed" in discard(8), True)
check("  named", "profile 'k' (@user3995128760667)" in discard(8), True)
# Said once. A run in this state produces hundreds of them.
check("  said once, however many follow", discard(40).count("hearts pressed"), 1)
# THE ONE THING IT MUST NOT DO: accuse an account that works. A like that lands
# proves the account is fine, whatever happens afterwards.
check("  an account that has ever landed one is never accused",
      "hearts pressed" in discard(40, landed_first=True), False)
# And it is a DECISION, not just a remark: --keep-going means "a bad video is
# not a reason to stop", which is about videos. An account whose every like is
# discarded is not a run having a bad patch, and its browser is one the working
# accounts need — k, m and p wrote 1,154 failure rows between them in one run
# while taking a third of the machine.
like._clicked_nothing = 0; like._ever_landed = False; like._discard_said = False
import contextlib as _cl, io as _io3
with _cl.redirect_stdout(_io3.StringIO()):
    said = [like.clicked_but_not_kept("k", "x") for _ in range(9)]
check("  it does not stop on the first few", any(said[:7]), False)
check("  and stops once it is sure", said[7], True)
check("  every call after that still says stop", said[8], True)
check("  the loop breaks on it", "if dead_account:" in nav_src, True)
check("  even under --keep-going",
      re.search(r"dead_account = True[\s\S]{0,400}?break", nav_src) is not None, True)
check("  and says the browser is needed elsewhere",
      "the working accounts need" in nav_src, True)

print("\nand a slow home page does not kill a worker")
# Unguarded, one line ended a whole profile's run:
#   playwright._impl._errors.TimeoutError: Page.goto: Timeout 30000ms exceeded.
#   navigating to "https://www.tiktok.com/"
# Thirty seconds is ordinary with several browsers on one machine — the same
# slowness that makes videos miss their render deadline, where the cost is one
# video rather than the whole list.
check("  the first navigation is guarded",
      re.search(r"for attempt in range\(3\):[\s\S]{0,400}?page\.goto\(\"https://www\.tiktok\.com/\"",
                nav_src) is not None, True)
check("  with a longer deadline than the default", "timeout=45000" in nav_src, True)
check("  it says so rather than dying silently", "the home page did not load" in nav_src, True)
check("  and blames the machine after three tries",
      "this is the machine rather than the site" in nav_src, True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
