"""What does an Instagram profile actually send while you scroll it?

The first smoke test of the channel scraper collected nothing, which has three
possible causes and they need telling apart:

  1. we are not logged in, and the page is a wall
  2. the posts arrive somewhere other than the XHR we listen to (Instagram
     embeds the first screenful in the document itself)
  3. the responses do arrive and the walker does not recognise them

So this reports every response the page makes, whether our own walker finds
posts in it, and what the initial HTML holds.

    python probe_ig_profile.py [handle] [scrolls]
"""
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

import scrape_channels as sc

load_dotenv()
HANDLE = (sys.argv[1] if len(sys.argv) > 1 else "mavgpt").lstrip("@")
SCROLLS = int(sys.argv[2]) if len(sys.argv) > 2 else 6
PROFILE = Path(os.getenv("BROWSER_PROFILE_DIR", "./browser_profile")).resolve()

seen = []


def note(resp):
    u = resp.url
    if not any(b in u for b in ("/graphql", "/api/v1/", "web_profile_info", "/api/graphql")):
        return
    try:
        body = resp.body()
    except Exception:
        body = b""
    row = {"url": u.split("?")[0][:90], "status": resp.status, "bytes": len(body), "posts": 0}
    try:
        data = json.loads(body.decode("utf-8", "replace"))
        nodes = []
        sc._ig_media_nodes(data, nodes)
        row["posts"] = len(nodes)
        if nodes and not any(r.get("sample") for r in seen):
            row["sample"] = {k: nodes[0].get(k) for k in
                             ("code", "shortcode", "taken_at", "taken_at_timestamp",
                              "like_count", "play_count", "comment_count") if k in nodes[0]}
            row["keys"] = sorted(nodes[0].keys())[:28]
    except Exception as e:
        row["parse"] = type(e).__name__
    seen.append(row)


with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE), headless=False, channel="chrome",
        args=["--disable-blink-features=AutomationControlled", "--no-first-run"],
        viewport={"width": 1280, "height": 900}, locale="en-US",
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on("response", note)
    page.goto(f"https://www.instagram.com/{HANDLE}/", wait_until="domcontentloaded", timeout=60000)
    time.sleep(5)

    print(f"final url      : {page.url}")
    cookies = {c['name'] for c in ctx.cookies()}
    print(f"session cookie : {'sessionid' in cookies}  (cookies: {len(cookies)})")
    try:
        print(f"title          : {page.title()[:80]}")
    except Exception:
        pass

    html = page.content()
    print(f"document bytes : {len(html)}")
    import re
    codes = set(re.findall(r'/(?:p|reel)/([A-Za-z0-9_-]{5,24})/', html))
    print(f"post codes in the document: {len(codes)}  {sorted(codes)[:6]}")

    # What the page-side profile fetch gives us (count + bio).
    print("web_profile_info:", sc.ig_profile_info(page, HANDLE))

    for i in range(SCROLLS):
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(3)
        print(f"   scroll {i+1}: {len(seen)} matching response(s) so far, "
              f"{sum(r['posts'] for r in seen)} post(s) parsed")

    print("\nresponses:")
    for r in seen:
        extra = ""
        if r.get("sample"):
            extra = f"\n        sample: {r['sample']}\n        keys:   {r.get('keys')}"
        print(f"   {r['status']}  {r['bytes']:>8}b  posts={r['posts']:<4} {r['url']}{extra}")
    if not seen:
        print("   (none — nothing matched, so the posts are not arriving over XHR)")

    # And what the DOM holds, as a fallback route.
    links = page.evaluate(
        """() => [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
                   .map(a => a.getAttribute('href')).slice(0, 200)"""
    )
    print(f"\npost links in the DOM: {len(links)}  {links[:4]}")
    ctx.close()
