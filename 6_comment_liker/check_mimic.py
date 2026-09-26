"""Comment like the thread is already talking, or don't comment at all.

A stored comment is written to be good anywhere, which is exactly what makes it
read as imported when it lands under a video where everybody is talking about
one particular rival tool. The best comment on a link like that is the one the
thread is already having, with our product's name in it.

So: read the video's own comments, find one recommending a rival, and ask the
dashboard for one in the same vein. Measured, against the real model:

    in   quillbot never worked for me but stealthwriter actually passes turnitin
    out  prohumanly comes back clean on turnitin for me

    in   ngl walterwrites got me through finals, tried everything else first
    out  prohumanly saved my english essay last week

    in   bro just use grubbyai it passed my whole essay first try
    out  used prohumanly for my term project last week

WHAT THIS IS NOT is a copy with the brand swapped. The same sentence under
fifty videos is a pattern somebody can search for, and swapping a name leaves
somebody else's sentence with ours in it.

THE FALLBACK IS THE FEATURE. No rival in the thread, a model that times out, a
line the filters reject — all three mean the same thing to the run: post a
stored comment instead. None of them is a reason to post something that has not
been through the dashboard's filters, and none is a reason to stop.

    python check_mimic.py
"""
import re
import sys
from pathlib import Path

import dashboard_settings as ds
import like

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


src = Path("like.py").read_text(encoding="utf-8")

print("finding the comment that recommends somebody else")
# A brand is spelled however the commenter feels like: "Walter Writes",
# "#walterwrites!", "WALTERWRITES".
check("  spacing does not hide it", like.flatten("Walter Writes"), "walterwrites")
check("  nor punctuation", like.flatten("#walterwrites!"), "walterwrites")
check("  nor case", like.flatten("QuillBot"), "quillbot")

# The list comes from the dashboard. Two lists of rival names in two projects is
# one list that is wrong within a month.
check("  the list is fetched, not hardcoded", "def rival_brands" in src, True)
check("  from the dashboard", '"/api/links/mimic?"' in src, True)
check("  and cached for the run", "global _RIVALS" in src, True)
check("  a run with no dashboard configured just finds nothing",
      re.search(r"if not base or not token:\s*\n\s*return _RIVALS", src) is not None, True)

like._RIVALS = ["walterwrites", "quillbot"]
THREAD = [
    {"text": "this is so funny"},
    {"text": "quillbot 🔥"},
    {"text": "ngl quillbot got me through finals, tried everything else first"},
]
sample, brand = like.rival_comment(THREAD)
# The LONGEST match: a two-word comment is no style reference at all.
check("  the longest mention wins", sample.startswith("ngl quillbot got me"), True)
check("  and it says which rival", brand, "quillbot")
check("  a thread with no rival gives nothing", like.rival_comment([{"text": "first"}]), ("", ""))
check("  and so does a run with no list",
      (setattr(like, "_RIVALS", []), like.rival_comment(THREAD))[1], ("", ""))

print("\nthe order the comment is chosen in")
check("  there is one function that decides", "def comment_for" in src, True)
check("  the mimic is tried first", src.index("mimic_from_dashboard(url, sample") <
      src.index("if not text:\n        text, prod = comment_from_dashboard("), True)
check("  only when the setting is on", 'getattr(args, "mimic_comments", False)' in src, True)
check("  and only when the thread has a rival in it",
      re.search(r"sample, brand = rival_comment\(aweme_comments\)\s*\n\s*if sample:", src) is not None, True)
# Every failure lands in the same place.
check("  nothing usable falls back", "nothing usable came back" in src, True)
check("  an HTTP error falls back", "dashboard would not write one" in src, True)
check("  an unreachable dashboard falls back", "could not reach the dashboard to write one" in src, True)
# Where a comment came from is in the log and the ledger: one nobody can
# explain later is worse than no comment.
check("  the source is reported", 'f"mimic:{rival or brand}"' in src, True)
check("  and the bank says so too", 'text, prod, source = "", "", "bank"' in src, True)
# ONE RETURN, because every comment now passes the de-brander on its way out and
# a second exit would be a way to skip it.
check("  every path leaves through one return",
      src.count("return text, prod, source"), 1)
check("  the run prints it", "({source})" in src, True)
check("  and so does a dry run", "WOULD COMMENT ({prod}, {source})" in src, True)

print("\ncomment only, never like")
check("  there is a switch", "--no-like" in src, True)
# It empties the like list and nothing else: `hits` is what decides whether the
# video carries a comment of ours, and that question is the whole basis of the
# commenting path.
check("  it empties the like targets",
      re.search(r"picks = \(\[\] if args\.no_like", src) is not None, True)
check("  and leaves the rest of the read alone", "hits = sum(1 for c in comments" in src, True)
check("  the help says it needs --comment-empty", "pointless without --comment-empty" in src, True)

print("\ncommenting needs the product list, even with nothing being liked")
# "Post on a video that carries none of our comments" is decided by counting the
# comments that name one of our products. With the list empty that count is zero
# on EVERY video, so the run would comment under videos it has already commented
# under — in public, from accounts trying not to look automated. And it is a
# likely combination: switching off liking and switching off "active products
# only" both feel like ways of saying "do not like things".
check("  refused before a browser opens", "--comment-empty needs --products" in src, True)
check("  saying what goes wrong", "already commented under" in src, True)
check("  and where to fix it", "tick 'Active products only'" in src, True)
check("  with an exit code, not a warning",
      re.search(r"tick 'Active products only'[\s\S]{0,160}?return 2", src) is not None, True)

print("\nand the run says what it is actually doing")
# A banner reading "liking comments for: ..." under --no-like is the run
# describing work it will not do.
check("  not liking is said out loud", "NOT liking anything" in src, True)

print("\na commenting run pulls only the links that need one")
# Without it the run pulls the whole cluster and opens every video to find out.
# Measured against the real dashboard: 1,381 links in, 712 out — 669 videos not
# opened at all, which is most of an hour of page loads.
check("  asked for on a comment-only run",
      '"withoutOurs": "1" if (args.comment_empty and args.no_like) else ""' in src, True)
# NOT on a run that also likes: those links are the ones with something to like.
check("  and never when liking too", '"withoutOurs": "1" if args.comment_empty else ""' in src,
      False)
check("  the run says how many were skipped", "already carry one of our comments" in src, True)
# A dashboard that predates the parameter ignores it and answers with
# everything. That is fine — the per-video check is what actually decides — but
# it should not look like the filter worked.
check("  an older dashboard is noticed",
      "does not know the withoutOurs filter yet" in src, True)
# The filter only removes links KNOWN to carry one of ours. A link nobody has
# scanned is not known to be clean and still comes back.
check("  and the per-video check still runs",
      "each video is checked before anything is written" in src, True)

print("\nand nothing can like under --no-like")
# The like list is emptied, which makes the loop skip each video long before the
# DOM sweep — but the sweep is the second path that can press a heart, and a
# switch meaning "like nothing" should not depend on control flow three screens
# away.
check("  the sweep is guarded too", "not args.no_dom_sweep and not args.no_like" in src, True)

print("\nthe comment box cannot be clicked, so it is not clicked")
# Every comment in a real run failed on the same line:
#
#   NOT posted - could not type: ElementHandle.click: Timeout 30000ms exceeded
#
# TikTok's editor is Draft.js and its placeholder ("Add comment...") sits ON TOP
# of the contenteditable. Measured: a click at the centre of the box lands on
# DIV.public-DraftEditorPlaceholder-inner, so Playwright waits for the element
# to start receiving pointer events and gives up thirty seconds later — three
# times a video, on every video.
check("  the measurement is written down",
      "public-DraftEditorPlaceholder-inner" in src, True)
# Focus is what typing needs. Three ways, cheapest first.
check("  the wrapper is clicked first", 'page.click(\'[data-e2e="comment-input"]\', timeout=3000)' in src, True)
check("  then a forced click", "box.click(force=True, timeout=3000)" in src, True)
check("  then focus outright", 'box.evaluate("el => el.focus()")' in src, True)
# A route that will not work should cost three seconds, not thirty.
check("  and none of them can hang", src.count("timeout=3000") >= 2, True)
check("  the old blocking click is gone", "\n        box.click()\n" in src, False)
# The arbiter is unchanged: a comment counts as posted only when it is found on
# the page afterwards.
check("  posting is still verified, not assumed", "verified on the page" in src, True)

print("\nevery link addressed, when that is what is asked for")
# --comment-empty on its own means "like what is there, and write on the videos
# that have nothing of ours". The withoutOurs filter drops exactly the links
# that HAVE our comments — the ones with something to like — so applying it to
# that combination would leave a run that likes nothing at all.
check("  the filter is only for a comment-only run",
      '"withoutOurs": "1" if (args.comment_empty and args.no_like) else ""' in src, True)
check("  and the trap is written down", "the run would like nothing at all" in src, True)
# The page says which of the four jobs the switches add up to, because working
# it out means reading three checkboxes in two groups.
html2 = Path("dashboard.html").read_text(encoding="utf-8")
check("  the page names the job", "Every link is addressed:" in html2, True)
check("  including likes only", "<b>Likes only.</b>" in html2, True)
check("  and comments only", "<b>Comments only.</b>" in html2, True)
check("  and says when it is matching the thread",
      "written to match it" in html2, True)

print("\nand what we posted can be checked afterwards")
vc = Path("verify_comments.py").read_text(encoding="utf-8")
like_src = Path("like.py").read_text(encoding="utf-8")
# The ledger already holds every posted comment: url, video, text, keyed
# "post:<aweme>".
check("  the list comes from the ledger", 'str(r[3]).startswith("post:")' in vc, True)
check("  only the ones that were actually posted", 'r[6] != "ok"' in vc, True)
# THE HANDLE IS NOT THE NAME. The passport endpoint answers "misgana a"; a
# comment is attributed to "drnardime". Comparing the two reported 4 of 4
# comments as removed when all four were on the page.
check("  the handle comes from the nav link", 'a[href^="/@"]' in vc, True)
check("  and the mistake is written down", "which is not our name" in vc.lower()
      or "NOT OUR NAME" in vc, True)
# The text is what identifies a comment: the ledger holds the exact words.
check("  a comment is found by its text", "THE TEXT IS THE IDENTIFIER" in vc, True)
check("  a survivor with different text is not counted as gone",
      'return "changed"' in vc, True)
check("  and an unreadable video is not counted either",
      'return "unknown"' in vc, True)
check("  nothing is written by the check", "It is not a re-post" in vc, True)
# THE PROFILE BEING CHECKED MAY BE BUSY, and usually is: the moment somebody
# asks is right after a run posted the comments. It is not the one looking.
check("  the reader is the one that has to be free",
      "busy.is_busy(profile_dir(n))" in vc, True)

print("\nthe check asks the dashboard, the way the admin does")
# lib/commentPresence judge(): one plain read of TikTok's comment list from the
# dashboard's own server, nobody signed in. Two reasons it is the better answer,
# both measured:
#   IT WORKS. The same request from this machine returns one to four comments on
#   a video with hundreds. The dashboard's server reads about fifty a link.
#   IT IS THE PUBLIC VIEW. A comment read from the account that wrote it proves
#   only that its author can see it — TikTok shows a filtered comment to its
#   author and to nobody else.
check("  it asks first", "def ask_dashboard" in vc, True)
check("  before opening any browser",
      vc.index("def ask_dashboard") < vc.index("def check_one"), True)
check("  at the endpoint the admin's read backs",
      '"/api/links/comment-check?"' in vc, True)
check("  in batches, because each item is a round trip", "rows[i:i + 25]" in vc, True)
check("  and the reason is written down", "what everyone else sees" in vc.lower()
      or "IT IS WHAT EVERYONE ELSE SEES" in vc, True)

print("\nand a miss is settled by the second source, not by arithmetic")
# Three rules for "we read enough to call it gone" were tried against real
# videos and all three were wrong:
#   complete        a 4-comment read called itself complete on a video whose
#                   page said 8, and reported a live comment as deleted.
#   read >= 10      these links are the freshest in the pool; their pages say
#                   1, 8, 5, 3. Nothing would ever be judged... except that
#   read >= total   TikTok's total is throttled with the list — "1 of 1" for a
#                   video showing two comments, one of them ours.
# So a hit is conclusive and a miss is not, and the account's own browser is
# asked about the misses.
check("  a public hit ends it", "in the public list, as @" in vc, True)
check("  a miss goes to a signed-in account",
      "asking signed-in accounts to look" in vc, True)
# NOT SERVED TO ANY READER is its own answer, and the useful one: the comment
# was posted, it cost a run, and it is reaching nobody who went looking.
check("  which can find it unseen", "UNSEEN" in vc, True)
check("  reported as its own state", '"unseen"' in vc, True)
check("  and counted apart from still-there", 'totals["unseen"]' in vc, True)
# But only when the public read was worth trusting, or it is the same confident
# guess in a new costume.
check("  claimed only on a read worth trusting", 'get("thin", True)' in vc, True)
check("  and a short read is not promoted to a verdict",
      "list came back short" in vc, True)

print("\nand a thin read is never called a deletion")
# A read of FOUR comments, marked complete, reported a comment as deleted that
# its author's browser found minutes later — along with six others like it.
route = Path("../3_dashboard/app/api/links/comment-check/route.ts").read_text(encoding="utf-8")
check("  the guard exists", "const thin = read.comments.length < 10" in route, True)
check("  it does not trust TikTok's own total", "throttled along" in route, True)
check("  the measurement is written down", '"1 of 1" for a video' in route, True)
check("  a hit still counts on a partial read", "found ||" in route, True)
# A thin read is never the last word: the liker says so and asks the browser.
check("  a thin read is never the last word",
      "every one of those reads came back thin" in vc, True)
check("  and the summary says which question it answered",
      "not a comment anybody else can" in vc, True)

print("\nand the looking is done by somebody who did not write it")
# THE AUTHOR IS THE ONE READER THAT CANNOT ANSWER. TikTok shows a restricted
# comment to its author exactly as if nothing were wrong, so the author's own
# browser reports "still there" for a comment nobody else can see. Measured on
# comments by @drnardime (profile a):
#   as Misgana Workineh   1 and 4 comments read, ours not among them
#   as Martha A943        8 comments read,       ours not among them
#   as Misgana a          found every one of them — AND IS profile a's own
#                         account, held by a second directory, profile-default
# So a hit by anybody else ends it, a miss by one account is not evidence, and
# an account has to be identified by its login and never by its directory.
check("  the finding is written down", "coin toss" in vc, True)
check("  with the numbers", "1 and 4 comments read" in vc, True)
check("  so the author is not the reader", "def reader_candidates" in vc, True)
check("  a hit by any reader ends it", "A HIT ENDS IT" in vc, True)
check("  a miss goes to the next account", "still unseen — asking" in vc, True)
check("  more than one reader by default", '"--readers", type=int, default=2' in vc,
      True)
# TWO DIRECTORIES CAN BE ONE ACCOUNT: `default` and `a` are both @drnardime, and
# `3` and `c` are both Martha A943.
check("  profiles on the author's account come out",
      'known.get(n) or ""' in vc, True)
check("  and a reader that wrote it is dropped mid-pass", 'return "self"' in vc, True)
check("  which says so rather than counting it", "barring that account" in vc, True)
check("  and every directory on that login with it", "blocked.add(" in vc, True)
# ONE ACCOUNT, THREE NAMES: @drnardime / screen_name "misgana a" / nickname
# "dr. nardi". The handle is the one that matches a comment's attribution.
check("  the three names are written down", "ONE ACCOUNT, THREE NAMES" in vc, True)
check("  the handle is what the self test compares",
      "writer == reader_handle" in vc, True)
# AND THE HANDLE IS READ FROM THE NAV ONLY. The old fallback to the first
# a[href^="/@"] on the page named the creator of the video being read, which is
# what hid profile-default being profile a.
check("  no falling back to any profile link on the page",
      'a[href^="/@"]\')' not in vc, True)
check("  and the trap is written down", "is the creator of the video" in vc, True)
# The verdict claims what was measured and not a word more.
check("  the word restricted is not claimed on a reader miss",
      'IT IS DELIBERATELY NOT CALLED "RESTRICTED"' in vc, True)
check("  it is claimed on a signed-out miss", "RESTRICTED: its author sees it" in vc,
      True)
# Nobody free to look is its own outcome, and it is not "your comments are gone".
check("  nobody free to look is not a verdict", "nobody was free to look" in vc, True)
check("  there is a wait for one", '"--wait"' in vc or "--wait" in vc, True)
check("  it says what it is waiting for", "waiting up to" in vc, True)
check("  it rechecks rather than trusting a cache",
      "busy.is_busy(profile_dir(n), force=True)" in vc, True)
dash3 = Path("dashboard.py").read_text(encoding="utf-8")
check("  and the button waits by default", '"--wait", "180"' in dash3, True)
check("  the button says who reads", "DIFFERENT account" in html2, True)

print("\nand the product goes in as words, not as a brand")
# WHY THIS IS NOT A STYLE PREFERENCE. Twenty-one comments were posted from four
# accounts, every one naming its product as a single word. Read back later by
# other signed-in accounts, not one was visible to anybody but its author — on
# videos where those readers were served other people's comments quite happily.
check("  the table is here too", '"purifytext": "purify text"' in like_src, True)
check("  all seven products", like_src.count('": "') >= 7, True)
check("  and the reason is written down", "reads as an advert to a person" in like_src,
      True)
# The dashboard's prompt asks for this form. A prompt is a request; this is the
# last thing that touches the text before it is typed.
check("  the liker rewrites it anyway", "def debrand" in like_src, True)
check("  as the safety net, not the mechanism", "THIS IS THE SAFETY NET" in like_src,
      True)
check("  applied to whatever wrote the comment",
      "LAST STOP BEFORE IT IS TYPED" in like_src, True)
check("  and it says what it changed", "written as words, not a brand" in like_src, True)

# Behaviour, not wording.
for src, want in [
    ("purifytext made the stress go away", "purify text made the stress go away"),
    ('i use "Purify Text" daily', "i use purify text daily"),
    ("#PurifyText saved me", "purify text saved me"),
    # AN INFLECTION SURVIVES: only the name is replaced, so the grammar the model
    # wrote stays. This is the form the account asked for.
    ("i purifytexted my essay", "i purify texted my essay"),
    ("tried Acoustic-Text and prohumanly", "tried acoustic text and pro humanly"),
]:
    check(f"  {src!r}", like.debrand(src)[0], want)
check("  and an already-plain one is left alone",
      like.debrand("purify text is fine"), ("purify text is fine", ""))

# THE INVARIANT THAT WOULD FAIL SILENTLY. Every product matcher here and in the
# dashboard flattens to letters and digits and asks for a SUBSTRING, so a form
# that moved the stem — "purity texting" — would read just as well and would be
# invisible to every check we have, including the admin's own comment-existence
# read.
for form in ["purify text", "purify texted", "purify texting", "purify texts"]:
    check(f"  {form!r} still resolves to the product",
          "purifytext" in like.norm(form), True)
check("  and the form that would break it is named",
      "purity" in like_src and "invisible to every check" in like_src, True)

print("\nand the links themselves can be listed")
# The ledger already holds every one: the url, the video, the product and the
# exact words. Printing them needs no browser and no network, which is what
# makes it answerable while every profile is in a run.
check("  there is a list mode", '"--list"' in vc, True)
check("  it opens nothing", "No browser and no network" in vc, True)
check("  the link is shown", "row['url']" in vc, True)
check("  with the words that were posted", "row['text']" in vc, True)
check("  and the product they were for", "row['product']" in vc, True)
# AND WHAT THE LAST CHECK FOUND, because the check is expensive and its answer is
# one line. Without it the list is only what we posted, which the ledger already
# says.
check("  verdicts are written down", "def note_checks" in vc, True)
check("  in their own file", 'CHECKS = HERE / "comment-checks.csv"' in vc, True)
check("  read back into the list", "def last_checks" in vc, True)
# A later run that found nobody free to look must not erase a real answer.
check("  a later 'could not check' does not erase one",
      "THE MOST RECENT CONCLUSIVE ONE" in vc, True)
check("  and a link never checked says so", "not checked yet" in vc, True)
dash4 = Path("dashboard.py").read_text(encoding="utf-8")
check("  the dashboard offers it", '"commented": lambda p' in dash4, True)
check("  on TikTok only, like the other readers",
      '"commented"' in dash4.split("TIKTOK_ONLY")[1][:140], True)
check("  with a button for every account and one each",
      html2.count("tool('commented'"), 2)

print("\nwith a button for it")
dash2 = Path("dashboard.py").read_text(encoding="utf-8")
check("  one profile at a time", '"comments": lambda p' in dash2, True)
check("  or every one that has posted", '["--all"]' in dash2, True)
check("  on TikTok only, like the other readers",
      '"comments"' in dash2.split("TIKTOK_ONLY")[1][:120], True)
check("  the page has both buttons", html2.count("tool('comments'"), 2)

print("\nboth switches reach both scripts")
for key, flag in (("mimic_comments", "--mimic-comments"), ("no_like", "--no-like")):
    f = ds.BY_KEY[key]
    check(f"  {key} is offered", f.flag, flag)
    check(f"  to like.py and run_parallel", sorted(f.targets), ["like", "parallel"])
    s = dict(ds.defaults(), **{key: True})
    check(f"  in the single command", flag in ds.like_command("py", "l.py", "a", s), True)
    check(f"  and the collection one", flag in ds.parallel_command("py", "r.py", ["a"], s), True)
# Off unless asked: one posts something public, the other silently stops a run
# doing the thing it is usually for.
check("  both off by default", (ds.defaults()["mimic_comments"], ds.defaults()["no_like"]),
      (False, False))
# They live with the other things that write or undo, not among the harmless
# ones.
check("  and they sit with the dangerous settings",
      (ds.BY_KEY["mimic_comments"].group, ds.BY_KEY["no_like"].group), ("danger", "danger"))

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
