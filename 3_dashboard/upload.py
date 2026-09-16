"""
Upload scraped CSV data to the Vercel dashboard.

Usage:
    python upload.py                        # uploads the most recent CSV
    python upload.py path/to/file.csv       # uploads a specific CSV
    python upload.py --all                  # uploads all CSVs merged
    python upload.py --tiktok               # all TikTok CSVs merged
    python upload.py --youtube              # all YouTube CSVs merged

    By default an upload REPLACES the search-rank links of the platforms it
    contains: the CSV is the current scrape, so rank links that are no longer in
    it have dropped out of the results and are removed with it. A URL that is
    already stored is UPDATED rather than re-created — it keeps its row (clicks,
    cached title, flags) and only its like/view count and rank are refreshed.
    python upload.py                        # replace this CSV's platforms
    python upload.py --all                  # every CSV in results/, merged

    --append adds without removing anything, which is what you want when a CSV
    is one keyword out of several you are uploading separately:
    python upload.py --append

    AN UPLOAD ONLY EVER TOUCHES SEARCH-RANK LINKS. A link with no search rank
    belongs to the posted-date clusters alone — it came from the verify list,
    not from a keyword search — and neither mode will edit or delete one.
    Measured on the live pool: a TikTok upload puts 3,643 rank links up for
    replacement and leaves 134,122 date-clustered ones untouched. Before that
    rule existed, one --replace of a TikTok CSV deleted 93% of the pool, which
    is why replacing used to be the scary option and no longer is.

    --dedupe cleans the dashboard in place: removes any duplicate links (keeps one
    row per URL). No CSV needed:
    python upload.py --dedupe

    Video titles are uploaded too when the CSV has a `title` column (scraper.py
    writes one). They're cached server-side in the dashboard's title table, so the
    admin Links page shows them without re-fetching from TikTok/YouTube.

    Platform is auto-detected per URL (tiktok / youtube_shorts / youtube_videos).
    Force it with --platform to target one bucket explicitly:
    python upload.py yt_videos.csv --platform youtube_videos
    python upload.py yt_shorts.csv  --platform youtube_shorts

Requires in .env (same directory as this script):
    DASHBOARD_URL=https://your-project.vercel.app
    UPLOAD_SECRET=your-secret-key
"""

import csv
import os
import re
import sys
from pathlib import Path

import requests
from dotenv import dotenv_values

# ── Config ───────────────────────────────────────────────────────────────────
_BASE = Path(__file__).parent
# Try .env.local first (Vercel's convention), then .env
_DOTENV = {
    **dotenv_values(_BASE / ".env"),
    **dotenv_values(_BASE / ".env.local"),  # .env.local overrides .env
}
DASHBOARD_URL = _DOTENV.get("DASHBOARD_URL", os.getenv("DASHBOARD_URL", "")).rstrip("/")
UPLOAD_SECRET = _DOTENV.get("UPLOAD_SECRET", os.getenv("UPLOAD_SECRET", ""))
RESULTS_DIR   = _BASE.parent / "1_tiktok_search_scraper" / "results"


# ── Helpers ──────────────────────────────────────────────────────────────────

def parse_url(url: str) -> tuple[str, str, str]:
    """Return (platform, author, video_id) from a TikTok or YouTube URL.

    Platform is one of: tiktok, youtube_shorts, youtube_videos, unknown.
    """
    if "tiktok.com" in url:
        m = re.search(r"tiktok\.com/@([^/]+)/video/(\d+)", url)
        if m:
            return "tiktok", m.group(1), m.group(2)
        # Numeric-handle style already handled above; fallback:
        m = re.search(r"/video/(\d+)", url)
        return "tiktok", "", m.group(1) if m else ""
    if "youtube.com" in url or "youtu.be" in url:
        m = re.search(r"/shorts/([^?&#/]+)", url)
        if m:
            return "youtube_shorts", "", m.group(1)
        m = re.search(r"[?&]v=([^&]+)", url)
        if m:
            return "youtube_videos", "", m.group(1)
    if "instagram.com" in url:
        m = re.search(r"instagram\.com/(?:p|reel)/([^/?#]+)", url)
        return "instagram", "", (m.group(1) if m else "")
    return "unknown", "", ""


VALID_PLATFORMS = {"tiktok", "youtube_shorts", "youtube_videos", "instagram"}


def parse_query(filename: str) -> str:
    """Extract human-readable search query from a CSV filename."""
    stem = Path(filename).stem                         # tiktok_humanizer_and_12_more_20260724_024408
    stem = re.sub(r"^(tiktok|youtube)_", "", stem)    # humanizer_and_12_more_20260724_024408
    stem = re.sub(r"_\d{8}_\d{6}$", "", stem)         # humanizer_and_12_more
    return stem.replace("_", " ")


def read_csv(path: Path, platform_override: str | None = None) -> list[dict]:
    rows = []
    query = parse_query(path.name)
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            url = row.get("url", "").strip()
            if not url:
                continue
            platform, author, video_id = parse_url(url)
            # An explicit --platform target forces the tag (useful when detection
            # can't tell, or to force a whole file into one platform bucket).
            if platform_override:
                platform = platform_override
            elif platform == "unknown" and "tiktok" in path.name:
                platform = "tiktok"
            try:
                like_count = int(row.get("like_count", 0) or 0)
            except ValueError:
                like_count = 0
            try:
                search_rank = int(row.get("search_rank", 0) or 0)
            except ValueError:
                search_rank = 0
            # Real LIKE count when the CSV has one (channel_videos_*.csv does).
            # TikTok's search grid only shows views, so like_count is views there —
            # the dashboard's channel-engagement score uses heart_count for TikTok
            # precisely so views can't stand in for likes.
            try:
                heart_count = int(row.get("heart_count", "") or 0)
            except ValueError:
                heart_count = 0
            rows.append({
                "url":          url,
                "platform":     platform,
                "author":       author,
                "video_id":     video_id,
                "like_count":   like_count,
                "posted_date":  row.get("posted_date", "").strip(),
                "scraped_at":   row.get("scraped_at", "").strip(),
                # Per-row keyword from the CSV column; fall back to the
                # filename-derived query for older CSVs without the column.
                "search_query": row.get("search_query", "").strip() or query,
                "search_rank":  search_rank,
                "heart_count":  heart_count,
                # Scraped video title/caption (scraper.py writes this column).
                # The server caches it in link_title and strips it from the row,
                # so it never bloats videos.json.
                "title":        row.get("title", "").strip(),
                "source_file":  path.name,
            })
    return rows


def collect_csvs(args: list[str]) -> list[Path]:
    """Return list of CSV paths to process based on CLI args."""
    flags = {a for a in args if a.startswith("--")}
    files = [a for a in args if not a.startswith("--")]

    # Specific file(s) named explicitly
    if files:
        paths = []
        for a in files:
            p = Path(a)
            if not p.is_absolute():
                p = RESULTS_DIR / p
            if p.exists():
                paths.append(p)
            else:
                print(f"[!] File not found: {p}")
        return paths

    all_csvs = sorted(RESULTS_DIR.glob("*.csv"), key=lambda p: p.name)

    if "--all" in flags:
        return all_csvs
    if "--tiktok" in flags:
        return [p for p in all_csvs if "tiktok" in p.name]
    if "--youtube" in flags:
        return [p for p in all_csvs if "youtube" in p.name]

    # Default: most recent CSV only (highest filename timestamp)
    non_empty = [p for p in all_csvs if p.stat().st_size > 100]
    if not non_empty:
        return all_csvs[-1:] if all_csvs else []
    return [non_empty[-1]]


def _report_protected(data: dict) -> None:
    """Say how many posted-date links the upload deliberately left alone.

    Usually the largest number on the page — 93% of the pool has no search rank
    — and worth printing precisely because it is the thing an upload no longer
    does. A silent "dropped 4,000 links" is what this replaced.
    """
    n = data.get("protectedDateOnly") or 0
    if n:
        print(f"    Posted-date links untouched: {n:,} "
              "(no search rank — an upload never edits or drops these)")


def upload(videos: list[dict], mode: str = "replace") -> None:
    if not DASHBOARD_URL:
        print("[!] DASHBOARD_URL not set in .env – cannot upload.")
        sys.exit(1)
    if not UPLOAD_SECRET:
        print("[!] UPLOAD_SECRET not set in .env – cannot upload.")
        sys.exit(1)

    url = f"{DASHBOARD_URL}/api/upload?mode={mode}"
    print(f"[*] Uploading {len(videos)} videos to {url} ({mode}) ...")
    r = requests.post(
        url,
        json=videos,
        headers={"x-upload-secret": UPLOAD_SECRET, "Content-Type": "application/json"},
        timeout=60,
    )
    if r.ok:
        data = r.json()
        if mode == "dedupe":
            print(f"[+] Dedupe complete – removed {data.get('removed', '?')} duplicate link(s); "
                  f"{data.get('count', '?')} unique videos remain.")
        elif mode == "append":
            print(f"[+] Upload successful – added {data.get('added', '?')} new link(s), "
                  f"updated {data.get('updated', '?')} existing link(s) (like count / search rank) "
                  f"(of {data.get('received', '?')} sent) → {data.get('count', '?')} videos stored in total.")
            print(f"    Titles cached: {data.get('titlesSaved', 0)}"
                  f" · posted-date clusters re-scored: {data.get('scored', 0)} link(s)")
            _report_protected(data)
        else:
            replaced = data.get("replacedPlatforms") or []
            scope = ", ".join(replaced) if replaced else "all"
            print(f"[+] Upload successful – replaced platform(s) [{scope}]: "
                  f"added {data.get('added', '?')} new link(s), "
                  f"updated {data.get('updated', '?')} existing link(s) (like count / search rank), "
                  f"dropped {data.get('removed', '?')} link(s) no longer in the batch "
                  f"→ {data.get('count', '?')} videos stored in total.")
            print(f"    Titles cached: {data.get('titlesSaved', 0)}"
                  f" · posted-date clusters re-scored: {data.get('scored', 0)} link(s)")
            _report_protected(data)
    else:
        print(f"[!] Upload failed: {r.status_code} {r.text}")
        sys.exit(1)


def main():
    args = sys.argv[1:]

    # A Windows console is cp1252, and this file's own messages contain em
    # dashes. Without this the upload SUCCEEDS and then dies printing the result,
    # which reads exactly like a failed upload.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older Python, or a stream without it
        pass

    # An unrecognised flag must not fall through into a real upload. --help used
    # to do exactly that: it matched nothing, was treated as "no arguments", and
    # uploaded the most recent CSV in replace mode.
    if "--help" in args or "-h" in args:
        print(__doc__)
        return
    known = {
        "--all", "--tiktok", "--youtube", "--append", "--replace", "--dedupe",
        "--platform",
    }
    unknown = [
        a
        for i, a in enumerate(args)
        if a.startswith("-")
        and a not in known
        # the value after --platform is not a flag
        and not (i > 0 and args[i - 1] == "--platform")
    ]
    if unknown:
        print(f"[!] Unknown option(s): {', '.join(unknown)}")
        print("    Run `python upload.py --help` to see what is accepted.")
        sys.exit(2)

    # --dedupe cleans the stored data in place (no CSV needed): removes any
    # duplicate links so only one row per URL remains.
    if "--dedupe" in args:
        print("[*] Deduplicating dashboard links (removing duplicate URLs)...")
        upload([], mode="dedupe")
        return

    # REPLACE is the default: an upload IS the current search-rank scrape, so the
    # stored rank links for its platforms are replaced by it. Rank links absent
    # from the CSV have dropped out of the results and go with them.
    #
    # It stopped being the dangerous option when the server stopped letting an
    # upload reach posted-date links at all. Measured on the live pool, a TikTok
    # upload now puts 3,643 rank links up for replacement and leaves 134,122
    # date-clustered ones untouched; it used to delete all 137,765.
    #
    # --append is the opt-in for adding to the rank set without dropping
    # anything, which is what you want when a CSV is one keyword out of several.
    if "--append" in args and "--replace" in args:
        print("[!] Use only one of --append / --replace.")
        sys.exit(1)
    mode = "append" if "--append" in args else "replace"
    args = [a for a in args if a not in ("--append", "--replace")]

    # --platform <tiktok|youtube_shorts|youtube_videos> forces the platform tag
    # on every uploaded row. In replace mode the server replaces ONLY the
    # platforms present in the upload, leaving other platforms' links untouched.
    platform_override = None
    if "--platform" in args:
        i = args.index("--platform")
        if i + 1 >= len(args):
            print("[!] --platform requires a value (tiktok | youtube_shorts | youtube_videos).")
            sys.exit(1)
        platform_override = args[i + 1]
        del args[i:i + 2]
        if platform_override not in VALID_PLATFORMS:
            print(f"[!] --platform must be one of {sorted(VALID_PLATFORMS)}.")
            sys.exit(1)

    csvs = collect_csvs(args)

    if not csvs:
        print("[!] No CSV files found.")
        print(f"    Looked in: {RESULTS_DIR}")
        sys.exit(1)

    print(f"[*] Reading {len(csvs)} CSV file(s):")
    all_rows: dict[str, dict] = {}  # url → row (dedup; last file wins for same URL)
    for path in csvs:
        rows = read_csv(path, platform_override)
        print(f"    {path.name}: {len(rows)} rows")
        for row in rows:
            existing = all_rows.get(row["url"])
            # Prefer the row with more info: a newer scrape wins, and on a tie the
            # one that actually carries a title wins (older CSVs have no title
            # column, so this stops a blank shadowing a good one).
            if existing is None or row["scraped_at"] > existing["scraped_at"]:
                all_rows[row["url"]] = row
            elif row["scraped_at"] == existing["scraped_at"] and row.get("title") and not existing.get("title"):
                all_rows[row["url"]] = row

    videos = sorted(all_rows.values(), key=lambda v: v["scraped_at"], reverse=True)

    # Show the platform breakdown so it's clear which buckets will be affected.
    by_platform: dict[str, int] = {}
    for v in videos:
        by_platform[v["platform"]] = by_platform.get(v["platform"], 0) + 1
    breakdown = ", ".join(f"{p}: {n}" for p, n in sorted(by_platform.items()))
    print(f"[*] Total unique videos: {len(videos)}  ({breakdown})")
    if mode == "replace":
        print(f"[*] Replace mode: the stored SEARCH-RANK links for {sorted(by_platform)} "
              f"are replaced by this batch — rank links not in the CSV are removed.")
        print("    Untouched: other platforms, and every posted-date link (no search "
              "rank). Pass --append to add without removing anything.")
    else:
        print("[*] Append mode: new links are added, existing ones refreshed; nothing is deleted.")

    upload(videos, mode=mode)


if __name__ == "__main__":
    main()
