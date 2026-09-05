#!/usr/bin/env python3
"""
Report what a video page actually renders, so the click selectors can be written
against reality instead of guesswork.

DOM mode clicked nothing on its first run. There are two very different reasons
that happens and they need telling apart:

  * the comments rendered and our selectors are wrong, or
  * the comments never rendered at all — headless Chromium often gets a login
    wall, an app interstitial or a captcha where a normal window gets the page.

So this prints what is on the page: which candidate selectors match, every
data-e2e value present, and the HTML around the first comment it can find,
including whatever the like control turns out to be called.

Usage:
    python inspect_dom.py                    # picks a video from the dashboard
    python inspect_dom.py <video-url>
    python inspect_dom.py <video-url> --headed     # watch it happen
"""
import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from like import UA, HERE, from_dashboard, video_id, select_comments_tab

REPORT_JS = """
() => {
  const count = (sel) => { try { return document.querySelectorAll(sel).length } catch { return -1 } }

  const CANDIDATES = [
    '[data-e2e="comment-level-1"]',
    '[data-e2e="comment-level-2"]',
    '[data-e2e="comment-username-1"]',
    '[data-e2e="comment-username-2"]',
    '[data-e2e="comment-like-icon"]',
    '[data-e2e="comment-like-count"]',
    '[data-e2e="comment-list"]',
    '[data-e2e="search-comment-container"]',
    '[class*="DivCommentItemContainer"]',
    '[class*="DivCommentListContainer"]',
    '[class*="DivCommentContentContainer"]',
  ]
  const counts = {}
  for (const c of CANDIDATES) counts[c] = count(c)

  // Every data-e2e on the page. The most useful line in the report: whatever
  // TikTok calls things today is in here verbatim.
  const e2e = {}
  for (const el of document.querySelectorAll('[data-e2e]')) {
    const k = el.getAttribute('data-e2e')
    e2e[k] = (e2e[k] || 0) + 1
  }

  // Anything that smells like a like control, however it is named.
  const likeish = []
  for (const el of document.querySelectorAll('[data-e2e],[aria-label],[class*="like" i]')) {
    const bits = [
      el.getAttribute('data-e2e') || '',
      el.getAttribute('aria-label') || '',
      typeof el.className === 'string' ? el.className : '',
    ].join(' ')
    if (/like|digg|heart/i.test(bits) && likeish.length < 25) {
      likeish.push({
        tag: el.tagName.toLowerCase(),
        e2e: el.getAttribute('data-e2e'),
        aria: el.getAttribute('aria-label'),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
      })
    }
  }

  // The first comment we can identify, and its surrounding markup.
  //
  // data-e2e is tried first, then a fallback that does not depend on TikTok's
  // naming at all: an @handle link that is not the video's author, which is what
  // a comment row always contains whatever the classes are called this week.
  let sample = null
  let u = document.querySelector('[data-e2e*="comment-username"]')
  if (!u) {
    const links = Array.from(document.querySelectorAll('a[href^="/@"]'))
    // Skip the first few: nav, the video's own author, the sidebar.
    u = links.find((a, i) => i > 2 && (a.innerText || '').trim().length > 0) || null
  }
  if (u) {
    let block = u
    for (let i = 0; i < 6 && block.parentElement; i++) block = block.parentElement
    sample = {
      username: (u.innerText || '').slice(0, 40),
      href: u.getAttribute('href') || '',
      html: block.outerHTML.slice(0, 3000),
    }
  }

  return {
    url: location.href,
    title: document.title,
    bodyChars: document.body ? document.body.innerText.length : 0,
    // A login wall or captcha is the other explanation for an empty page.
    loginWall: /log in|sign up/i.test((document.body || {}).innerText || '') &&
               counts['[data-e2e="comment-level-1"]'] === 0,
    captcha: !!document.querySelector('[class*="captcha" i], #captcha-verify-image'),
    counts,
    e2e,
    likeish,
    sample,
  }
}
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="Dump a video page's comment DOM.")
    ap.add_argument("url", nargs="?", default="")
    ap.add_argument("--profile", default="default")
    ap.add_argument("--headed", action="store_true", help="show the browser")
    ap.add_argument("--scrolls", type=int, default=4)
    args = ap.parse_args()

    target = args.url
    if not target:
        print("No URL given — asking the dashboard…")
        pulled, _ = from_dashboard("date", "1", {"platform": "tiktok", "limit": "5"})
        target = next((u for u in pulled if video_id(u)), "")
        if not target:
            return 1
    print(f"opening {target}\n")

    pdir = HERE / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    if not (pdir / "Default").exists():
        print(f"No session at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(pdir),
            headless=not args.headed,
            user_agent=UA,
            locale="en-US",
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(target, wait_until="domcontentloaded")
        page.wait_for_timeout(4000)

        # TikTok serves the FEED player here, not a page with a comment sidebar:
        # the first report showed comment-icon and comment-count present while
        # every comment selector was zero. The list only exists once the comment
        # panel is opened, so open it before looking for anything inside it.
        # Wait for the icon rather than assuming 4s was enough — a slow render
        # reported "no comment-icon" for a page that simply had not painted yet.
        try:
            page.wait_for_selector('[data-e2e="comment-icon"]', timeout=25000)
        except Exception:  # noqa: BLE001
            pass
        opened = page.evaluate(
            """() => {
                const btn = document.querySelector('[data-e2e="comment-icon"]')
                if (!btn) return 'no comment-icon'
                // The icon is usually a child of the real click target.
                const clickable = btn.closest('button, [role="button"], a') || btn
                clickable.click()
                return 'clicked'
            }"""
        )
        print(f"opening comments: {opened}")
        page.wait_for_timeout(3000)
        # The panel has a Comments tab and a "You may like" tab; some accounts
        # land on the latter and never render a single comment.
        if not page.query_selector('[data-e2e="comment-level-1"]'):
            print(f"selecting Comments tab: {select_comments_tab(page)}")
            page.wait_for_timeout(3000)

        for _ in range(args.scrolls):
            page.mouse.wheel(0, 1200)
            page.wait_for_timeout(900)

        r = page.evaluate(REPORT_JS)
        # A picture is the fastest way to see a modal, a login wall or a
        # different layout. Named per profile, because the whole question here is
        # why one account behaves differently from another.
        shot = HERE / f"inspect-{args.profile}.png"
        try:
            page.screenshot(path=str(shot), full_page=False)
            print(f"screenshot: {shot.name}")
        except Exception as e:  # noqa: BLE001
            print(f"(screenshot failed: {str(e)[:60]})")
        (HERE / f"inspect-{args.profile}.json").write_text(json.dumps(r, indent=2), encoding="utf-8")
        if args.headed:
            print("(browser stays open 20s so you can look)")
            page.wait_for_timeout(20000)
        ctx.close()

    print(f"landed on : {r['url']}")
    print(f"title     : {r['title']}")
    print(f"body text : {r['bodyChars']} chars")
    print(f"login wall: {r['loginWall']}    captcha: {r['captcha']}")

    print("\nselector counts:")
    for k, v in r["counts"].items():
        print(f"  {v:4}  {k}")

    print(f"\ndata-e2e values on the page ({len(r['e2e'])}):")
    for k in sorted(r["e2e"]):
        print(f"  {r['e2e'][k]:4}  {k}")

    print(f"\nelements that look like a like control ({len(r['likeish'])}):")
    for x in r["likeish"]:
        print(f"  <{x['tag']}> e2e={x['e2e']} aria={x['aria']} class={x['cls']}")

    if r["sample"]:
        print(f"\nfirst comment (@{r['sample']['username']}), surrounding HTML:")
        # The Windows console is cp1252 and TikTok markup is not; encoding
        # errors here must not lose the whole report.
        sys.stdout.buffer.write(
            (r["sample"]["html"][:1800] + "\n").encode("utf-8", "replace")
        )
    else:
        print("\nNo comment username node found at all.")

    # The one question this run exists to answer.
    rows = r["counts"].get('[data-e2e="comment-level-1"]', 0)
    print(f"\nCOMMENT PANEL: {'OPEN, ' + str(rows) + ' row(s)' if rows else 'DID NOT OPEN'}")
    if not rows:
        print(
            "  Nothing rendered in the panel. Check the screenshot for a modal, a\n"
            "  consent banner, an age gate or a login prompt over the page — the\n"
            "  click lands on that instead of the comment icon."
        )
    print(f"\nfull report written to inspect-{args.profile}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
