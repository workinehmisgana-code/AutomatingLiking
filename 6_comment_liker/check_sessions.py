"""Does the session list say what it means?

sessions.py opens every profile on disk, asks the site who it is, and writes the
signed-in ones to a file. Three ways that can quietly be wrong, and each one is
worse than having no file at all:

  1. FINDING THE WRONG PROFILES. The three prefixes nest — "profile",
     "profile-ig", "profile-yt" — so every Instagram directory also matches
     TikTok's prefix. Matched naively, `profile-ig-b` is reported as a TikTok
     profile named "ig-b"; excluded naively, every Instagram directory
     disappears, because "profile-" is a prefix of them too. Both directions
     are wrong in one direction each.

  2. CALLING A BUSY PROFILE A DEAD ONE. Chromium locks a user data directory
     while it holds it, so a profile being worked by a running liker cannot be
     opened. Reported as "signed out" it would send somebody to re-login nine
     perfectly good accounts mid-run.

  3. REPORTING THE SITE'S OWN JARGON AS A FAULT. TikTok's passport endpoint
     answers {"message": "error"} to anyone who is not logged in, so its word
     for "signed out" is "error" — printed as a reason it reads as a broken
     check.

    python check_sessions.py
"""
import sys
import tempfile
from pathlib import Path

import sessions

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


print("which directory belongs to which site")
check("  the bare one is tiktok's default", sessions.site_of_dir("profile"), ("tiktok", "profile"))
check("  a named tiktok profile", sessions.site_of_dir("profile-a"), ("tiktok", "profile"))
# The nesting. profile-ig-b matches "profile" too, and longest match is what
# stops it being read as a TikTok profile called "ig-b".
check("  an instagram profile is instagram's",
      sessions.site_of_dir("profile-ig-b"), ("instagram", "profile-ig"))
check("  instagram's default", sessions.site_of_dir("profile-ig"), ("instagram", "profile-ig"))
check("  a youtube profile", sessions.site_of_dir("profile-yt-q"), ("youtube", "profile-yt"))
check("  something else entirely", sessions.site_of_dir("shards"), (None, ""))
# A profile whose NAME starts with ig- is still a TikTok profile: profile-igloo
# is "igloo" on TikTok, not Instagram, because "profile-ig" is not a prefix of
# it followed by a separator.
check("  a tiktok profile whose name merely starts with ig",
      sessions.site_of_dir("profile-igloo"), ("tiktok", "profile"))

print("\ndiscovery finds each site's own, and only its own")
tmp = Path(tempfile.mkdtemp(prefix="sess-"))
for d in ("profile", "profile-a", "profile-3", "profile-igloo",
          "profile-ig", "profile-ig-b", "profile-yt-q", "shards", "logs"):
    (tmp / d / "Default").mkdir(parents=True)
(tmp / "notes.txt").write_text("", encoding="utf-8")
real_here = sessions.HERE
sessions.HERE = tmp
try:
    tt = sessions.discover("tiktok")
    ig = sessions.discover("instagram")
    yt = sessions.discover("youtube")
finally:
    sessions.HERE = real_here
check("  tiktok", tt, ["default", "3", "a", "igloo"])
check("  instagram", ig, ["default", "b"])
check("  youtube", yt, ["q"])
# "default" first is the order a person would write them in themselves.
check("  default leads", tt[0], "default")
check("  and a stray file is not a profile", "notes" in tt, False)

print("\nthe file that comes out")
R = sessions.Result
rows = [
    R("a", "in", account="Misgana a"),
    R("b", "in", account="someone"),
    R("c", "out", detail="error"),
    R("d", "in-use", detail="open in another process"),
    R("e", "no-session", detail="no browser has ever run in this directory"),
]
out = tmp / "sessions-tiktok.txt"
sessions.write_file(out, "tiktok", rows)
body = out.read_text(encoding="utf-8")
print(body.rstrip())
lines = [l for l in body.splitlines() if l.strip() and not l.startswith("#")]
check("  only the signed-in ones are listed", [l.split()[0] for l in lines], ["a", "b"])
# First token is the profile name, everything after # is for the reader — the
# same shape as the other list files here, so `cut -d' ' -f1` works.
check("  the account is a comment, not a column", lines[0].split("#")[1].strip(), "@Misgana a")
check("  the counts are in the header", "2 signed in of 5 checked" in body, True)
check("  including the ones that were busy", "1 in use by a running liker" in body, True)
check("  and the ones that were not signed in", "1 signed out" in body, True)
check("  and the ones never logged in", "1 never logged in" in body, True)
# The one conclusion a reader must not draw from this file.
check("  a busy profile is named, and not as a failure",
      "IN USE, so not checked" in body and "almost certainly fine" in body, True)
check("  the busy ones are named", "#   d" in body, True)
check("  and there is a line to paste", "#   --profiles a,b" in body, True)

print("\nnothing signed in at all still writes a usable file")
empty = tmp / "none.txt"
sessions.write_file(empty, "tiktok", [R("z", "out", detail="error")])
eb = empty.read_text(encoding="utf-8")
check("  it says none", "# (none)" in eb, True)
check("  with no --profiles line to paste by mistake", "--profiles" in eb, False)
check("  and still has a header", eb.startswith("# tiktok profiles"), True)

print("\na busy profile is never called signed out")
src = Path("sessions.py").read_text(encoding="utf-8")
check("  the lock is recognised", "IN_USE_MARKERS" in src, True)
for marker in ("processsingleton", "already in use", "singletonlock"):
    check(f"  by '{marker}'", marker in src, True)
check("  it is its own state, not 'out'", '"in-use"' in src, True)
# And the terminal says what to do about it, because the person reading it is
# usually mid-run and about to draw the wrong conclusion.
check("  the terminal explains it", "Being in use says nothing about whether they are signed in" in src, True)

print("\nthe site's own jargon is not reported as a fault")
check("  'error' is dropped", sessions.reason("error"), "")
check("  so is an empty reason", sessions.reason(""), "")
check("  and 'success'", sessions.reason("success"), "")
check("  but a real one survives", sessions.reason("HTTP 429"), "HTTP 429")

print("\nit only reads")
# A profile directory is a signed-in browser. Opening one to look at it must not
# be able to change it.
check("  every profile is opened headless", "headless=True," in src, True)
check("  and closed again", "ctx.close()" in src, True)
check("  the probes are login.py's own, not a second opinion",
      "from login import" in src and "signed_in," in src, True)
check("  a directory with no Default is not opened at all",
      'if not (pdir / "Default").exists():' in src, True)
# Interrupting must not throw the answers away.
check("  stopping early still writes what was learned",
      "Stopped early — writing what was checked so far." in src, True)

print("\n\"signed out\" and \"nobody has looked\" are different answers")
# The file listed only the profiles that PASSED, so a profile missing from it
# could be either — and a profile created after the last scan was being reported
# as one with a dead session. Those need different buttons pressed.
tri = tmp / "tri.txt"
sessions.write_file(tri, "tiktok", [
    R("a", "in", account="aa"),
    R("b", "out"),
    R("c", "no-session"),
    R("d", "in-use"),
])
body3 = tri.read_text(encoding="utf-8")
check("  the ones that failed are recorded", "#not-signed-in b,c" in body3, True)
check("  under a heading a person can read", "CHECKED AND NOT SIGNED IN" in body3, True)
# read_file is unchanged: it still answers "who is signed in", which is what
# everything downstream asks it.
check("  the signed-in list is unchanged", sessions.read_file(tri), {"a": "aa"})
op = sessions.read_checked(tri)
check("  but the file now has an opinion about the failures", sorted(op), ["a", "b", "c"])
# A busy profile was NOT checked, so the file must not claim to know about it.
check("  and none about a busy one", "d" in op, False)
check("  nor about one it never saw", "zzz" in op, False)
# An older file, written before failures were recorded, has no such line at
# all. It still reads — it just has opinions only about the ones that passed.
old_style = tmp / "old.txt"
old_style.write_text(
    "# a header\n#\nx  # @xx\ny  # @yy\n",
    encoding="utf-8")
check("  a file written before this still reads",
      sorted(sessions.read_checked(old_style)), ["x", "y"])
check("  and a missing file has no opinions", sessions.read_checked(tmp / "nope.txt"), set())

print("\nchecking some of them does not delete the rest")
# `sessions.py --profiles l` writes the same file a full scan does. Without a
# merge it would write a file containing only `l`, throwing away fifteen
# profiles that were never in question.
whole = tmp / "merge.txt"
sessions.write_file(whole, "tiktok", [
    R("a", "in", account="aa"), R("b", "in", account="bb"), R("c", "in", account="cc"),
])
back = sessions.read_file(whole)
check("  the file reads back", back, {"a": "aa", "b": "bb", "c": "cc"})
check("  comments are not data", "#" in "".join(back), False)
# Re-checking b alone: a and c are carried over, b gets a fresh answer.
merged = [
    R(n, "in", account=acc, carried=True) for n, acc in back.items() if n != "b"
] + [R("b", "in", account="bb2")]
sessions.write_file(whole, "tiktok", merged)
again = sessions.read_file(whole)
check("  the others survive", sorted(again), ["a", "b", "c"])
check("  and the re-checked one is updated", again["b"], "bb2")
# A carried row is a weaker claim than a fresh one, and says so.
body2 = whole.read_text(encoding="utf-8")
check("  carried rows are marked", body2.count("(not re-checked)"), 2)
check("  and counted in the header", "2 carried over from an earlier run" in body2, True)
check("  and the header says which run this was",
      "3 listed. 1 checked just now; 2 carried over" in body2, True)
check("  a missing file merges to nothing", sessions.read_file(tmp / "nope.txt"), {})
# Checking l must not make the file forget that o was looked at and found
# signed out, or o would go back to reading "not checked yet" for ever.
src2 = Path("sessions.py").read_text(encoding="utf-8")
check("  the failures are carried over as well as the passes",
      "previously_checked = read_checked(out_path)" in src2, True)
check("  as rows the next write puts back",
      'Result(name, "out", carried=True)' in src2, True)

print("\none ordering, not two")
# The file and the --profiles line printed at the end must agree, or somebody
# pastes a list that does not match the file beside it.
order = [r.profile for r in sessions.live_profiles(
    [R("b", "in"), R("default", "in"), R("a", "in", carried=True), R("z", "out")])]
check("  default first, then alphabetical", order, ["default", "a", "b"])
check("  signed-out ones are not in it", "z" in order, False)
check("  the file uses it", "live = live_profiles(results)" in src, True)
check("  and so does the terminal", src.count("live_profiles(results)"), 2)

print("\nopening a profile by hand")
op = Path("open_profile.py").read_text(encoding="utf-8")
# Same lock detection as the scanner: opening a directory a liker is using is
# how a profile gets corrupted, and it must say so rather than throw.
check("  it reuses the scanner's lock detection", "from sessions import IN_USE_MARKERS" in op, True)
check("  and explains what to do", "Stop that run first" in op, True)
# Headed, resizable, and with the SAME user agent and flags the liker uses:
# opening the same directory with a different fingerprint is the one thing
# these profiles exist to avoid.
check("  the window is visible", "headless=False," in op, True)
check("  and resizable, not a fixed viewport", "viewport=None," in op, True)
check("  the user agent is login.py's", "user_agent=UA," in op, True)
check("  and so are the flags", '"--disable-blink-features=AutomationControlled"' in op, True)
# The point of the tool: confirm what changed rather than assume it.
check("  it says who it opened as", "signed in as @{who}" in op, True)
check("  and who it closed as", "ACCOUNT CHANGED" in op, True)
check("  noticing a fresh sign-in", "NOW SIGNED IN as" in op, True)
check("  and a lost one", "NO LONGER SIGNED IN" in op, True)
# Closed once, deliberately: a context torn down mid-write leaves a
# half-written user data directory.
check("  the context is closed deliberately", op.count("ctx.close()"), 1)
check("  Ctrl+C is caught", "except KeyboardInterrupt:" in op, True)
check("  and the session list is flagged as now stale",
      "Refresh the session list with" in op, True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
