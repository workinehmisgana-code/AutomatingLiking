#!/usr/bin/env python3
"""
All accounts on the SAME link at the same time.

run_parallel.py splits the work — each video goes to one account, and the point
is coverage. This does the opposite: every account works the same video at once,
so a comment collects its likes before anyone moves on. That is what actually
lifts a comment up the ranking, and it keeps the accounts together instead of
letting one run ahead.

ONE LIKE PER ACCOUNT PER COMMENT, but never two of our comments on the same
number: a group of comments already sharing a like count gets exactly one like,
to the top of the group (tie_filter in like.py). So the counts come out ragged
without anybody giving up a like.

--spread is the older answer to the same problem and is off by default: it
divides each video's comments between the accounts — the first gets the whole
roster, the next about three quarters, and so on — which works, and costs a like
on most videos.

How it stays in step: one process, one thread and one browser per account, and a
barrier between videos. Nobody starts video N+1 until everyone has finished N.
If an account stalls, the barrier times out and the rest carry on without it
rather than the whole run hanging.

Threads rather than processes because the barrier has to be shared. Each thread
creates its own sync_playwright(), which is how Playwright's sync API is meant to
be used off the main thread.

Setup, once per account:
    python login.py --profile a
    python login.py --profile b

Then:
    python run_lockstep.py --profiles a,b,c --cluster-by date --clusters 1
    python run_lockstep.py --profiles a,b --links links.txt --limit 20
    python run_lockstep.py --profiles a,b,c --clusters 1 --dry-run

Each account keeps its own done-<profile>.csv, so "already liked" stays a fact
about that account and the files never interleave.
"""
import argparse
import csv
import random
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from like import (
    UA,
    HERE,
    COLUMNS,
    CLICK_JS,
    READ_MINE_JS,
    NORM_PRODUCTS,
    done_path,
    purge_failures,
    report_purge,
    fetch_comments,
    open_video,
    launch_liker,
    open_comments,
    load_more_comments,
    safe_eval,
    from_dashboard,
    norm,
    read_links,
    spread_hash,
    spread_keep,
    spread_targets,
    tie_filter,
    video_id,
    wanted,
)

import console

console.fix()

# How long one account will wait at the barrier for the others. Past this the
# run continues without whoever is stuck — a hung browser must not freeze
# everybody else indefinitely.
BARRIER_TIMEOUT = 240

print_lock = threading.Lock()


def say(profile: str, msg: str, width: int = 8) -> None:
    with print_lock:
        print(f"[{profile:<{width}}] {msg}", flush=True)


def open_ledger(path: Path):
    fresh = not path.exists()
    f = path.open("a", newline="", encoding="utf-8")
    w = csv.writer(f)
    if fresh:
        w.writerow(COLUMNS)
        f.flush()
    return f, w


def load_done(path: Path) -> set[str]:
    if not path.exists():
        return set()
    with path.open(encoding="utf-8") as f:
        return {r["cid"] for r in csv.DictReader(f) if r.get("cid")}


def account(profile, videos, targets, args, barrier, tally, width):
    """One account's whole run, in step with the others."""
    # The whole roster, which is what makes the spread computable here without
    # asking the other threads anything.
    roster = [x.strip() for x in args.profiles.split(",") if x.strip()]
    ledger = done_path(profile)
    # Same rule as like.py: last run's failures come out of the ledger before
    # it is read as a skip list, so a comment that failed on a slow page is
    # tried again instead of being written off for good.
    if not args.keep_failures and not args.dry_run:
        line = report_purge(purge_failures(ledger), ledger.name)
        if line:
            say(profile, line, width)
    already = load_done(ledger)
    f, w = open_ledger(ledger)
    ok = failed = 0

    def record(url, aweme, c, status, note):
        w.writerow([
            time.strftime("%Y-%m-%dT%H:%M:%S"), url, aweme,
            c["cid"], c["user"], c["text"][:200], status, note[:120],
        ])
        f.flush()

    def sync(label):
        """Wait for the others. Never fatal — a broken barrier just means solo."""
        try:
            barrier.wait(timeout=BARRIER_TIMEOUT)
        except threading.BrokenBarrierError:
            say(profile, f"({label}: others gone, continuing alone)", width)
        except Exception:
            say(profile, f"({label}: barrier timed out, continuing)", width)

    try:
        with sync_playwright() as p:
            ctx = launch_liker(p, profile, headed=args.headed)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto("https://www.tiktok.com/", wait_until="domcontentloaded")
            page.wait_for_timeout(2500)
            who = page.evaluate(
                """async () => {
                    const r = await fetch('/passport/web/account/info/?aid=1459', { credentials: 'include' })
                    if (!r.ok) return null
                    const j = await r.json().catch(() => null)
                    const d = (j || {}).data || {}
                    return d.user_id_str || d.user_id ? (d.screen_name || d.username || 'yes') : null
                }"""
            )
            if not who:
                say(profile, f"NOT SIGNED IN — run: python login.py --profile {profile}", width)
                barrier.abort()
                ctx.close()
                return
            say(profile, f"signed in as {who}", width)

            # Everyone opens their browser before anyone starts liking, so the
            # first video is genuinely simultaneous rather than staggered by
            # however long each browser took to start.
            sync("ready")

            for i, (aweme, url) in enumerate(videos, 1):
                # MY SHARE of this video's comments, not all of them. Every
                # account computes this for itself and they agree without
                # talking, because the answer is a hash of the comment id
                # against the roster. See spread_keep in like.py.
                here = targets.get(aweme, [])
                mine = spread_keep(aweme, here, profile, roster) if args.spread else here
                wants = [c for c in mine if c["cid"] not in already]
                if not wants:
                    left = len(here) - len(mine)
                    say(
                        profile,
                        f"[{i}/{len(videos)}] {aweme}: "
                        + (f"all {left} left to the other accounts" if left == len(here) and left
                           else "nothing left for me"),
                        width,
                    )
                    sync(f"video {i}")
                    continue

                # A small offset before each video. Three accounts hitting the
                # same comment in the same millisecond, from one IP, is the most
                # legible coordination signal there is. --stagger 0 removes it.
                if hi_stagger > 0:
                    time.sleep(random.uniform(lo_stagger, hi_stagger))

                try:
                    if not open_video(page, url):
                        for c in wants:
                            record(url, aweme, c, "fail:load", "page did not render in time")
                        say(profile, f"[{i}/{len(videos)}] {aweme}: page did not render", width)
                        sync(f"video {i}")
                        continue
                    before = safe_eval(page, READ_MINE_JS, [aweme, 4]) or {}
                    todo = [c for c in wants if not (before.get(c["cid"]) or {}).get("mine")]
                    if todo and not open_comments(page):
                        for c in todo:
                            record(url, aweme, c, "fail:dom", "comment panel did not open")
                            failed += 1
                        say(profile, f"[{i}/{len(videos)}] {aweme}: comment panel did not open", width)
                        sync(f"video {i}")
                        continue
                    if todo:
                        load_more_comments(page, args.scrolls)
                    if not todo:
                        for c in wants:
                            record(url, aweme, c, "ok", "already liked before this run")
                            ok += 1
                        say(profile, f"[{i}/{len(videos)}] {aweme}: all {len(wants)} already liked", width)
                        sync(f"video {i}")
                        continue

                    clicks = safe_eval(
                        page,
                        CLICK_JS,
                        [[{"cid": c["cid"], "user": c["user"], "text": c["text"]} for c in todo], args.scrolls],
                    ) or {}
                    if clicks.get("_error"):
                        for c in todo:
                            record(url, aweme, c, "fail:dom", clicks["_error"])
                            failed += 1
                        say(profile, f"[{i}/{len(videos)}] {aweme}: {clicks['_error']}", width)
                        sync(f"video {i}")
                        continue

                    page.wait_for_timeout(2000)
                    after = safe_eval(page, READ_MINE_JS, [aweme, 4]) or {}
                    seen, sample = clicks.get("_seen"), clicks.get("_sample") or ""
                    landed = 0
                    for c in todo:
                        state = after.get(c["cid"]) or {}
                        note = str(clicks.get(c["cid"], "?"))
                        if note == "not found" and seen is not None:
                            note = f"not found among {seen} row(s) [{sample}]"
                        if state.get("mine"):
                            record(url, aweme, c, "ok", f"digg_count={state.get('digg')}")
                            ok += 1
                            landed += 1
                        else:
                            record(url, aweme, c, "fail:dom", note)
                            failed += 1
                    say(profile, f"[{i}/{len(videos)}] {aweme}: {landed}/{len(todo)} liked", width)
                except Exception as e:  # noqa: BLE001
                    say(profile, f"[{i}/{len(videos)}] {aweme}: error {str(e)[:80]}", width)
                    for c in wants:
                        record(url, aweme, c, "fail:error", str(e)[:120])
                        failed += 1

                sync(f"video {i}")
                time.sleep(random.uniform(lo_delay, hi_delay))
            ctx.close()
    except Exception as e:  # noqa: BLE001
        say(profile, f"crashed: {str(e)[:120]}", width)
        barrier.abort()
    finally:
        f.close()
        tally[profile] = (ok, failed)


def main() -> int:
    ap = argparse.ArgumentParser(description="All accounts on the same link at once.")
    ap.add_argument("--profiles", required=True, help="comma-separated login.py profile names")
    ap.add_argument("--links", type=Path, help="file of video URLs instead of the dashboard")
    ap.add_argument("--cluster-by", default="date", choices=["rank", "date", "combined"])
    ap.add_argument("--clusters", default="")
    ap.add_argument("--platform", default="tiktok")
    ap.add_argument("--category", default="")
    ap.add_argument("--max-links", type=int, default=500)
    ap.add_argument("--limit", type=int, default=0, help="stop after this many videos")
    ap.add_argument("--pages", type=int, default=3)
    ap.add_argument("--scrolls", type=int, default=6)
    ap.add_argument("--delay", default="2,5", help="seconds between videos, 'min,max'")
    ap.add_argument("--stagger", default="0,4",
                    help="seconds each account waits before a video, 'min,max'. 0,0 = same instant")
    ap.add_argument("--users", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--like-ties", action="store_true",
                    help="like every comment in a tied group. By default only the "
                         "top comment of each like-count is liked, so a like of "
                         "ours never puts two of our comments on the same number")
    ap.add_argument("--spread", action="store_true",
                    help="DIVIDE each video's comments between the accounts "
                         "instead of every account liking every one. Off by "
                         "default: it costs a like on most videos, and the tie "
                         "rule already stops our comments landing on the same "
                         "like count")
    ap.add_argument("--headed", action="store_true",
                    help="show each browser window")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-failures", action="store_true",
                    help="leave failed rows in each done-<profile>.csv, so failed "
                         "comments are never retried (by default they are dropped "
                         "and tried again)")
    args = ap.parse_args()

    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
    if not profiles:
        print("No profiles given.")
        return 2
    missing = [
        p for p in profiles
        if not (HERE / ("profile" if p == "default" else f"profile-{p}") / "Default").exists()
    ]
    if missing:
        print("No session for: " + ", ".join(missing))
        for p in missing:
            print(f"  python login.py --profile {p}")
        return 1

    global lo_delay, hi_delay, lo_stagger, hi_stagger
    try:
        lo_delay, hi_delay = (float(x) for x in args.delay.split(","))
        lo_stagger, hi_stagger = (float(x) for x in args.stagger.split(","))
    except ValueError:
        print("--delay and --stagger want 'min,max'")
        return 2

    # ── the work, discovered once and shared by every account ────────────────
    if args.links:
        links = read_links(args.links)
        products = NORM_PRODUCTS
        print(f"{len(links)} link(s) from {args.links.name}")
    else:
        links, live = from_dashboard(
            args.cluster_by, args.clusters,
            {"platform": args.platform, "category": args.category, "limit": str(args.max_links)},
        )
        products = [norm(p) for p in live] if live else NORM_PRODUCTS

    users = {u.strip().lstrip("@").lower() for u in args.users.split(",") if u.strip()}
    videos: list[tuple[str, str]] = []
    targets: dict[str, list[dict]] = {}
    for u in links:
        aweme = video_id(u)
        if not aweme:
            continue
        picks = [c for c in fetch_comments(aweme, args.pages) if wanted(c, products, users, args.all)]
        if not picks:
            continue
        # ONE LIKE PER LIKE COUNT. Read once here, centrally, which is the right
        # place for it: every account is about to work this same video at the
        # same moment, and they must all hold back the same comments or the rule
        # means nothing.
        tied = 0
        if not args.like_ties:
            picks, tied = tie_filter(picks, products=products)
        if not picks:
            continue
        videos.append((aweme, u))
        targets[aweme] = picks
        print(
            f"  {aweme}: {len(picks)} comment(s) to like"
            + (f", {tied} tied on likes and left alone" if tied else "")
        )
        if args.limit and len(videos) >= args.limit:
            break

    if not videos:
        print("Nothing to like.")
        return 0
    total = sum(len(v) for v in targets.values())
    print(f"\n{len(videos)} video(s), {total} comment(s), {len(profiles)} account(s) in lockstep")
    if not args.spread or len(profiles) < 2:
        print(f"→ up to {total * len(profiles)} likes, {len(profiles)} per comment\n")
    else:
        # The real figure, per video, rather than one multiplication that stopped
        # being true: a video's comments get different numbers of likes now, and
        # the run should say which numbers before it starts.
        each = sum(
            sum(spread_targets(len(profiles), len(v), spread_hash(a)))
            for a, v in targets.items()
        )
        rows = " or ".join(
            ", ".join(str(k) for k in spread_targets(len(profiles), 3, st))
            for st in range(3)
        )
        print(
            f"→ up to {each} likes. Our comments on one video get {rows} of "
            f"the {len(profiles)} accounts — which shares, and which comment "
            f"takes which, both follow the video — so neither the counts on "
            f"one video nor the highest across videos repeat.\n"
        )

    if args.dry_run:
        for aweme, url in videos[:10]:
            print(f"  {url}")
            for c in targets[aweme]:
                print(f"      @{c['user']:<20} {c['text'][:60]}")
        if len(videos) > 10:
            print(f"  … and {len(videos) - 10} more video(s)")
        return 0

    width = max(len(p) for p in profiles)
    barrier = threading.Barrier(len(profiles))
    tally: dict[str, tuple[int, int]] = {}
    threads = [
        threading.Thread(target=account, args=(p, videos, targets, args, barrier, tally, width))
        for p in profiles
    ]
    started = time.time()
    for t in threads:
        t.start()
    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        print("\nstopping — waiting for browsers to close…")
        barrier.abort()
        for t in threads:
            t.join(timeout=30)

    print(f"\nfinished in {int(time.time() - started)}s")
    for p in profiles:
        ok, failed = tally.get(p, (0, 0))
        print(f"  {p:<12} {ok} liked, {failed} failed   ({done_path(p).name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
