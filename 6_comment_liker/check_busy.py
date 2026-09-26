"""A profile another browser has open cannot be read, and must not be judged.

This was found while trying to explain why the dashboard showed the wrong
TikTok account for several profiles. The proof is one line:

    PermissionError: [WinError 32] The process cannot access the file because
    it is being used by another process
        profile-a/Default/Network/Cookies

Chromium holds the cookie database for as long as it has the profile. A SECOND
browser on the same directory does not fail — it starts, renders TikTok, and
reports the account as signed out, because it read no cookies. Measured on
profile a, at a moment when a run was working that very profile and printing
"signed in as Misgana a":

    python login.py --profile a --check    ->  NOT signed in (error)
    python like.py --profile a             ->  Not signed in on profile 'a'

Every consumer of that answer then does the wrong thing: sessions.py writes the
profile onto its #not-signed-in line, the dashboard shows a stale or wrong
account, and a run stops on an account that was working.

So the question is asked before the browser is opened, of the machine rather
than of the profile: which user data directories do the running browsers say
they were started with. That also catches a run started in another terminal,
which the dashboard's own bookkeeping cannot.

    python check_busy.py
"""
import re
import sys
import tempfile
from pathlib import Path

import busy

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


src = {f: Path(f).read_text(encoding="utf-8")
       for f in ("busy.py", "like.py", "login.py", "sessions.py", "open_profile.py")}

print("one spelling of a directory")
tmp = Path(tempfile.mkdtemp())
# The same directory arrives as a Path from one caller and as a string from a
# command line in another, with different capitalisation and slashes. Compared
# raw, a held profile would look free.
check("  a Path and its string agree", busy._key(tmp), busy._key(str(tmp)))
check("  a trailing slash does not matter", busy._key(str(tmp) + "\\"), busy._key(tmp))
check("  nor does case on Windows",
      busy._key(str(tmp).upper()) == busy._key(str(tmp)), sys.platform.startswith("win"))
check("  a relative path is resolved", busy._key(Path(".")), busy._key(Path.cwd()))

print("\nasking the machine what is open")
held = busy.dirs_in_use(force=True)
check("  the answer is a set of directories", isinstance(held, set), True)
check("  every entry is in one spelling", [d for d in held if d != busy._key(d)], [])
# Whatever is running right now, a directory that certainly is not a browser
# profile must not be in it.
check("  a directory nobody opened is free", busy.is_busy(tmp), False)
# The cache exists because a scan asks about twenty profiles in a row and the
# browsers do not come and go between them.
check("  the answer is cached briefly", busy.CACHE_S > 0, True)
check("  and can be forced", busy.dirs_in_use(force=True) is not None, True)
# Not being able to ask must never stop a run: an empty answer is "nothing
# found", which is what the code did before this existed.
check("  a failure answers 'nothing found'", "except Exception:  # noqa: BLE001\n            pass"
      in src["busy.py"], True)

print("\nand the answer reaches every place that used to guess")
# like.py stopped runs on working accounts. This is the worst of the four: it
# cost the rest of that profile's list.
check("  a run refuses to open a held profile", "if busy.is_busy(pdir):" in src["like.py"], True)
check("  saying it is not a session problem",
      "says nothing about" in src["busy.py"], True)
# login.py --check said NOT signed in. Exit 2, like the throttled case: a
# caller that treats non-zero as "log this account in again" must not.
check("  --check says IN USE instead", "IN USE — cannot check" in src["login.py"], True)
check("  with its own exit code",
      re.search(r"IN USE[\s\S]{0,300}?return 2", src["login.py"]) is not None, True)
# sessions.py already had an in-use state, but only from a launch error — which
# never came, because the launch succeeded.
check("  a scan checks before it launches",
      re.search(r'if busy\.is_busy\(pdir\)[\s\S]{0,200}?Result\(name, "in-use"',
                src["sessions.py"]) is not None, True)
check("  and the profile keeps what was already known about it",
      'if r.state in ("refused", "in-use") and name in previous' in src["sessions.py"], True)
check("  opening one by hand says so too",
      "ALREADY OPEN in another browser" in src["open_profile.py"], True)

print("\nthe dashboard stops trusting a scan it cannot date")
dash = Path("dashboard.py").read_text(encoding="utf-8")
html = Path("dashboard.html").read_text(encoding="utf-8")
# A run says who it is from inside the browser that holds the session. That
# cannot be stale, so it wins over the file.
check("  a run's own words are recorded", "def note_account" in dash, True)
check("  and outrank the session file",
      'SEEN_ACCOUNT.get(job_key(n, platform)) or accounts.get(n, "")' in dash, True)
# run_parallel prefixes each child's line with the profile, so one pattern has
# to read both shapes.
check("  a collection run's prefix is understood", "(?P<from>" in dash, True)
check("  the page says where the name came from", "p.said" in html, True)


class _Job:
    # A job is named "profile@platform": the same letter can be working TikTok
    # and Instagram at once, from two directories, and they are two jobs.
    def __init__(self, name, kind="like"):
        self.name, self.kind = name, kind


import dashboard as dash_mod  # noqa: E402

dash_mod.SEEN_ACCOUNT.clear()
dash_mod.note_account(_Job("a@tiktok"),
                      "signed in as Misgana a \u00b7 using 32 param(s) from capture.json")
check("  an independent run names its own profile",
      dash_mod.SEEN_ACCOUNT.get("a@tiktok"), "Misgana a")
dash_mod.note_account(_Job("collection@tiktok", "parallel"),
                      "[k         ] signed in as user3995128760667 \u00b7 using 32 param(s)")
check("  a collection run names the right one",
      dash_mod.SEEN_ACCOUNT.get("k@tiktok"), "user3995128760667")
# The same profile on another platform is another account, and must not be
# overwritten by this one.
dash_mod.note_account(_Job("a@instagram", "web"), "signed in as someone_else")
check("  and the same letter elsewhere is kept apart",
      (dash_mod.SEEN_ACCOUNT.get("a@tiktok"), dash_mod.SEEN_ACCOUNT.get("a@instagram")),
      ("Misgana a", "someone_else"))
# "unknown — TikTok would not say" is like.py admitting it does not know. It is
# not a name, and must not be shown as one.
dash_mod.note_account(_Job("q@tiktok"),
                      "signed in as unknown — TikTok would not say, but the page is signed in")
check("  an admission of not knowing is not a name",
      "q@tiktok" in dash_mod.SEEN_ACCOUNT, False)

print("\nand how far down its list a profile has got")
# Most of a run is videos that are already done: like.py writes nothing for
# those, so a working profile's likes-this-run can sit at zero for ten minutes.
# Without this, that reads as idle — or as failing, if its one new row was a
# failure.
dash_mod.SEEN_AT.clear()
dash_mod.note_progress(_Job("a@tiktok"),
                       "  [43/1368] 7681832692882640135: 1 match, all done already")
check("  an independent run's position", dash_mod.SEEN_AT.get("a@tiktok"), (43, 1368))
dash_mod.note_progress(_Job("collection@tiktok", "parallel"),
                       "[k         ]   [7/1368] 768: 3 match, 3 to like")
check("  and a collection's, per profile", dash_mod.SEEN_AT.get("k@tiktok"), (7, 1368))
check("  the page shows it", "${lv.seen}/${lv.total}" in html, True)
check("  explaining why the likes can sit still",
      "most are already done and" in html, True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
