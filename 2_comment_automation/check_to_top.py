#!/usr/bin/env python3
"""
Does --to-top aim at the right number, and can it still find our comments?

TWO THINGS ARE BEING CHECKED AND THE SECOND ONE IS A BUG THAT WAS ALREADY LIVE.

1. THE TARGET. The default run aims at a share of the VIDEO's likes: send the
   largest batch that keeps the comment under HEART_THRESHOLD x video likes.
   That is a plausibility rule, and it says nothing about whether our comment is
   the one a visitor reads. --to-top aims at the OTHER COMMENTS instead: pass the
   best-liked one by a margin. The number comes from the comment section, which
   is where the competition actually is.

2. THE MATCHING. Keywords were matched as plain substrings of the comment text,
   so "purifytext" did not match "purify text" — and the comment bank writes the
   product as ordinary words on purpose, which is most of what it now produces.
   Our newest comments were invisible to this tool: it would report "no matching
   comments" on a video carrying three of them.

Nothing here opens a browser or touches Zefoy.

    python check_to_top.py
"""
import sys
from pathlib import Path

import automate as a

HERE = Path(__file__).resolve().parent
FAILS = 0


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


# ── matching our own comments ──────────────────────────────────────────────
print("our comments are found however the product is spelled:")
check("  one word", a.matches_keyword("purifytext is the one", "purifytext"), True)
# THE BUG. Every one of these was a miss before, and they are what the bank
# actually writes now.
check("  two words", a.matches_keyword("purify text got me through", "purifytext"), True)
check("  hyphenated", a.matches_keyword("Purify-Text honestly", "purifytext"), True)
check("  quoted and capitalised", a.matches_keyword('"Purify Text" always', "purifytext"), True)
check("  spaced keyword, joined comment", a.matches_keyword("purifytext!!", "purify text"), True)
check("  punctuation in between", a.matches_keyword("acoustic.text works", "acoustictext"), True)
check("  a different product is still a miss", a.matches_keyword("kinprose is fine", "purifytext"), False)
check("  and an empty keyword matches nothing", a.matches_keyword("anything", ""), False)
check("  norm strips to letters and digits", a.norm("Purify-Text 2!"), "purifytext2")

# ── how many hearts to send ────────────────────────────────────────────────
# The share-of-likes rule, unchanged, for contrast: it is about the video.
print("\nthe old target is a share of the video's likes:")
check("  room below the threshold", a.choose_heart_count(1000, 100, 0.75), 50)
check("  no room left", a.choose_heart_count(100, 95, 0.75), 0)
check("  an unknown like count sends the smallest batch", a.choose_heart_count(0, 0), 25)

# The to-top target is arithmetic on the comment section, so it is checked as
# arithmetic: deficit = best other comment + margin - ours.
def deficit(ours, rival, margin=a.TOP_MARGIN):
    return rival + margin - ours


print("\nthe new target is the best OTHER comment:")
check("  behind by 40, margin 3", deficit(10, 50), 43)
check("  already level, so still short", deficit(50, 50), 3)
check("  already ahead by more than the margin", deficit(60, 50) <= 0, True)
check("  exactly the margin ahead is enough", deficit(53, 50) <= 0, True)
check("  one short of the margin is not", deficit(52, 50) <= 0, False)
check("  nothing else on the video", deficit(0, 0), 3)
check("  the margin is configurable", deficit(10, 50, margin=25), 65)

# ── the ceiling on the chase ───────────────────────────────────────
#
# Chasing the lead is the goal; HEART_THRESHOLD is the limit on what that goal
# may cost. A comment carrying more hearts than the video it sits under is a
# comment nobody believes, and winning the comment section that way loses the
# thing the comment is for. So the gap is closed as far as the ceiling allows,
# and when that is not far enough it is said rather than quietly overshot.
#
# The same arithmetic the run does, checked as arithmetic:
#   room    = threshold x video likes - ours
#   allowed = min(deficit, room), and nothing at all when that is under 25.
SMALLEST = min(a._HEART_OPTIONS)


def plan(ours, rival, likes, threshold, margin=a.TOP_MARGIN):
    """What one visit would send. None means it refuses: the ceiling is in the way."""
    deficit = rival + margin - ours
    if deficit <= 0:
        return "already top"
    if likes <= 0:
        return deficit          # no like count, so no ceiling to compute
    room = int(likes * threshold) - ours
    if room <= 0:
        return None
    allowed = min(deficit, room)
    return None if allowed < SMALLEST else allowed


print("\nthe chase stops at HEART_THRESHOLD:")
# Room to spare: the gap is what gets sent, and the dropdown rounds it down to a
# batch Zefoy sells.
check("  plenty of room", plan(ours=10, rival=50, likes=1000, threshold=1.0), 43)
# HEART_THRESHOLD=1 on a 100-like video: 100 allowed, we have 60, so 40 left —
# less than the 43 the lead needs. Send the 40 and stop short.
check("  capped short of the lead", plan(ours=60, rival=100, likes=100, threshold=1.0), 40)
check("  and the cap bites before the lead does",
      plan(ours=60, rival=100, likes=100, threshold=1.0) < (100 + 3 - 60), True)
# A tighter threshold bites sooner.
check("  0.75 of 100 likes, we have 60", plan(ours=60, rival=100, likes=100, threshold=0.75), None)
# Already at or over the ceiling: nothing may be sent at all.
check("  already at the ceiling", plan(ours=100, rival=200, likes=100, threshold=1.0), None)
check("  already over it", plan(ours=130, rival=200, likes=100, threshold=1.0), None)
# THE CASE THAT MATTERS MOST. 20 of room, and the smallest batch Zefoy sells is
# 25 — sending it anyway is the one thing the threshold exists to prevent.
check("  room for 20, smallest batch 25, so nothing",
      plan(ours=80, rival=200, likes=100, threshold=1.0), None)
check("  room for exactly one batch", plan(ours=75, rival=200, likes=100, threshold=1.0), 25)
# No like count (a dashboard link): no ceiling can be computed, so the chase runs
# uncapped — stated at startup rather than silently assumed.
check("  unknown like count is uncapped", plan(ours=10, rival=50, likes=0, threshold=1.0), 43)
check("  already leading needs no ceiling",
      plan(ours=60, rival=50, likes=10, threshold=1.0), "already top")

# ── more than one comment of ours on a video ─────────────────────────
#
# A video often carries several. Once one of them is clear of every stranger the
# hearts belong on the NEXT one rather than on the next video: two of our
# comments at the top of a section is worth more than one of them further clear.
#
# The rival is the same for all of them — the best comment that is not ours.
# Aiming our second comment at our first would have them racing each other up a
# section they already own.
def choose(ours, rival):
    """Which of ours to work on, and how many are still behind after it.

    Returns (picked hearts, others still behind) or None when all of ours lead.
    """
    behind = [h for h in ours if h <= rival]
    if not behind:
        return None
    return max(behind), len(behind) - 1


print("\nwith several of our comments on one video:")
check("  the one closest to the line goes first", choose([12, 180, 40], rival=200), (180, 2))
check("  then the next closest", choose([12, 40], rival=200), (40, 1))
check("  then the last", choose([12], rival=200), (12, 0))
check("  one already clear is skipped", choose([250, 40], rival=200), (40, 0))
check("  all of them clear means the video is done", choose([250, 210], rival=200), None)
check("  level with the rival is not clear", choose([200], rival=200), (200, 0))
check("  a single comment behaves as before", choose([12], rival=200), (12, 0))

# is_top is what stops the rounds, so it has to mean "nothing left on this
# video" rather than "the comment I just hearted is clear" — otherwise the
# second comment never gets a single heart.
def done(after, rival, others_behind):
    return after > rival and others_behind == 0


print("\nand the video is only finished when all of ours lead:")
check("  this one clear, another behind", done(after=210, rival=200, others_behind=1), False)
check("  this one clear, none behind", done(after=210, rival=200, others_behind=0), True)
check("  not clear, none behind", done(after=190, rival=200, others_behind=0), False)

# ── what actually landed, not what was asked for ───────────────────────
#
# "50 hearts" is what the dropdown says, and it is not what arrives: they trickle
# in over the following seconds and the total is routinely short. Every decision
# after a submit used to be made against the number we ASKED for — whether the
# lead had been taken, whether another round was worth a cooldown, whether the
# threshold was spent — and all three can be wrong in the same direction.
#
# So the count is read off the page while the batch lands, and the decisions are
# arithmetic on the watched number.
def after_batch(before, landed, rival, likes, threshold, margin=a.TOP_MARGIN):
    """(is it top now, how far short, is the ceiling spent) from the REAL count."""
    after = before + landed
    # Strictly ahead is the goal. The margin is a cushion asked for on the way
    # up, not part of the test: a comment one clear of the rival IS the top one,
    # and buying the cushion costs another cooldown on a video already won.
    now_top = after > rival
    left = max(0, rival + margin - after)
    spent = bool(left) and likes > 0 and (int(likes * threshold) - after) < SMALLEST
    return now_top, left, spent


print("\nthe decision uses the count that landed:")
# Asked for 50, got 50: clear of a rival on 180.
check("  a full batch takes the lead", after_batch(171, 50, 140, 0, 1.0), (True, 0, False))
# THE CASE THIS EXISTS FOR. Asked for 50, 12 arrived. Assuming 50 would have
# called this a win and moved on, leaving the comment second.
check("  a short batch does not", after_batch(171, 12, 200, 0, 1.0), (False, 20, False))
check("  and assuming the full 50 would have said it did",
      after_batch(171, 50, 200, 0, 1.0)[0], True)
# One clear of the rival is the top comment, margin or no margin.
check("  one ahead is ahead", after_batch(171, 30, 200, 0, 1.0)[0], True)
check("  dead level is not", after_batch(171, 29, 200, 0, 1.0)[0], False)
# The ceiling is re-checked against the real number too, so a short batch does
# not spend headroom it never used.
check("  the ceiling is judged on the real count",
      after_batch(70, 10, 200, 100, 1.0)[2], True)
check("  30 of room is still room for a batch",
      after_batch(60, 10, 200, 100, 1.0)[2], False)
check("  room left after a short batch is still room",
      after_batch(40, 10, 200, 100, 1.0)[2], False)
check("  nothing landed at all", after_batch(171, 0, 200, 0, 1.0), (False, 32, False))

automate_src = (HERE / "automate.py").read_text(encoding="utf-8")
check("  every comment of ours is collected, not just the first",
      "EVERY COMMENT OF OURS ON THIS VIDEO" in automate_src, True)
check("  the second is not aimed at the first",
      "racing" in automate_src and "a section they already own" in automate_src, True)
check("  a half-finished video is not reported as done",
      "the run congratulating" in automate_src, True)
check("  and is_top means nothing is left here",
      "others_behind == 0" in automate_src, True)
# THE LIST CAN GO AWAY BETWEEN READING IT AND ACTING ON IT. Zefoy replaces the
# whole results panel with "Session expired. Please re-login." in place — the
# menu, the URL and the rest of the page are untouched. Every number read before
# that survives in memory, so the run looked like it was working: a rival on
# 6,071 hearts, ours on 0, the comment text empty, then five seconds spent
# waiting for a dropdown on a row that no longer existed.
# ZEFOY SELLS 25 OR 50 A SUBMIT — 75 and 100 are in the page source, commented
# out. A comment needing 313 gets 50 now and the rest over later rounds. That was
# reported as "313 not available", which reads like a fault; it is a price list.
# A BROWSER THAT IS GONE IS NOT A CAPTCHA THAT IS HARD. Over --cdp the adb
# forward disappears whenever the daemon drops the device, 127.0.0.1:9222 stops
# pointing at anything, and every later call answers "has been closed" — which
# read as "the captcha image never rendered", eight times, and then a prompt
# asking somebody to type a word into a window that cannot be reached.
print("\na dead connection is named, not retried:")
check("  there is a class for it", "class BrowserGone" in automate_src, True)
check("  a closed page is recognised", "def browser_gone(" in automate_src, True)
check("  so is a dropped socket",
      '"has been closed" in msg' in automate_src and '"websocket" in msg' in automate_src, True)
check("  the captcha loop stops instead of spinning",
      "EIGHT TRIES AT A BROWSER THAT IS NOT THERE" in automate_src, True)
check("  a dead page is not reported as 'no captcha here'",
      "ASKED FIRST, because a dead page answers" in automate_src, True)
check("  and nobody is asked to type into a window that is gone",
      "Nobody can type a word into a window that is not there" in automate_src, True)
check("  the message says how to put it back",
      "adb forward tcp:9222 localabstract:chrome_devtools_remote" in automate_src, True)

print("\nthe batch size is Zefoy's, and said as such:")
check("  the two real options are written down",
      "ZEFOY SELLS 25 OR 50 A SUBMIT" in automate_src, True)
check("  with the commented-out ones as evidence",
      "<!--<option value=" in automate_src, True)
check("  the note says what is left, not what failed",
      "left for the next round" in automate_src, True)
check("  and nothing prints 'not available' any more",
      'print(f"  [~] Dropdown: {hearts_sent} not available' in automate_src, False)
# Wanting fewer than the smallest batch is the one case worth flagging: the
# overshoot is unavoidable and can carry a comment past a ceiling.
check("  an unavoidable overshoot is still flagged",
      "wanted \u2014 sending" in automate_src, True)

print("\nthe session expiring mid-video is noticed:")
check("  an empty target row stops the attempt",
      "if not comment_text.strip():" in automate_src, True)
check("  and the expiry is named when that is why",
      "Session expired while reading the comment" in automate_src, True)
check("  a row that vanished for another reason is said differently",
      "The comment list went away before the heart could be sent" in automate_src, True)
check("  the words Zefoy actually uses are what is matched",
      "SESSION_GONE = " in automate_src and "please re-login" in automate_src, True)
# The div's id is a base64 blob Zefoy changes, so keying on it would work right
# up until it did not.
check("  matched on the text, not on the panel's id",
      "base64 blob" in automate_src, True)

print("\nand the watcher itself:")
check("  it stops once the target is reached", "target reached at" in automate_src, True)
check("  or once the count stops moving", "settled at" in automate_src, True)
check("  a vanished row ends it at the last number, not zero",
      "last seen at" in automate_src, True)
check("  the row is re-found by text, not by index",
      "an index that was right a moment ago" in automate_src, True)
# NOTHING SELF-IMPOSED IS LEFT on the Zefoy path. Zefoy meters hearts itself
# and says so — its countdown is read off the page and waited out — so a
# second delay of our own only made the run slower, never safer.
check("  no pause of our own between rounds",
      "NO SELF-IMPOSED PAUSE" in automate_src, True)
check("  none between videos either",
      "NOTHING BETWEEN VIDEOS EITHER" in automate_src, True)
check("  an unreadable count is not reported as zero",
      "COULD NOT READ IT IS NOT ZERO" in automate_src, True)
check("  and 'all of ours lead' shows the counts",
      "THE NUMBERS, not just the verdict" in automate_src, True)
check("  and it can be turned off", "--watch" in automate_src and "HEART_WATCH_SECONDS" in automate_src, True)

# ── the wiring, which no unit test can see ─────────────────────────────────
src = (HERE / "automate.py").read_text(encoding="utf-8")
print("\nand the wiring:")
check("  the ceiling is applied while chasing",
      "THE CEILING STILL APPLIES" in src, True)
check("  nothing is sent that would break it",
      "the one thing the threshold exists to prevent" in src, True)
check("  a capped video stops rather than burning rounds",
      "CAPPED IS AS FINISHED AS TOP" in src, True)
check("  and is not left pending for a pass that cannot help",
      "would re-scan it and reach the same answer" in src, True)
check("  an unknown like count is called out, not assumed",
      "cannot be applied here" in src, True)
check("  the log says which videos hit the ceiling",
      '"rival_hearts", "short_of_lead", "is_top", "capped",' in src, True)
check("  the scan records the best comment that is not ours",
      "THE BEST COMMENT THAT IS NOT ONE OF OURS" in src, True)
# Two of our comments can sit on one video. Taking the top ROW as the rival
# would have us racing ourselves to infinity.
check("  ours are excluded by keyword, not by position",
      "would have us racing ourselves" in src, True)
check("  --to-top takes the comment whatever it already has",
      "if to_top or choose_heart_count(" in src, True)
# "Leading comment now" was printed for the best comment that is not ours
# whether or not it actually led, so a video where ours had 12 hearts and the
# next best had 1 announced a leader and then said ours was already top — two
# true statements reading as a contradiction.
check("  the rival line says whether it is ahead or behind",
      "AHEAD OR BEHIND, said in those words" in src, True)
check("  and is labelled by which",
      "'Next best' if ahead else 'Ahead of us'" in src, True)
check("  already-leading is a success, not a skip",
      '"Already the top comment' in src, True)
check("  one batch per visit, re-read next visit",
      "re-reads the live counts rather than" in src, True)
check("  an unfinished video stays pending",
      "UNFINISHED VIDEOS STAY PENDING" in src, True)
check("  the log carries the rival and the gap",
      '"rival_hearts", "short_of_lead", "is_top",' in src, True)
check("  Freer is left aiming at the old target",
      "--to-top applies to Zefoy only" in src, True)
check("  and a plain list of links is accepted",
      "def _load_plain_links" in src, True)

# ── a plain list of links, end to end ──────────────────────────────────────
print("\na list of links is a list of links:")
tmp = HERE / "logs" / "_check_links.txt"
tmp.parent.mkdir(parents=True, exist_ok=True)
tmp.write_text(
    "https://www.tiktok.com/@a/video/111\n"
    "\n"
    "# a comment line\n"
    "  https://www.tiktok.com/@b/video/222  \n"
    "https://www.tiktok.com/@a/video/111\n"
    "https://example.com/not-tiktok\n",
    encoding="utf-8",
)
got = a.load_urls(str(tmp))
check("  two links, deduped, non-TikTok dropped", [e["url"] for e in got], [
    "https://www.tiktok.com/@a/video/111",
    "https://www.tiktok.com/@b/video/222",
])
check("  with no like count, which --to-top does not need",
      [e["like_count"] for e in got], [0, 0])
tmp.unlink(missing_ok=True)

# ── the dashboard's own link pool ──────────────────────────────────────────
#
# This tool used to work only from a CSV: a scrape frozen on the day it was
# taken, clustered locally — so "cluster 1" here and "cluster 1" on the admin
# links page were different sets of links sharing a name. --from-dashboard asks
# instead, which is the only way the two can agree, because clusters are
# relative and live nowhere in the database.
print("\nthe dashboard pool is wired in:")
check("  the token is read from either .env",
      "3_dashboard" in src and "LINKS_EXPORT_TOKEN" in src, True)
check("  the same endpoint the liker uses", "/api/links/clusters?" in src, True)
check("  a failure says so rather than looking empty",
      "looks\n    exactly like \"nothing matched\"" in src or
      'exactly like "nothing matched"' in src, True)
# BEST CLUSTER FIRST. The dashboard assigns the numbers and then returns the
# links in its own list order — a two-cluster selection came back with cluster 2
# at the top and the number changing 992 times on the way down, so a run that
# stopped early had spent its time on the worse half.
# "all" rather than "": PowerShell drops an empty quoted argument before the
# script sees it, and argparse then fails with "expected one argument".
check("  every cluster is asked for by name", '"all"' in src and "every shell" in src, True)
check("  blank and 0 mean the same thing",
      '("", "all", "0")' in src, True)
check("  and the state file is named for it, not left blank",
      'or "all"' in src, True)
check("  the links are ordered by cluster", "BEST CLUSTER FIRST" in src, True)
check("  with the sort done, not the clustering",
      'entries.sort(key=lambda e: (e["cluster"] is None, e["cluster"] or 0))' in src, True)
check("  a link with no cluster goes last", 'e["cluster"] is None' in src, True)
check("  and the run says what order it will work in",
      "best first, the dashboard's ranking within each" in src, True)
check("  the selection is NOT re-clustered here",
      "ALREADY CLUSTERED." in src, True)
check("  a --loop pass re-asks for the links",
      "links added since it started" in src, True)
# args.csv falls back to CSV_FILE in .env, which is almost always set, so
# `args.csv or <dashboard key>` picked the CSV's state file on EVERY dashboard
# run — skipping dashboard links on the strength of a CSV run's history and
# writing them into a file describing a different list.
check("  the state file follows the source, not the .env fallback",
      "THE SOURCE DECIDES THIS, NOT WHETHER A CSV HAPPENS TO BE CONFIGURED" in src, True)
check("  and args.csv cannot win when --from-dashboard is on",
      "if args.from_dashboard\n        else args.csv" in src, True)
check("  keywords can come from the active products",
      "THE PRODUCTS THE DASHBOARD HAS SWITCHED ON" in src, True)
# The clusters endpoint carries no like count, so the default heart target has
# nothing to work from. Said once at startup rather than quietly sending the
# smallest batch to every video.
check("  and the missing like counts are called out",
      "share-of-likes target has nothing to work from" in src, True)

# ── what counts as "nothing to do here" ────────────────────────────────────
# no_comment is an OBSERVATION: we read the comments and none are ours. The run
# acts on it — the link is recorded as done and never visited again, and the row
# goes into no_comment_*.csv, the file for working out why a keyword is missing.
#
# Four failures claimed it without having read anything: Zefoy's count button not
# appearing, and three Freer equivalents. Links the run never managed to open
# were retired as "no comment of ours", and the keyword-debugging file filled
# with rows that had no comments in them.
print("\nonly a real reading of the comments retires a link:")
check("  no matching comments does",
      "No matching comments for any keyword" in src and src.count("no_comment=True") > 0, True)
for note in ("Count button did not appear after Search",
             "Video info did not load after URL submit",
             "Show comments button did not appear",
             "Comment list did not appear"):
    # The call is `return fail("<note>")` with nothing after it: no no_comment.
    check(f"  {note.lower()} does not",
          f'fail("{note}")' in src, True)
check("  and only the true observations are left",
      src.count("no_comment=True"), 3)

# ── leading is not the same as carrying weight ─────────────────────────────
# A comment on eleven hearts tops a section whose next best is four, and under a
# video with forty thousand likes it still reads as a comment nobody noticed. The
# number beside it is the number a visitor judges it by, and it is being judged
# against the video — so a comment under HEART_FLOOR of the video's likes is
# worked EVEN WHEN IT ALREADY LEADS.
print("\na comment that leads but is thin for its video is still worked:")

FLOOR = a.HEART_FLOOR


def decide(ours, rival, likes, margin=3, threshold=0.85, floor=FLOOR):
    """The target in zefoy_process_url, as arithmetic: (what happened, sent)."""
    lead_at = rival + margin
    floor_at = int(likes * floor) if likes > 0 and floor > 0 else 0
    deficit = max(lead_at, floor_at) - ours
    if deficit <= 0:
        return "nothing to do", 0
    room = None
    if likes > 0:
        room = int(likes * threshold) - ours
        if room <= 0:
            return "at the ceiling", 0
    allowed = deficit if room is None else min(deficit, room)
    smallest = min(a._HEART_OPTIONS)
    if room is not None and allowed < smallest and ours == rival and room > 0:
        return "tie-break", smallest
    if room is not None and allowed < smallest:
        return "short", 0
    return "chasing", allowed


check("  the default floor is a quarter", FLOOR, 0.25)
# 40,000 likes -> a floor of 10,000 hearts. Leading on 11 is not enough.
check("  ours 11, rival 4, 40k likes", decide(11, 4, 40_000), ("chasing", 9_989))
check("  it stops at the floor", decide(10_000, 4, 40_000), ("nothing to do", 0))
# One heart short of the floor is still one heart short, and Zefoy's smallest
# batch is 25 — so it stops rather than overshooting a target it set itself.
check("  a heart short of the floor sends nothing", decide(9_999, 4, 40_000), ("short", 0))

print("\nthe two targets, and the further one wins:")
# 100 likes -> floor 25, but a rival on 80 needs 83.
check("  a strong rival beats the floor", decide(10, 80, 100), ("chasing", 73))
# 40,000 likes -> floor 10,000, and a rival on 4 needs 7.
check("  a weak rival loses to the floor", decide(0, 4, 40_000), ("chasing", 10_000))

print("\nthe floor sits under the ceiling, so they never fight:")
for likes in (100, 1_000, 40_000, 170_000):
    floor_at = int(likes * FLOOR)
    ceiling_at = int(likes * a.HEART_THRESHOLD)
    check(f"  {likes:,} likes: floor {floor_at:,} < ceiling {ceiling_at:,}",
          floor_at < ceiling_at, True)

print("\nand where the floor cannot apply, nothing changes:")
check("  an unknown like count has no floor", decide(11, 4, 0), ("nothing to do", 0))
check("  and --floor 0 makes leading enough",
      decide(11, 4, 40_000, floor=0), ("nothing to do", 0))

print("\nthe rule is in the file, and it reaches the run:")
check("  the setting exists", 'HEART_FLOOR     = float(os.getenv("HEART_FLOOR", "0.25"))' in src, True)
check("  a thin leader is picked up", "and o not in behind]" in src, True)
check("  behind is worked before thin", "queue = behind if behind else thin" in src, True)
check("  the target is the further of the two", "target_at = max(lead_at, floor_at)" in src, True)
check("  a video under the floor is not called done", "floor_met = True" in src, True)
check("  and a flag can set it", '"--floor", type=float' in src, True)

# ── a tie is not a lead ────────────────────────────────────────────────────
# Level with the best stranger, the only thing between our comment and the top
# of the section is the margin — three hearts — while the smallest batch Zefoy
# sells is twenty-five. The ceiling refused the whole thing, so the video was
# left exactly as found: tied, un-hearted, "stopping 3 short of the lead". That
# was a third of the videos in one run.
#
# On a tie, and only on a tie, a comment with room under the ceiling now gets one
# batch and the run moves on. It overshoots HEART_THRESHOLD deliberately.
print("\na tie is broken with one batch, then the run moves on:")

SMALLEST = min(a._HEART_OPTIONS)


def decide(ours, rival, likes, margin=3, threshold=0.85):
    """The decision in zefoy_process_url, as arithmetic.

    Returns (what happened, hearts sent, is this video finished).
    """
    deficit = rival + margin - ours
    if deficit <= 0:
        return "already top", 0, True
    room = None
    if likes > 0:
        room = int(likes * threshold) - ours
        if room <= 0:
            return "at the ceiling", 0, True
    allowed = deficit if room is None else min(deficit, room)
    if room is not None and allowed < SMALLEST and ours == rival and room > 0:
        return "tie-break", SMALLEST, True
    if room is not None and allowed < SMALLEST:
        return "short of the lead", 0, True
    return "chasing", allowed, False


check("  14 vs 14 on a 20-like video", decide(14, 14, 20), ("tie-break", SMALLEST, True))
check("  3 vs 3 on a 10-like video", decide(3, 3, 10), ("tie-break", SMALLEST, True))
# No room at all is not a tie worth breaking: there is nothing under the ceiling.
check("  0 vs 0 on a 1-like video", decide(0, 0, 1), ("at the ceiling", 0, True))

print("\nbehind rather than level is unchanged — the ceiling still refuses:")
check("  10 vs 14 on a 20-like video", decide(10, 14, 20), ("short of the lead", 0, True))
check("  0 vs 83 on a 100-like video", decide(0, 83, 100), ("chasing", 85, False))

print("\nand the paths either side of it are untouched:")
check("  already ahead", decide(60, 50, 1000), ("already top", 0, True))
check("  room for the whole chase", decide(0, 100, 1000), ("chasing", 103, False))
check("  no like count means no ceiling", decide(5, 5, 0), ("chasing", 3, False))

print("\nthe rule is in the file, and it finishes the video:")
check("  only on a tie",
      'and comment_hearts == rival["hearts"] and room > 0' in src, True)
check("  one batch", "allowed = smallest" in src, True)
check("  and no second round", "spent = tie_break" in src, True)
check("  the flag exists on every path", "        tie_break = False\n        if to_top:" in src, True)

# ── failures that are worth a second look ──────────────────────────────────
# Zefoy swaps the whole results panel out when it decides a session is over, and
# that can land between reading the comment list and hearting a row in it. Every
# number was read before the swap, so the run looked like it was working: a rival
# on 6,071 hearts, ours on 0, no comment text at all. The scan was fine a second
# earlier, so the answer is to read it again rather than give up on the video.
print("\nsome failures are worth one more look:")
check("  the vanished list says so", "retryable=True" in src, True)
check("  the visit acts on it",
      'elif not out["ok"] and out.get("retryable"):' in src, True)
check("  once, not in a loop", src.count('out.get("retryable")'), 1)

# A comment carries emoji; a Windows console is cp1252. Printing one raised
# UnicodeEncodeError inside the heart path, and the per-link handler recorded it
# as the video's own failure: measured, found 629 hearts behind, then abandoned
# over a glyph the terminal could not draw.
print("\nwhat the terminal can draw does not decide what gets hearted:")
check("  stdout is made utf-8", '_stream.reconfigure(encoding="utf-8"' in src, True)
check("  unprintable characters are replaced, not raised",
      'errors="replace"' in src, True)
check("  stderr too", "for _stream in (sys.stdout, sys.stderr):" in src, True)


# ── getting back to the comment we are going to heart ──────────────────────
# Comments are collected across every page, so the one worth hearting is often
# several pages back by the time the scan finishes. Going back failed outright on
# a deep page: "Could not return to the target comment page (1) to heart it", and
# the video was abandoned with nothing sent. Zefoy's pager is a sliding window —
# from page 5 the buttons read 3 4 5 6 7 — so there is no "1" to click.
print("\nthe pager is a window, so a far page is not always one click away:")


class Pager:
    """Zefoy's pagination, as a window of `width` either side of the current page."""

    def __init__(self, cur, total, width=2):
        self.cur, self.total, self.width = cur, total, width
        self.clicks = []
        self.wanted = None

    def visible(self):
        lo, hi = max(1, self.cur - self.width), min(self.total, self.cur + self.width)
        return list(range(lo, hi + 1))

    # Just enough of the Playwright locator surface for _zefoy_click_page.
    def locator(self, sel):
        return self

    def filter(self, has_text=None):
        self.wanted = next((n for n in self.visible() if has_text.match(str(n))), None)
        return self

    def count(self):
        return 1 if self.wanted else 0

    @property
    def first(self):
        return self

    def scroll_into_view_if_needed(self):
        pass

    def click(self):
        self.clicks.append(self.wanted)
        self.cur = self.wanted


_real_wait = a.page_wait
a.page_wait = lambda *x: None
try:
    pg = Pager(cur=5, total=9)
    check("  what is on screen", pg.visible(), [3, 4, 5, 6, 7])
    check("  no 1 to click", 1 in pg.visible(), False)

    print("\nwalking back one page at a time gets there anyway:")
    pg = Pager(cur=5, total=9)
    check("  it arrives", a._zefoy_goto_page(pg, 1, cur=5), True)
    check("  via its neighbours", pg.clicks, [4, 3, 2, 1])
    check("  and lands on page 1", pg.cur, 1)

    print("\na page already in the window is still one click:")
    pg = Pager(cur=5, total=9)
    check("  straight there", a._zefoy_goto_page(pg, 7, cur=5), True)
    check("  one click", pg.clicks, [7])

    print("\nforwards too, not only back:")
    pg = Pager(cur=1, total=9)
    check("  from the first page to the ninth", a._zefoy_goto_page(pg, 9, cur=1), True)
    check("  neighbour by neighbour", pg.clicks, [2, 3, 4, 5, 6, 7, 8, 9])

    print("\nand with no known current page it can only try the direct click:")
    pg = Pager(cur=5, total=9)
    check("  a far page fails", a._zefoy_goto_page(pg, 1), False)
    check("  without clicking anything", pg.clicks, [])
finally:
    a.page_wait = _real_wait

check("  the caller says which page it is on", "cur=cur_page)" in src, True)

env = a.load_env()
have = bool(env.get("DASHBOARD_URL")) and bool(env.get("LINKS_EXPORT_TOKEN"))
check("  both settings are present", have, True)

if have:
    print("\nand it answers (live):")
    try:
        entries, products = a.from_dashboard(
            "date", "1", {"platform": "tiktok", "limit": "50"}
        )
        check("  links came back", len(entries) > 0, True)
        check("  each is a TikTok URL",
              all("tiktok.com" in e["url"] for e in entries), True)
        check("  shaped like a CSV row",
              sorted(entries[0].keys()) == sorted(
                  ["url", "like_count", "search_rank", "posted_date",
                   "scraped_at", "cluster", "category"]), True)
        # THIS USED TO ASSERT {0}. The clusters endpoint now sends the like
        # count, so the share-of-likes ceiling works on dashboard links too —
        # the assertion was describing a gap that has since been closed.
        check("  every like count is a sane number",
              all(isinstance(e["like_count"], int) and e["like_count"] >= 0
                  for e in entries), True)
        with_likes = sum(1 for e in entries if e["like_count"] > 0)
        print(f"   {with_likes} of {len(entries)} link(s) came with a like count")
        check("  and the dashboard does send them now", with_likes > 0, True)
        check("  and the active products came too", len(products) > 0, True)
    except SystemExit as e:
        check(f"  the dashboard answered ({e})", False, True)
else:
    print("   (skipping the live call: DASHBOARD_URL / LINKS_EXPORT_TOKEN not set)")

print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
