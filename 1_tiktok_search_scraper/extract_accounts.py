"""
Extract the unique accounts behind the scraped video links.

Reads one or more of the scraper's result CSVs (columns: search_query,
search_rank, url, like_count, posted_date, scraped_at), pulls the account out of
each URL, de-duplicates across all input files, and writes a CSV of the unique
account links with a per-account video count.

Which platforms put the account in the URL:
  • TikTok    → https://www.tiktok.com/@<handle>/video/<id>   ✅ in the URL
  • YouTube   → https://www.youtube.com/watch?v=<id>          ❌ channel not in URL
  • Reddit    → https://www.reddit.com/r/<sub>/comments/...   ❌ (subreddit, not a user)
  • Instagram → https://www.instagram.com/p/<code>/           ❌ but LOOKED UP

Instagram post links carry no username, which is why they used to be dropped on
the floor — 5,353 rows of them in results/, every one discarded. They are now
resolved by fetching the post (see instagram_owner.py), cached in
results/instagram_owners.json so the cost is paid once, and counted like any
other account. Plain HTTP gets about 85% of them; --ig-browser finishes the rest
through the scraper's own logged-in Chromium.

Rows that already name the account in a column ("account", "channel",
"username") are believed without fetching anything.

Usage:
  python extract_accounts.py                        # all results/*.csv
  python extract_accounts.py results/tiktok_*.csv   # specific files / globs
  python extract_accounts.py path/to/file.csv -o accounts.csv
  python extract_accounts.py -p tiktok              # only one platform
  python extract_accounts.py --no-instagram-lookup  # skip the fetching
  python extract_accounts.py --ig-browser           # then finish the stubborn ones
"""

import argparse
import csv
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import instagram_owner as ig


def account_from_url(url: str):
    """Return (platform, account_url, handle) for a video URL, or None if the
    account can't be derived from the URL alone."""
    u = url.strip()

    # TikTok: /@handle/video/... or /@handle/photo/...  (handle may be a username
    # or a numeric user id — kept as-is)
    m = re.match(r"https?://(?:www\.)?tiktok\.com/@([^/?#]+)", u, re.I)
    if m:
        h = m.group(1)
        return ("tiktok", f"https://www.tiktok.com/@{h}", h)

    # YouTube channel handle, when present (e.g. youtube.com/@channel/...)
    m = re.match(r"https?://(?:www\.)?youtube\.com/@([^/?#]+)", u, re.I)
    if m:
        h = m.group(1)
        return ("youtube", f"https://www.youtube.com/@{h}", h)

    # Instagram username that precedes /reel|/p (not the bare /p/<code> form)
    m = re.match(r"https?://(?:www\.)?instagram\.com/([^/?#]+)/(?:reel|reels|p|tv)/", u, re.I)
    if m and m.group(1).lower() not in ig.NOT_A_HANDLE:
        h = m.group(1)
        return ("instagram", ig.profile_url(h), h)

    # Reddit user pages, when present
    m = re.match(r"https?://(?:www\.)?reddit\.com/(?:user|u)/([^/?#]+)", u, re.I)
    if m:
        h = m.group(1)
        return ("reddit", f"https://www.reddit.com/user/{h}/", h)

    return None


def resolve_inputs(patterns: list[str]) -> list[Path]:
    files: list[Path] = []
    for pat in patterns:
        p = Path(pat)
        if p.is_file():
            files.append(p)
        else:
            files.extend(Path(".").glob(pat))
    return sorted(set(files))


# Columns a CSV might already use to name the account. Free when present, so
# they are read before anything is fetched.
ACCOUNT_COLUMNS = ("account", "channel", "username", "author", "handle", "owner")


def platform_of(url: str) -> str | None:
    u = url.lower()
    if "tiktok.com" in u:
        return "tiktok"
    if "youtube.com" in u or "youtu.be" in u:
        return "youtube"
    if "instagram.com" in u:
        return "instagram"
    if "reddit.com" in u:
        return "reddit"
    return None


def account_from_row(row: dict, url: str):
    """The account a CSV column names, for rows whose URL does not carry one.

    channel_videos_*.csv already has an 'account' column, and a future Instagram
    export may too. Believing it costs nothing and saves a fetch.
    """
    plat = platform_of(url)
    if not plat:
        return None
    for col in ACCOUNT_COLUMNS:
        h = (row.get(col) or "").strip().lstrip("@")
        if not h or "/" in h or " " in h or h.lower() in ig.NOT_A_HANDLE:
            continue
        if plat == "tiktok":
            return ("tiktok", f"https://www.tiktok.com/@{h}", h)
        if plat == "youtube":
            return ("youtube", f"https://www.youtube.com/@{h}", h)
        if plat == "instagram":
            return ("instagram", ig.profile_url(h), h)
        if plat == "reddit":
            return ("reddit", f"https://www.reddit.com/user/{h}/", h)
    return None


def main():
    ap = argparse.ArgumentParser(description="Extract unique account links from scraped link CSVs.")
    ap.add_argument("inputs", nargs="*", help="CSV file(s) or glob(s). Default: results/*.csv")
    ap.add_argument("-o", "--out", help="Output CSV path (default: results/unique_accounts_<ts>.csv)")
    ap.add_argument("-p", "--platform", help="Only this platform (tiktok/youtube/instagram/reddit)")
    ap.add_argument("--links-only", action="store_true",
                    help="Also write a plain .txt with one account URL per line")
    ap.add_argument("--no-instagram-lookup", action="store_true",
                    help="Do not fetch Instagram posts; use only what is already cached")
    ap.add_argument("--ig-workers", type=int, default=8,
                    help="Instagram posts to fetch at once (default 8)")
    ap.add_argument("--ig-attempts", type=int, default=3,
                    help="Tries per post before giving up on it (default 3)")
    ap.add_argument("--ig-limit", type=int, default=0,
                    help="Resolve at most this many NEW posts this run (0 = no cap)")
    ap.add_argument("--ig-browser", action="store_true",
                    help="Finish the posts plain HTTP could not resolve, using the "
                         "scraper's logged-in browser_profile (slow, needs playwright)")
    ap.add_argument("--ig-headless", action="store_true",
                    help="Run that browser without a window")
    args = ap.parse_args()

    files = resolve_inputs(args.inputs or ["results/*.csv"])
    if not files:
        print("[!] No input CSV files found. Pass a file/glob, or run from the project root.")
        sys.exit(1)

    # account_url -> {platform, handle, videos: set(url), queries: set(query)}
    accounts: dict[str, dict] = {}
    total_rows = 0
    want = args.platform.lower() if args.platform else None

    def add(platform, acc_url, handle, video_url, query):
        if want and platform != want:
            return
        a = accounts.setdefault(
            acc_url, {"platform": platform, "handle": handle, "videos": set(), "queries": set()}
        )
        a["videos"].add(video_url)
        if query:
            a["queries"].add(query)

    # Instagram posts whose account is not in the URL: (code, url, query). Held
    # back rather than dropped, and resolved in one batch below — one pass over
    # the files, one pass over the network.
    pending_ig: list[tuple[str, str, str]] = []

    for f in files:
        try:
            with open(f, newline="", encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    url = (row.get("url") or "").strip()
                    if not url:
                        continue
                    total_rows += 1
                    q = (row.get("search_query") or "").strip()
                    info = account_from_url(url) or account_from_row(row, url)
                    if info:
                        add(info[0], info[1], info[2], url, q)
                        continue
                    code = ig.post_code(url)
                    if code:
                        pending_ig.append((code, url, q))
        except Exception as e:
            print(f"[!] Skipping {f}: {e}")

    # ── Instagram: the account has to be fetched ─────────────────────────────
    if pending_ig and (not want or want == "instagram"):
        codes = list(dict.fromkeys(c for c, _, _ in pending_ig))
        cache = ig.load_cache()
        known = sum(1 for c in codes if (cache.get(c) or {}).get("user"))
        print(f"[*] Instagram: {len(pending_ig)} post link(s), {len(codes)} unique "
              f"post(s), {known} already known")

        if not args.no_instagram_lookup:
            fresh = [c for c in codes
                     if c not in cache or ig.stale_miss(cache[c])]
            if args.ig_limit and len(fresh) > args.ig_limit:
                print(f"[*]   capped at {args.ig_limit} new post(s) this run "
                      f"({len(fresh) - args.ig_limit} left for next time)")
                fresh = fresh[:args.ig_limit]
            if fresh:
                print(f"[*]   fetching {len(fresh)} post(s) with {args.ig_workers} worker(s)...")
                start = datetime.now()

                def progress(done, total, code, who):
                    if done % 25 == 0 or done == total:
                        rate = done / max(1e-9, (datetime.now() - start).total_seconds())
                        left = (total - done) / rate if rate else 0
                        print(f"      {done}/{total}  ({rate:.1f}/s, ~{left/60:.0f} min left)",
                              flush=True)

                cache = ig.resolve_many(fresh, workers=args.ig_workers,
                                        attempts=args.ig_attempts, cache=cache,
                                        on_progress=progress)

            if args.ig_browser:
                stuck = [c for c in codes if not (cache.get(c) or {}).get("user")]
                if stuck:
                    print(f"[*]   {len(stuck)} post(s) plain HTTP would not give up — "
                          f"opening the browser profile")
                    try:
                        cache = ig.resolve_with_browser(
                            stuck, cache=cache, headless=args.ig_headless,
                            on_progress=lambda d, t, c, w: (
                                print(f"      {d}/{t}  {c} -> {'@' + w if w else '(none)'}", flush=True)
                                if d % 10 == 0 or d == t else None),
                        )
                    except ImportError:
                        print("[!]   playwright is not installed — skipping the browser pass")
                    except Exception as e:
                        print(f"[!]   browser pass stopped: {e}")

        resolved = unresolved = 0
        for code, url, q in pending_ig:
            who = (cache.get(code) or {}).get("user")
            if who:
                add("instagram", ig.profile_url(who), who, url, q)
                resolved += 1
            else:
                unresolved += 1
        print(f"[*] Instagram: {resolved} link(s) attributed, {unresolved} still unknown")
        if unresolved and args.no_instagram_lookup:
            print("[*]   drop --no-instagram-lookup to fetch them")
        elif unresolved and not args.ig_browser:
            print("[*]   re-run with --ig-browser to finish those through a logged-in browser")

    if not accounts:
        print("[!] No accounts could be extracted.")
        sys.exit(0)

    # Most-prolific accounts first.
    rows = sorted(accounts.items(), key=lambda kv: (-len(kv[1]["videos"]), kv[0]))

    out = args.out or f"results/unique_accounts_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["account_url", "platform", "handle", "video_count", "search_queries"])
        for acc_url, a in rows:
            w.writerow([acc_url, a["platform"], a["handle"], len(a["videos"]), "; ".join(sorted(a["queries"]))])

    if args.links_only:
        txt = str(Path(out).with_suffix(".txt"))
        with open(txt, "w", encoding="utf-8") as fh:
            for acc_url, _ in rows:
                fh.write(acc_url + "\n")

    # Summary
    by_platform: dict[str, int] = defaultdict(int)
    for _, a in rows:
        by_platform[a["platform"]] += 1
    print(f"[*] Read {len(files)} file(s), {total_rows} link rows")
    print(f"[*] Unique accounts: {len(rows)}")
    for plat, n in sorted(by_platform.items()):
        print(f"      {plat:<10}: {n}")
    print(f"[*] Saved -> {out}")
    if args.links_only:
        print(f"[*] Links   -> {Path(out).with_suffix('.txt')}")
    print("\nTop accounts by videos:")
    for acc_url, a in rows[:15]:
        print(f"  {len(a['videos']):>4}  {acc_url}")


if __name__ == "__main__":
    main()
