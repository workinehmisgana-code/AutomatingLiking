#!/usr/bin/env python3
"""
Run several accounts at once.

Each account gets its own Chromium profile, its own process, and its own slice
of the videos. Separate PROCESSES rather than threads: Playwright's sync API is
not built to be shared across threads, and a crashed browser then takes down one
account instead of the run.

Two ways to divide the work:

  --share split   (default)  each video goes to ONE account.
                             N accounts, N times the throughput.
  --share stack              every account visits every video.
                             N accounts, N times the likes per comment.

Split is what you want to cover more ground. Stack is what you want if the point
is to push a particular comment up — but note that several accounts liking the
same comments within minutes is the clearest coordination signal there is, so
stack with a long --delay or not at all.

Setup, once per account:
    python login.py --profile a
    python login.py --profile b

Then:
    python run_parallel.py --profiles a,b,c --cluster-by date --clusters 1
    python run_parallel.py --profiles a,b --links links.txt --share stack
    python run_parallel.py --profiles a,b --clusters 1 --per-account 50

Keep going until you stop it:
    python run_parallel.py --profiles a,b,c --share stack --clusters 1         --max-links 20000 --loop

--loop sweeps the whole list, waits --loop-pause, then sweeps again, until
Ctrl+C. Each pass re-reads the dashboard, so links added since the last sweep
are picked up; and because every account keeps its own ledger, a later pass only
visits comments that account has not already liked. Left running, it settles
into liking whatever is new.

Each account writes its own done-<profile>.csv, so nothing interleaves and
"already liked" stays a fact about that account rather than about the comment.
Output is prefixed with the account name.

WHEN AN ACCOUNT STOPS AND YOU WANT TO KNOW WHY
On screen nine accounts interleave into one stream, so the answer scrolls past
in seconds -- and the exit code cannot give it either: like.py exits 1 both for
"worked the whole list, some likes failed" and for an uncaught traceback. So
every run writes, under logs/<when it started>/:

    <profile>.log   everything that account printed, to itself, in order, and
                    appended across --loop passes. This is the one to open.
    exits.csv       one row per account per pass: exit code, seconds, how it
                    ended, and the reason in a few words.

At the end of each pass the accounts that did NOT simply work are listed with
their reason and the path to their log. Use --log-dir to put them elsewhere.
"""
import argparse
import csv
import re
import subprocess
import sys
import time
import threading
from collections import deque
from datetime import datetime
from pathlib import Path

from like import HERE, from_dashboard, read_links, video_id, done_path

import console

console.fix()

SHARDS = HERE / "shards"
LOGS = HERE / "logs"

# ── Why did that account stop? ───────────────────────────────────────────────
#
# On screen, nine accounts interleave into one stream and the answer scrolls
# past in seconds. Worse, the exit CODE cannot answer it: like.py returns 1 for
# "ran to the end, some likes failed", and Python also exits 1 on an uncaught
# traceback. The two look identical from the outside.
#
# What distinguishes them is the CLOSING SUMMARY. like.py prints
# "N liked, M failed ... Log: ..." as the last thing it does, so a worker that
# printed it finished its list and a worker that did not died somewhere. That
# one line is the difference between "working as designed" and "crashed", and
# it is what this reads.
#
# Two files come out of a run:
#
#   <profile>.log   everything that account printed, in order, to itself. This
#                   is the one to open: uninterleaved, and it holds the whole
#                   traceback rather than the last few lines of it.
#   exits.csv       one row per account per pass — exit code, how long it ran,
#                   how it ended, and the reason in a few words.



# Output lines kept in memory per worker, to quote in the summary. The whole
# output is on disk; this is only what gets shown without opening the file.
TAIL_LINES = 60

# Things like.py says on its way out, most specific first. The first match wins,
# so a traceback (read separately, below) beats all of these and "logged out"
# beats the generic failure stop that follows it.
CAUSES = [
    (re.compile(r"THIS PROFILE IS LOGGED OUT", re.I), "logged out"),
    (re.compile(r"Could not sign back in", re.I), "re-login failed"),
    (re.compile(r"slider captcha", re.I), "captcha not solved"),
    (re.compile(r"browser is gone", re.I), "browser closed"),
    (re.compile(r"First three all failed", re.I), "stopped: first three failed"),
    (re.compile(r"Every like has failed", re.I), "stopped: every like failed"),
    (re.compile(r"Not signed in on profile", re.I), "not signed in"),
    (re.compile(r"No session at ", re.I), "no session on disk"),
]

# The line like.py prints last, always. Its presence is the proof that the
# worker reached the end of its list rather than stopping somewhere.
# The dry run has its own last line and never prints the other one, so it would
# otherwise be reported as having stopped early on every single pass.
FINISHED_RE = re.compile(r"\d+ liked, \d+ failed|comment\(s\) would be liked")


class Worker:
    """One account's process, and what it had to say for itself.

    Holds the log file open for the whole run so a --loop pass appends to the
    same file: an account that dies on pass 40 is best read with passes 1-39
    above it, not in its own file with no history.
    """

    def __init__(self, name: str, log_dir: Path, width: int):
        self.name = name
        self.width = width
        self.path = log_dir / f"{name}.log"
        self.fh = self.path.open("a", encoding="utf-8", newline="")
        self.reset()

    def reset(self) -> None:
        """Start of a pass: forget the last one's tail and verdict."""
        self.tail: deque[str] = deque(maxlen=TAIL_LINES)
        self.lines = 0
        self.finished = False
        self.causes: list[str] = []
        self.traceback: str = ""
        self._in_traceback = False

    def note(self, text: str) -> None:
        """Write a line of our own into the account's log (pass markers etc)."""
        self.fh.write(f"{text}\n")
        self.fh.flush()

    def pump(self, stream) -> None:
        """Echo a child's output, prefixed on screen and plain in its own file."""
        for line in iter(stream.readline, ""):
            text = line.rstrip()
            # The file gets EVERY line, including the blank ones: a traceback is
            # laid out with them and collapsing them makes it harder to read.
            self.fh.write(line if line.endswith("\n") else line + "\n")
            self.lines += 1
            if not text.strip():
                continue
            self.fh.flush()
            self.tail.append(text)
            print(f"[{self.name:<{self.width}}] {text}", flush=True)
            if FINISHED_RE.search(text):
                self.finished = True
            for rx, why in CAUSES:
                if rx.search(text) and why not in self.causes:
                    self.causes.append(why)
            # A traceback's LAST line is the exception, which is the one worth
            # quoting. Everything from "Traceback" onwards is kept so the frame
            # that raised is in the summary too.
            if text.startswith("Traceback (most recent call last)"):
                self._in_traceback = True
                self.traceback = text
            elif self._in_traceback:
                self.traceback = text  # keep overwriting: the last one is the error
                if not (text.startswith(" ") or text.startswith("\t")):
                    self._in_traceback = False
        stream.close()

    def verdict(self, code: int, how: str) -> tuple[str, str]:
        """Why this account stopped, in a few words, and the evidence for it.

        `how` is what the PARENT did — "finished", "timeout", "interrupted" —
        which outranks anything in the output: an account killed at the deadline
        did not choose to stop.
        """
        if how == "timeout":
            return "killed: past the time limit", self.tail[-1] if self.tail else ""
        if how == "interrupted":
            return "stopped by Ctrl+C", self.tail[-1] if self.tail else ""
        if self.traceback:
            return "crashed", self.traceback
        if self.causes:
            return self.causes[0], self.tail[-1] if self.tail else ""
        if self.finished:
            # like.py exits 1 when any like failed. That is the list worked to
            # the end, not a fault, and calling it one would bury the real ones.
            return ("worked its whole list" if code == 0 else "finished, some likes failed"), (
                self.tail[-1] if self.tail else ""
            )
        if self.lines == 0:
            # Nothing at all: the process never got as far as printing. Almost
            # always the browser failing to launch — a profile directory in use
            # by another run, or no memory left to start Chrome with.
            return "died before printing anything", ""
        return "stopped without finishing its list", self.tail[-1] if self.tail else ""

    def close(self) -> None:
        try:
            self.fh.close()
        except Exception:  # noqa: BLE001
            pass


def write_exit_row(csv_path: Path, row: dict) -> None:
    """Append one line to exits.csv, writing the header the first time."""
    new = not csv_path.exists()
    with csv_path.open("a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=["ended_at", "pass", "profile", "exit_code", "seconds",
                        "ended", "reason", "detail", "log"],
        )
        if new:
            w.writeheader()
        w.writerow(row)


def run_pass(args, profiles, width, workers, log_dir, pass_no):
    """One sweep over the links. Returns the per-account exit codes, or None
    when there was nothing to work on."""
    # ── the work, fetched once ───────────────────────────────────────────────
    if args.links:
        links = read_links(args.links)
        print(f"{len(links)} link(s) from {args.links.name}")
    else:
        links, _ = from_dashboard(
            args.cluster_by,
            args.clusters,
            {"platform": args.platform, "category": args.category, "limit": str(args.max_links)},
        )
    videos = [u for u in links if video_id(u)]
    if args.videos:
        videos = videos[: args.videos]
    if not videos:
        print("No TikTok video URLs to work on.")
        # Recorded too. A --loop that quietly does nothing for six hours because
        # the dashboard returns an empty list looks identical, from outside, to
        # one that is working.
        for w in workers.values():
            w.note(f"pass {pass_no}: nothing to work on — the link source returned no videos")
        return None
    SHARDS.mkdir(exist_ok=True)
    shard_files: dict[str, Path] = {}
    if args.share == "stack":
        for p in profiles:
            f = SHARDS / f"{p}.txt"
            f.write_text("\n".join(videos) + "\n", encoding="utf-8")
            shard_files[p] = f
        print(f"stack: all {len(videos)} video(s) to each of {len(profiles)} account(s)")
    else:
        # Round-robin rather than contiguous blocks: the link order is the
        # dashboard's ranking, so slicing it in blocks would hand one account
        # every good link and another the tail.
        buckets: dict[str, list[str]] = {p: [] for p in profiles}
        for i, u in enumerate(videos):
            buckets[profiles[i % len(profiles)]].append(u)
        for p in profiles:
            f = SHARDS / f"{p}.txt"
            f.write_text("\n".join(buckets[p]) + "\n", encoding="utf-8")
            shard_files[p] = f
        print(
            f"split: {len(videos)} video(s) across {len(profiles)} account(s) — "
            + ", ".join(f"{p}:{len(buckets[p])}" for p in profiles)
        )
    for p in profiles:
        print(f"  {p:12} -> {shard_files[p].name}, ledger {done_path(p).name}")
    print()
    # ── launch ───────────────────────────────────────────────────────────────
    width = max(len(p) for p in profiles)
    stamp = datetime.now().isoformat(timespec="seconds")
    for w in workers.values():
        w.reset()
        w.note(f"\n===== pass {pass_no} · {stamp} =====")
    procs = []
    started: dict[str, float] = {}
    # HOW MANY BROWSERS AT ONCE.
    #
    # A Chromium is seven processes and several hundred megabytes, so nineteen
    # accounts at once is a different kind of load from nineteen accounts. The
    # window changes nothing about WHAT gets done — every account still works
    # its own shard to the end — only how many are doing it at the same moment.
    #
    # --sequential is the special case where the window is one; it is kept
    # because it is what people already type.
    window = 1 if args.sequential else (args.at_once or len(profiles))
    window = max(1, min(window, len(profiles)))
    if window < len(profiles):
        print(f"{window} browser(s) at a time; "
              f"{len(profiles) - window} account(s) start as others finish")

    def launch(slot: int, p: str):
        cmd = [
            sys.executable, "-u", str(HERE / "like.py"),
            "--profile", p,
            "--links", str(shard_files[p]),
            "--products",
            "--delay", args.delay,
            "--scrolls", str(args.scrolls),
            "--pages", str(args.pages),
            "--window-slot", str(slot),
            "--window-count", str(len(profiles)),
        ]
        if args.per_account:
            cmd += ["--limit", str(args.per_account)]
        if args.users:
            cmd += ["--users", args.users]
        if args.all_products:
            cmd.append("--all-products")
        if args.all:
            cmd.append("--all")
        if args.unlike:
            cmd.append("--unlike")
        if args.dry_run:
            cmd.append("--dry-run")
        # Every remaining flag is a plain on/off that like.py understands and
        # run_parallel has no opinion about. Driven from one table rather than
        # a stack of ifs: the list used to be hand-maintained and drifted, so
        # --keep-going existed in like.py and simply could not be reached from
        # here. check_forwarding.py fails if the two ever diverge again.
        for flag, on in (
            ("--keep-failures", args.keep_failures),
            ("--headed", args.headed),
            ("--keep-going", args.keep_going),
            ("--solve-captcha", args.solve_captcha),
            ("--no-captcha-window", args.no_captcha_window),
            ("--debug", args.debug),
            ("--mimic-comments", args.mimic_comments),
            ("--no-like", args.no_like),
            ("--no-relogin", args.no_relogin),
            ("--no-dom-sweep", args.no_dom_sweep),
            ("--with-media", args.with_media),
            ("--comment-empty", args.comment_empty),
        ):
            if on:
                cmd.append(flag)
        if args.mode != "dom":
            cmd += ["--mode", args.mode]
        if args.comment_product:
            cmd += ["--comment-product", args.comment_product]
        proc = subprocess.Popen(
            cmd,
            cwd=str(HERE),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            # The child's stdout is a pipe, so Windows hands it cp1252 and the
            # first em dash it prints ends the worker. See console.py.
            env=console.child_env(),
        )
        procs.append((p, proc))
        started[p] = time.time()
        threading.Thread(target=workers[p].pump, args=(proc.stdout,), daemon=True).start()
        return proc

    # Start the first window's worth, staggered: browser startup and the first
    # page load are the heaviest moments, and several at once is what starves
    # the machine.
    waiting = list(enumerate(profiles))
    for slot, p in waiting[:window]:
        launch(slot, p)
        if (slot + 1) < window:
            time.sleep(args.stagger)
    waiting = waiting[window:]
    codes = {}
    how: dict[str, str] = {}
    deadline = time.time() + args.timeout_min * 60 if args.timeout_min else None
    try:
        # Polled rather than waited on in order, because the next account to
        # start is whichever one finishes first — waiting on them in sequence
        # would leave the window half empty whenever an early account has a
        # long shard.
        while True:
            live = [(p, pr) for p, pr in procs if pr.poll() is None]
            for p, pr in procs:
                if p in codes or pr.poll() is None:
                    continue
                codes[p] = pr.returncode
                how.setdefault(p, "finished")
                # A slot came free: start the next account waiting for one.
                if waiting:
                    slot, nxt = waiting.pop(0)
                    print(f"[{nxt}] starting — a slot came free")
                    launch(slot, nxt)
            if not waiting and not [1 for _, pr in procs if pr.poll() is None]:
                break
            if deadline is not None and time.time() >= deadline:
                for p, pr in live:
                    print(f"[{p}] past the {args.timeout_min}-minute limit, terminating")
                    pr.terminate()
                    codes[p] = pr.wait()
                    how[p] = "timeout"
                # Anything still queued never ran, and saying so is better than
                # a summary that quietly omits it.
                for _, nxt in waiting:
                    print(f"[{nxt}] never started — the time limit came first")
                    codes[nxt] = -1
                    how[nxt] = "never started"
                waiting.clear()
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nstopping…")
        for _, proc in procs:
            proc.terminate()
        for p, proc in procs:
            codes[p] = proc.wait()
            how.setdefault(p, "interrupted")
        for _, nxt in waiting:
            codes.setdefault(nxt, -1)
            how.setdefault(nxt, "never started")
        waiting.clear()
    except Exception as e:  # noqa: BLE001
        # The parent itself fell over. Whatever the children did still gets
        # written below, which is the whole point of writing it here.
        print(f"\nparent error while waiting: {e}")
        for p, proc in procs:
            codes.setdefault(p, proc.poll() if proc.poll() is not None else -1)
            how.setdefault(p, "parent error")

    # ── why each one stopped ────────────────────────────────────────────────
    # The threads reading each child's output are daemons racing the child's
    # exit, so give them a moment to drain: the last lines before a crash are
    # exactly the ones worth having, and they are the ones still in flight.
    time.sleep(0.4)
    ended_at = datetime.now().isoformat(timespec="seconds")
    reasons: dict[str, tuple[str, str]] = {}
    for p in profiles:
        w = workers[p]
        code = codes.get(p, -1)
        if how.get(p) == "never started":
            reason, detail = "never started — the run ended first", ""
        else:
            reason, detail = w.verdict(code, how.get(p, "finished"))
        reasons[p] = (reason, detail)
        w.note(f"----- pass {pass_no} ended: exit {code} · {how.get(p, '?')} · {reason}")
        if detail:
            w.note(f"      {detail}")
        write_exit_row(
            log_dir / "exits.csv",
            {
                "ended_at": ended_at,
                "pass": pass_no,
                "profile": p,
                "exit_code": code,
                "seconds": round(time.time() - started.get(p, time.time()), 1),
                "ended": how.get(p, "?"),
                "reason": reason,
                "detail": detail[:400],
                "log": w.path.name,
            },
        )

    print()
    for p in profiles:
        reason, detail = reasons[p]
        # Only the ones that did NOT simply work are worth a second line; a
        # clean run should not print nine paragraphs about itself.
        bad = reason not in ("worked its whole list", "finished, some likes failed")
        print(f"{p:<{width}}  exit {codes.get(p)}  {reason}")
        if bad and detail:
            print(f"{'':<{width}}  {detail[:160]}")
    trouble = [p for p in profiles
               if reasons[p][0] not in ("worked its whole list", "finished, some likes failed")]
    if trouble:
        # Name the file rather than the directory. The question is always about
        # one account, and the answer is the whole of its log, not a summary.
        print("\nwhat happened, in full:")
        for p in trouble:
            print(f"  {workers[p].path}")
    print(f"exit log: {log_dir / 'exits.csv'}")
    print("Check each done-<profile>.csv, or: " + " ".join(f"python verify.py --profile {p};" for p in profiles))
    return codes


def main() -> int:
    ap = argparse.ArgumentParser(description="Like with several accounts at once.")
    ap.add_argument("--profiles", required=True, help="comma-separated login.py profile names")
    ap.add_argument("--share", default="split", choices=["split", "stack"],
                    help="split: a video goes to one account. stack: every account visits every video")
    # Where the work comes from — same options like.py has.
    ap.add_argument("--links", type=Path, help="file of video URLs instead of the dashboard")
    ap.add_argument("--cluster-by", default="date", choices=["rank", "date", "combined"])
    ap.add_argument("--clusters", default="")
    ap.add_argument("--platform", default="tiktok")
    ap.add_argument("--category", default="")
    ap.add_argument("--max-links", type=int, default=500,
                    help="links to pull from the dashboard; raise it for --loop")
    # Passed through to each child.
    # --limit is the name like.py uses, so accept it here too rather than making
    # anyone remember which script calls it what.
    ap.add_argument("--per-account", "--limit", type=int, default=0, dest="per_account",
                    help="most likes per account (0 = no cap)")
    ap.add_argument("--headed", action="store_true",
                    help="give every account its own visible Chrome window, tiled")
    ap.add_argument("--loop", action="store_true",
                    help="keep sweeping the links until you stop it with Ctrl+C")
    ap.add_argument("--loop-pause", type=float, default=300,
                    help="seconds to wait between passes in --loop (default 300)")
    ap.add_argument("--sequential", action="store_true",
                    help="run accounts one after another (the same as --at-once 1)")
    ap.add_argument("--at-once", type=int, default=0, metavar="N",
                    help="most accounts running at the same time (0 = all of them). "
                         "This is the memory lever: one Chromium is seven processes, "
                         "so nine accounts at once is sixty-three. With --at-once 4 "
                         "the same accounts work the same shards, four browsers at a "
                         "time, and the rest start as those finish")
    ap.add_argument("--timeout-min", type=float, default=0,
                    help="give up on a still-running account after N minutes (0 = wait)")
    ap.add_argument("--stagger", type=float, default=6.0,
                    help="seconds between starting each account (default 6)")
    ap.add_argument("--videos", type=int, default=0,
                    help="only use the first N videos — for a quick trial run")
    ap.add_argument("--delay", default="2,5")
    ap.add_argument("--scrolls", type=int, default=6)
    ap.add_argument("--pages", type=int, default=3)
    ap.add_argument("--users", default="")
    ap.add_argument("--all-products", action="store_true",
                    help="match every product, deactivated ones included")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--unlike", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    # Passed straight through to each like.py worker.
    ap.add_argument("--keep-going", action="store_true",
                    help="do not stop a worker on repeated video failures — work its list to the end")
    ap.add_argument("--solve-captcha", action="store_true",
                    help="let each worker try the solving API before asking you")
    ap.add_argument("--no-captcha-window", action="store_true",
                    help="headless only: do not open a window when a captcha appears. "
                         "By default one is opened for as long as it takes, then the "
                         "worker goes back to headless. For unattended runs")
    ap.add_argument("--mimic-comments", action="store_true",
                    help="when commenting, match a comment already under the video that "
                         "recommends a rival, instead of taking a stored one")
    ap.add_argument("--no-like", action="store_true",
                    help="like nothing — only post comments (with --comment-empty)")
    ap.add_argument("--debug", action="store_true",
                    help="every worker says far more: elapsed time on each line, how long "
                         "each page took, and what a failed page actually contained — in "
                         "its ledger note as well as its log")
    ap.add_argument("--no-relogin", action="store_true",
                    help="do not try to sign a worker back in when TikTok drops its session")
    ap.add_argument("--no-dom-sweep", action="store_true",
                    help="do not read the open comment panel for product comments the api list missed")
    ap.add_argument("--with-media", action="store_true",
                    help="let the pages load video/images — slower, only for debugging")
    ap.add_argument("--comment-empty", action="store_true",
                    help="on a video carrying NONE of our product comments, post one. "
                         "OFF by default: it is the only thing here that writes something public, "
                         "and through this script it writes from every profile at once")
    ap.add_argument("--comment-product", default="",
                    help="which product's comment to post with --comment-empty")
    ap.add_argument("--mode", default="dom", choices=["dom", "fast", "api"],
                    help="passed to each worker; dom is the only mode that works")
    ap.add_argument("--keep-failures", action="store_true",
                    help="passed through to like.py: leave failed rows in the "
                         "ledger instead of retrying them")
    ap.add_argument("--log-dir", type=Path, default=None,
                    help="where to write each account's log and exits.csv "
                         "(default: logs/<the time this run started>)")
    args = ap.parse_args()

    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
    if not profiles:
        print("No profiles given.")
        return 2

    # Every profile must be signed in BEFORE anything starts. Finding out three
    # minutes in that account C was never logged in wastes the whole run.
    missing = [p for p in profiles if not (HERE / ("profile" if p == "default" else f"profile-{p}") / "Default").exists()]
    if missing:
        print("No session for: " + ", ".join(missing))
        for p in missing:
            print(f"  python login.py --profile {p}")
        return 1

    width = max(len(p) for p in profiles)

    # One directory per RUN, not per pass: under --loop an account that dies on
    # pass 40 is read with passes 1-39 above it in the same file. Named for the
    # moment the run started, so two runs cannot write over each other.
    log_dir = args.log_dir or (LOGS / datetime.now().strftime("%Y%m%d-%H%M%S"))
    log_dir.mkdir(parents=True, exist_ok=True)
    workers = {p: Worker(p, log_dir, width) for p in profiles}
    print(f"logs: {log_dir}")

    n = 0
    try:
        while True:
            n += 1
            if args.loop:
                print(f"── pass {n} ──")
            codes = run_pass(args, profiles, width, workers, log_dir, n)
            if not args.loop:
                if codes is None:
                    return 2
                return 0 if all(c == 0 for c in codes.values()) else 1
            # Keep going. Each pass re-reads the dashboard, so links added
            # since the last sweep are picked up, and the per-account ledgers
            # mean only comments not yet liked are visited again.
            print(f"pass {n} finished — next in {args.loop_pause}s (Ctrl+C to stop)\n")
            time.sleep(args.loop_pause)
    except KeyboardInterrupt:
        print(f"\nstopped after {n} pass(es).")
        return 0
    finally:
        for w in workers.values():
            w.close()
        print(f"logs: {log_dir}")




if __name__ == "__main__":
    sys.exit(main())
