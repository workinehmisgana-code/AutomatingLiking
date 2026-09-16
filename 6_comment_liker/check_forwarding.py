#!/usr/bin/env python3
"""
Every like.py flag can be reached through run_parallel.py.

run_parallel launches one like.py per profile and builds each command line by
hand. That list was maintained by eye, so it drifted: --keep-going existed in
like.py, was exactly what a nine-profile run needed, and simply could not be
passed — argparse refused it before anything launched.

Hand-maintained lists drift again. This compares the two sets and names the
difference, so the next flag added to like.py fails here rather than in front of
whoever needed it.

Flags run_parallel CONSUMES rather than forwards are listed below with the
reason: it fetches and shards the links itself, so the workers are handed a
--links file and never the query that produced it.

    python check_forwarding.py
"""
import io
import re
import sys

FAILS = 0


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


def flags(src):
    return set(re.findall(r'ap\.add_argument\(\s*"(--[a-z0-9-]+)"', src))


like = io.open("like.py", encoding="utf-8").read()
par = io.open("run_parallel.py", encoding="utf-8").read()

# What the launcher puts on a worker's command line, however it is spelled.
sent = set(re.findall(r'cmd\.append\("(--[a-z0-9-]+)"\)', par))
sent |= set(re.findall(r'cmd \+= \["(--[a-z0-9-]+)"', par))
sent |= set(re.findall(r'^\s+"(--[a-z0-9-]+)",', par, re.M))
sent |= set(re.findall(r'\(\s*"(--[a-z0-9-]+)",\s*args\.', par))

# Consumed by run_parallel itself, deliberately not forwarded.
CONSUMED = {
    # It fetches the pool and shards it, then hands each worker a --links file.
    "--from-dashboard", "--cluster-by", "--clusters", "--platform",
    "--category", "--max-links", "--links",
    # Set per worker by the launcher, not by the operator.
    "--profile", "--window-slot", "--window-count",
    # Always on for a sharded run.
    "--products",
    # run_parallel spells this --per-account, and forwards it as --limit.
    "--limit",
}

missing = sorted(flags(like) - sent - CONSUMED)
print("every like.py flag is reachable, forwarded or deliberately consumed:")
check("  nothing unreachable", missing, [])

print("\nthe flag this check was written for:")
check("  --keep-going is declared", "--keep-going" in flags(par), True)
check("  and forwarded", "--keep-going" in sent, True)

print("\nand the rest of the per-worker flags:")
for f in ("--solve-captcha", "--no-relogin", "--no-dom-sweep", "--with-media",
          "--comment-empty", "--comment-product", "--mode"):
    check(f"  {f}", f in flags(par) and f in sent, True)

# A forwarded flag that like.py does not accept fails every worker at launch,
# which is the same bug pointing the other way.
unknown = sorted(sent - flags(like))
print("\nnothing is forwarded that like.py would reject:")
check("  no unknown flags", unknown, [])

print("\nthe forwarding is table-driven, not a stack of ifs:")
check("  one table", "for flag, on in (" in par, True)

print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
