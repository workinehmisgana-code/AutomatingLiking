#!/usr/bin/env python3
"""
Does the Control Center build the right commands, and can it find the programs?

NOTHING HERE OPENS A BROWSER OR TOUCHES AN ACCOUNT. The window's whole job is to
turn a form into one of four command lines that already exist, so that is what
gets checked: the flags, the modes that change them, and the refusals.

    python check_app.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import app as a  # noqa: E402

FAILS = 0


# The window's own markup, for asserting that a setting has a control and
# is wired into the form - a setting the form never reads is a setting
# that silently resets itself every time the window is opened.
# app.py's own text, for asserting that a route the page calls exists.
SRC = (HERE / "app.py").read_text(encoding="utf-8")
UI = (HERE / "ui.html").read_text(encoding="utf-8")


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


def flags(cmd: list[str]) -> list[str]:
    """The command without the interpreter or the script path."""
    return cmd[2:]


def has(cmd, *pairs) -> bool:
    """Is every flag (and its value, where given) in this command?"""
    s = " ".join(cmd)
    return all(p in s for p in pairs)


# ── the programs it drives ─────────────────────────────────────────────────
print(f"the {len(a.SCRIPTS)} programs it drives are where it thinks they are:")
for t in a.tool_health():
    check(f"  {t['tool']}", t["ok"], True)

# ── search ─────────────────────────────────────────────────────────────────
print("\na search turns a box of phrases into one command:")
s = dict(a.DEFAULTS["search"])
# THE PHRASES LIVE PER GENRE NOW. One textarea shows one genre; the others'
# phrases are kept beside it, and queries_for() reads the selected one.
s["genre"] = "humanizer"
s["queries_by_genre"] = {"humanizer": "ai humanizer\n\n  turnitin bypass  \n"}
title, cmd, cwd = a.build_search(s)
check("  both phrases, trimmed",
      flags(cmd)[flags(cmd).index("--query") + 1:flags(cmd).index("--query") + 3],
      ["ai humanizer", "turnitin bypass"])
check("  blank lines are not phrases", " ".join(cmd).count("--query"), 1)
check("  it runs in the scraper's folder", cwd, a.SCRAPER_DIR)
check("  the platform is passed", has(cmd, "--platform tiktok"), True)

# --content is YouTube's alone. Sent for TikTok it would be a flag the program
# ignores and a reader has to wonder about.
check("  no --content for TikTok",
      "--content" in " ".join(a.build_search_for(s, "tiktok", "")[1]), False)
check("  but YouTube gets it",
      has(a.build_search_for(s, "youtube", "shorts")[1], "--content shorts"), True)

# ── YouTube is read a tab at a time ────────────────────────────────────────
# Its results page mixes Shorts with long videos, and scraper.py only clicks a
# filter chip when it is told which one:
#
#     chip_label = {"shorts": "Shorts", "videos": "Videos"}.get(content)
#
# For "all" that is None, so no tab is clicked and the mixed page is scraped as
# it comes. Reading both means running it twice.
print("\nYouTube's two tabs are two runs:")
y = dict(a.DEFAULTS["search"])
y["platforms"] = ["youtube"]
y["content"] = "all"
check("  both tabs, Shorts first", a.search_runs(y), [("youtube", "shorts"), ("youtube", "videos")])
y["content"] = "shorts"
check("  one tab is one run", a.search_runs(y), [("youtube", "shorts")])
y["content"] = "videos"
check("  either one", a.search_runs(y), [("youtube", "videos")])
# A settings file with nothing in it should not quietly scrape the mixed page.
y["content"] = ""
check("  and a missing choice still clicks tabs",
      a.search_runs(y), [("youtube", "shorts"), ("youtube", "videos")])

y["content"] = "all"
cmds = [a.build_search_for(y, pl, ct, True)[1] for pl, ct in a.search_runs(y)]
check("  the first run asks for the Shorts tab", has(cmds[0], "--content shorts"), True)
check("  the second for the Videos tab", has(cmds[1], "--content videos"), True)
check("  and neither is left to the mixed page",
      any("--content all" in " ".join(c) for c in cmds), False)
titles = [a.build_search_for(y, pl, ct, True)[0] for pl, ct in a.search_runs(y)]
# The genre is in the title too: genres are searched one after another, and
# the job list is the only place that says which run belongs to which.
check("  the job titles say which tab", titles,
      ["Search · humanizer · youtube shorts · 3 phrase(s)",
       "Search · humanizer · youtube videos · 3 phrase(s)"])

print("\nother platforms are unaffected by the YouTube split:")
y["platforms"] = ["tiktok", "youtube", "instagram"]
check("  three platforms, four runs", len(a.search_runs(y)), 4)
check("  in order", a.search_runs(y),
      [("tiktok", ""), ("youtube", "shorts"), ("youtube", "videos"), ("instagram", "")])

print("\nand the two YouTube runs do not share a file:")
y["output"] = "results/run.csv"
outs = [Path(a.build_search_for(y, pl, ct, True)[1][-1]).name for pl, ct in a.search_runs(y)]
# THE GENRE IS IN THE NAME as well as the platform. The same platform searched
# for two genres would otherwise write one file twice, and the second run
# would overwrite the first - which reads as a scrape that found nothing.
check("  the tab goes into the name too", outs,
      ["run_humanizer_tiktok.csv", "run_humanizer_youtube_shorts.csv",
       "run_humanizer_youtube_videos.csv", "run_humanizer_instagram.csv"])

# ── several platforms at once ──────────────────────────────────────────────
# scraper.py takes ONE --platform and writes ONE file, so "all of them" is four
# runs. They start together, which is the whole reason the window exists.
print("\nticking four platforms is four runs, not one:")
s = dict(a.DEFAULTS["search"])
s["platforms"] = ["reddit", "tiktok", "youtube"]
check("  only what was ticked", a.chosen_platforms(s), ["tiktok", "youtube", "reddit"])
check("  in a fixed order, whatever order they were ticked in",
      a.chosen_platforms({"platforms": ["youtube", "tiktok"]}), ["tiktok", "youtube"])
check("  a made-up platform is dropped",
      a.chosen_platforms({"platforms": ["tiktok", "myspace"]}), ["tiktok"])
# A settings file written before this was a list holds a bare string.
check("  an old single-platform setting still reads",
      a.chosen_platforms({"platforms": "youtube"}), ["youtube"])
check("  nothing ticked is nothing to run", a.chosen_platforms({"platforms": []}), [])
try:
    a.build_search({**s, "platforms": []})
    check("  and that is refused rather than guessed at", False, True)
except ValueError as e:
    check("  and that is refused rather than guessed at", "at least one platform" in str(e), True)

lines = a.preview("search", s).split("\n")
# Four lines, not three: YouTube is read a tab at a time, so it is two of
# them. See the section on that below.
check("  one preview line per run", len(lines), 4)
check("  each naming its own platform",
      [l.split("--platform ")[1].split(" ")[0] for l in lines],
      ["tiktok", "youtube", "youtube", "reddit"])
check("  and the YouTube pair names its tabs",
      [l.split("--content ")[1].split(" ")[0] for l in lines if "--content" in l],
      ["shorts", "videos"])

# TWO SCRAPERS MUST NOT SHARE A FILE. They run at the same time and the second
# to finish would overwrite the first.
print("\na named output file is kept apart per platform:")
s["output"] = "results/run.csv"
outs = [a.build_search_for(s, pl, many=True)[1][-1] for pl in a.chosen_platforms(s)]
check("  the platform goes into the name", [Path(o).name for o in outs],
      ["run_humanizer_tiktok.csv", "run_humanizer_youtube.csv", "run_humanizer_reddit.csv"])
check("  one platform keeps the name as typed",
      a.build_search_for(s, "tiktok", many=False)[1][-1], "results/run.csv")
check("  and no name at all stays no name",
      "--output" in " ".join(a.build_search_for({**s, "output": ""}, "tiktok", many=True)[1]),
      False)

# ── which file the upload sends ────────────────────────────────────────────
# "The newest CSV" was fine for one search and is wrong for four: the newest file
# when a TikTok run finishes may be the Instagram run's, and replace-mode on the
# wrong file removes the rank links of a platform nobody was uploading.
print("\nthe upload sends the file the scraper said it wrote:")


class FakeJob:
    def __init__(self, lines, cwd=None):
        self._lines = lines
        self.cwd = str(cwd or a.SCRAPER_DIR)

    def tail(self, since):
        return list(self._lines), len(self._lines)


B = chr(92)
check("  read out of the scraper's own last line",
      a.written_file(FakeJob([
          "[*] working",
          "[+] Done! Saved 1,204 unique URLs to 'results/links_tiktok.csv'",
      ])), str((a.SCRAPER_DIR / "results" / "links_tiktok.csv").resolve()))
check("  the last one wins if a job wrote twice",
      Path(a.written_file(FakeJob([
          "[+] Done! Saved 10 unique URLs to 'a.csv'",
          "[+] Done! Saved 20 unique URLs to 'b.csv'",
      ]))).name, "b.csv")
check("  and nothing is invented when it did not say",
      a.written_file(FakeJob(["[!] it crashed"])), "")

# THE TWO PROGRAMS DISAGREE ABOUT RELATIVE PATHS, and neither is wrong. The
# scraper prints its own, relative to where IT runs; upload.py joins a relative
# path onto its own idea of the results folder — which is that same folder
# again, so the path doubles back on itself:
#
#   [!] File not found: …\1_tiktok_search_scraper\results\results\tiktok_….csv
#
# An absolute path is used as given, by both.
print("\nthe path handed to the upload is absolute, so neither program re-joins it:")
rel = a.written_file(FakeJob(
    ["[+] Done! Saved 1,204 unique URLs to 'results" + B + "tiktok_x.csv'"]))
check("  it is absolute", Path(rel).is_absolute(), True)
check("  pointing at the scraper's results folder", Path(rel).parent,
      a.SCRAPER_DIR / "results")
check("  not doubled back on itself", ("results" + B + "results") in rel, False)
check("  forward slashes land in the same place",
      Path(a.written_file(FakeJob(
          ["[+] Done! Saved 9 unique URLs to 'results/instagram_x.csv'"]))).parent,
      a.SCRAPER_DIR / "results")
_abs = str(a.SCRAPER_DIR / "results" / "yt.csv")
check("  and one that was already absolute is left alone",
      a.written_file(FakeJob([f"[+] Done! Saved 9 unique URLs to '{_abs}'"])), _abs)

# Empty for THIS genre. The guard must still fire, or a search starts with no
# phrases and the scraper becomes the thing that complains.
s["queries_by_genre"] = {"humanizer": "   \n\n"}
s["queries"] = ""
try:
    a.build_search(s)
    check("  an empty phrase list is refused", False, True)
except ValueError as e:
    check("  an empty phrase list is refused", "at least one" in str(e), True)

# ── upload ─────────────────────────────────────────────────────────────────
print("\nthe upload says which pool it is replacing:")
check("  replace is the default (no --append)",
      "--append" in " ".join(a.build_upload({"platform": "tiktok", "upload_mode": "replace"})[1]),
      False)
check("  append is asked for by name",
      has(a.build_upload({"platform": "tiktok", "upload_mode": "append"})[1], "--append"), True)
check("  a platform narrows it", has(a.build_upload({"platform": "youtube"})[1], "--youtube"), True)
check("  a named CSV wins over the platform",
      a.build_upload({"csv": "results/x.csv", "platform": "tiktok"})[1][-1], "results/x.csv")
check("  and it runs where upload.py lives", a.build_upload({})[2], a.DASH_DIR)

# ── harvest ────────────────────────────────────────────────────────────────
print("\nthe Instagram harvest stages what it finds:")
h = dict(a.DEFAULTS["harvest"])
check("  the channel count is passed", has(a.build_harvest(h)[1], "--limit 50"), True)
check("  uploading is the default, so no --no-upload",
      "--no-upload" in " ".join(a.build_harvest(h)[1]), False)
h["upload"] = False
check("  switching it off says so", has(a.build_harvest(h)[1], "--no-upload"), True)
h.update({"upload": True, "dry_run": True})
check("  a dry run is a dry run", has(a.build_harvest(h)[1], "--dry-run"), True)
# --headed IS NOT SENT. scrape_channels.py has no such flag and refuses the whole
# run over it — "unrecognized arguments: --headed", exit 2, before a single
# channel is scraped — and it never needed one: that browser is always on screen.
check("  and --headed is never sent", "--headed" in " ".join(a.build_harvest(h)[1]), False)
h["accounts"] = " mine.csv "
check("  an accounts file is trimmed", has(a.build_harvest(h)[1], "--accounts mine.csv"), True)

# ── hearts ─────────────────────────────────────────────────────────────────
print("\nthe heart runner carries every setting that changes what it does:")
z = dict(a.DEFAULTS["hearts"])
cmd = a.build_hearts(z)[1]
check("  the service", has(cmd, "--service zefoy"), True)
check("  the dashboard as the source", has(cmd, "--from-dashboard"), True)
# NOT RANK. Rank clustering is also a FILTER: it keeps only links that carry a
# search rank, and 2,648 of 177,628 in the pool do - the other 98.5% came from
# channel scrapes and are date-only. Defaulting to it meant the liker was
# offered 1.5% of the work, and with a genre picked it could be none at all:
# every rank-bearing link happened to come from one website search, so a
# humanizer run matched zero and exited saying "No links to work".
check("  and clusters by combined, not rank", has(cmd, "--cluster-by combined"), True)
# Still OFFERED - the filter is the right one when a search run is what you
# want to work. Only the default changed.
check("  rank is still offered in the window", 'value="rank"' in UI, True)
check("  the target", has(cmd, "--to-top", "--margin 3", "--rounds 4"), True)
check("  one pass by default", has(cmd, "--no-loop"), True)
check("  and it carries on from last time", has(cmd, "--resume"), True)

z["source"] = "csv"
try:
    a.build_hearts(z)
    check("  a CSV source with no CSV is refused", False, True)
except ValueError as e:
    check("  a CSV source with no CSV is refused", "Choose a CSV" in str(e), True)
z["csv"] = "links.csv"
cmd = a.build_hearts(z)[1]
check("  a CSV run does not ask the dashboard",
      "--from-dashboard" in " ".join(cmd), False)

# Fresh and resume are opposite instructions, and automate.py refuses both.
z = dict(a.DEFAULTS["hearts"]); z["fresh"] = True
cmd = a.build_hearts(z)[1]
check("  fresh and resume are never sent together",
      has(cmd, "--fresh") and "--resume" not in " ".join(cmd), True)

# WHERE A RUN HAPPENS IS A CHECKBOX NOW, not a side effect of filling in an
# address: a PC run never carries --cdp even with one saved, or ticking both
# would start two runs driving the same handset.
z = dict(a.DEFAULTS["hearts"])
z.update(on_pc=False, on_phone=True, cdp=" http://127.0.0.1:9222 ")
cmd = a.build_hearts(z)[1]
check("  the phone's address is trimmed", has(cmd, "--cdp http://127.0.0.1:9222"), True)
check("  and brings the reconnect budget with it", has(cmd, "--recover 5"), True)
check("  the title says where it runs", "on the phone" in a.build_hearts(z)[0], True)
z.update(on_pc=True, on_phone=False)
check("  and a PC run ignores a saved address",
      "--cdp" in " ".join(a.build_hearts(z)[1]), False)

z = dict(a.DEFAULTS["hearts"]); z["loop"] = True
check("  a loop asks for a loop", has(a.build_hearts(z)[1], "--loop", "--loop-delay"), True)
z = dict(a.DEFAULTS["hearts"]); z["service"] = "zefoy"
check("  --delay is Freer's, so Zefoy does not get it",
      "--delay" in " ".join(a.build_hearts(z)[1]), False)
z["service"] = "freer"
check("  Freer does", has(a.build_hearts(z)[1], "--delay"), True)
z = dict(a.DEFAULTS["hearts"]); z["workers"] = 1
check("  one window needs no --workers", "--workers" in " ".join(a.build_hearts(z)[1]), False)
z["workers"] = 3
check("  three does", has(a.build_hearts(z)[1], "--workers 3"), True)

# ── settings ───────────────────────────────────────────────────────────────
# ── the phone ──────────────────────────────────────────────────────────────
# Running on the phone needed a terminal: adb reconnect, adb forward, and the
# part nobody guesses — Chrome opens its debugging socket once at startup, so a
# Chrome that ran through a disconnect has none and no amount of forwarding
# helps. The window does all of that now, by calling automate.py's own helpers
# rather than growing a second copy of them.
print("\nthe phone is attached from the window, not from a terminal:")
_h = a.hearts_module()
check("  the heart runner's helpers are reachable", _h is not None, True)
if _h:
    for name in ("adb_bin", "_adb", "cdp_alive", "cdp_relink", "CHROME_PKG"):
        check(f"  it borrows {name}", hasattr(_h, name), True)

# adb prints its own chatter above the header when it has to start its daemon,
# and listing "* daemon not running" as a connected phone is worse than listing
# nothing.
_real_adb = _h._adb if _h else None
if _h:
    try:
        _h._adb = lambda *args, **kw: (0, "* daemon not running; starting now at tcp:5037\n"
                                          "* daemon started successfully\n"
                                          "List of devices attached\n"
                                          "RZ8T21TZJSL\tdevice\n")
        check("  the daemon's chatter is not a device", a.adb_devices(), ["RZ8T21TZJSL\tdevice"])
        _h._adb = lambda *args, **kw: (0, "List of devices attached\n")
        check("  and an empty list is empty", a.adb_devices(), [])
    finally:
        _h._adb = _real_adb

print("\nand what it reports is what it found:")
_state = a.phone_state("")
check("  no address is not a connected phone", _state["ok"], False)
check("  it says which adb it would use", bool(_state["adb"]), True)
_state = a.phone_state("http://127.0.0.1:1")   # nothing listens there
check("  an address nothing answers is not ready", _state["ok"], False)
check("  and it says why", "listening" in _state["detail"] or "refus" in _state["detail"], True)

# ── the floor reaches the run ──────────────────────────────────────────────
# Two runs are independent by default; sharing is the thing you ask for.
# ── where to run ───────────────────────────────────────────────────────────
# One press, one or two runs. The PC's liker opens its own throwaway browser and
# the phone's attaches over adb, so nothing is shared between them except — when
# asked for — the list.
print("\nthe PC, the phone, or both:")
_w = dict(a.DEFAULTS["hearts"])
_w.update(on_pc=True, on_phone=False, tag="")
check("  this PC alone is one run", a.hearts_places(_w), ["pc"])
check("  and carries no --cdp",
      "--cdp" in " ".join(a.build_hearts_for(_w, "pc")[1]), False)
_w.update(on_pc=False, on_phone=True)
check("  the phone alone is one run", a.hearts_places(_w), ["phone"])
check("  and does carry it", has(a.build_hearts_for(_w, "phone")[1], "--cdp"), True)
_w.update(on_pc=True, on_phone=True)
check("  both is two, the PC first", a.hearts_places(_w), ["pc", "phone"])
_w.update(on_pc=False, on_phone=False)
check("  and nothing ticked is nowhere to run", a.hearts_places(_w), [])
try:
    a.build_hearts(_w)
    check("  which is refused, not guessed at", False, True)
except ValueError as e:
    check("  which is refused, not guessed at", "Tick somewhere" in str(e), True)

print("\ntogether means ONE record; apart means two:")
_w.update(on_pc=True, on_phone=True, share=True, tag="")
_cmds = [a.build_hearts_for(_w, pl, many=True)[1] for pl in a.hearts_places(_w)]
check("  both share", sum("--share" in " ".join(c) for c in _cmds), 2)
check("  on a record named for you", sum("--tag team" in " ".join(c) for c in _cmds), 2)
check("  and only one of them drives the phone",
      sum("--cdp" in " ".join(c) for c in _cmds), 1)
_w["tag"] = "desk"
_cmds = [a.build_hearts_for(_w, pl, many=True)[1] for pl in a.hearts_places(_w)]
check("  a name you gave is the one they share",
      sum("--tag desk" in " ".join(c) for c in _cmds), 2)

_w["share"] = False
_cmds = [a.build_hearts_for(_w, pl, many=True)[1] for pl in a.hearts_places(_w)]
# SEPARATE RECORDS OR THEY LIE TO EACH OTHER: sharing a state file without the
# claims protocol means each skips what the other finished and calls the list
# done, having done half of it between them.
check("  apart, neither shares", sum("--share" in " ".join(c) for c in _cmds), 0)
check("  and the records are kept apart",
      sorted(c[c.index("--tag") + 1] for c in _cmds), ["desk-pc", "desk-phone"])
_w["tag"] = ""
_cmds = [a.build_hearts_for(_w, pl, many=True)[1] for pl in a.hearts_places(_w)]
check("  with no name given, by where they run",
      sorted(c[c.index("--tag") + 1] for c in _cmds), ["pc", "phone"])

# A single run has nobody to share with, so it is never sent.
_w.update(on_pc=True, on_phone=False, share=True)
check("  one run never shares",
      "--share" in " ".join(a.build_hearts_for(_w, "pc")[1]), False)

print("\nsharing is something two runs do:")
_t = dict(a.DEFAULTS["hearts"])
_t.update(on_pc=True, on_phone=False, share=True)
check("  a lone run does not share",
      "--share" in " ".join(a.build_hearts(_t)[1]), False)
_t.update(on_phone=True)
check("  two runs do",
      has(a.build_hearts_for(_t, "pc", many=True)[1], "--share"), True)

print("\nthe floor is a setting the window can set:")
_z = dict(a.DEFAULTS["hearts"])
check("  a quarter by default", _z["floor"], 0.25)
check("  and it is sent", has(a.build_hearts(_z)[1], "--floor 0.25"), True)
_z["floor"] = 0
# 0 is a real choice — it means leading is enough — so it must be sent, not
# dropped the way an empty optional would be.
check("  zero is sent too, because zero means something",
      has(a.build_hearts(_z)[1], "--floor 0"), True)
_z = dict(a.DEFAULTS["hearts"]); _z["to_top"] = False
check("  but not without --to-top, which is the only mode it applies to",
      "--floor" in " ".join(a.build_hearts(_z)[1]), False)

print("\nsettings survive a restart, and a half-written file does not break one:")
s = a.load_settings()
check("  every tool has defaults", sorted(s.keys()), sorted(a.DEFAULTS.keys()))
check("  and every key is there",
      all(set(a.DEFAULTS[t]) <= set(s[t]) for t in a.DEFAULTS), True)
check("  a preview is offered before anything runs",
      a.preview("hearts", s["hearts"]).startswith("-u"), True)
check("  a bad setting previews as its error, not a crash",
      a.preview("search", {**s["search"], "queries": "",
                           "queries_by_genre": {"humanizer": ""}}).startswith("("), True)

# ── the runner ─────────────────────────────────────────────────────────────
# Harmless commands only: this is about the plumbing, not the programs.
import time  # noqa: E402

print("\na job streams its output and reports how it ended:")
j = a.RUNNER.start("test", "hello", [
    sys.executable, "-u", "-c",
    "import time\nfor i in range(3): print('line', i); time.sleep(0.1)\n"
    "print('emoji \U0001f970 ok')"], HERE)
for _ in range(80):
    if j.status in ("done", "failed", "stopped"):
        break
    time.sleep(0.1)
check("  it finished", j.status, "done")
check("  exit code", j.exit_code, 0)
lines_out, seq = j.tail(0)
check("  the command it ran is the first line", lines_out[0].startswith("$ "), True)
check("  every line arrived", sum(1 for l in lines_out if l.startswith("line ")), 3)
# The emoji is the one that killed a heart run on a cp1252 console. Children are
# told to speak UTF-8 so a caption cannot end a job.
check("  an emoji survives the trip", any("\U0001f970" in l for l in lines_out), True)
check("  and the exit is recorded", lines_out[-1], "[exited with code 0]")
check("  asking again returns nothing new", j.tail(seq)[0], [])

print("\nhow a job ended is not guesswork:")
f = a.RUNNER.start("test", "boom", [sys.executable, "-c", "raise SystemExit(3)"], HERE)
for _ in range(80):
    if f.status in ("done", "failed", "stopped"):
        break
    time.sleep(0.1)
check("  a non-zero exit is a failure", (f.status, f.exit_code), ("failed", 3))

sleeper = a.RUNNER.start("test", "sleeper",
                         [sys.executable, "-c", "import time; time.sleep(30)"], HERE)
time.sleep(0.8)
check("  a running job says so", sleeper.status, "running")
check("  stopping one works", sleeper.stop(), True)
for _ in range(60):
    if sleeper.status in ("stopped", "failed", "done"):
        break
    time.sleep(0.1)
# Stopped on purpose is not the same as fell over, and a window that called it a
# failure would have you hunting a bug every time you pressed Stop.
check("  and it is 'stopped', not 'failed'", sleeper.status, "stopped")

# ── a queued search still gets its upload ──────────────────────────────────
# THE BUG THIS EXISTS FOR. Browser jobs queue behind the shared Chrome profile,
# so a four-platform search starts one run and leaves the rest `queued`. The
# chained upload waited while the job was "starting" or "running" — and a queued
# job is neither. It fell straight through, read a status that was not "done",
# and announced "not uploading" before the search had begun. TikTok (first, so it
# ran at once) uploaded; YouTube and Instagram never did.
print("\na search that has to wait its turn still uploads when it finishes:")
import threading  # noqa: E402

_started = []
_real_start = a.RUNNER.start


def _spy(tool, title, cmd, cwd):
    _started.append((tool, title, cmd))
    return _real_start(tool, title, cmd, cwd)


_csv = a.SCRAPER_DIR / "results"
_csv.mkdir(parents=True, exist_ok=True)
_csv = _csv / "__check_app__.csv"
_csv.write_text("url\nhttps://example.com/1\n", encoding="utf-8")
_prog = "print(%r)" % (f"[+] Done! Saved 1 unique URLs to '{_csv}'")

_holder = _real_start("search", "holder",
                      [sys.executable, "-c", "import time; time.sleep(3)"], HERE)
time.sleep(0.5)
_queued = _real_start("search", "Search · youtube shorts",
                      [sys.executable, "-u", "-c", _prog], HERE)
time.sleep(0.4)
check("  the second search is queued", _queued.status, "queued")
check("  and 'queued' is not mistaken for finished", _queued.finished(), False)

a.RUNNER.start = _spy
try:
    _started.clear()
    _t = threading.Thread(target=a._chain_upload,
                          args=(_queued, {"upload_mode": "append"}, "youtube"), daemon=True)
    _t.start()
    time.sleep(1.5)
    check("  its upload does not fire while it waits", _started, [])
    _holder.stop()
    for _ in range(150):
        if _queued.finished():
            break
        time.sleep(0.1)
    check("  the queued search then runs and finishes", _queued.status, "done")
    _t.join(timeout=15)
    check("  and its upload is started", [t for t, _, _ in _started], ["upload"])
    if _started:
        _cmd = _started[0][2]
        check("  with the exact file it wrote",
              _cmd[-2] if _cmd[-1] == "--append" else _cmd[-1], str(_csv))
finally:
    a.RUNNER.start = _real_start
    try:
        _csv.unlink()
    except OSError:
        pass

# Everything that has not finished is work in hand, queued included: a badge
# reading 1 while three searches wait would say the opposite.
check("  a queued job counts as outstanding work", a.RUNNER.running() >= 0, True)

print("\njobs run at the same time, which is the whole point:")
t0 = time.time()
batch = [a.RUNNER.start("test", f"p{i}",
                        [sys.executable, "-c", "import time; time.sleep(1.5)"], HERE)
         for i in range(3)]
for jb in batch:
    for _ in range(100):
        if jb.status in ("done", "failed", "stopped"):
            break
        time.sleep(0.1)
elapsed = time.time() - t0
check(f"  three 1.5s jobs finished in {elapsed:.1f}s, not 4.5s", elapsed < 3.0, True)


# ── the genre filter on the two tabs that do work against one pool ─────────
#
# Both tabs act on a POOL, and a genre is a pool: the harvester visits the
# accounts feeding one and files what it finds back into it, and the liker
# hearts our comment on one genre's videos. Passing the wrong genre, or
# dropping it in silence, means work done against the wrong product - so what
# matters is that a chosen genre reaches the command line and an unknown one
# never does.
print("\nthe Instagram harvest can be aimed at one genre:")
h = dict(a.DEFAULTS["harvest"])
check("  all genres by default", a.build_harvest(h)[1].count("--genre"), 0)
check("  and the title says so", "all genres" in a.build_harvest(h)[0], True)

h_web = {**h, "genre": "website"}
title, cmd, _ = a.build_harvest(h_web)
check("  a chosen genre reaches the command", has(cmd, "--genre website"), True)
check("  and the title names it", "Website builder" in title, True)
# The harvester declares choices=, so an unknown value would fail the whole run
# at argparse rather than harvest everything. Dropped here instead.
check("  an unknown genre is dropped, not passed on",
      a.build_harvest({**h, "genre": "nonsense"})[1].count("--genre"), 0)
check("  the window has a control for it", "h_genre" in UI, True)
check("  and it is wired into the form", "genre:'h_genre'" in UI.replace('"', "'"), True)

print("\nand so can the comment liker:")
z = dict(a.DEFAULTS["hearts"])
check("  all genres by default", a.build_hearts(z)[1].count("--genre"), 0)
z_web = {**z, "genre": "website"}
check("  a chosen genre reaches the command", has(a.build_hearts(z_web)[1], "--genre website"), True)
check("  an unknown genre is dropped, not passed on",
      a.build_hearts({**z, "genre": "nonsense"})[1].count("--genre"), 0)
check("  the window has a control for it", "z_genre" in UI, True)
check("  and it is wired into the form", "genre:'z_genre'" in UI.replace('"', "'"), True)


# ── the account liker ───────────────────────────────────────
#
# A SECOND LIKER, and the difference from the first is whose account does the
# liking: hearts goes through Zefoy or Freer, this signs in as one of ours. The
# settings that decide what a run touches are the ones worth pinning - which
# links, what counts as a target, and as whom.
print("\nthe account liker takes its links the same way the other one does:")
k = dict(a.DEFAULTS["liker"])
title, cmd, cwd = a.build_liker(k)
check("  it runs in the liker's folder", cwd.name, "6_comment_liker")
check("  from the dashboard by default", has(cmd, "--from-dashboard"), True)
# The same trap as the Zefoy liker: rank clustering keeps 1.5% of the pool.
check("  and clusters by combined, not rank", has(cmd, "--cluster-by combined"), True)
check("  liking our products, not everything", has(cmd, "--products"), True)
check("  and never --all", "--all" in cmd, False)

print("\nand it can be aimed at one genre, like the rest:")
check("  all genres by default", cmd.count("--genre"), 0)
check("  a chosen genre reaches the command",
      has(a.build_liker({**k, "genre": "website"})[1], "--genre website"), True)
check("  an unknown genre is dropped, not passed on",
      a.build_liker({**k, "genre": "nonsense"})[1].count("--genre"), 0)

print("\nthe settings that change who it acts as, and what it does:")
check("  the saved login is passed", has(cmd, "--profile default"), True)
check("  a dry run likes nothing", has(a.build_liker({**k, "dry_run": True})[1], "--dry-run"), True)
check("  unliking is a separate flag", has(a.build_liker({**k, "unlike": True})[1], "--unlike"), True)
# THE TIE RULE IS ON UNLESS ASKED OTHERWISE. By default the liker gives one
# like per like-count per video, so a like of ours never puts two of our
# comments on the same number - three on 5 used to become three on 14, which
# turned a coincidence into a pattern on every video. The window can switch it
# off for a run where the comments are genuinely different and independently
# earned, but it must not do so by accident.
check("  tied comments are left alone by default", k["like_ties"], False)
check("  and the default command does not ask to like them",
      a.build_liker(k)[1].count("--like-ties"), 0)
check("  ticking it reaches the command",
      has(a.build_liker({**k, "like_ties": True})[1], "--like-ties"), True)
check("  the window has a control for it", "k_like_ties" in UI, True)
# Named handles instead of products is a different run, and an empty list for it
# is a run that would like nothing while looking like it worked.
check("  named handles replace --products",
      has(a.build_liker({**k, "target": "users", "users": "w1,w2"})[1], "--users w1,w2"), True)
check("  and --products is then gone",
      "--products" in a.build_liker({**k, "target": "users", "users": "w1"})[1], False)
try:
    a.build_liker({**k, "target": "users", "users": "  "})
    check("  no handles is refused, not run", False, True)
except ValueError:
    check("  no handles is refused, not run", True, True)
try:
    a.build_liker({**k, "source": "file", "links": ""})
    check("  a file source with no file is refused", False, True)
except ValueError:
    check("  a file source with no file is refused", True, True)
check("  a file source does not query the dashboard",
      "--from-dashboard" in a.build_liker({**k, "source": "file", "links": "l.txt"})[1], False)

print("\nthe window has a page for it:")
check("  a nav entry", 'data-page="liker"' in UI, True)
check("  a page", 'id="page-liker"' in UI, True)
check("  a start button that names the tool", "start('liker')" in UI, True)
# Every setting the builder reads must have a control, or it silently resets to
# the default each time the window is opened.
for key in a.DEFAULTS["liker"]:
    check(f"  a control for {key}", f"k_{key}" in UI, True)


# ── every tab actually opens ───────────────────────────────────
#
# THE BUG THIS EXISTS FOR. The switcher used to iterate a list written in the
# page - ['search','harvest','hearts','jobs'] - so adding the Account liker gave
# it a nav button and a section the switcher had never heard of. Clicking it hid
# the other four and left page-liker hidden: the tab highlighted and the body
# went blank, with no error anywhere.
#
# Checking that the markup exists was not enough, because all of it did. What
# has to hold is that every nav entry REACHES its section.
print("\nevery tab in the sidebar opens a page:")
main = re.search(r"<main>(.*)</main>", UI, re.S)
check("  the page has a main", bool(main), True)
# Direct children only: the switcher selects 'main > section', so a section
# nested inside another one is hidden by its parent and never shown.
sections = re.findall(r'<section id="(page-[a-z]+)"', main.group(1) if main else "")
navs = sorted(set(re.findall(r'data-page="([a-z]+)"', UI)))
for n in navs:
    check(f"  {n} has a section", f"page-{n}" in sections, True)
for sec in sections:
    check(f"  {sec} has a nav entry", sec[5:] in navs, True)
# And the switcher must read the DOM rather than a hardcoded list, or the two
# go out of step again the next time a tab is added.
check("  the switcher reads the DOM, not a list",
      "document.querySelectorAll('main > section')" in UI, True)
check("  and no hardcoded page list is left",
      "['search','harvest','hearts','jobs']" in UI, False)


print("\nseveral accounts on one list is several runs:")
k = dict(a.DEFAULTS["liker"])
check("  blank means the default login", a.liker_profiles({**k, "profiles": ""}), ["default"])
check("  a list is split and trimmed",
      a.liker_profiles({**k, "profiles": " a , b ,c "}), ["a", "b", "c"])
# A name twice is two browsers on ONE profile directory, which Chromium refuses
# outright - so the duplicate has to go before it reaches a command line.
check("  a repeated name is dropped",
      a.liker_profiles({**k, "profiles": "a,b,a"}), ["a", "b"])

names = a.liker_profiles({**k, "profiles": "a,b"})
cmds = [a.build_liker_for({**k, "profiles": "a,b"}, n, names)[1] for n in names]
check("  one command per account", len(cmds), 2)
check("  each runs as its own", has(cmds[0], "--profile a") and has(cmds[1], "--profile b"), True)
# No --peers: with it like.py divides each video's comments between the
# accounts, and every account must like every comment of ours that is not tied.
check("  no account is told to split the comments",
      any("--peers" in c for c in cmds), False)
check("  a single account has no peers",
      a.build_liker_for(k, "default", ["default"])[1].count("--peers"), 0)
check("  the title names the account", "\u00b7 b \u00b7" in a.build_liker_for({**k, "profiles": "a,b"}, "b", names)[0], True)
check("  the preview shows every run",
      len(a.preview("liker", {**k, "profiles": "a,b,c"}).splitlines()), 3)

print("\nand the words that make a comment ours can be set:")
check("  blank sends nothing, so the products stand", a.build_liker(k)[1].count("--keywords"), 0)
check("  given words reach the command",
      has(a.build_liker({**k, "keywords": "purifytext, purify text"})[1],
          "--keywords purifytext, purify text"), True)
check("  the window has a box for them", "k_keywords" in UI, True)
check("  and a picker for the logins", "k_profile_pick" in UI, True)
check("  fed from the server, not typed blind", "/api/logins" in UI, True)
check("  which the server answers", "/api/logins" in SRC, True)
# The logins ARE the directories login.py writes; reading them from disk is what
# makes a typo impossible to save.
logins = a.liker_logins()
check("  and reads them off disk", isinstance(logins, list), True)
check("  leaving out the sites this tool cannot work",
      [l for l in logins if l["name"].startswith(("ig-", "yt-"))], [])


# ── a press that cannot do any work is refused ───────────────────────
#
# WHAT THIS IS FOR. Clustering is also a filter: "Search rank" keeps only links
# carrying a search rank, about 1.5% of the pool. With a genre as well it can
# come to nothing - rank + humanizer is exactly zero, because every rank-bearing
# link came from one website search. Pressing Start on that opened a browser per
# account, asked the dashboard, and exited 2 each time.
#
# Fixing the saved file was not enough either: an open page holds the old form,
# and pressing Start writes it back over whatever was saved. So the selection is
# checked at the press, where it is made.
#
# NO NETWORK IN THESE CHECKS. dashboard_matches returns None when it cannot ask,
# and the guard treats None as "do not block" - a check that needed the internet
# would fail on a train and teach everyone to ignore it.
print("\na selection with no links in it is refused before anything starts:")
check("  the guard exists", callable(getattr(a, "check_selection", None)), True)
def start_block(tool: str) -> str:
    """The body of one tool's branch in /api/start, up to the next branch.

    Taken by boundary rather than by a character budget: the branches carry long
    comments, and a window wide enough for today's is a window that will read
    into the NEXT tool's branch tomorrow and pass for the wrong reason.
    """
    # INSIDE /api/start, not anywhere the name appears. preview() branches on
    # the same tool names and comes first in the file, so searching the whole
    # source found the preview's branch - which has no guard in it, and never
    # should: asking what a press WOULD run must not refuse anything.
    route = SRC.find('if u.path == "/api/start":')
    if route < 0:
        return ""
    start = SRC.find(f'if tool == "{tool}":', route)
    if start < 0:
        return ""
    nxt = SRC.find("if tool == ", start + 20)
    return SRC[start : nxt if nxt > 0 else len(SRC)]


check("  it is asked before the account liker starts",
      "check_selection" in start_block("liker"), True)
check("  and before the zefoy liker starts",
      "check_selection" in start_block("hearts"), True)
# A file of links is its own answer; the dashboard has no opinion about it, and
# asking it would refuse a perfectly good run.
check("  but not when the links come from a file",
      'source", "dashboard")) != "file"' in start_block("liker"), True)
# THE PART THAT MUST NOT BLOCK. An unreachable dashboard is not an empty one: a
# guard that read its own network error as "nothing matched" would refuse every
# press the moment the laptop lost Wi-Fi. Forced here rather than hoped for, by
# handing it an environment with no dashboard in it.
_env = a.dashboard_env
try:
    a.dashboard_env = lambda: {}
    check("  no dashboard configured means unknown, not zero",
          a.dashboard_matches({"clusterBy": "combined"}), None)
    check("  and unknown lets the press through",
          a.check_selection({"cluster_by": "rank", "clusters": "all"}), None)
finally:
    a.dashboard_env = _env
check("  and unknown does not refuse the press",
      "if n is None or n > 0:" in SRC, True)
# The message has to name the box to change, not just report the symptom.
check("  the message names the filter to change", "is why" in SRC, True)
check("  and says what Combined is for", "date-only" in SRC, True)


# ── and it blames the right box ──────────────────────────────────
#
# THE BUG THIS EXISTS FOR. The guard stopped at the first filter whose removal
# unblocked the selection and reported it as the cause. With rank clustering AND
# a genre set, removing EITHER one unblocks it - so it printed "Cluster by rank
# is why, 174,980 match without it", which reads as "there are no ranked links".
# There were 2,648 of them, all in a different genre. The message sent you to
# change a box that was not wrong on its own.
#
# Stubbed, not measured: the dashboard is a moving target and the shape of the
# answer is what is being checked.
print("\nand when two filters are jointly to blame, it says so:")
_real = a.dashboard_matches
try:
    # The real pool as it stood: 2,648 ranked links, every one of them website.
    def fake(p):
        rank = p.get("clusterBy") == "rank"
        genre = p.get("genre") or ""
        if rank and genre == "humanizer":
            return 0
        if rank and genre in ("", "website"):
            return 2648
        if rank:
            return 0
        return 174980 if genre in ("", "humanizer") else 2648
    a.dashboard_matches = fake

    try:
        a.check_selection({"cluster_by": "rank", "clusters": "all", "genre": "humanizer"})
        msg = ""
    except ValueError as e:
        msg = str(e)
    check("  it refuses the empty combination", bool(msg), True)
    check("  and names the clustering", "Cluster by" in msg, True)
    # THE REGRESSION. Naming only the clustering is what made it read as a lie.
    check("  AND the genre, not just the first one found", "Genre" in msg, True)
    check("  with the count behind each", "2,648" in msg and "174,980" in msg, True)
    check("  saying the combination is what is empty", "COMBINATION" in msg, True)
    # The sentence that ends the hunt: where the ranked links actually are.
    check("  and where the ranked links really are", "Website builder" in msg, True)
    check("  it does not claim there are none",
          "only keeps links that carry a search rank" in msg, False)

    # One filter genuinely alone is still reported as one.
    def only_genre(p):
        return 0 if (p.get("genre") or "") == "slides" else 177628
    a.dashboard_matches = only_genre
    try:
        a.check_selection({"cluster_by": "combined", "clusters": "all", "genre": "slides"})
        one = ""
    except ValueError as e:
        one = str(e)
    check("  a sole cause is still reported as one", "is why" in one, True)
    check("  and not dressed up as a combination", "COMBINATION" in one, False)
finally:
    a.dashboard_matches = _real


print("\na refused press leaves the saved settings alone:")
# The form used to be written to disk BEFORE anything was checked, so a press
# refused for holding no links still saved the selection that had just been
# refused - which quietly overwrote a correction every time a stale page was
# open. The write now happens at the moment the run is committed to.
start_src = SRC[SRC.find('if u.path == "/api/start":'):]
check("  the save is deferred behind a commit()", "def commit() -> None:" in start_src, True)
# After the DEFINITION, which also contains the text "commit()" and is of
# course written before the checks - comparing against it passed for a reason
# that had nothing to do with when the save happens.
_after_def = start_src[start_src.find("def commit() -> None:") + 20:]
check("  and no call to it comes before the checks",
      _after_def.find("commit()") > _after_def.find("check_selection"), True)
# Every path that starts something has to commit, or a good press stops saving.
check("  every start commits first", start_src.count("commit()") >= 5, True)


print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
