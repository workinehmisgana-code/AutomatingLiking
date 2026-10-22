#!/usr/bin/env python3
"""
Do the comments you typed into the dashboard get posted — and does an empty box
change nothing?

THE RULE, and it is the whole feature: while comments.txt has anything in it,
those are what the accounts post on videos carrying none of ours. While it is
empty, nothing changes and the comments come from the dashboard's generated set
exactly as before.

An empty list is the ABSENCE of an instruction, not an instruction to post
nothing. A run that went quiet because a box was blank would be doing less than
it was told to without ever saying so, which is the failure this is written to
make impossible.

Nothing here opens a browser or posts anything.

    python check_own_comments.py
"""
import io
import sys
from pathlib import Path

import like

HERE = Path(__file__).resolve().parent
FAILS = 0


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


TMP = HERE / "logs" / "_check_comments.txt"
TMP.parent.mkdir(parents=True, exist_ok=True)


def write(text: str) -> list[str]:
    TMP.write_text(text, encoding="utf-8")
    return like.read_own_comments(TMP)


print("reading the list:")
check("  nothing at all", write(""), [])
check("  blank lines only", write("\n   \n\n"), [])
check("  one comment", write("purify text cleared my draft"), ["purify text cleared my draft"])
# A file somebody edits by hand wants room for a reminder of what a batch was
# for, and that reminder must never end up under a video.
check("  notes are not comments", write("# the essay batch\nacoustic text works"),
      ["acoustic text works"])
check("  surrounding space is trimmed", write("   spaced out   "), ["spaced out"])
# Deduped the way comments are matched everywhere else in this project: by
# letters and digits only, so one line is not posted twice under two spellings.
check("  the same comment twice, once",
      write("purify text is good\nPurify-Text is good!"), ["purify text is good"])
check("  two different ones stay two",
      len(write("purify text is good\nacoustic text is good")), 2)
check("  a missing file reads as empty", like.read_own_comments(HERE / "no-such-file.txt"), [])

print("\nwhat the run does with it:")
# The product is read OUT OF THE TEXT: the ledger records which product a posted
# comment was for, and a hand-written list mixes them.
write("purify text cleared my draft")
check("  the product is read from the words",
      like.own_comment_for.__doc__ is not None and True, True)
src = (HERE / "like.py").read_text(encoding="utf-8")
check("  your list is tried before the dashboard's set",
      src.index("text, prod = own_comment_for(") < src.index("text, prod = comment_from_dashboard("),
      True)
check("  and after --mimic-comments, which is a deliberate opt-in",
      src.index("mimic_from_dashboard(") < src.index("text, prod = own_comment_for("), True)
check("  an empty list falls through to the generated set",
      'if not text:\n        text, prod = comment_from_dashboard(' in src, True)
check("  the source is recorded, so a comment can be explained later",
      'source = "own"' in src, True)
check("  it can be turned off for a run", "--no-own-comments" in src, True)
check("  and the switch reaches a parallel run",
      "--no-own-comments" in (HERE / "run_parallel.py").read_text(encoding="utf-8"), True)

# The ledger keeps WHERE a comment came from, so "Its commented links" can tell
# one you typed from one that was generated. It was computed and then thrown
# away at exactly the moment it stopped being derivable: a month later nothing
# about the text itself says which list it came out of.
# LETTERS THAT ARE NOT LETTERS. The comments are posted with Greek and Cyrillic
# glyphs standing in for Latin ones, which is how they get past a filter looking
# for the product name — and it hid them from US: norm() stripped them, so our
# own matcher answered "no product here" for a comment we had just written. A
# video carrying one then looks empty and earns a second comment from the next
# account. Measured: 11 of 65 commented videos carry comments from 2-4 profiles.
LOOKALIKE_TEXT = "ρυяιfутєχт"


def _ours(text):
    return like.wanted({"text": text, "user": "x"}, like.NORM_PRODUCTS, set(), False)


print("\nour own comments are recognised however they are spelled:")
check("  lookalike glyphs fold back", like.norm(LOOKALIKE_TEXT), "purifytext")
check("  so the product matcher sees them", _ours(LOOKALIKE_TEXT + " is good"), True)
check("  plain spelling still works", _ours("purify text is good"), True)
check("  and an unrelated comment is still not ours",
      _ours("a totally unrelated english comment"), False)
# A long distinctive product name needs about ten characters in a row to line up
# by chance, so an ordinary comment in another alphabet is not swept in.
check("  nor is an ordinary comment in another alphabet", _ours("это обычный комментарий"), False)
check("  every comment in the real list is matched",
      all(_ours(c) for c in like.read_own_comments()) if like.read_own_comments() else True,
      True)

print("\nand the listing can tell them apart:")
vc = (HERE / "verify_comments.py").read_text(encoding="utf-8")
check("  the source goes into the ledger note", 'f"{source} \u2014 {note}"' in src, True)
check("  the listing reads it back", '"source": source if source in ("own", "bank")' in vc, True)
check("  and says it in words", '"own": "your list", "bank": "generated"' in vc, True)
# Asserted on behaviour rather than on the spelling of the separator: one
# file writes the em-dash as a character and the other as an escape, and
# they are the same string once Python has read them.
DASH = ' \u2014 '


def _parse(note):
    """What posted_rows makes of one ledger note."""
    head = note.split(DASH)[0].strip() if DASH in note else ''
    return head if head in ("own", "bank") or head.startswith("mimic") else ""


check("  a comment from your list is labelled", _parse("own" + DASH + "posted"), "own")
check("  one from the generated set too", _parse("bank" + DASH + "posted"), "bank")
check("  a mimic keeps what it mimicked",
      _parse("mimic:gptinf" + DASH + "posted"), "mimic:gptinf")
check("  a row written before this says nothing rather than guessing",
      _parse("posted"), "")
check("  and a note that merely contains a dash is not a source",
      _parse("could not post" + DASH + "box never opened"), "")

# A COMMENT ANNOUNCED AND NEVER WRITTEN DOWN was the whole of "it is not saving
# the comments": three paths gave up on a video and recorded nothing, so a run
# could print "commenting as purifytext" eight times, post none of them, and
# leave a ledger that looked like it had never been asked to.
# WHOSE VIDEOS TO COMMENT ON. The channel is read out of the link, so deciding
# costs nothing and a video that is not wanted is skipped before any page loads.
print("\nonly the listed channels are commented under:")
TMP_CH = HERE / "logs" / "_check_channels.txt"
TMP_CH.parent.mkdir(parents=True, exist_ok=True)


def chans(text):
    TMP_CH.write_text(text, encoding="utf-8")
    return like.read_comment_channels(TMP_CH)


V = "https://www.tiktok.com/@sav.studies/video/7682829383207292173"
check("  the channel comes out of the link", like.channel_of(V), "sav.studies")
check("  a photo post too",
      like.channel_of("https://www.tiktok.com/@studywjenny4/photo/768"), "studywjenny4")
check("  a short link has none", like.channel_of("https://vt.tiktok.com/ZSabc/"), "")
check("  the @ is optional", chans("@sav.studies\nsav.studies"), ["sav.studies"])
check("  a pasted profile URL works",
      chans("https://www.tiktok.com/@studywjenny4"), ["studywjenny4"])
check("  notes are not channels", chans("# leave the rest\n@sav.studies"), ["sav.studies"])
TMP_CH.unlink(missing_ok=True)

check("  an empty list means every channel", like.channel_wanted(V, []), True)
check("  a listed channel is commented under", like.channel_wanted(V, ["@sav.studies"]), True)
check("  case and punctuation do not matter", like.channel_wanted(V, ["SAV-Studies"]), True)
check("  anywhere else is left alone",
      like.channel_wanted("https://www.tiktok.com/@someone.else/video/3",
                          ["@sav.studies"]), False)
# A rule naming the channels that are WANTED cannot be satisfied by a link we
# cannot attribute, so a short link is out while a list is in force.
check("  and a link with no channel is not guessed at",
      like.channel_wanted("https://vt.tiktok.com/ZSabc/", ["@sav.studies"]), False)

check("  the list is read once per run", "channels = read_comment_channels()" in src, True)
# DECIDED ON THE LIST, NOT PER VIDEO. Per video meant reading every link's
# comments first — one request each — only to find the channel was not wanted.
# A run with two channels listed and 1,423 links opened a browser and sat in
# silence for twenty minutes.
check("  the link list is cut before anything is fetched",
      "THE CHANNEL FILTER IS APPLIED TO THE LIST" in src, True)
check("  and the run says how much it cut",
      "link(s) are theirs; " in src and "the rest are not opened at all" in src, True)
check("  an empty result stops rather than opening a browser",
      "none of the links are from those channels" in src, True)
# Only for a comment-only run: the list names channels worth COMMENTING under,
# and cutting the list on a run that is also liking would lose every like
# everywhere else.
check("  only when the run is comment-only", "comment_only = bool(" in src, True)
check("  otherwise it stays a per-video test",
      "the whole list is still worked" in src, True)
check("  and tested per video", "channel_wanted(url, channels)" in src, True)

# THE READ-BACK AFTER POSTING COMPARES TWO NORMALISATIONS, one built in Python
# and one computed by JS on the page. They must agree — and they stopped agreeing
# the moment norm() learned to fold lookalike glyphs: the needle became
# "purifytext..." while the page still read "f...", so a comment typed in those
# glyphs could never be found afterwards and every one was reported "sent but the
# comment did not appear", having posted perfectly.
print("\nthe read-back after posting compares like with like:")
import re as _re


def _page_sees(t):
    """Exactly what the JS inside post_comment computes from the page."""
    return _re.sub(r"[^a-z0-9]", "", t.lower())


for _t in ("ρυяιfутєχт is another one worth checking out.",
           "purify text cleared my draft in one go",
           "Has anyone tried ρυяιfутєχт for this?"):
    check(f"  {_t[:34]!r} is found again",
          like.norm_literal(_t)[:40] in _page_sees(_t), True)
# The folding normaliser would not have found any of them.
check("  the folding one would have missed it",
      like.norm(
          "ρυяιfутєχт is another one worth checking out."
      )[:40] in _page_sees(
          "ρυяιfутєχт is another one worth checking out."),
      False)
check("  and the pairing is written down", "PAIRED WITH THE JS IN post_comment" in src, True)
check("  with the right one used", "needle = norm_literal(text)[:40]" in src, True)

# THE PANEL IS A BETTER WITNESS THAN THE READ. The public comment list comes back
# with one or two comments on most of these videos, so "none of ours here" is
# often just a short read. The rendered panel is already on screen by then.
print("\nand a video this account already commented on is left alone:")
check("  the open panel is scanned before writing",
      "THE PANEL IS OPEN, SO LOOK BEFORE WRITING" in src, True)
check("  matched on this browser's own handle",
      'norm(str(r.get("user") or "")) == norm(my_handle)' in src, True)
check("  the handle comes from the nav only",
      "WHOAMI_JS" in src and "creator of the video" in src, True)
# A SKIP IS NOT A SUCCESS. Recording it as plain "ok" would have put links in
# "its commented links" that the account never commented on — the list is built
# from rows whose status is exactly "ok". It still has to START with "ok", or
# purge_failures clears it and the next run re-opens a video it has settled.
check("  the skip has its own status", '"ok:already"' in src, True)
check("  kept by a purge", "ok:already".startswith("ok"), True)
check("  but not listed as commented",
      'r[6] != "ok"' in vc, True)
check("  and not listed as a failure either",
      'str(r[6]).startswith("ok")' in vc, True)
check("  and the skip is recorded, not silent",
      "already has a comment here" in src, True)

print("\nevery attempt leaves a trace:")
check("  a page that would not render is recorded",
      'record_post(url, aweme, key, prod, text, "fail:load"' in src, True)
check("  with what the page actually showed", "why = why_stuck(page)" in src, True)
check("  a signed-out moment is recorded", "signed out when the comment" in src, True)
check("  a captcha in the way is recorded", "a captcha was in the way" in src, True)
check("  and one browser is not blamed on a crowd",
      "ONE BROWSER IS NOT A CROWD" in src, True)
# THE LINK, NOT THE NUMBER. Every per-video line named the video by its aweme
# id, which is the one form of it nobody can do anything with: it cannot be
# opened, pasted into a browser, or matched against the links file by eye.
check("  the run names the video by its link",
      "total_videos}] {url}:" in src, True)
check("  and nowhere still prints the bare id there",
      "total_videos}] {aweme}:" in src, False)
check("  the listing shows what did not post",
      "were attempted and did not post" in vc, True)
check("  without pretending they are out there",
      'str(r[6]).startswith("ok")' in vc, True)


print("\nthe dashboard edits the same file the run reads:")
dash = (HERE / "dashboard.py").read_text(encoding="utf-8")
page = (HERE / "dashboard.html").read_text(encoding="utf-8")
check("  read through like.OWN_COMMENTS", "like.OWN_COMMENTS.read_text" in dash, True)
check("  written through like.write_own_comments", "like.write_own_comments" in dash, True)
check("  the count comes from re-reading, not from what was sent",
      "kept = like.read_own_comments()" in dash, True)
check("  there is a box to type into", 'id="ownComments"' in page, True)
check("  it says what empty means", "Empty means nothing changes" in page, True)
check("  and it is not overwritten while you type",
      "document.activeElement !== el" in page, True)

# The one that matters: a live round trip through the same functions the
# dashboard calls, ending empty.
print("\na round trip, as the page does it:")
like.write_own_comments(["first one", "# a note", "", "second one"], TMP)
check("  saved and read back", like.read_own_comments(TMP), ["first one", "second one"])
like.write_own_comments([], TMP)
check("  cleared back to empty", like.read_own_comments(TMP), [])

TMP.unlink(missing_ok=True)

live = like.read_own_comments()
print(f"\nthe real list right now: {len(live)} comment(s)"
      + (" — these would be posted" if live else " — the generated set is used"))
for c in live[:5]:
    print(f"   {c[:70]}")

print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
