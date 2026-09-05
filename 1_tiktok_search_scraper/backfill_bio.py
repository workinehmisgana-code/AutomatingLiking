#!/usr/bin/env python3
"""
Fill in the `bio` column on channel_videos_*.csv rows scraped before the scraper
started saving it.

No browser needed. TikTok's public video EMBED page carries the author's bio:
    https://www.tiktok.com/embed/v2/<videoId>
        -> __FRONTITY_CONNECT_STATE__ .. videoData.authorInfos.signature
So one plain HTTP GET per CHANNEL (using any one of its videos) backfills every
row that channel owns — ~180 requests for a 38k-row file, not 38k.

Usage:
    python backfill_bio.py                 # newest results/channel_videos_*.csv
    python backfill_bio.py --all           # every channel_videos_*.csv
    python backfill_bio.py path/to.csv
    python backfill_bio.py --limit 5       # try just 5 channels first
    python backfill_bio.py --dry-run       # fetch + report, write nothing

The original file is copied to <name>.bak before it is rewritten.
"""
import csv
import glob
import json
import re
import shutil
import sys
import time
from pathlib import Path

import requests

# Bios are full of emoji; a Windows console defaults to cp1252 and would crash
# mid-run on the first one. The CSV itself is always written as UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

RESULTS = Path(__file__).parent / "results"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
STATE_RE = re.compile(r'<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>(.*?)</script>', re.S)
VIDEO_ID_RE = re.compile(r"/video/(\d+)")
DELAY = 1.5  # TikTok rate-limits hard; one channel every DELAY seconds


def clean(text: str) -> str:
    """Collapse whitespace so a multi-line bio stays one CSV field."""
    return " ".join(str(text or "").split())


def find_signature(node, depth: int = 0):
    """Depth-first search for authorInfos.signature in the embed state."""
    if depth > 10 or node is None:
        return ""
    if isinstance(node, dict):
        sig = node.get("signature")
        if isinstance(sig, str) and sig.strip():
            return sig
        for v in node.values():
            found = find_signature(v, depth + 1)
            if found:
                return found
    elif isinstance(node, list):
        for v in node:
            found = find_signature(v, depth + 1)
            if found:
                return found
    return ""


def fetch_bio(video_url: str, session: requests.Session) -> str:
    """Channel bio via one of its videos' embed page. '' if unavailable."""
    m = VIDEO_ID_RE.search(video_url)
    if not m:
        return ""
    try:
        r = session.get(f"https://www.tiktok.com/embed/v2/{m.group(1)}",
                        headers={"User-Agent": UA}, timeout=25)
        if not r.ok:
            return ""
        sm = STATE_RE.search(r.text)
        if not sm:
            return ""
        return clean(find_signature(json.loads(sm.group(1))))
    except Exception:
        return ""


# Handle -> bio, shared across files in one run: the same channel appears in
# several channel_videos_*.csv, and refetching it per file would triple the
# requests against a rate-limited endpoint for no gain.
BIO_CACHE: dict[str, str] = {}


def backfill(path: Path, limit: int, dry_run: bool) -> None:
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = list(reader.fieldnames or [])
        rows = list(reader)
    if not rows:
        print(f"  {path.name}: empty, skipped")
        return

    # Add the column if this file predates it — keep `state` last if present.
    if "bio" not in fields:
        fields.insert(fields.index("state") if "state" in fields else len(fields), "bio")

    # Which channels still need one? A channel is done if ANY of its rows has a bio.
    by_account: dict[str, list[dict]] = {}
    known: dict[str, str] = {}
    for r in rows:
        acct = (r.get("account") or "").strip()
        if not acct:
            continue
        by_account.setdefault(acct, []).append(r)
        if clean(r.get("bio")):
            known.setdefault(acct, clean(r["bio"]))
        elif acct in BIO_CACHE:
            known.setdefault(acct, BIO_CACHE[acct])

    need = [a for a in by_account if a not in known]
    print(f"  {path.name}: {len(rows)} rows, {len(by_account)} channels — "
          f"{len(need)} need a bio, {len(known)} already have one")
    if limit:
        need = need[:limit]
        print(f"  (--limit {limit}: fetching {len(need)})")

    session = requests.Session()
    got = 0
    for i, acct in enumerate(need, 1):
        # Any video of this channel resolves the same author.
        url = next((r["url"] for r in by_account[acct] if r.get("url")), "")
        bio = fetch_bio(url, session)
        if bio:
            known[acct] = bio
            BIO_CACHE[acct] = bio
            got += 1
        print(f"    [{i}/{len(need)}] @{acct}: {bio[:60] + '…' if len(bio) > 60 else (bio or '(none)')}")
        if i < len(need):
            time.sleep(DELAY)

    filled = 0
    for acct, group in by_account.items():
        bio = known.get(acct, "")
        if not bio:
            continue
        for r in group:
            if not clean(r.get("bio")):
                r["bio"] = bio
                filled += 1

    print(f"  → {got}/{len(need)} channel bios fetched; {filled} rows filled")
    if dry_run:
        print("  (--dry-run: nothing written)")
        return
    if not filled and "bio" in (csv.DictReader(path.open(encoding='utf-8-sig')).fieldnames or []):
        print("  (nothing to write)")
        return

    backup = path.with_suffix(path.suffix + ".bak")
    shutil.copy2(path, backup)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            r.setdefault("bio", "")
            w.writerow(r)
    tmp.replace(path)
    print(f"  ✔ rewrote {path.name} (backup: {backup.name})")


def main() -> None:
    args = sys.argv[1:]
    limit = 0
    if "--limit" in args:
        i = args.index("--limit")
        limit = int(args[i + 1])
        del args[i:i + 2]
    dry_run = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]

    if "--all" in args:
        paths = [Path(p) for p in sorted(glob.glob(str(RESULTS / "channel_videos_*.csv")))]
    elif [a for a in args if not a.startswith("--")]:
        paths = [Path(a) for a in args if not a.startswith("--")]
    else:
        found = sorted(glob.glob(str(RESULTS / "channel_videos_*.csv")))
        paths = [Path(found[-1])] if found else []
    if not paths:
        raise SystemExit("No channel_videos_*.csv found.")

    for p in paths:
        backfill(p, limit, dry_run)


if __name__ == "__main__":
    main()
