"""Remove posts that leaked into an Instagram scrape from someone else's account.

Before the ownership check existed, the response handler took every post-shaped
object out of every /graphql/query response while a profile was open. A profile
page also fetches suggested reels and the signed-in user's own feed over that
same endpoint, so a handful of strangers' posts were saved as if they belonged
to the channel being scraped — filed under its name and stamped with its bio.

A leaked row is identifiable after the fact: every legitimately scraped row
belongs to a channel that was actually scanned, and the scan state next to the
file lists exactly which those were. Anything else came from a suggestion.

    python fix_instagram_leaks.py            # report only
    python fix_instagram_leaks.py --apply    # rewrite the files
"""
import csv
import json
import shutil
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results"
APPLY = "--apply" in sys.argv

files = sorted(RESULTS.glob("instagram_videos_*.csv"))
if not files:
    print("No results/instagram_videos_*.csv found.")
    sys.exit(0)

for path in files:
    state_path = path.with_suffix(path.suffix + ".scan.json")
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        print(f"{path.name}: no scan state beside it — cannot tell which channels were "
              f"scanned, so nothing is touched.")
        continue

    scanned = {k[3:].lower() for k in state if k.startswith("ig:")}
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames or []
        rows = list(reader)

    keep, drop = [], []
    for r in rows:
        (keep if (r.get("account") or "").strip().lower() in scanned else drop).append(r)

    print(f"\n{path.name}: {len(rows)} row(s), {len(scanned)} channel(s) scanned")
    if not drop:
        print("   nothing leaked in.")
        continue
    by_account = {}
    for r in drop:
        by_account.setdefault(r.get("account", ""), 0)
        by_account[r["account"]] += 1
    print(f"   {len(drop)} row(s) from {len(by_account)} account(s) that were never scanned:")
    for a, n in sorted(by_account.items(), key=lambda kv: -kv[1]):
        print(f"      {n:>4}  @{a}")

    if not APPLY:
        print("   (run with --apply to remove them)")
        continue

    shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(keep)

    # The scan state counts what is stored per channel; it has to match.
    counts = {}
    for r in keep:
        counts[(r.get("account") or "").lower()] = counts.get((r.get("account") or "").lower(), 0) + 1
    for k, v in state.items():
        if k.startswith("ig:") and isinstance(v, dict):
            v["stored"] = counts.get(k[3:].lower(), 0)
    state_path.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")
    print(f"   removed. {len(keep)} row(s) left; original kept as {path.name}.bak")
