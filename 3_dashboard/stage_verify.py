"""
Stage channel-scraped CSV links into the dashboard's "Links to verify" list.

This is the counterpart to upload.py. Where upload.py pushes links straight into
the MAIN pool (videos.json), this one puts them in the verify_link staging table
so they show up on the Links-to-verify page for review, and you merge the ones
you want yourself. Nothing here ever touches the main list.

Only links you have not already decided on are staged. A link is skipped when it
is already in the main pool (you merged it) or on the block list (you rejected
it) — matched by TikTok VIDEO ID, not URL text, so /video/ vs /photo/ forms and
query strings can't sneak the same video back in as "new".

Usage:
    python stage_verify.py                                  # newest channel_videos_*.csv
    python stage_verify.py results/channel_videos_X.csv     # one specific file
    python stage_verify.py --all                            # every channel_videos_*.csv
    python stage_verify.py --account betweenstudybreaks     # just one channel
    python stage_verify.py --dry-run                        # report only, write nothing
    python stage_verify.py --limit 5000                     # cap what gets staged

Requires in .env (same directory as this script):
    DATABASE_URL=postgres://...          # verify_link + blocked_link live here
    DASHBOARD_URL=https://your.vercel.app
    LINKS_EXPORT_TOKEN=...               # reads the main pool's URL list

Why the database directly: the dashboard's verify-upload endpoint authenticates
with an admin SESSION COOKIE (it is called from the browser), so there is no
token a script can present. The block list is in Postgres anyway, and the upsert
below is a copy of saveVerifyLinks in lib/db.ts — same columns, same limits, same
conflict rules — so a run behaves exactly like uploading through the page.
"""

import argparse
import csv
import os
import re
import sys
from pathlib import Path

import psycopg2
import requests
from dotenv import dotenv_values

# ── Config ───────────────────────────────────────────────────────────────────
_BASE = Path(__file__).parent
_DOTENV = {
    **dotenv_values(_BASE / ".env"),
    **dotenv_values(_BASE / ".env.local"),  # .env.local overrides .env
}
DATABASE_URL = _DOTENV.get("DATABASE_URL", os.getenv("DATABASE_URL", ""))
DASHBOARD_URL = _DOTENV.get("DASHBOARD_URL", os.getenv("DASHBOARD_URL", "")).rstrip("/")
EXPORT_TOKEN = _DOTENV.get("LINKS_EXPORT_TOKEN", os.getenv("LINKS_EXPORT_TOKEN", ""))
RESULTS_DIR = _BASE.parent / "1_tiktok_search_scraper" / "results"

# Rows per INSERT. Postgres takes far larger arrays, but a smaller batch keeps
# progress visible and a transient network error cheap to retry.
BATCH = 2000

VIDEO_ID_RE = re.compile(r"/(?:video|photo)/(\d+)")

# Column limits copied from saveVerifyLinks (lib/db.ts) so the two agree.
LIMITS = {"account": 120, "posted_date": 60, "title": 500, "bio": 500}

UPSERT = """
INSERT INTO verify_link
  (url, account, view_count, heart_count, comment_count, share_count, posted_date, title, bio)
SELECT * FROM unnest(
  %s::text[], %s::text[], %s::bigint[], %s::bigint[], %s::bigint[], %s::bigint[],
  %s::text[], %s::text[], %s::text[])
ON CONFLICT (url) DO UPDATE SET
  account       = COALESCE(NULLIF(EXCLUDED.account, ''), verify_link.account),
  view_count    = CASE WHEN EXCLUDED.view_count    > 0 THEN EXCLUDED.view_count    ELSE verify_link.view_count    END,
  heart_count   = CASE WHEN EXCLUDED.heart_count   > 0 THEN EXCLUDED.heart_count   ELSE verify_link.heart_count   END,
  comment_count = CASE WHEN EXCLUDED.comment_count > 0 THEN EXCLUDED.comment_count ELSE verify_link.comment_count END,
  share_count   = CASE WHEN EXCLUDED.share_count   > 0 THEN EXCLUDED.share_count   ELSE verify_link.share_count   END,
  posted_date   = COALESCE(NULLIF(EXCLUDED.posted_date, ''), verify_link.posted_date),
  title         = COALESCE(NULLIF(EXCLUDED.title, ''), verify_link.title),
  bio           = COALESCE(NULLIF(EXCLUDED.bio, ''), verify_link.bio)
"""


# ── Helpers ──────────────────────────────────────────────────────────────────

def video_id(url: str) -> str:
    """The numeric TikTok video id, or '' when the URL doesn't carry one.

    Matching on the id rather than the URL is what makes the "already decided"
    check reliable: the same video appears as /video/ and /photo/, with and
    without query strings, and every one of those is the same post.
    """
    m = VIDEO_ID_RE.search(url or "")
    return m.group(1) if m else ""


def as_int(value: object) -> int:
    try:
        n = int(float(str(value).strip() or 0))
        return n if n >= 0 else 0
    except (TypeError, ValueError):
        return 0


def channel_csvs() -> list[Path]:
    """Channel scrapes, newest filename last (they are timestamp-named)."""
    return sorted(RESULTS_DIR.glob("channel_videos_*.csv"))


def pool_video_ids() -> set[str]:
    """Video ids already in the main list, via the token-authenticated export."""
    if not DASHBOARD_URL or not EXPORT_TOKEN:
        sys.exit("[!] DASHBOARD_URL and LINKS_EXPORT_TOKEN must be set in .env.")
    r = requests.get(
        f"{DASHBOARD_URL}/api/links/export",
        headers={"Authorization": f"Bearer {EXPORT_TOKEN}"},
        timeout=300,
    )
    if r.status_code != 200:
        sys.exit(f"[!] Could not read the main link list ({r.status_code}).")
    ids = {video_id(u) for u in r.text.splitlines() if u.strip()}
    ids.discard("")
    return ids


def decided_ids(conn) -> tuple[set[str], set[str]]:
    """(blocked, already staged) video ids."""
    with conn.cursor() as cur:
        cur.execute("SELECT url FROM blocked_link")
        blocked = {video_id(r[0]) for r in cur.fetchall()}
        cur.execute("SELECT url FROM verify_link")
        staged = {video_id(r[0]) for r in cur.fetchall()}
    blocked.discard("")
    staged.discard("")
    return blocked, staged


def read_rows(paths: list[Path], account: str) -> list[dict]:
    """Every usable row from the CSVs, de-duplicated by video id.

    Later files win on a repeat, so re-scraping a channel refreshes its counts
    rather than staging the older numbers.
    """
    by_id: dict[str, dict] = {}
    for path in paths:
        with path.open(newline="", encoding="utf-8-sig") as fh:
            reader = csv.DictReader(fh)
            if not reader.fieldnames or "url" not in reader.fieldnames:
                print(f"    ! {path.name}: no url column, skipped")
                continue
            for row in reader:
                url = (row.get("url") or "").strip()
                vid = video_id(url)
                if not vid or not url.startswith("http"):
                    continue
                acct = (row.get("account") or "").strip()
                if account and acct.lower() != account.lower():
                    continue
                by_id[vid] = {
                    "url": url,
                    "account": acct[: LIMITS["account"]],
                    "view_count": as_int(row.get("view_count")),
                    "heart_count": as_int(row.get("heart_count")),
                    "comment_count": as_int(row.get("comment_count")),
                    "share_count": as_int(row.get("share_count")),
                    "posted_date": (row.get("posted_date") or "").strip()[: LIMITS["posted_date"]],
                    "title": (row.get("title") or "").strip()[: LIMITS["title"]],
                    "bio": (row.get("bio") or "").strip()[: LIMITS["bio"]],
                }
    return list(by_id.values())


def stage(conn, rows: list[dict]) -> int:
    """Upsert in batches. Returns how many rows were sent."""
    sent = 0
    with conn.cursor() as cur:
        for i in range(0, len(rows), BATCH):
            chunk = rows[i : i + BATCH]
            cur.execute(
                UPSERT,
                (
                    [r["url"] for r in chunk],
                    [r["account"] for r in chunk],
                    [r["view_count"] for r in chunk],
                    [r["heart_count"] for r in chunk],
                    [r["comment_count"] for r in chunk],
                    [r["share_count"] for r in chunk],
                    [r["posted_date"] for r in chunk],
                    [r["title"] for r in chunk],
                    [r["bio"] for r in chunk],
                ),
            )
            sent += len(chunk)
            print(f"\r    staged {sent:,} / {len(rows):,}", end="", flush=True)
    conn.commit()
    print()
    return sent


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    ap = argparse.ArgumentParser(
        description="Stage channel CSV links into the Links-to-verify list."
    )
    ap.add_argument("csv", nargs="?", default="", help="A specific CSV (default: the newest channel scrape).")
    ap.add_argument("--all", action="store_true", help="Every channel_videos_*.csv in results/.")
    ap.add_argument("--account", default="", help="Only this channel handle.")
    ap.add_argument("--limit", type=int, default=0, help="Stage at most this many links.")
    ap.add_argument("--dry-run", action="store_true", help="Report what would be staged; write nothing.")
    args = ap.parse_args()

    if not DATABASE_URL:
        sys.exit("[!] DATABASE_URL is not set in .env.")

    if args.csv:
        paths = [Path(args.csv)]
        if not paths[0].exists():
            paths = [RESULTS_DIR / args.csv]
        if not paths[0].exists():
            sys.exit(f"[!] No such file: {args.csv}")
    elif args.all:
        paths = channel_csvs()
    else:
        found = channel_csvs()
        if not found:
            sys.exit(f"[!] No channel_videos_*.csv in {RESULTS_DIR}")
        paths = [found[-1]]

    print(f"Reading {len(paths)} file(s):")
    for p in paths:
        print(f"    {p.name}")
    rows = read_rows(paths, args.account)
    print(f"  {len(rows):,} distinct video(s) in the CSV(s)"
          + (f" for @{args.account}" if args.account else ""))
    if not rows:
        sys.exit("Nothing to stage.")

    print("Checking what has already been decided…")
    in_pool = pool_video_ids()
    conn = psycopg2.connect(DATABASE_URL, sslmode="require")
    try:
        blocked, staged_already = decided_ids(conn)
        print(f"    main list {len(in_pool):,} | blocked {len(blocked):,} | already staged {len(staged_already):,}")

        fresh, skip_pool, skip_blocked, skip_staged = [], 0, 0, 0
        for r in rows:
            vid = video_id(r["url"])
            if vid in in_pool:
                skip_pool += 1
            elif vid in blocked:
                skip_blocked += 1
            elif vid in staged_already:
                skip_staged += 1
            else:
                fresh.append(r)

        print(f"\n  skipped, already in the main list : {skip_pool:,}")
        print(f"  skipped, on the block list        : {skip_blocked:,}")
        print(f"  skipped, already staged           : {skip_staged:,}")
        if args.limit and len(fresh) > args.limit:
            print(f"  capped by --limit                 : {len(fresh) - args.limit:,} left for a later run")
            fresh = fresh[: args.limit]
        print(f"  TO STAGE                          : {len(fresh):,}")
        if fresh:
            channels = {r["account"].lower() for r in fresh if r["account"]}
            with_title = sum(1 for r in fresh if r["title"])
            with_bio = sum(1 for r in fresh if r["bio"])
            print(f"    across {len(channels):,} channel(s); {with_title:,} with a title, {with_bio:,} with a bio")

        if not fresh:
            print("\nNothing new — every link is already merged, blocked or staged.")
            return
        if args.dry_run:
            print("\n(--dry-run: nothing was written)")
            return

        print()
        stage(conn, fresh)
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM verify_link")
            total = cur.fetchone()[0]
        print(f"\nDone. The Links-to-verify list now holds {total:,} link(s).")
        print("Review them there, then merge the ones you want with the per-row")
        print("channel merge button (it takes the whole channel, not just a page).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
