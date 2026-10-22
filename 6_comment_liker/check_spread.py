#!/usr/bin/env python3
"""
Do our comments on one video end up with DIFFERENT numbers of likes?

THE PROBLEM, in the ledgers. Stacked accounts liked every comment of ours on a
video, so each of them came to rest on exactly the number of accounts in the run
— and it was the same number on every video and every link. Comments that agree
to the unit, sitting in comment sections where nothing else does, are the single
easiest way to find the whole operation at once: find one, read its like count,
search the count.

THE FIX is in like.py: spread_keep. Each video's comments are put in an order
derived from the video and the comment id, the places in that order get shrinking
shares of the roster, and WHO fills each share is decided by hashing the comment
id against the account names. Every account computes the same answer alone, so
nothing has to be coordinated at runtime and a re-run repeats it exactly.

This measures both halves: what the ledgers already show, and what the new rule
would give on that same real data.

    python check_spread.py
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path

from like import (
    SPREAD_STARTS,
    spread_hash,
    spread_keep,
    spread_targets,
    tie_filter,
)

HERE = Path(__file__).resolve().parent
FAILS = 0


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


def comments(n, tag="v"):
    return [{"cid": f"{tag}{i:04d}", "user": "u", "text": "t"} for i in range(n)]


# ── it does nothing where there is nothing to spread ────────────────────────
print("a run with nothing to divide is left alone:")
cs = comments(5)
check("  one account likes everything", len(spread_keep("v1", cs, "a", ["a"])), 5)
check("  and so does an empty roster", len(spread_keep("v1", cs, "a", [])), 5)
check("  a lone comment is liked by all", len(spread_keep("v1", comments(1), "a", list("abcdefghi"))), 1)

# ── the shares ──────────────────────────────────────────────────────────────
print("\nthe shares shrink, and never to nothing:")
check("  nine accounts, four comments", spread_targets(9, 4), [9, 8, 7, 5])
check("  three accounts, four comments", spread_targets(3, 4), [3, 2, 1, 1])
check("  two accounts", spread_targets(2, 3), [2, 1, 1])
check("  a long tail still gets liked", min(spread_targets(9, 12)), 1)
check("  and never more than the roster", max(spread_targets(9, 12)), 9)

# The ladder's STARTING rung follows the video. Without that, the best-liked
# comment on every single video sat at exactly the roster size — the same
# giveaway one level up, and just as searchable.
print("\nand where the ladder starts follows the video:")
tops = {spread_targets(9, 3, st)[0] for st in range(SPREAD_STARTS)}
check("  the top share is not always the whole roster", sorted(tops), [7, 8, 9])
check("  every start still decreases", all(
    spread_targets(9, 4, st) == sorted(spread_targets(9, 4, st), reverse=True)
    for st in range(SPREAD_STARTS)
), True)
check("  and still never reaches zero", min(
    min(spread_targets(9, 8, st)) for st in range(SPREAD_STARTS)
) >= 1, True)

# ── the whole point: different counts on one video ──────────────────────────
ROSTER = list("abcdefghi")  # nine accounts, as a real stacked run has
print(f"\nwith {len(ROSTER)} accounts on one video carrying 4 comments of ours:")
cs = comments(4)
AWEME = "7677839583689641223"
per = {c["cid"]: 0 for c in cs}
for p in ROSTER:
    for c in spread_keep(AWEME, cs, p, ROSTER):
        per[c["cid"]] += 1
counts = sorted(per.values(), reverse=True)
check("  the counts differ", counts, spread_targets(len(ROSTER), 4, spread_hash(AWEME)))
check("  all four are distinct", len(set(counts)), 4)
check("  every comment is liked by somebody", min(counts) >= 1, True)
check("  before this, they were all the same", [len(ROSTER)] * 4, [9, 9, 9, 9])

# Across videos, not just within one: if every video's best comment took the
# whole roster, "9 likes" would still find them all.
highs = set()
for v in range(60):
    vcs = comments(4, f"hi{v}c")
    tally = {c["cid"]: 0 for c in vcs}
    for p in ROSTER:
        for c in spread_keep(f"high{v}", vcs, p, ROSTER):
            tally[c["cid"]] += 1
    highs.add(max(tally.values()))
check("  and the highest count varies between videos", sorted(highs), [7, 8, 9])

# ── it is stable, and it rotates ────────────────────────────────────────────
print("\nstable across runs, different across videos:")
check(
    "  the same answer twice",
    spread_keep("v1", cs, "c", ROSTER) == spread_keep("v1", cs, "c", ROSTER),
    True,
)
check(
    "  the roster can be given in any order",
    [c["cid"] for c in spread_keep("v1", cs, "c", ROSTER)]
    == [c["cid"] for c in spread_keep("v1", cs, "c", list(reversed(ROSTER)))],
    True,
)
# 40 videos, each with four comments of its own. Real comment ids are unique to
# a comment, so a fixed set reused across videos would test a case that cannot
# happen and miss the one that does: the account chosen for a comment follows the
# COMMENT, and only the size of the share follows the video.
VIDEOS = [(f"video{v}", comments(4, f"v{v}c")) for v in range(40)]
tops = defaultdict(int)
takers = defaultdict(int)
for aweme, vcs in VIDEOS:
    liked = defaultdict(int)
    for p in ROSTER:
        got = spread_keep(aweme, vcs, p, ROSTER)
        takers[p] += len(got)
        for c in got:
            liked[c["cid"]] += 1
    # Which of the four the whole roster likes is that video's first place.
    tops[max(liked, key=lambda k: liked[k])[-1]] += 1
check("  every position takes a turn at the top", len(tops), 4)
check("  no account likes everything", max(takers.values()) < 40 * 4, True)
check("  and none is left with nothing", min(takers.values()) > 0, True)
gap = round(100 * (max(takers.values()) - min(takers.values())) / max(takers.values()))
check("  the accounts carry a similar load", gap < 40, True)

# ── one like per like-count ─────────────────────────────────────
#
# The spread above stops our comments from AGREEING on a like count. This stops
# us creating the agreement in the first place: comments already sharing a count
# are a group, the group gets exactly one like, and it goes to the comment
# highest in the section. Three comments on 5 used to become three comments on
# 14 — a coincidence turned into a pattern, on every video.
def with_likes(counts):
    return [{"cid": f"c{i}", "likes": n, "text": f"t{i}"} for i, n in enumerate(counts)]


print("\none like per like-count:")
kept, held = tie_filter(with_likes([9, 4, 1]))
check("  all different, so all are liked", ([c["likes"] for c in kept], held), ([9, 4, 1], 0))
kept, held = tie_filter(with_likes([5, 5, 5]))
check("  three on the same count, one like", ([c["likes"] for c in kept], held), ([5], 2))
kept, held = tie_filter(with_likes([7, 3, 3, 9, 7]))
check("  two groups, one like each", ([c["likes"] for c in kept], held), ([7, 3, 9], 2))
# The API hands a video's comments back in section order, so the FIRST one at a
# given count is the top of that group. That is why there is no sort: a sort
# would have to invent a tiebreak, and this one is given.
kept, _ = tie_filter([
    {"cid": "top", "likes": 5, "text": "highest in the section"},
    {"cid": "mid", "likes": 5, "text": "below it"},
])
check("  and the TOP of the group gets it", kept[0]["cid"], "top")
check("  a lone comment is untouched", len(tie_filter(with_likes([3]))[0]), 1)

# A GROUP IS SAME LIKES AND SAME PRODUCT.
_P = ["purifytext", "humlexic"]
def _c(text, likes, cid):
    return {"cid": cid, "text": text, "likes": likes, "user": "u" + cid}
_mix = [
    _c("purifytext saved me", 5, "1"),
    _c("i use purifytext daily", 5, "2"),
    _c("humlexic is the one", 5, "3"),
    _c("humlexic passes for me", 5, "4"),
    _c("purifytext again", 7, "5"),
]
kept, held = tie_filter(_mix, products=_P)
check("  same likes + same product: one each", [c["cid"] for c in kept], ["1", "3", "5"])
check("  the other two of each product are held", held, 2)
check("  same likes, different products: both liked",
      [c["cid"] for c in tie_filter([_mix[0], _mix[2]], products=_P)[0]], ["1", "3"])
check("  the product named first decides the group",
      [c["cid"] for c in tie_filter([_c("humlexic beats purifytext", 5, "a"),
                                     _c("humlexic ftw", 5, "b")], products=_P)[0]], ["a"])
check("  without products it is the like count alone, as before",
      len(tie_filter([_mix[0], _mix[2]])[0]), 1)
check("  nothing at all is fine", tie_filter([]), ([], 0))
# Zero is a count like any other: two comments nobody has liked are tied.
kept, held = tie_filter(with_likes([0, 0, 2]))
check("  two on zero are tied too", ([c["likes"] for c in kept], held), ([0, 2], 1))
# What it does NOT do, written down so it surprises nobody later.
check(
    "  one tie per group per pass, not all of them",
    [c["likes"] for c in tie_filter(with_likes([5, 5, 5]))[0]] + [5, 5],
    [5, 5, 5],
)

tie_like = (HERE / "like.py").read_text(encoding="utf-8")
tie_lock = (HERE / "run_lockstep.py").read_text(encoding="utf-8")
tie_par = (HERE / "run_parallel.py").read_text(encoding="utf-8")
print("\nand it reaches every path that likes anything:")
check("  the dom path and the dry run", "keep, tied = eligible(picks)" in tie_like, True)
check("  the fast path", "my_share(aweme, eligible(picks)[0])" in tie_like, True)
check("  the dom sweep", "my_share(aweme, eligible(extras)[0])" in tie_like, True)
check(
    "  judged before the roster is divided",
    "The tie rule comes FIRST, before the roster is divided up" in tie_like,
    True,
)
check(
    "  swept rows carry their real count, not a zero",
    '"likes": int(r.get("likes") or 0)' in tie_like,
    True,
)
check("  the per-video line says how many were tied", "{tied} tied on likes" in tie_like, True)
check("  lockstep applies it once, centrally", "picks, tied = tie_filter(picks, products=products)" in tie_lock, True)
check(
    "  and one flag turns it off everywhere",
    all("--like-ties" in x for x in (tie_like, tie_lock, tie_par)),
    True,
)

# ── the real ledgers ────────────────────────────────────────────────────────
# Every profile keeps its own done-<p>.csv, so "how many of us liked this
# comment" is simply how many ledgers hold an ok row for that cid.
liked_by = defaultdict(set)
video_of = {}
for f in sorted(HERE.glob("done*.csv")):
    prof = f.stem.replace("done-", "") if f.stem != "done" else "default"
    try:
        with f.open(encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                if not (row.get("status") or "").startswith("ok"):
                    continue
                cid = (row.get("cid") or "").strip()
                aweme = (row.get("aweme_id") or "").strip()
                if not cid or not aweme or cid.startswith("post:"):
                    continue
                liked_by[cid].add(prof)
                video_of[cid] = aweme
    except OSError:
        continue

by_video = defaultdict(list)
for cid, profs in liked_by.items():
    by_video[video_of[cid]].append((cid, len(profs)))

multi = {v: cs_ for v, cs_ in by_video.items() if len(cs_) > 1}
same = sum(1 for cs_ in multi.values() if len({n for _, n in cs_}) == 1)
print(f"\nwhat the ledgers hold: {len(liked_by):,} comment(s) across {len(by_video):,} video(s)")
if multi:
    print(
        f"  {len(multi):,} video(s) carry more than one comment of ours, and on "
        f"{same:,} of them ({round(100 * same / len(multi))}%) every comment has "
        f"the SAME number of our likes."
    )
    worst = sorted(multi.items(), key=lambda kv: -len(kv[1]))[:3]
    for v, cs_ in worst:
        print(f"    {v}: " + ", ".join(str(n) for _, n in sorted(cs_, key=lambda x: -x[1])))

    # The same videos under the new rule, with the roster that actually worked
    # them.
    changed = 0
    now_same = 0
    for v, cs_ in multi.items():
        roster = sorted({p for cid, _ in cs_ for p in liked_by[cid]})
        if len(roster) < 2:
            continue
        objs = [{"cid": cid} for cid, _ in cs_]
        per = {cid: 0 for cid, _ in cs_}
        for p in roster:
            for c in spread_keep(v, objs, p, roster):
                per[c["cid"]] += 1
        changed += 1
        if len({n for n in per.values()}) == 1:
            now_same += 1
    print(
        f"  under the new rule those {changed:,} video(s) would leave "
        f"{now_same:,} with matching counts"
        + (" — the rest all differ." if now_same == 0 else ".")
    )
    print("\non the real ledgers:")
    check("  no video keeps every comment on one count", now_same, 0)
else:
    print("  no video carries more than one comment of ours yet — nothing to compare.")

# ── the runners actually pass the roster ────────────────────────────────────
par = (HERE / "run_parallel.py").read_text(encoding="utf-8")
lock = (HERE / "run_lockstep.py").read_text(encoding="utf-8")
like = (HERE / "like.py").read_text(encoding="utf-8")
# DIVIDING IS OPT-IN, and it did not start that way. It was the first answer to
# "our comments all carry the same like count"; the tie rule is the better one,
# because it costs nobody a like. So the roster goes out only when asked for.
print("\nthe runners hand the roster over only when asked:")
check("  run_parallel wants --spread and --share stack",
      'if args.spread and args.share == "stack" and len(profiles) > 1:' in par, True)
check("  because split visits each link once", '"--peers", ",".join(profiles)' in par, True)
check("  run_lockstep asks for it too",
      "spread_keep(aweme, here, profile, roster) if args.spread else here" in lock, True)
check("  neither offers --no-spread any more",
      "--no-spread" not in par and "--no-spread" not in lock, True)
check("  and both declare --spread", '"--spread"' in par and '"--spread"' in lock, True)
check("  like.py needs a roster to do anything", "spread_on = bool(peers) and len(peers) > 1" in like, True)
check("  the dom sweep is spread too", "my_share(aweme, eligible(extras)[0])" in like, True)
check("  and the run says what it is doing", "spreading likes across" in like, True)

print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
