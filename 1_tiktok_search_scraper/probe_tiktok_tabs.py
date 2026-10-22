#!/usr/bin/env python3
"""
What TikTok's search tab strip looks like, and where each tab goes.

WRITTEN TO CHASE A MISCLICK. The scraper used to reach the Photo tab by finding
the element whose text read "Photo" and clicking it, and it was seen landing on
the USERS tab instead. This probe could not reproduce that on either search
page - five unambiguous labels at fixed positions, one match each - but it found
the thing that made the click unnecessary: every tab has its own URL, which is
how the scraper opens them now. Nothing about which tab is ACTIVE is in the DOM
(no aria-selected, same class on every item), so the URL is also the only way to
confirm one.

Kept for the next time the strip changes: it lists the strip as rendered, what a
text locator resolves to for each label, and where clicking each one navigates.

    python probe_tiktok_tabs.py                 the default query
    python probe_tiktok_tabs.py "ai humanizer"
"""
import os
import re
import sys
import time
import urllib.parse

from playwright.sync_api import sync_playwright

QUERY = sys.argv[1] if len(sys.argv) > 1 else "ai humanizer"
PROFILE = os.getenv("BROWSER_PROFILE_DIR", "./browser_profile")
URL = "https://www.tiktok.com/search?q=" + urllib.parse.quote(QUERY)

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        PROFILE, headless=False, channel="chrome",
        args=["--disable-blink-features=AutomationControlled"],
        viewport={"width": 1280, "height": 900},
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    print(f"[*] {URL}")
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    time.sleep(8)
    try:
        page.locator('[data-e2e="modal-close-inner-button"]').first.click(timeout=3000)
        time.sleep(1)
    except Exception:
        pass

    # ── the tab strip, as rendered ──────────────────────────────────────────
    print("\n--- every element with the tux-web-text test id, in DOM order")
    rows = page.evaluate("""() => {
      const out = [];
      const els = document.querySelectorAll('[data-testid="tux-web-text"], [data-e2e="tux-web-text"]');
      let i = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        out.push({
          i: i++,
          text: String(el.innerText || el.textContent || '').trim().slice(0, 24),
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
        });
        if (out.length > 40) break;
      }
      return out;
    }""")
    for r in rows:
        print(f"    {r['i']:>3}  {r['text']!r:<26} at ({r['x']},{r['y']}) {r['w']}x{r['h']}")
    if not rows:
        print("    none - the test id has been renamed, which on its own breaks every tab click")

    # ── what the locator picks, per label ───────────────────────────────────
    print("\n--- what click_search_tab's locator resolves to")
    for label in ("Top", "Users", "Videos", "LIVE", "Photo", "Photos"):
        loc = page.get_by_test_id("tux-web-text").filter(
            has_text=re.compile(rf"^{re.escape(label)}$", re.IGNORECASE)
        )
        try:
            n = loc.count()
        except Exception as e:  # noqa: BLE001
            print(f"    {label:<7} count failed: {e}")
            continue
        if n == 0:
            print(f"    {label:<7} 0 matches")
            continue
        details = []
        for k in range(min(n, 4)):
            try:
                box = loc.nth(k).bounding_box()
                txt = loc.nth(k).inner_text(timeout=2000).strip()[:20]
                where = (f"({round(box['x'])},{round(box['y'])}) "
                         f"{round(box['width'])}x{round(box['height'])}") if box else "no box"
                details.append(f"{txt!r} {where}")
            except Exception as e:  # noqa: BLE001
                details.append(f"<unreadable: {type(e).__name__}>")
        star = "  <-- .first is what gets clicked" if n else ""
        print(f"    {label:<7} {n} match(es){star}")
        for d in details:
            print(f"            {d}")

    # ── and the thing a tab click SHOULD use ───────────────────────────────
    print("\n--- candidate anchors/buttons that look like real tabs")
    tabs = page.evaluate("""() => {
      const out = [];
      for (const el of document.querySelectorAll('a[href*="/search"], [role="tab"], [data-e2e*="tab"]')) {
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        out.push({
          tag: el.tagName.toLowerCase(),
          text: String(el.innerText || '').trim().slice(0, 20),
          href: (el.getAttribute('href') || '').slice(0, 70),
          e2e: el.getAttribute('data-e2e') || '',
          role: el.getAttribute('role') || '',
          y: Math.round(r.y),
        });
        if (out.length > 20) break;
      }
      return out;
    }""")
    for t in tabs:
        print(f"    <{t['tag']}> {t['text']!r:<22} y={t['y']:<5} role={t['role']!r} e2e={t['e2e']!r}")
        if t["href"]:
            print(f"           href={t['href']}")
    if not tabs:
        print("    none")

    print("\n[*] Browser open for 25s so you can see the strip too.")
    time.sleep(25)
    ctx.close()
