"""A site that will not answer has not said the account is logged out.

After a seventeen-account run, `login.py --check` reported this:

    profile profile-a: NOT signed in (HTTP 403)
    profile profile-b: NOT signed in (HTTP 403)
    profile profile-c: NOT signed in (HTTP 403)

The sessions were fine. A page-level probe of the same three profiles, at the
same moment, said so plainly:

    passport endpoint says: signed_in=False  'HTTP 403'
    the PAGE says logged out: False
    nav: {'hasProfileIcon': False, 'hasInbox': False, 'loginButton': False}

No login button, no logged-out shell. TikTok had simply decided to stop
answering this machine — which is what it does when seventeen browsers ask it
things at once. The check asked, was refused, and reported the refusal as a
verdict.

That mattered in three places at once, all of them costly:

  * `login.py --check` tells somebody to sign in again. Seventeen accounts, by
    hand, each with a password and a code off a phone, to fix nothing.
  * `sessions.py` writes every one of them onto the `#not-signed-in` line, which
    is the file's record of "we looked and there was no session". The next
    reader believes it.
  * `like.py` stops the run with "Not signed in on profile 'a'".

So there is a third answer now, between "signed in" and "signed out": the site
would not say. It is never written to the file as a negative, it keeps whatever
was already known about the profile, and every message about it says to wait
rather than to log in.

    python check_throttled.py
"""
import re
import sys
import tempfile
from pathlib import Path

import login
import sessions

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


src = {f: Path(f).read_text(encoding="utf-8")
       for f in ("login.py", "sessions.py", "like.py", "like_web.py")}

print("what counts as the site refusing to answer")
# The measured one. 403 is what arrived.
check("  a 403", login.is_refusal("HTTP 403"), True)
check("  a 429, the other throttle", login.is_refusal("HTTP 429"), True)
check("  anything 5xx — the site being broken is not the account being logged out",
      login.is_refusal("HTTP 503"), True)
# These two are this code failing to ask, not the site answering.
check("  the probe itself blowing up", login.is_refusal("probe failed: Execution context"), True)
check("  a reply that was not JSON", login.is_refusal("no JSON"), True)

print("\nand what does not")
# The real signed-out answers must still read as signed out, or the fix has
# simply moved the wrong verdict to the other side.
check("  a plain no", login.is_refusal("not signed in"), False)
# TikTok's own word for "you are not logged in" is the message "error", which
# is exactly the sort of string a careless match would swallow.
check("  tiktok's word for it", login.is_refusal("error"), False)
check("  an empty reason", login.is_refusal(""), False)
check("  no reason at all", login.is_refusal(None), False)

print("\nthe scan gets a state for it, kept apart from signed out")
check("  the probe raises it", '"refused"' in src["sessions.py"], True)
check("  only on a refusal", "if not ok and is_refusal(who)" in src["sessions.py"], True)
# The one line that must never carry a refused profile. read_checked() reads it
# back as "we looked and found no session", which is the opinion this run does
# not have.
neg = re.search(r"negative = (.+)", src["sessions.py"]).group(1)
check("  the not-signed-in line is out + none + bad", neg, "out + none + bad")
check("  with refused nowhere in it", "refused" in neg, False)
check("  and the code says why", "has not\n    # been judged" in src["sessions.py"], True)
# The file is read by people as well as by read_checked().
check("  the file explains the non-answer", "# NO ANSWER" in src["sessions.py"], True)
check("  telling the reader not to act on it",
      "do not sign them in on this" in src["sessions.py"], True)
check("  the terminal says it too", "no answer — the site would not say" in src["sessions.py"], True)
check("  and blames the right thing", "throttling this machine" in src["sessions.py"], True)

print("\nnothing learned means nothing unlearned")
# A profile that was listed yesterday and refused to answer today keeps its
# entry. Dropping it would shorten the --profiles line somebody pastes into the
# next run, on the strength of an answer the site never gave.
check("  the existing file is read even on a full scan",
      "previous = read_file(out_path)\n" in src["sessions.py"], True)
# In-use is the same kind of non-answer and carries the same way: another
# browser had the profile, so its cookies could not be read at all. See busy.py.
check("  a refused profile keeps its previous entry",
      'if r.state in ("refused", "in-use") and name in previous' in src["sessions.py"], True)
check("  as a carried row, not a fresh one",
      re.search(r'r\.state in \("refused", "in-use"\) and name in previous[\s\S]{0,500}?carried=True',
                src["sessions.py"]) is not None, True)
# Carried is already the file's word for "not re-checked on this run", which is
# precisely what a refusal means.
check("  and carried rows are already marked in the header",
      "carried over from an earlier run and not re-checked" in src["sessions.py"], True)

print("\nthe file survives a scan where every profile is refused")
tmp = Path(tempfile.mkdtemp(prefix="thr-"))
out = tmp / "sessions-tiktok.txt"
sessions.write_file(out, "tiktok", [
    sessions.Result("a", "in", account="@one"),
    sessions.Result("b", "in", account="@two"),
])
before = sessions.read_file(out)
check("  two listed to begin with", sorted(before), ["a", "b"])


def not_signed_in(path):
    """The names on the file's #not-signed-in line, which is its record of
    'we looked and there was no session'. read_checked() is a wider question —
    it returns everyone the file has any opinion about, including the live
    ones — so it cannot answer this."""
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#not-signed-in "):
            return {n.strip() for n in line[len("#not-signed-in "):].split(",") if n.strip()}
    return set()


# Now the throttled scan: nothing is known, so the rows are carried.
sessions.write_file(out, "tiktok", [
    sessions.Result("a", "in", account="@one", carried=True),
    sessions.Result("b", "in", account="@two", carried=True),
])
check("  both still listed afterwards", sorted(sessions.read_file(out)), ["a", "b"])
check("  and neither was recorded as signed out", not_signed_in(out), set())
# The genuinely signed-out ones must still land on that line, or the file has
# stopped being able to say anything.
sessions.write_file(out, "tiktok", [
    sessions.Result("a", "in", account="@one"),
    sessions.Result("b", "out", detail="not signed in"),
    sessions.Result("c", "refused", detail="HTTP 403"),
])
check("  a real signed-out profile is still recorded", not_signed_in(out), {"b"})
check("  the refused one is not", "c" in not_signed_in(out), False)
check("  though the file still mentions it", "\n#   c" in out.read_text(encoding="utf-8"), True)

print("\na refused check does not cost the shard")
# From the dashboard run this came from:
#
#   1363 video(s). 4140 comment(s) already done.
#   TikTok would not answer about profile 'a' (HTTP 403).
#
# ...and the profile stopped. Seventeen browsers asking the same endpoint
# within seconds of launch is enough to earn a 403, and `login.py --check` had
# said "signed in as Misgana a" a minute earlier. Giving up there throws away
# 1,363 links over a question that has a second, better source: the rendered
# page. A logged-out TikTok shows a Log in button and no profile icon.
like_src = src["like.py"]
check("  the probe can be asked again", "def ask_who()" in like_src, True)
check("  and is, after waiting", "for wait_s in (10, 30, 60):" in like_src, True)
check("  saying what it is still getting", "still {acct.get('reason')} after" in like_src, True)
# Not hard_reload(): that waits for a comment icon the home page does not have,
# so every attempt would burn a timeout before asking anything.
check("  reloading the home page directly", "wait_until=\"domcontentloaded\"" in like_src, True)
# The fallback, and the whole point: the page is asked, and believed.
check("  then the page is asked", re.search(
    r"for wait_s in \(10, 30, 60\)[\s\S]{0,1400}?if page_is_logged_out\(page\):",
    like_src) is not None, True)
check("  a page that really is logged out still stops the run", re.search(
    r"if page_is_logged_out\(page\):[\s\S]{0,400}?return 1", like_src) is not None, True)
check("  telling that one to sign in", re.search(
    r"if page_is_logged_out\(page\):[\s\S]{0,300}?python login\.py --profile",
    like_src) is not None, True)
# And a page that looks fine carries on, which is the behaviour that was
# missing: the run continues rather than the account being abandoned.
check("  a page that looks signed in carries on", "Carrying on." in like_src, True)
check("  without claiming to know who it is",
      "unknown — TikTok would not say" in like_src, True)
check("  blaming the concurrency it came from",
      "accounts at once" in like_src, True)
check("  and not the account", "Do NOT sign this profile in again" in like_src, True)

print("\nthe header counts this run, not the file's memory")
# Real output from `python sessions.py --profiles a`, where a was signed in:
#
#   # 18 listed. 1 checked just now, 1 signed out; 18 carried over...
#
# Nothing was signed out. The counts were drawn from the whole results list,
# which carries every row read back out of the old file, so somebody else's
# answer from weeks ago was reported as this run's finding.
out2 = tmp / "counts.txt"
sessions.write_file(out2, "tiktok", [
    sessions.Result("a", "in", account="@one"),
    sessions.Result("q", "out", carried=True),
    sessions.Result("z", "out", detail="not signed in"),
])
header = out2.read_text(encoding="utf-8").splitlines()[1]
check("  two checked, one of them signed out", "2 checked just now, 1 signed out" in header, True)
check("  and the carried one is named as carried", "1 carried over" in header, True)
# The carried negative still belongs on the line: checking a must not make the
# file forget that q was looked at.
check("  which does not drop it from the record", not_signed_in(out2), {"q", "z"})

print("\nlogin.py --check says which of the two it got")
check("  a refusal is not called NOT signed in",
      re.search(r'elif is_refusal\(who\)[\s\S]{0,200}?NO ANSWER', src["login.py"]) is not None, True)
check("  and says to wait rather than sign in",
      "rather than signing in again" in src["login.py"], True)
# Exit code 2, not 1. A caller that treats every non-zero as "re-login this
# account" would otherwise do the one thing this whole change exists to stop.
check("  with its own exit code", "return 0 if ok else (2 if is_refusal(who) else 1)"
      in src["login.py"], True)

print("\nand a run stops with the right instruction")
check("  like.py asks for the reason, not just the name",
      "acct.get(\"who\")" in src["like.py"], True)
check("  a refusal is handled first", 'if not who and is_refusal(acct.get("reason")):'
      in src["like.py"], True)
check("  saying it is the machine, not the account",
      "This is throttling, from {args.window_count} accounts at once" in src["like.py"], True)
check("  and pointing at the actual lever", "--at-once" in src["like.py"], True)
# A genuine signed-out account must still be told to log in.
check("  a real signed-out profile still gets the login line",
      "Run: python login.py --profile {args.profile}" in src["like.py"], True)
# An unreadable probe (safe_eval swallows a destroyed context and returns None)
# is a refusal, not a verdict: it is this code failing to ask.
check("  an unreadable probe counts as no answer",
      '{"reason": "probe failed"}' in src["like.py"], True)
check("  the other liker agrees", 'refused = is_refusal(who)' in src["like_web.py"], True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
