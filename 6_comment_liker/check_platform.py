"""Four platforms, three profile directories, two scripts — one dashboard.

    TikTok           like.py       profile-x
    Instagram        like_web.py   profile-ig-x
    YouTube Shorts   like_web.py   profile-yt-x
    YouTube videos   like_web.py   profile-yt-x

A platform decides three things at once, and conflating any two of them breaks
something quietly:

  THE LINKS    the dashboard feed labels every link with one of those four, and
               shorts are not videos — different pages, different comment
               sections. One site, two platforms.
  THE SCRIPT   TikTok has its own liker. The rest go through like_web.py, which
               accepts a different set of flags; a table that offers it one of
               like.py's would produce a run that dies on an unrecognised
               argument.
  THE PROFILE  one Chrome user data directory per SITE, which is the whole
               reason the same letter can work every platform at the same time:
               profile-a, profile-ig-a and profile-yt-a are three directories
               and three browsers. Only two runs over ONE directory collide,
               and YouTube's two platforms share one — so they do.

    python check_platform.py
"""
import re
import subprocess
import sys
from pathlib import Path

import dashboard as dash
import dashboard_settings as ds
from login import profile_dir

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


print("the four the feed actually has")
# These are the dashboard's own platform values (3_dashboard lib/config.ts:
# CLICK_PLATFORMS), not names invented here — the --platform filter is passed
# straight through to the feed.
check("  exactly four", sorted(ds.PLATFORMS),
      ["instagram", "tiktok", "youtube_shorts", "youtube_videos"])
check("  tiktok is its own script", ds.script_of("tiktok"), "like.py")
for p in ("instagram", "youtube_shorts", "youtube_videos"):
    check(f"  {p} goes to the web liker", ds.script_of(p), "like_web.py")
# One site, two platforms: the difference is which links, nothing else.
check("  shorts and videos are one site",
      (ds.site_of("youtube_shorts"), ds.site_of("youtube_videos")), ("youtube", "youtube"))
check("  instagram is its own", ds.site_of("instagram"), "instagram")
# Anything unrecognised is TikTok rather than a crash: this value comes out of a
# settings file that a person can edit.
check("  nonsense falls back to tiktok", ds.platform_of({"platform": "twitter"}), "tiktok")
check("  and so does nothing at all", ds.platform_of({}), "tiktok")

print("\nthree directories, which is why they can run together")
check("  tiktok", profile_dir("a", "tiktok").name, "profile-a")
check("  instagram", profile_dir("a", "instagram").name, "profile-ig-a")
check("  youtube", profile_dir("a", "youtube").name, "profile-yt-a")
check("  all different",
      len({profile_dir("a", s).name for s in ("tiktok", "instagram", "youtube")}), 3)

print("\nevery flag a web run sends is one like_web.py accepts")
out = subprocess.run([sys.executable, "like_web.py", "--help"],
                     capture_output=True, text=True).stdout
allowed = set(re.findall(r"(--[a-z0-9][a-z0-9-]*)", out))
check("  like_web answered --help", len(allowed) > 10, True)
for p in ("instagram", "youtube_shorts", "youtube_videos"):
    cmd = ds.web_command("py", "like_web.py", "a", dict(ds.defaults(), platform=p))
    check(f"  {p}", [a for a in cmd if a.startswith("--") and a not in allowed], [])
# --site is the profile family; --platform is the feed filter. For YouTube they
# differ, and swapping them would send shorts work to a videos list.
cmd = ds.web_command("py", "like_web.py", "a", dict(ds.defaults(), platform="youtube_shorts"))
check("  --site is the login family", cmd[cmd.index("--site") + 1], "youtube")
check("  --platform is the feed filter", cmd[cmd.index("--platform") + 1], "youtube_shorts")
# like.py keeps its own flags, unchanged.
tt = ds.like_command("py", "like.py", "a", dict(ds.defaults(), platform="tiktok"))
check("  tiktok still tiles its windows", "--window-slot" in tt, True)
check("  and the web liker is not given flags it lacks", "--window-slot" in cmd, False)

print("\na job is a profile ON A PLATFORM")
check("  keyed together", dash.job_key("a", "instagram"), "a@instagram")
check("  and read back", dash.job_parts("a@instagram"), ("a", "instagram"))
# An old key from a run started before platforms existed is TikTok's.
check("  a bare name is tiktok's", dash.job_parts("a"), ("a", "tiktok"))
check("  so the same letter is two jobs",
      dash.job_key("a", "tiktok") != dash.job_key("a", "instagram"), True)

print("\nand the ledgers stay apart, exactly as the liker names them")
import like_web as lw  # noqa: E402

for site, plat in (("instagram", "instagram"), ("youtube", "youtube_shorts"),
                   ("youtube", "youtube_videos")):
    for prof in ("a", "default"):
        check(f"  {plat} / {prof}", dash.ledger_file(prof, plat).name,
              lw.ledger_path(site, prof).name)
check("  tiktok's is done-a.csv", dash.ledger_file("a", "tiktok").name, "done-a.csv")
# The names NEST — done-a, done-ig-a, done-yt-a — so a plain done*.csv glob reads
# "ig-a" as a TikTok profile called ig-a and misses every real one.
counts = dash.ledger_counts("tiktok")
check("  a tiktok scan does not pick up ig/yt ledgers",
      [n for n in counts if n.startswith(("ig-", "yt-"))], [])

print("\nrunning together is refused only where it really collides")
# What a run holds is a DIRECTORY. Profile a on TikTok and profile a on
# Instagram are two of them; shorts and videos are one.
src = Path("dashboard.py").read_text(encoding="utf-8")
check("  holdings are keyed by profile and site", 'held[f"{name}@{site}"] = key' in src, True)
check("  site, not platform, so shorts and videos still clash",
      "site = ds.site_of(platform)" in src, True)
# And a run somebody started in another terminal holds it just as firmly.
check("  a browser opened elsewhere blocks it too",
      "busy.is_busy(profile_dir(n, site))" in src, True)

print("\nwhat has no collection mode says so")
# run_parallel.py starts like.py children. There is no equivalent for the web
# liker, and pretending otherwise would start a run that cannot work.
check("  refused before anything starts",
      "has no collection mode" in src, True)
html = Path("dashboard.html").read_text(encoding="utf-8")
check("  and the page says it before you press Start",
      "has no collection mode" in html, True)

print("\nthe tools follow the platform, because they open browsers too")
check("  a scan scans that site", dash.TOOLS["sessions"]("", "instagram")[1][-1], "instagram")
check("  signing in signs into that site",
      "--site" in dash.TOOLS["login"]("a", "youtube")[1], True)
check("  opening one by hand too",
      dash.TOOLS["open"]("a", "", "instagram")[1][dash.TOOLS["open"]("a", "", "instagram")[1]
                                                  .index("--site") + 1], "instagram")
# The TikTok-only ones are refused rather than run against a site they cannot
# read: verify.py reads TikTok's API, solve_captcha is TikTok's puzzle.
# "comments" joined them: checking a posted comment reads TikTok's own comment
# list, which is no more portable to Instagram than verify.py is. So did
# "commented" -- the list of links we commented on comes from the TikTok ledger.
check("  and TikTok's own tools are not offered elsewhere",
      sorted(dash.TIKTOK_ONLY), ["captcha", "commented", "comments", "emails", "verify", "why"])
check("  refused with a reason", "only works on TikTok" in src, True)

print("\nthe page switches everything, not just a label")
check("  there is a selector", 'id="platform"' in html, True)
check("  saving it keeps the other settings",
      "...(S.shared || {}), platform: value" in html, True)
# Switching platform must clear the selection: a set of profiles chosen for
# TikTok is not a set of profiles to run on Instagram, and some of them may
# never have been signed in there at all.
check("  the selection is cleared", re.search(r"setPlatform[\s\S]{0,800}?SEL = new Set\(\)",
                                              html) is not None, True)
check("  jobs are looked up per platform", "S.jobs[jobKey(p.name)]" in html, True)
check("  and stopping one stops the right one", "stopOne('${jobKey(p.name)}')" in html, True)
check("  the state carries the platform", '"platform": platform' in src, True)
# A new profile belongs to the site you are looking at: "a" on Instagram is
# profile-ig-a, and creating TikTok's instead leaves somebody signing in to a
# browser the run will never open.
check("  a new profile is made for this site", "name: n, site: S.site" in html, True)
# A platform nobody has signed in to yet has no profiles, and an empty table
# reads as a broken page rather than as work to do.
check("  an empty list explains itself", "profiles yet" in html, True)
check("  saying these are separate browsers",
      "does not sign you in here" in html, True)

print("\nthe TikTok roster is offered on every platform")
# Seventeen accounts were set up on TikTok as a, b, c…, and the Instagram and
# YouTube work is the same people's other accounts. Listing only the
# directories that exist meant Instagram opened empty with nothing to press,
# and every name would have had to be typed in again — twice, once per site,
# matched by hand.
import shutil as _shutil

_tt = set(dash.known_profiles("tiktok"))
for _site in ("instagram", "youtube"):
    _offered = set(dash.profiles_for(_site))
    check(f"  every tiktok name is offered on {_site}", sorted(_tt - _offered), [])
check("  and tiktok is unchanged", dash.profiles_for("tiktok"), dash.known_profiles("tiktok"))
# NOTHING IS COPIED. profile-ig-a is a fresh browser: it is a different account,
# and a copied TikTok session would be neither that account nor a clean one.
# So listing the names must not bring any directory into existence.
_absent = [n for n in sorted(_tt) if not profile_dir(n, "instagram").exists()]
check("  there is a name with no instagram browser to test with", bool(_absent), True)
dash.profiles_for("instagram")
check("  listing it created nothing",
      [n for n in _absent if profile_dir(n, "instagram").exists()], [])
src2 = Path("dashboard.py").read_text(encoding="utf-8")
check("  the code says why nothing is copied", "Nothing is copied" in src2, True)
# A name with no browser here is not "signed out": nobody has looked, and there
# is nothing to look at.
check("  the page distinguishes not-set-up from signed-out", "not set up here" in html, True)
check("  and refuses to run one", 'No browser for this name on this platform yet' in html, True)
check("  a name with no directory here is never called checked",
      '"checked": n in checked and n in on_disk' in src2, True)

print("\nand a profile can be deleted")
# THE DIRECTORY IS THE ACCOUNT: deleting it signs that account out on this
# machine and there is no undo, so the guards matter more than the button.
check("  there is one", "def delete_profile" in src2, True)
check("  refused while a browser has it open", "busy.is_busy(pdir)" in src2, True)
check("  and while a run holds it", 'f"{name}@{site}" in held' in src2, True)
check("  a name that is not one is refused", dash.delete_profile("../etc", "tiktok")[0], False)
check("  and one that does not exist", dash.delete_profile("nosuchprofile", "tiktok")[0], False)
# What it must NOT take with it.
check("  the ledger is kept", "is the record of work already done" in src2, True)
check("  and the other sites' browsers", "are untouched" in src2, True)
# The name survives as long as it has a browser somewhere; when it does not,
# keeping its settings is keeping a ghost.
check("  the last one takes the settings with it",
      "That was its last browser" in src2, True)
# The confirmation is typing the name, not dismissing a dialog.
check("  the page asks for the name to be typed",
      "Type the profile name to confirm" in html, True)
check("  and says what cannot be undone", "cannot be undone" in html, True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
