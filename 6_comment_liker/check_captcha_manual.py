"""When a captcha appears, does the alarm go off — and is the API left alone?

The point of the change is that nobody waits in silence. Two things have to hold
and neither is visible from the outside:

  * the notification and the sound fire the MOMENT the wait starts, not after a
    round of API attempts;
  * with --solve-captcha off, the solving API is never called at all — not even
    once "just to check".

Nothing here opens a browser or touches the network: the page and the notifier
are stood in for, so what is being measured is the ORDER of events.

    python check_captcha_manual.py
"""
import sys
import time

import like
import notify

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


events = []


class FakePage:
    """A page whose captcha clears after two polls."""

    def __init__(self, clears_after=2):
        self.polls = 0
        self.clears_after = clears_after

    def wait_for_timeout(self, ms):
        self.polls += 1
        events.append(f"poll{self.polls}")


def fake_present(page):
    return page.polls < page.clears_after


# Stand in for the notifier and the solving API.
real = {
    "toast": notify.toast, "sound": notify.sound, "alert": notify.alert,
    "present": like.captcha_present, "solve": like.solve_captcha_here,
}
notify.toast = lambda t, b: events.append("toast") or True
notify.sound = lambda times=3: events.append("sound")
notify.alert = lambda t, b, times=3: (events.append("toast"), events.append("sound"))
like.captcha_present = fake_present
like.solve_captcha_here = lambda page, verbose=True: events.append("API CALLED") or False

try:
    print("a captcha appears, headed:")
    events.clear()
    page = FakePage(clears_after=2)
    got = like.wait_out_captcha(page, "e", headed=True, timeout_s=30)
    check("it waits and reports the solve", got, True)
    check("the API was never called", "API CALLED" in events, False)
    # The alarm must come BEFORE any waiting, or the person is told last.
    check("the toast is the first thing that happens", events[0], "toast")
    check("the sound comes before the first poll",
          events.index("sound") < events.index("poll1"), True)
    print(f"      order: {' -> '.join(events)}")

    print("\nnobody solves it:")
    events.clear()
    page = FakePage(clears_after=999)
    got = like.wait_out_captcha(page, "e", headed=True, timeout_s=6)
    check("it gives up rather than hanging the run", got, False)
    check("still no API call", "API CALLED" in events, False)
    check("it alerted before giving up", events[0], "toast")

    # The message must not blame a service that was never asked.
    import io as _io, contextlib
    buf = _io.StringIO()
    with contextlib.redirect_stdout(buf):
        like.wait_out_captcha(FakePage(clears_after=1), "e", headed=True, timeout_s=3)
    check("it does not claim the service failed when it was not tried",
          "solving service" in buf.getvalue(), False)
    buf = _io.StringIO()
    with contextlib.redirect_stdout(buf):
        like.wait_out_captcha(FakePage(clears_after=1), "e", headed=True, timeout_s=3,
                              tried_api=True)
    check("it does say so when it was tried", "solving service" in buf.getvalue(), True)

    print("\nheadless, where there is nobody to ask:")
    events.clear()
    got = like.wait_out_captcha(None, "e", headed=False)
    check("it does not pretend someone can solve it", got, False)
    check("but it still raises the alarm", events, ["toast", "sound"])

    print("\nthe flag itself:")
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--solve-captcha", action="store_true")
    check("solving is OFF unless asked for", ap.parse_args([]).solve_captcha, False)
    check("--solve-captcha turns it on", ap.parse_args(["--solve-captcha"]).solve_captcha, True)
    # The old flag must be gone, not silently ignored.
    src = open("like.py", encoding="utf-8").read()
    check("the old --no-solve-captcha flag is gone", "no-solve-captcha" in src, False)
    check("the API is only ever called behind the flag",
          src.count("solve_captcha_here(page)"), 2)
    check("and both of those sites are guarded", src.count("if args.solve_captcha:"), 2)
finally:
    notify.toast, notify.sound, notify.alert = real["toast"], real["sound"], real["alert"]
    like.captcha_present, like.solve_captcha_here = real["present"], real["solve"]

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
