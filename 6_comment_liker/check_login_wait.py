"""Signing in waits for the person, not for a stopwatch.

login.py used to give up after five minutes:

    Log in to tiktok in the window that opened. Waiting...
      …still waiting (300s)
    Timed out waiting for sign-in.

Five minutes was a guess at how long it takes to type a password, read a code
off a phone and clear whatever captcha the site decides to show. When the guess
was wrong the window closed mid-sign-in and the whole thing had to be started
again — strictly worse than waiting, and nothing is consumed by waiting: the
script sits on one page and probes it every three seconds.

So there is no deadline by default. Which makes two other endings matter, because
they are now the only ones:

  * CLOSING THE WINDOW. With no timeout this is how somebody abandons a sign-in,
    and it must read as an abandoned sign-in rather than a traceback.
  * CTRL+C. Same, and the profile directory has to be left as it was rather than
    half-written by a context torn down mid-flight.

    python check_login_wait.py
"""
import re
import sys
from pathlib import Path

import login

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


src = Path("login.py").read_text(encoding="utf-8")

print("there is no deadline unless one is asked for")
# argparse is the source of truth for the default, so read it from argparse.
import argparse  # noqa: E402
import io  # noqa: E402
from contextlib import redirect_stdout  # noqa: E402

help_text = io.StringIO()
try:
    with redirect_stdout(help_text):
        login.main.__globals__  # touch it so a missing main fails loudly here
        sys.argv = ["login.py", "--help"]
        try:
            login.main()
        except SystemExit:
            pass
finally:
    sys.argv = ["check_login_wait.py"]
text = help_text.getvalue()
check("  --timeout still exists", "--timeout" in text, True)
check("  0 means wait indefinitely", "0 = wait indefinitely" in text, True)
check("  and that is the default", re.search(r"default[:=]?\s*0", src) is not None, True)
check("  argparse's own default is 0", 'ap.add_argument("--timeout", type=int, default=0' in src, True)
# The loop has to actually honour it, not just advertise it.
check("  the loop runs forever at 0", "while args.timeout <= 0 or waited < args.timeout:" in src, True)
check("  and the reason is written down", "Five minutes was a guess" in src, True)

print("\nthe two ways it can now end")
# A closed window is the normal abandonment now, so it must not look like a bug.
closed = len(re.findall(r"The browser window was closed\. Nothing was saved", src))
check("  a closed window is reported, twice over", closed, 2)
check("  once for the wait", re.search(r"page\.wait_for_timeout\(3000\)\s*\n\s*except Exception", src) is not None, True)
check("  and once for the probe", re.search(r"ok, who = probe\(page\)\s*\n\s*except Exception", src) is not None, True)
check("  Ctrl+C is caught", "except KeyboardInterrupt:" in src, True)
check("  and says nothing was saved", "Given up on. Nothing was saved." in src, True)
# Tearing the context down mid-flight is what leaves a half-written profile, so
# the interrupt path closes it deliberately.
check("  closing the context deliberately on the way out",
      re.search(r"except KeyboardInterrupt:[\s\S]{0,400}?ctx\.close\(\)", src) is not None, True)
# A traceback must never be the thing a person sees here.
check("  neither ending raises", "raise" not in src.split("print(f\"Log in to")[1], True)

print("\nthe waiting says how long it has been waiting")
# Bare seconds stop being legible around four minutes, which is exactly when
# somebody starts wondering whether it has hung.
check("  seconds under a minute", login.elapsed(45), "45s")
check("  the boundary", login.elapsed(60), "1m 00s")
check("  minutes and seconds", login.elapsed(192), "3m 12s")
check("  padded, so it does not jump about", login.elapsed(65), "1m 05s")
check("  hours, for a sign-in left open", login.elapsed(3864), "1h 04m")
check("  zero reads sensibly", login.elapsed(0), "0s")
check("  and the loop prints it", "elapsed(waited)" in src, True)

print("\na deadline still works if one is given")
check("  the loop stops at it", "waited < args.timeout" in src, True)
check("  and says so in its own words", 'Gave up after {args.timeout}s.' in src, True)
check("  the opening line names the limit", "Waiting up to {args.timeout}s" in src, True)
check("  and says it is unbounded otherwise",
      "Waiting for as long as it takes" in src, True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
