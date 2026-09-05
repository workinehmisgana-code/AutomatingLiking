#!/usr/bin/env python3
"""
Verify one user commented on their TikTok sample link(s), via Freer (nreer.com).

Opens a browser, waits for you to solve the Freer captcha, then enters the user's
sample links ONE BY ONE and searches each video's comments for the user's own
@username. The MOMENT it finds a match it stops (no more pages, no more links)
and reports success. Prints a single JSON line to stdout (the LAST line) so the
dashboard's /api/admin/verify-user route can parse it:

    {"username": "kezyyy6", "found": true, "checked": 1, "matched_link": "...", "total_commenters": 42}

Reuses the maintained Freer flow (browser launch, captcha handling, navigation)
from automate.py / extract_comments.py.

Usage:
    python verify_user.py --username @kezyyy6 --links https://www.tiktok.com/@a/video/1 https://...
"""
import argparse
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

from automate import new_browser_page, page_wait, freer_open_service, FREER_URL
from extract_comments import (
    quick_captcha,
    freer_go_back,
    open_url_form,
    TIKTOK_URL_RE,
)


def norm_user(u: str) -> str:
    return (u or "").strip().lstrip("@").lower()


def find_user_in_comments(page, url: str, target: str, max_pages: int):
    """Open one video on Freer and page through its comments, stopping the MOMENT
    the target @username appears. Returns (found: bool, users_seen: set)."""
    users_seen: set = set()

    # 1. Submit the URL.
    inp = page.locator("form#form1 input[type='search']").first
    inp.wait_for(state="visible", timeout=15000)
    inp.fill(url)
    page_wait(0.2, 0.4)
    page.locator("form#form1 button[type='submit']").first.click()
    page_wait(0.8, 1.3)
    quick_captcha(page)

    # 2. Open the comment stats, then "Show comments".
    try:
        page.locator("button[data-type='com_op']").first.wait_for(state="visible", timeout=15000)
    except PWTimeout:
        print("    · video info did not load", file=sys.stderr)
        return False, users_seen
    page.locator("button[data-type='com_op']").first.click()
    page_wait(0.5, 1.0)
    quick_captcha(page)
    try:
        page.locator("button[onclick*='show_comments']").first.wait_for(state="visible", timeout=10000)
    except PWTimeout:
        print("    · 'show comments' did not appear", file=sys.stderr)
        return False, users_seen
    page.locator("button[onclick*='show_comments']").first.click()
    try:
        page.locator("#msg .border.border-info").first.wait_for(state="visible", timeout=10000)
    except PWTimeout:
        page_wait(1.0, 1.6)
    quick_captcha(page)
    if page.locator(".input-group.mb-1").count() == 0:
        print("    · no comments on this video", file=sys.stderr)
        return False, users_seen

    # 3. Page through comments, checking each page's usernames. Stop on a match.
    clicked_offsets = {0}
    scan_page = 1
    while scan_page <= max_pages:
        rows = page.locator(".input-group.mb-1").all()
        for row in rows:
            try:
                u = norm_user(row.locator("p strong").first.inner_text())
            except Exception:
                u = ""
            if u:
                users_seen.add(u)
                if u == target:
                    return True, users_seen  # found → stop immediately

        # Next comment page (stop at disabled / wrap-around). Guard every DOM read
        # with count() FIRST: on the last page (and Freer's "No an comment found."
        # overflow page) there is no pager, and get_attribute() on a zero-match
        # locator would BLOCK for the full 30s timeout — the "stuck at the end" hang.
        next_btn = None
        next_offset = -1
        try:
            if page.locator("li[title='next']").count() == 0:
                break
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
                    break
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

    return False, users_seen


def main():
    ap = argparse.ArgumentParser(description="Verify a user's @username appears in their sample links' comments (Freer).")
    ap.add_argument("--username", required=True, help="The user's TikTok @username.")
    ap.add_argument("--name", default="", help="The user's registered dashboard name (for logging).")
    ap.add_argument("--links", nargs="*", default=[], help="The user's submitted TikTok sample video URLs.")
    ap.add_argument("--max-pages", type=int, default=30)
    args = ap.parse_args()

    target = norm_user(args.username)
    name = (args.name or "").strip() or "(no name)"
    # Accept ANY tiktok.com link (short/mobile/photo/full) — Freer resolves it.
    # (TIKTOK_URL_RE is too strict for short links like vm.tiktok.com/… .)
    links = [l for l in args.links if l and "tiktok.com" in l.lower()]
    result = {"username": target, "found": False, "checked": 0, "matched_link": None, "total_commenters": 0}
    if not target or not links:
        print(f"nothing to check: username={target!r} links={len(links)}", file=sys.stderr)
        print(json.dumps(result))
        return

    print(f"verifying account: {name}  (tiktok @{target}, {len(links)} sample link(s))", file=sys.stderr, flush=True)
    all_users: set = set()
    with sync_playwright() as p:
        browser, _ctx, page = new_browser_page(p)
        page.goto(FREER_URL, wait_until="domcontentloaded", timeout=30000)
        freer_open_service(page)  # blocks until you solve the captcha + "Use" is clicked → URL form

        for i, url in enumerate(links):
            print(f"checking {url}", file=sys.stderr)
            found = False
            try:
                found, seen = find_user_in_comments(page, url, target, args.max_pages)
                all_users |= seen
            except Exception as e:  # noqa: BLE001
                print(f"error on {url}: {e}", file=sys.stderr)
            result["checked"] += 1
            if found:
                result["found"] = True
                result["matched_link"] = url
                break  # found → stop the whole process
            if i < len(links) - 1:
                freer_go_back(page)
                open_url_form(page)

        browser.close()

    result["total_commenters"] = len(all_users)
    print(json.dumps(result))  # LAST line = the machine-readable result


if __name__ == "__main__":
    main()
