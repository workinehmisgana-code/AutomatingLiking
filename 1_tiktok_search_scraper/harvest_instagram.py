#!/usr/bin/env python3
"""
Extract new Instagram videos, end to end, in one command.

WHY THIS IS NOT A BUTTON IN THE DASHBOARD
Instagram's profile page is a JavaScript shell. The posts are not in the HTML at
all — the page fetches them after it loads, which is why 626 KB of profile page
contains zero post codes, and why every serverless route returns nothing:

    /<handle>/embed/                200, 267 KB, zero post codes
    /<handle>/embed/captioned/      404
    /<handle>/reels/                200, 666 KB, zero post codes
    /<handle>/?__a=1                200, 728 KB, zero post codes
    /p/<code>/embed/                200, links only to itself
    /api/v1/users/web_profile_info/ 429, even with cookies and a pause

Nothing that only speaks HTTP can list an Instagram profile. Something that RUNS
THE JAVASCRIPT can, which is exactly what scrape_channels.py already does with
the signed-in browser profile — it has scraped 2,145 Instagram accounts this way.

So the loop lives here, on the machine with the browser, and the dashboard is
asked for the input and handed the output:

    1. ask the dashboard which Instagram channels it holds, best first
    2. scrape those channels (incremental: only what is newer than we have)
    3. post what was found into the Links-to-verify staging list

Nothing reaches a user from this. Staged links still have to be reviewed and
merged by hand on the Links-to-verify page, exactly as an uploaded CSV does.

    python harvest_instagram.py --limit 50          # the 50 best channels
    python harvest_instagram.py --limit 50 --dry-run
    python harvest_instagram.py --accounts mine.txt # skip step 1

Needs DASHBOARD_URL and UPLOAD_SECRET in .env (the same two upload.py uses);
LINKS_EXPORT_TOKEN is used for the read if it is set.
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def load_env() -> dict:
    """DASHBOARD_URL / UPLOAD_SECRET / LINKS_EXPORT_TOKEN, .env first."""
    out: dict[str, str] = {}
    for path in (HERE / ".env", HERE.parent / "3_dashboard" / ".env"):
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    for k in ("DASHBOARD_URL", "UPLOAD_SECRET", "LINKS_EXPORT_TOKEN"):
        if os.getenv(k):
            out[k] = os.environ[k]
    return out


def api(env: dict, path: str, payload=None, token_key="UPLOAD_SECRET", timeout=120):
    base = env.get("DASHBOARD_URL", "").rstrip("/")
    if not base:
        raise SystemExit("DASHBOARD_URL is not set (put it in .env)")
    token = env.get(token_key) or env.get("UPLOAD_SECRET", "")
    if not token:
        raise SystemExit(f"{token_key} is not set (put it in .env)")
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base}{path}",
        data=data,
        method="POST" if data else "GET",
        headers={
            "Content-Type": "application/json",
            # Read endpoints take the export token; writes take the upload
            # secret. Both are sent; the server accepts whichever it needs.
            "x-upload-secret": env.get("UPLOAD_SECRET", ""),
            "x-links-token": env.get("LINKS_EXPORT_TOKEN", ""),
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", errors="replace") or "{}")


def ranked_instagram(env: dict, limit: int) -> list[dict]:
    """The dashboard's ranked Instagram channels, best first."""
    d = api(env, "/api/admin/verify-links/extract", token_key="LINKS_EXPORT_TOKEN")
    channels = [c for c in (d.get("channels") or []) if c.get("platform") == "instagram"]
    return channels[:limit] if limit else channels


def newest_csv() -> Path | None:
    files = sorted(glob.glob(str(RESULTS / "instagram_videos_*.csv")))
    return Path(files[-1]) if files else None


def rows_since(path: Path | None, before: set[str]) -> list[dict]:
    """Rows in the newest Instagram CSV whose URL was not there beforehand.

    Compared by URL rather than by the file's own `state` column: a re-run marks
    rows NEW again, and uploading those would be a no-op at best and a
    re-staging of links already judged at worst.
    """
    if not path or not path.exists():
        return []
    out = []
    with path.open(encoding="utf-8", errors="ignore", newline="") as f:
        for r in csv.DictReader(f):
            u = (r.get("url") or "").strip()
            if u and u not in before:
                out.append(r)
    return out


def urls_in(path: Path | None) -> set[str]:
    if not path or not path.exists():
        return set()
    with path.open(encoding="utf-8", errors="ignore", newline="") as f:
        return {(r.get("url") or "").strip() for r in csv.DictReader(f) if r.get("url")}


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=50,
                    help="how many channels to take from the top of the ranking (0 = all)")
    ap.add_argument("--accounts", help="use this accounts file instead of asking the dashboard")
    ap.add_argument("--dry-run", action="store_true",
                    help="do everything except the scrape and the upload")
    ap.add_argument("--headed", action="store_true", help="show the browser")
    ap.add_argument("--no-upload", action="store_true",
                    help="scrape, but leave the CSV for a manual upload")
    args = ap.parse_args()

    env = load_env()

    # ── 1. which channels ─────────────────────────────────────────────────
    if args.accounts:
        accounts_file = Path(args.accounts)
        print(f"[1/3] using {accounts_file}")
    else:
        print("[1/3] asking the dashboard for its ranked Instagram channels…")
        channels = ranked_instagram(env, args.limit)
        if not channels:
            print("      none returned — is LINKS_EXPORT_TOKEN set, and are there Instagram links?")
            return 1
        RESULTS.mkdir(exist_ok=True)
        accounts_file = RESULTS / f"ig-channels-{time.strftime('%Y%m%d_%H%M%S')}.txt"
        accounts_file.write_text(
            "\n".join(
                [f"# {len(channels)} instagram channel(s), best first, from the dashboard", ""]
                + [f"https://www.instagram.com/{c['handle']}/" for c in channels]
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"      {len(channels)} channel(s) -> {accounts_file.name}")
        print(f"      best: {', '.join(c['handle'] for c in channels[:5])}")

    before_file = newest_csv()
    before = urls_in(before_file)
    print(f"      already held in {before_file.name if before_file else '(no csv yet)'}: {len(before):,} post(s)")

    if args.dry_run:
        print("\ndry run — not scraping, not uploading.")
        return 0

    # ── 2. scrape, with the browser that can actually see the posts ───────
    print("\n[2/3] scraping (incremental: stops at the first post already held)…")
    cmd = [sys.executable, "-u", str(HERE / "scrape_channels.py"),
           "--accounts", str(accounts_file), "--platform", "instagram"]
    if args.headed:
        cmd.append("--headed")
    rc = subprocess.call(cmd, cwd=str(HERE))
    if rc != 0:
        print(f"      scrape exited {rc} — stopping before the upload.")
        return rc

    # ── 3. hand what was found back ──────────────────────────────────────
    after_file = newest_csv()
    fresh = rows_since(after_file, before)
    print(f"\n[3/3] {len(fresh):,} new post(s) in {after_file.name if after_file else '(none)'}")
    if not fresh:
        print("      nothing new to stage.")
        return 0
    if args.no_upload:
        print(f"      --no-upload: left in {after_file}")
        return 0

    sent = 0
    CHUNK = 500
    for i in range(0, len(fresh), CHUNK):
        rows = [
            {
                "url": r.get("url", ""),
                "account": r.get("account", ""),
                "view_count": int(float(r.get("view_count") or 0)),
                "heart_count": int(float(r.get("heart_count") or 0)),
                "comment_count": int(float(r.get("comment_count") or 0)),
                "share_count": int(float(r.get("share_count") or 0)),
                "posted_date": r.get("posted_date", ""),
                "title": r.get("title", ""),
                "bio": r.get("bio", ""),
            }
            for r in fresh[i : i + CHUNK]
        ]
        try:
            d = api(env, "/api/admin/verify-links/upload", {"rows": rows})
            sent += int(d.get("saved") or 0)
            print(f"      staged {sent:,}/{len(fresh):,}")
        except urllib.error.HTTPError as e:
            print(f"      upload failed: HTTP {e.code} {e.read()[:200]!r}")
            return 1

    print(f"\nDone. {sent:,} link(s) are waiting on the Links-to-verify page.")
    print("Review them there and merge the ones worth keeping — nothing is live yet.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
