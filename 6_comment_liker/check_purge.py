"""Does clearing failures from the ledger do exactly that, and nothing else?

The ledger is the only record of what has already been liked, so a bug here is
not "a comment gets retried" — it is "every comment gets liked again", or worse,
a file that no longer parses. Four things are checked, on COPIES of the real
ledgers plus a few cases the real ones do not contain:

  * every failed row goes, and every 'ok' row stays, byte for byte — including
    the ones whose comment text holds commas, quotes and newlines
  * a cid that failed once and succeeded later stays skipped, so nothing is
    liked twice
  * the file still parses afterwards, with the right header
  * running it twice changes nothing the second time

    python check_purge.py
"""
import csv
import shutil
import sys
import tempfile
from pathlib import Path

from like import COLUMNS, purge_failures

HERE = Path(__file__).resolve().parent

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


def read(p):
    with p.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


tmp = Path(tempfile.mkdtemp(prefix="purge-"))

# ── The real ledgers, copied ─────────────────────────────────────────────────
print("real ledgers:")
for src in sorted(HERE.glob("done*.csv")):
    if src.stat().st_size == 0:
        continue
    work = tmp / src.name
    shutil.copy2(src, work)
    before = read(work)
    ok_before = [r for r in before if (r.get("status") or "").startswith("ok")]

    counts = purge_failures(work)
    after = read(work)

    label = src.name
    check(f"{label}: failures counted", sum(counts.values()), len(before) - len(ok_before))
    check(f"{label}: only ok rows remain", len(after), len(ok_before))
    # Byte for byte: the surviving rows must be the SAME rows, in order, with
    # every field intact — commas and quotes in comment text included.
    same = all(
        all(a.get(c, "") == b.get(c, "") for c in COLUMNS) for a, b in zip(ok_before, after)
    )
    check(f"{label}: surviving rows unchanged", same, True)
    check(f"{label}: nothing left to clear on a second pass", purge_failures(work), {})

# ── The cases the real files do not contain ──────────────────────────────────
print("\nedge cases:")


def make(name, rows):
    p = tmp / name
    with p.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        for r in rows:
            w.writerow(r)
    return p


def row(cid, status, text="plain", note=""):
    return ["2026-09-05T00:00:00", "https://t/x", "1", cid, "u", text, status, note]


# A comment that failed, then succeeded on a later run: the 'ok' row must
# survive, or it would be liked a second time.
p = make("retried.csv", [row("c1", "fail:dom"), row("c1", "ok", note="digg_count=1")])
purge_failures(p)
after = read(p)
check("a cid that failed then succeeded keeps its ok row", [r["status"] for r in after], ["ok"])

# Text carrying the delimiters, so a naive line-based rewrite would corrupt it.
nasty = 'he said "acoustictext, obviously"\nand meant it'
p = make("nasty.csv", [row("c1", "ok", nasty), row("c2", "fail:load")])
purge_failures(p)
after = read(p)
check("commas, quotes and newlines survive", after[0]["text"], nasty)
check("and the failed row beside them is gone", len(after), 1)

# Anything that is not 'ok' is a failure, including shapes not seen yet.
p = make("shapes.csv", [
    row("c1", "ok"), row("c2", "fail:api"), row("c3", "fail:429/0"),
    row("c4", ""), row("c5", "fail:silent"), row("c6", "ok"),
])
counts = purge_failures(p)
check("every non-ok shape is cleared", sum(counts.values()), 4)
check("a blank status counts as a failure", counts.get("(blank)"), 1)
check("ok rows survive", [r["cid"] for r in read(p)], ["c1", "c6"])

# A ledger with nothing wrong in it must not be rewritten at all.
p = make("clean.csv", [row("c1", "ok"), row("c2", "ok")])
stamp = p.stat().st_mtime_ns
check("a clean ledger reports nothing", purge_failures(p), {})
check("and is left untouched on disk", p.stat().st_mtime_ns, stamp)

# Missing and header-only files.
check("a missing ledger is not an error", purge_failures(tmp / "nope.csv"), {})
check("a header-only ledger is not an error", purge_failures(make("empty.csv", [])), {})

check("no temp file is left behind", sorted(x.name for x in tmp.glob("*.tmp")), [])

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
