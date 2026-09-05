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
"""
import argparse
import subprocess
import sys
import time
import threading
from pathlib import Path

from like import HERE, from_dashboard, read_links, video_id, done_path

SHARDS = HERE / "shards"


def pump(name: str, stream, width: int) -> None:
    """Echo a child's output with its account name in front."""
    for line in iter(stream.readline, ""):
        if line.strip():
            print(f"[{name:<{width}}] {line.rstrip()}", flush=True)
    stream.close()


def run_pass(args, profiles, width):
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
    procs = []
    for slot, p in enumerate(profiles):
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
        if args.keep_failures:
            cmd.append("--keep-failures")
        if args.headed:
            cmd.append("--headed")
        proc = subprocess.Popen(
            cmd,
            cwd=str(HERE),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        procs.append((p, proc))
        threading.Thread(target=pump, args=(p, proc.stdout, width), daemon=True).start()
        if args.sequential:
            # One at a time. Slower in wall-clock, but each browser gets the whole
            # machine — and for stacking, where every account visits the same
            # videos anyway, finishing reliably beats finishing together.
            proc.wait()
        elif p != profiles[-1]:
            # Staggered, not simultaneous. Browser startup and the first page load
            # are the heaviest moments; several at once is what starves the machine.
            time.sleep(args.stagger)
    codes = {}
    deadline = time.time() + args.timeout_min * 60 if args.timeout_min else None
    try:
        for p, proc in procs:
            if deadline is None:
                codes[p] = proc.wait()
                continue
            # A child that cannot open a comment panel spends its whole list
            # timing out; without this the parent sits there for hours.
            left = max(1, int(deadline - time.time()))
            try:
                codes[p] = proc.wait(timeout=left)
            except subprocess.TimeoutExpired:
                print(f"[{p}] past the {args.timeout_min}-minute limit, terminating")
                proc.terminate()
                codes[p] = proc.wait()
    except KeyboardInterrupt:
        print("\nstopping…")
        for _, proc in procs:
            proc.terminate()
        for p, proc in procs:
            codes[p] = proc.wait()
    print("\n" + ", ".join(f"{p}: exit {codes.get(p)}" for p in profiles))
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
                    help="run accounts one after another instead of at once")
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
    ap.add_argument("--keep-failures", action="store_true",
                    help="passed through to like.py: leave failed rows in the "
                         "ledger instead of retrying them")
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
    n = 0
    try:
        while True:
            n += 1
            if args.loop:
                print(f"── pass {n} ──")
            codes = run_pass(args, profiles, width)
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




if __name__ == "__main__":
    sys.exit(main())
