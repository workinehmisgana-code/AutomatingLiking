"""Two ways to reach a Short's comments — which one actually works?

A Shorts URL is a different page from a watch URL, with a different comment UI:
the comments live in a panel you have to open, not in the page body. But it is
the SAME video, and comments belong to the video, not to the surface it is
watched on — so /watch?v=<id> may serve the ordinary comment section that
like_web.py already reads and verifies.

This tries both on the same ids and reports what each yields.

    python probe_shorts.py <shorts-url-or-id> [...]
"""
import json
import re
import sys

from playwright.sync_api import sync_playwright

import like_web as lw

IDS = [re.sub(r".*/shorts/", "", a).split("?")[0] for a in sys.argv[1:]] or ["-45WzxMDoWs"]

PANEL_JS = """() => {
  const out = {threads: 0, viewModels: 0, items: [], panels: 0};
  out.panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer').length;
  out.threads = document.querySelectorAll('ytd-comment-thread-renderer').length;
  out.viewModels = document.querySelectorAll('ytd-comment-view-model').length;
  const nodes = document.querySelectorAll('ytd-comment-thread-renderer, ytd-comment-view-model');
  let i = 0;
  for (const t of nodes) {
    if (i++ >= 4) break;
    const a = t.querySelector('#author-text');
    const body = t.querySelector('#content-text');
    const btn = t.querySelector('#like-button button, button[aria-label*="Like" i]');
    out.items.push({
      author: (a?.textContent || '').trim(),
      text: (body?.innerText || '').trim().slice(0, 50),
      btn: btn ? {aria: btn.getAttribute('aria-label'),
                  pressed: btn.getAttribute('aria-pressed')} : null,
    });
  }
  return out;
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_context(user_agent=lw.UA, locale="en-US",
                               viewport={"width": 1280, "height": 950}).new_page()

    for vid in IDS:
        print(f"\n================ {vid} ================")

        print("-- as /watch?v= --")
        page.goto(f"https://www.youtube.com/watch?v={vid}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        print("   landed on:", page.url)
        lw.load_comments(page, "youtube", 6)
        rows = page.evaluate(lw.YT_COLLECT) or []
        print(f"   like_web's own collector: {len(rows)} comment(s)")
        for r in rows[:3]:
            print(f"      @{r['user'][:20]:<20} id={(r['id'] or '-')[:12]:<12} "
                  f"likeable={r['likeable']}  {r['text'][:40]}")

        print("-- as /shorts/ --")
        page.goto(f"https://www.youtube.com/shorts/{vid}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        print("   landed on:", page.url)
        print("   before opening the panel:", json.dumps(page.evaluate(PANEL_JS))[:200])
        # The comment button on a Short opens the panel.
        opened = False
        for sel in ['button[aria-label*="Comment" i]', '#comments-button button',
                    'ytd-reel-player-overlay-renderer #comments-button button']:
            try:
                el = page.query_selector(sel)
                if el:
                    el.click()
                    opened = True
                    break
            except Exception:
                pass
        print("   comment button clicked:", opened)
        page.wait_for_timeout(3500)
        for _ in range(4):
            page.mouse.wheel(0, 800)
            page.wait_for_timeout(900)
        print("   after: ", json.dumps(page.evaluate(PANEL_JS), indent=1)[:1200])
        rows2 = page.evaluate(lw.YT_COLLECT) or []
        print(f"   like_web's collector on the shorts page: {len(rows2)} comment(s)")

    browser.close()
