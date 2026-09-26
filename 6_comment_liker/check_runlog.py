"""When an account stops, does the run say why — and say it in a file?

Nine accounts interleave into one terminal, so the answer scrolls past in
seconds. And the exit CODE cannot give it: like.py returns 1 for "worked the
whole list, some likes failed" AND Python exits 1 on an uncaught traceback, so
from outside the two are identical.

What separates them is the closing summary. like.py prints
"N liked, M failed ... Log: ..." as the last thing it does, so a worker that
printed it reached the end of its list and one that did not stopped somewhere.
Everything here rests on that line.

The cases that must not be confused with each other:

    worked its whole list          exit 0, summary printed
    finished, some likes failed    exit 1, summary printed  <- NOT a crash
    crashed                        traceback, no summary
    died before printing anything  no output at all — Chrome would not start
    killed: past the time limit    the parent stopped it, whatever it was doing
    logged out / captcha / ...     like.py said so on its way out

Two of them are driven through real child processes, because a traceback
arriving down a pipe from a dying process is the thing being tested and a
string in a test file is not.

    python check_runlog.py
"""
import io
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

import run_parallel as rp

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


TMP = Path(tempfile.mkdtemp(prefix="runlog-"))


def feed(name, text):
    """Run one worker over a canned stream and hand it back."""
    w = rp.Worker(name, TMP, 4)
    with redirect_stdout(io.StringIO()):
        w.pump(io.StringIO(text))
    return w


SUMMARY = "\n12 liked, 3 failed. Log: done-a.csv\n"

print("a worker that finished is not a worker that crashed")
w = feed("ok0", "  [1/2] 7361: 2 match, 2 to like\n     2/2 liked" + SUMMARY)
check("  exit 0 and a summary", w.verdict(0, "finished")[0], "worked its whole list")
# like.py exits 1 whenever ANY like failed. Calling that a crash would bury the
# real ones under a hundred false alarms.
check("  exit 1 and a summary is still a finish", feed("ok1", SUMMARY).verdict(1, "finished")[0],
      "finished, some likes failed")
check("  the summary is what proves it", w.finished, True)
check("  and a worker without one did not finish", feed("no", "working…\n").finished, False)

print("\na dry run has its own last line")
# It never prints the other one, so without this every dry run would be
# reported as having stopped early.
d = feed("dry", "1 video(s). 3957 comment(s) already done.\n\n0 comment(s) would be liked.\n")
check("  recognised as finished", d.verdict(0, "finished")[0], "worked its whole list")

print("\nwhat like.py says on its way out is read back")
for text, want in [
    ("\n  THIS PROFILE IS LOGGED OUT and would not come back", "logged out"),
    ("\n  Could not sign back in. Do it once by hand:", "re-login failed"),
    ("\n  TikTok is showing its slider captcha to profile 'd'.", "captcha not solved"),
    ("     browser is gone — stopping this profile", "browser closed"),
    ("\nFirst three all failed — stopping. Check done.csv", "stopped: first three failed"),
    ("\nEvery like has failed — stopping. Check done.csv.", "stopped: every like failed"),
    ("Not signed in on profile 'c'.", "not signed in"),
]:
    check(f"  {want}", feed("c", "working…\n" + text + "\n").verdict(1, "finished")[0], want)

print("\nthe parent's own verdict outranks anything in the output")
# An account killed at the deadline did not choose to stop, however healthy its
# last lines looked — including a full closing summary from the pass before.
k = feed("t", "working…" + SUMMARY)
check("  a timeout is a timeout", k.verdict(0, "timeout")[0], "killed: past the time limit")
check("  and Ctrl+C is Ctrl+C", k.verdict(0, "interrupted")[0], "stopped by Ctrl+C")

print("\nnothing at all is its own answer")
# Chrome failing to launch — a profile directory already in use, or no memory
# left — produces a process that exits having printed nothing.
check("  no output", feed("q", "").verdict(1, "finished")[0], "died before printing anything")
check("  output but no summary", feed("q2", "  [1/50] 736: 1 match\n").verdict(1, "finished")[0],
      "stopped without finishing its list")

# ── real children ──────────────────────────────────────────────────────────
print("\na real child that crashes, down a real pipe")
CRASH = (
    "import sys\n"
    "print('  [1/9] 7361: 1 match, 1 to like', flush=True)\n"
    "raise RuntimeError('Page.evaluate: Execution context was destroyed')\n"
)
src = TMP / "crash.py"
src.write_text(CRASH, encoding="utf-8")
proc = subprocess.Popen([sys.executable, "-u", str(src)], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, encoding="utf-8")
w = rp.Worker("crash", TMP, 5)
with redirect_stdout(io.StringIO()):
    w.pump(proc.stdout)
code = proc.wait()
reason, detail = w.verdict(code, "finished")
check("  it exits non-zero", code != 0, True)
check("  and is called a crash", reason, "crashed")
# The LAST line of a traceback is the exception, which is the useful one. The
# frames above it are in the log file.
check("  quoting the exception, not the frame",
      detail, "RuntimeError: Page.evaluate: Execution context was destroyed")
check("  the traceback is in the log too",
      "Traceback (most recent call last)" in w.path.read_text(encoding="utf-8"), True)
check("  along with the line before it",
      "[1/9] 7361: 1 match" in w.path.read_text(encoding="utf-8"), True)

print("\na real child that prints nothing and dies")
src2 = TMP / "silent.py"
src2.write_text("import sys\nsys.exit(3)\n", encoding="utf-8")
proc = subprocess.Popen([sys.executable, "-u", str(src2)], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, encoding="utf-8")
w2 = rp.Worker("silent", TMP, 6)
with redirect_stdout(io.StringIO()):
    w2.pump(proc.stdout)
check("  exit code is kept", proc.wait(), 3)
check("  and the silence is the finding", w2.verdict(3, "finished")[0],
      "died before printing anything")

print("\nthe log is per account and survives a pass")
# Under --loop an account that dies on pass 40 is read with passes 1-39 above
# it, so the file is opened once for the run and appended to.
keep = rp.Worker("keeps", TMP, 5)
keep.note("===== pass 1 =====")
with redirect_stdout(io.StringIO()):
    keep.pump(io.StringIO("first pass" + SUMMARY))
keep.reset()
keep.note("===== pass 2 =====")
with redirect_stdout(io.StringIO()):
    keep.pump(io.StringIO("second pass\n"))
keep.close()
body = keep.path.read_text(encoding="utf-8")
check("  both passes are in one file", ("first pass" in body, "second pass" in body), (True, True))
check("  each marked", body.count("===== pass"), 2)
# reset() has to forget the previous pass's verdict, or a worker that finished
# pass 1 would read as finished for ever.
check("  and the verdict does not carry over", keep.finished, False)

print("\nhow many browsers at once")
# The memory question. A Chromium is seven processes, so nineteen accounts at
# once is a hundred and thirty — and the machine, not the site, becomes the
# limit. The window changes nothing about WHAT gets done: the same accounts
# work the same shards, just fewer at a time.
rp_src = Path("run_parallel.py").read_text(encoding="utf-8")
check("  there is a window", "--at-once" in rp_src, True)
check("  0 means all of them", "args.at_once or len(profiles)" in rp_src, True)
check("  and it can never be 0 or more than there are",
      "window = max(1, min(window, len(profiles)))" in rp_src, True)
# --sequential predates it and is what people already type.
check("  one at a time is the same thing", "1 if args.sequential else" in rp_src, True)
# The next account to start is whichever finishes first. Waiting on them in the
# order they were given would leave the window half empty whenever an early
# account draws a long shard.
check("  a freed slot starts the next one", "a slot came free" in rp_src, True)
check("  chosen by polling, not by waiting in order",
      "Polled rather than waited on in order" in rp_src, True)
# An account that never got a slot must not vanish from the summary: a run that
# quietly did twelve of nineteen looks exactly like one that did nineteen.
check("  an account that never ran is reported", '"never started"' in rp_src, True)
check("  on the time limit", "never started — the time limit came first" in rp_src, True)
check("  and on Ctrl+C", 'how.setdefault(nxt, "never started")' in rp_src, True)
check("  with a row of its own in the summary",
      "never started — the run ended first" in rp_src, True)

print("\nand a leaner browser")
lk = Path("like.py").read_text(encoding="utf-8")
# One page at a time is all a worker ever has.
check("  one renderer", "--renderer-process-limit=1" in lk, True)
check("  no gpu process", "--disable-gpu" in lk, True)
check("  no extensions, sync or component updates",
      all(f in lk for f in ("--disable-extensions", "--disable-sync",
                            "--disable-component-update")), True)
check("  and no caches worth keeping for pages visited once",
      "--disk-cache-size=1" in lk, True)
# None of it may change what the page can do — the comment panel is text and
# DOM, and that is what the run reads.
check("  media, images and fonts were already blocked at the network layer",
      'BLOCKED_RESOURCES = {"media", "image", "font"}' in lk, True)
check("  nothing here disables javascript", "--disable-javascript" in lk, False)
check("  nor the DOM the panel lives in", "--disable-dom" in lk, False)

print("\nexits.csv")
csv_path = TMP / "exits.csv"
rp.write_exit_row(csv_path, {
    "ended_at": "2026-09-18T01:00:00", "pass": 1, "profile": "d", "exit_code": 1,
    "seconds": 12.5, "ended": "finished", "reason": "crashed",
    "detail": "RuntimeError: boom", "log": "d.log",
})
rp.write_exit_row(csv_path, {
    "ended_at": "2026-09-18T01:05:00", "pass": 2, "profile": "d", "exit_code": 0,
    "seconds": 90.0, "ended": "finished", "reason": "worked its whole list",
    "detail": "", "log": "d.log",
})
lines = csv_path.read_text(encoding="utf-8").strip().splitlines()
check("  a header, written once", lines[0],
      "ended_at,pass,profile,exit_code,seconds,ended,reason,detail,log")
check("  one row per pass", len(lines), 3)
check("  the reason is in it", "crashed" in lines[1], True)
check("  and which file to open", lines[1].endswith("d.log"), True)

print("\nthe run points at the files rather than summarising them")
src_txt = Path("run_parallel.py").read_text(encoding="utf-8")
check("  a directory per run, named for when it started",
      'LOGS / datetime.now().strftime("%Y%m%d-%H%M%S")' in src_txt, True)
check("  overridable", "--log-dir" in src_txt, True)
check("  the path is printed at the start", 'print(f"logs: {log_dir}")' in src_txt, True)
# Only the accounts that did not simply work: a clean run should not print nine
# paragraphs about itself.
check("  only the troubled accounts are named at the end",
      "what happened, in full:" in src_txt, True)
check("  with the path to the account's own log", "{workers[p].path}" in src_txt, True)
# The reading threads are daemons racing the child's exit, and the last lines
# before a crash are exactly the ones still in flight.
check("  the readers are given a moment to drain", "time.sleep(0.4)" in src_txt, True)
# A parent that falls over must still write what the children did.
check("  a parent error still records the children",
      '"parent error"' in src_txt, True)
# The logs name accounts, so they stay out of git.
check("  and the directory is not committed",
      "6_comment_liker/logs/" in Path("../.gitignore").read_text(encoding="utf-8"), True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
