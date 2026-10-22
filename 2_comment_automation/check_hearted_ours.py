#!/usr/bin/env python3
"""
Did every heart this tool has ever sent land on one of OUR comments?

Reads the run logs, which record the comment each batch was sent to, and holds
every successful heart against the keyword it was supposed to be aimed at. A row
with hearts_sent > 0 whose comment_text does not contain comment_keyword is a
batch that went to a stranger.

WHY THERE ARE ANY. The scan recorded WHERE our comment sat - page 2, row 7 - and
the heart was then sent to `.nth(7)` after paging back. An index is not an
identity: one comment arriving in between shifts every row down by one, and row
7 is now somebody else's. See _locate_our_row in automate.py, and
check_right_row.py for the cases.

This is the damage report, not the fix. It is also the regression test for the
logs written from now on: run it after a session and it should say none.

    python check_hearted_ours.py              every log
    python check_hearted_ours.py --since 20261001
"""
import csv
import sys
from pathlib import Path

import automate as a

LOGS = Path(__file__).resolve().parent / "logs"

args = sys.argv[1:]
since = ""
if "--since" in args:
    since = args[args.index("--since") + 1]

files = sorted(p for p in LOGS.glob("run_*.csv")
               if not since or any(ch.isdigit() for ch in p.stem) and p.stem[-15:-7] >= since)

sent_rows = 0
hearts_total = 0
wrong = []          # (file, url, keyword, text, hearts)
no_keyword = 0

for p in files:
    try:
        with open(p, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                try:
                    hearts = int(row.get("hearts_sent") or 0)
                except ValueError:
                    hearts = 0
                if hearts <= 0:
                    continue
                kw = (row.get("comment_keyword") or "").strip()
                text = (row.get("comment_text") or "").strip()
                sent_rows += 1
                hearts_total += hearts
                if not kw:
                    # Nothing to hold it against. Counted, not accused.
                    no_keyword += 1
                    continue
                if not a.matches_keyword(text, kw):
                    wrong.append((p.name, row.get("url", ""), kw, text, hearts))
    except OSError:
        continue

print(f"{len(files)} run log(s), {sent_rows:,} batch(es) sent, "
      f"{hearts_total:,} hearts in total.")
if no_keyword:
    print(f"{no_keyword:,} row(s) recorded no keyword, so they cannot be judged.")

if not wrong:
    print("\nEvery heart went to a comment carrying its own keyword.")
    sys.exit(0)

bad_hearts = sum(w[4] for w in wrong)
print(f"\n{len(wrong):,} batch(es) - {bad_hearts:,} hearts - went to a comment that "
      f"does NOT carry the keyword they were aimed at:\n")
for name, url, kw, text, hearts in wrong[:40]:
    print(f"  {name}")
    print(f"    {url}")
    print(f"    aimed at '{kw}', hearted: \"{text[:110]}\"  ({hearts} hearts)")
if len(wrong) > 40:
    print(f"  ... and {len(wrong) - 40:,} more")

print(f"\n{bad_hearts:,} of {hearts_total:,} hearts "
      f"({bad_hearts / max(1, hearts_total):.1%}) went to somebody else's comment.")
sys.exit(1)
