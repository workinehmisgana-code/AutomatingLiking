#!/usr/bin/env python3
"""
Extract the COMMENTS on TikTok videos via Freer (nreer.com) — read-only, no
hearts are ever given. For each link it opens Freer's "Comment Hearts" view
(which lists every comment on the video), collects the commenter usernames +
comment texts across all pages, then clicks the page's Back button to return to
the dashboard before the next link. Output is a JSON file pairing each link with
its list of comments.

Links are processed in the SAME cluster order the dashboard uses: split into
clusters by search rank AND by posted date, then interleaved (rank-cluster 1,
date-cluster 1, rank-cluster 2, …). Feed it a scraper CSV (with search_rank /
posted_date columns) to get real clustering; a plain URL list still works but
then all links fall in one cluster (processed in file order).

Why Freer: TikTok blocks direct comment scraping. Freer already renders the full
comment list for a video, so we read it there. Reuses the maintained Freer flow
from automate.py.

Usage:
    python extract_comments.py --links scraped.csv
    python extract_comments.py --links links.txt --out comments.json
    python extract_comments.py https://www.tiktok.com/@u/video/123 https://...
    python extract_comments.py --links scraped.csv --no-cluster   # keep file order

A browser window opens (headed) because Freer is captcha-gated — solve the word
captcha when prompted and the script continues on its own. Results are saved
after every video, so a stop/timeout never loses finished work.
"""
import argparse
import csv
import io
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# Reuse the proven Freer flow (browser launch, captcha/timer handling, service
# open, URL-form navigation) from the automation so selectors stay in sync.
from automate import (
    new_browser_page,
    page_wait,
    freer_open_service,
    freer_ensure_url_form,
    freer_wait_captcha,
    FREER_URL,
)

TIKTOK_URL_RE = re.compile(r"https?://(?:www\.)?tiktok\.com/@[^/\s,\"']+/(?:video|photo)/\d+")


# ── Dashboard-identical clustering (port of lib/cluster.ts) ───────────────────

_UNIT_MS = {
    "second": 1_000, "minute": 60_000, "hour": 3_600_000, "day": 86_400_000,
    "week": 604_800_000, "month": 2_629_800_000, "year": 31_557_600_000,
    "s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000,
    "w": 604_800_000, "mo": 2_629_800_000, "y": 31_557_600_000,
}


def _iso_ms(s: str):
    if not s:
        return None
    try:
        return int(datetime.fromisoformat(s.strip().replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def parse_posted_date(raw, scraped_at):
    """Normalise a scraped posted_date into epoch-ms (or None). Mirrors the
    dashboard's parsePostedDate: relative words/abbreviations + absolute dates."""
    if not raw:
        return None
    s = str(raw).strip().lower()
    base = _iso_ms(scraped_at) or int(time.time() * 1000)
    if s in ("just now", "today"):
        return base
    if s == "yesterday":
        return base - 86_400_000
    m = re.match(r"(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago", s)
    if m:
        return base - int(m.group(1)) * _UNIT_MS.get(m.group(2), 0)
    m = re.match(r"^(\d+)\s*(mo|s|m|h|d|w|y)\s*ago$", s)
    if m:
        return base - int(m.group(1)) * _UNIT_MS.get(m.group(2), 0)
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$", s)
    if m:
        return int(datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc).timestamp() * 1000)
    m = re.match(r"^(\d{1,2})[-/](\d{1,2})$", s)
    if m:
        y = datetime.fromtimestamp(base / 1000, tz=timezone.utc).year
        try:
            t = int(datetime(y, int(m.group(1)), int(m.group(2)), tzinfo=timezone.utc).timestamp() * 1000)
            if t > base + 86_400_000:
                t = int(datetime(y - 1, int(m.group(1)), int(m.group(2)), tzinfo=timezone.utc).timestamp() * 1000)
            return t
        except Exception:
            return None
    return _iso_ms(raw)


def _chunk(items, n):
    """Split into n contiguous, as-even-as-possible clusters."""
    out, start = [], 0
    for i in range(n):
        size = (len(items) - start) // (n - i)
        out.append(items[start:start + size])
        start += size
    return out


def cluster_and_order(items, n_clusters=10):
    """Order links by interleaved rank & date clusters (the dashboard 'combined'
    order): rank-cluster 1, date-cluster 1, rank-cluster 2, …. Stable, deduped."""
    if len(items) <= 1:
        return list(items)
    n = min(n_clusters, len(items))
    BIG = 10 ** 18

    def rank_of(e):
        r = e.get("search_rank") or 0
        return r if r and r > 0 else BIG

    by_rank = sorted(items, key=rank_of)  # stable
    rank_clusters = _chunk(by_rank, n)

    def recency(e):
        v = parse_posted_date(e.get("posted_date"), e.get("scraped_at"))
        return v if v is not None else float("-inf")

    by_date = sorted(items, key=recency, reverse=True)
    date_clusters = _chunk(by_date, n)

    seen, out = set(), []

    def emit(cluster):
        for e in cluster:
            if e["url"] not in seen:
                seen.add(e["url"])
                out.append(e)

    for i in range(n):
        emit(rank_clusters[i])  # i-th search-rank cluster
        emit(date_clusters[i])  # then i-th posted-date cluster
    emit(items)  # safety net
    return out


# ── Input loading ─────────────────────────────────────────────────────────────

def _to_int(v):
    try:
        return int(float(str(v).strip()))
    except Exception:
        return 0


def load_links(links_file: str, positional: list[str]) -> list[dict]:
    """Return link dicts {url, search_rank, posted_date, scraped_at}. A CSV with a
    'url' header is parsed for clustering fields; otherwise each line is scanned
    for a TikTok URL (no clustering fields)."""
    items: list[dict] = []
    if links_file:
        text = Path(links_file).read_text(encoding="utf-8", errors="ignore")
        head = next((ln for ln in text.splitlines() if ln.strip()), "")
        is_csv = "," in head and "url" in head.lower()
        if is_csv:
            for row in csv.DictReader(io.StringIO(text)):
                raw_url = (row.get("url") or "").strip()
                m = TIKTOK_URL_RE.search(raw_url) or TIKTOK_URL_RE.search(",".join(map(str, row.values())))
                if not m:
                    continue
                items.append({
                    "url": m.group(0),
                    "search_rank": _to_int(row.get("search_rank")),
                    "posted_date": (row.get("posted_date") or "").strip(),
                    "scraped_at": (row.get("scraped_at") or "").strip(),
                })
        else:
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                m = TIKTOK_URL_RE.search(line)
                url = m.group(0) if m else (line if line.lower().startswith("http") else "")
                if url:
                    items.append({"url": url, "search_rank": 0, "posted_date": "", "scraped_at": ""})
    for u in positional or []:
        items.append({"url": u, "search_rank": 0, "posted_date": "", "scraped_at": ""})
    # De-dupe by URL, preserving first.
    seen, out = set(), []
    for it in items:
        if it["url"] not in seen:
            seen.add(it["url"])
            out.append(it)
    return out


# ── Freer flow ────────────────────────────────────────────────────────────────

def quick_captcha(page):
    """Fast captcha check: only hand off to the (blocking) full handler if a
    captcha is actually on screen RIGHT NOW. Avoids freer_wait_captcha's 5s poll
    on every step when there is no captcha (the usual case mid-session). The
    preceding page_wait already lets the AJAX response settle into the DOM."""
    try:
        if page.locator("form#cat").first.is_visible():
            freer_wait_captcha(page)
    except Exception:
        pass


def open_url_form(page):
    """Dashboard → URL form via 'Use', fast. Falls back to the robust (slower)
    freer_ensure_url_form only for rare states (a cooldown timer showing)."""
    quick_captcha(page)
    try:
        if page.locator("form#form1").first.is_visible():
            return
    except Exception:
        pass
    # Close a leftover success modal that could block the Use button.
    try:
        cb = page.locator(".modal.show button.close").first
        if cb.count() and cb.is_visible():
            cb.click()
            page_wait(0.3, 0.6)
    except Exception:
        pass
    try:
        use = page.locator("button[onclick*='tok_free']").filter(has_text="Use").first
        use.wait_for(state="visible", timeout=5000)
        use.click()
        page_wait(0.8, 1.4)
        quick_captcha(page)
        page.locator("form#form1").first.wait_for(state="visible", timeout=6000)
        return
    except Exception:
        # A timer or unexpected state — let the robust helper wait it out.
        freer_ensure_url_form(page)


def freer_go_back(page):
    """From the comments page, click the header 'Go Back' button (onclick =
    zxndnnndje()) to return to the service dashboard."""
    quick_captcha(page)
    try:
        page.locator("button[title='Go Back']").first.click(timeout=5000)
    except Exception:
        try:
            page.evaluate("zxndnnndje()")  # the back button's JS call, no args
        except Exception:
            pass
    page_wait(1.0, 1.6)
    quick_captcha(page)


def extract_comments_for_url(page, url: str, max_pages: int) -> list[dict]:
    """Open one video on Freer and return [{user, text}] for every comment. Never
    touches a heart button."""
    # 1. Submit the URL.
    inp = page.locator("form#form1 input[type='search']").first
    inp.wait_for(state="visible", timeout=15000)
    inp.fill(url)
    page_wait(0.2, 0.4)
    page.locator("form#form1 button[type='submit']").first.click()
    # The wait_for below gates readiness, so this settle can be short.
    page_wait(0.8, 1.3)
    quick_captcha(page)

    # 2. Open the comment stats, then "Show comments".
    try:
        page.locator("button[data-type='com_op']").first.wait_for(state="visible", timeout=15000)
    except PWTimeout:
        print("    · video info did not load")
        return []
    page.locator("button[data-type='com_op']").first.click()
    page_wait(0.5, 1.0)
    quick_captcha(page)

    try:
        page.locator("button[onclick*='show_comments']").first.wait_for(state="visible", timeout=10000)
    except PWTimeout:
        print("    · 'show comments' did not appear")
        return []
    page.locator("button[onclick*='show_comments']").first.click()
    # The comment panel (.border.border-info, with a "<b>N</b> Comments" header)
    # renders whether or not there are comments. Wait for the PANEL, then bail
    # early on the "0 Comments / No an comment found" page instead of sitting for
    # 10s waiting on comment rows that will never appear.
    try:
        page.locator("#msg .border.border-info").first.wait_for(state="visible", timeout=10000)
    except PWTimeout:
        page_wait(1.0, 1.6)
    quick_captcha(page)
    if page.locator(".input-group.mb-1").count() == 0:
        print("    · no comments on this video")
        return []

    # 3. Page through the comment list. Each row:
    #    <p><strong>@username</strong><small>comment text…</small></p>
    #    <button class="btn-info" …><i class="fa fa-heart"></i><small>HEARTS</small></button>
    comments: list[dict] = []
    seen: set[tuple] = set()
    clicked_offsets: set[int] = {0}  # p=0 opens by default
    scan_page = 1
    while scan_page <= max_pages:
        rows = page.locator(".input-group.mb-1").all()
        for row in rows:
            try:
                user = row.locator("p strong").first.inner_text().strip()
            except Exception:
                user = ""
            try:
                text = row.locator("p small").first.inner_text().strip()
            except Exception:
                text = ""
            # Heart count lives in the heart button's <small> (NOT the comment's).
            try:
                hraw = row.locator("button.btn-info small").first.inner_text().strip()
                hearts = int(hraw.replace(",", "")) if hraw else 0
            except Exception:
                hearts = 0
            key = (user, text)
            if (user or text) and key not in seen:
                seen.add(key)
                comments.append({"user": user, "text": text, "hearts": hearts})

        # Advance to the next comment page (stop at disabled / wrap-around). This
        # is the pagination 'next' (li[title='next']) — NOT the header Back button.
        #
        # Guard every DOM read with count() FIRST: on the last page (and on Freer's
        # "No an comment found." overflow page, which has a "294 Comments" header
        # but no pager) there is NO li[title='next']. Calling get_attribute() on a
        # zero-match locator BLOCKS for Playwright's full 30s timeout before
        # throwing — that was the "stuck at the end of the comments" hang.
        next_btn = None
        next_offset = -1
        try:
            if page.locator("li[title='next']").count() == 0:
                break  # no pager → single/last page, done
            next_li = page.locator("li[title='next']").first
            if "disabled" in (next_li.get_attribute("class") or ""):
                break
            next_btn = next_li.locator("button.page-link").first
            if next_btn.count() == 0:
                break
            m = re.search(r"&p=(\d+)", next_btn.get_attribute("onclick") or "")
            if m:
                next_offset = int(m.group(1))
                if next_offset in clicked_offsets:
                    break  # looped back to a page we already scanned
        except Exception:
            break

        if next_offset >= 0:
            clicked_offsets.add(next_offset)
        next_btn.click()
        scan_page += 1
        try:
            page.locator("#loading").wait_for(state="visible", timeout=2000)
            page.locator("#loading").wait_for(state="hidden", timeout=10000)
        except Exception:
            page_wait(1.5, 2.5)
        quick_captcha(page)

    return comments


def main():
    ap = argparse.ArgumentParser(description="Extract TikTok comments via Freer (no hearting), in dashboard cluster order.")
    ap.add_argument("urls", nargs="*", help="TikTok video URLs (optional if --links is used).")
    ap.add_argument("--links", default="", help="Scraper CSV (for clustering) or a URL-per-line file.")
    ap.add_argument("--out", default="comments_extracted.json", help="Output JSON path.")
    ap.add_argument("--max-pages", type=int, default=30, help="Max comment pages per video.")
    ap.add_argument("--clusters", type=int, default=10, help="Number of clusters (default 10, like the dashboard).")
    ap.add_argument("--no-cluster", action="store_true", help="Keep input order instead of cluster order.")
    ap.add_argument("--restart", action="store_true", help="Ignore the existing output file and start over.")
    args = ap.parse_args()

    items = load_links(args.links, args.urls)
    if not items:
        sys.exit("No URLs. Pass some directly or use --links <file>.")

    ordered = items if args.no_cluster else cluster_and_order(items, args.clusters)
    out_path = Path(args.out)

    # Resume: reuse whatever is already in the output file and skip links already
    # done, so a stop/captcha-timeout continues where it left off. --restart forces
    # a fresh run (overwrites the file).
    results: list[dict] = []
    done: set = set()
    if out_path.exists() and not args.restart:
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
            if isinstance(existing, list):
                results = existing
                done = {str(r.get("url")) for r in existing if isinstance(r, dict) and r.get("url")}
        except Exception:
            results, done = [], set()

    todo = [it for it in ordered if it["url"] not in done]
    mode = "input order" if args.no_cluster else f"cluster order ({args.clusters} clusters, rank↔date interleave)"
    if done:
        print(f"Resuming: {len(done)} link(s) already done, {len(todo)} left of {len(ordered)} → {out_path}")
    else:
        print(f"{len(todo)} link(s) to process in {mode} → {out_path}")
    if not todo:
        print("Nothing left to do. Pass --restart to re-scan everything.")
        return
    print()

    with sync_playwright() as p:
        browser, _ctx, page = new_browser_page(p)
        print("Opening nreer.com …")
        page.goto(FREER_URL, wait_until="domcontentloaded", timeout=30000)
        freer_open_service(page)  # blocks until captcha solved + "Use" clicked → URL form

        for i, it in enumerate(todo, 1):
            url = it["url"]
            print(f"[{i}/{len(todo)}] rank={it.get('search_rank') or '-'} date={it.get('posted_date') or '-'}  {url}")

            # Make sure the URL form is actually ready BEFORE submitting. Right
            # after the captcha (and between links) Freer often shows a cooldown
            # TIMER or the dashboard instead of the search form; open_url_form
            # waits the timer out and clicks "Use" as needed. For links after the
            # first, first click Back to leave the previous comments page.
            try:
                if i > 1:
                    freer_go_back(page)
                open_url_form(page)
            except Exception as e:  # noqa: BLE001
                print(f"    ! could not reach the URL form: {e}")

            comments: list[dict] = []
            try:
                comments = extract_comments_for_url(page, url, args.max_pages)
            except Exception as e:  # noqa: BLE001
                print(f"    ! error: {e}")
            print(f"    → {len(comments)} comment(s)")
            results.append({"url": url, "count": len(comments), "comments": comments})
            out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

        browser.close()

    total = sum(r["count"] for r in results)
    print(f"\nDone. {total} comment(s) across {len(results)} link(s) → {out_path}")


if __name__ == "__main__":
    main()
