"""What does a comment look like, in the DOM, on Instagram and YouTube?

TikTok is liked through its own signed API. Neither of the other two offers that:
YouTube's Data API has no endpoint for liking a comment at all, and Instagram's
is closed to anything but approved apps. So both have to be done the way a person
does it — find the comment, click its heart — which means the selectors have to
be real, not guessed.

This reports, for a real post: how many comments are on the page, and for each
one the author, the text, and whether a like control can actually be found next
to it (with the attributes that identify it).

Nothing is clicked. This only looks.

    python probe_web_comments.py --site youtube  --url https://www.youtube.com/watch?v=...
    python probe_web_comments.py --site instagram --url https://www.instagram.com/p/CODE/ \
        --profile-dir ../1_tiktok_search_scraper/browser_profile
"""
import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# ── YouTube ──────────────────────────────────────────────────────────────────
YT_JS = """() => {
  const out = {threads: 0, items: []};
  const threads = document.querySelectorAll('ytd-comment-thread-renderer');
  out.threads = threads.length;
  let i = 0;
  for (const t of threads) {
    if (i++ >= 6) break;
    const author = t.querySelector('#author-text');
    const text = t.querySelector('#content-text');
    // Every candidate for "the like button", with what identifies it.
    const cands = [];
    for (const sel of ['#like-button button', 'ytd-toggle-button-renderer button',
                       'button[aria-label*="like" i]', '#like-button']) {
      const el = t.querySelector(sel);
      if (el) cands.push({sel,
        tag: el.tagName.toLowerCase(),
        aria: el.getAttribute('aria-label'),
        pressed: el.getAttribute('aria-pressed'),
        title: el.getAttribute('title')});
    }
    out.items.push({
      author: (author?.textContent || '').trim(),
      href: author?.getAttribute('href') || author?.closest('a')?.getAttribute('href') || '',
      text: (text?.textContent || '').trim().slice(0, 70),
      likeCandidates: cands,
    });
  }
  return out;
}"""

# ── Instagram ────────────────────────────────────────────────────────────────
# Instagram ships no stable ids or classes, so a comment is found structurally:
# a list item that contains a link to a profile and a button whose label is
# Like/Unlike.
IG_JS = """() => {
  const out = {rows: 0, items: []};
  const seen = new Set();
  const buttons = [...document.querySelectorAll('[role="button"], button')]
    .filter(b => /^(like|unlike)$/i.test((b.getAttribute('aria-label') || '').trim()));
  out.likeButtons = buttons.length;
  for (const b of buttons.slice(0, 8)) {
    // Walk up until the block also holds a profile link — that block is the comment.
    let node = b, hops = 0, link = null;
    while (node && hops++ < 8) {
      link = node.querySelector?.('a[href^="/"][role="link"], a[href^="/"]');
      if (link && node.innerText && node.innerText.trim().length > 0) break;
      node = node.parentElement;
    }
    if (!node) continue;
    const key = (node.innerText || '').slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.items.push({
      aria: b.getAttribute('aria-label'),
      author: (link?.getAttribute('href') || '').replace(/\\//g, ''),
      textBlock: (node.innerText || '').replace(/\\n/g, ' | ').slice(0, 120),
      depth: hops,
    });
  }
  out.rows = out.items.length;
  return out;
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, choices=["youtube", "instagram"])
    ap.add_argument("--url", required=True)
    ap.add_argument("--profile-dir", default="", help="a logged-in Chromium profile to reuse")
    ap.add_argument("--scrolls", type=int, default=6)
    args = ap.parse_args()

    with sync_playwright() as p:
        if args.profile_dir:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=str(Path(args.profile_dir).resolve()),
                headless=False, channel="chrome", user_agent=UA, locale="en-US",
                viewport={"width": 1280, "height": 950},
                args=["--disable-blink-features=AutomationControlled", "--no-first-run"],
            )
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
        else:
            browser = p.chromium.launch(headless=False)
            ctx = browser.new_context(user_agent=UA, locale="en-US",
                                      viewport={"width": 1280, "height": 950})
            page = ctx.new_page()

        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        print("url:", page.url)

        if args.site == "youtube":
            # Comments live below the fold and are not rendered until scrolled to.
            for i in range(args.scrolls):
                page.mouse.wheel(0, 1400)
                page.wait_for_timeout(1200)
            print(json.dumps(page.evaluate(YT_JS), indent=1)[:4000])
        else:
            # A post page shows a few comments; the rest need "load more".
            for i in range(3):
                try:
                    more = page.query_selector('[aria-label="Load more comments"], svg[aria-label="Load more comments"]')
                    if more:
                        more.click()
                        page.wait_for_timeout(1500)
                except Exception:
                    pass
                page.mouse.wheel(0, 900)
                page.wait_for_timeout(1200)
            print(json.dumps(page.evaluate(IG_JS), indent=1)[:3000])
            print("\n-- what IS on the page --")
            print(json.dumps(page.evaluate("""() => {
                const labels = {};
                for (const el of document.querySelectorAll('[aria-label]')) {
                  const a = el.getAttribute('aria-label').trim().slice(0, 40);
                  labels[a] = (labels[a] || 0) + 1;
                }
                const top = Object.entries(labels).sort((a,b) => b[1]-a[1]).slice(0, 30);
                return {
                  textLen: document.body.innerText.length,
                  loginWall: /log in|sign up/i.test(document.body.innerText.slice(0, 400)),
                  articles: document.querySelectorAll('article').length,
                  uls: document.querySelectorAll('ul').length,
                  svgLabels: [...document.querySelectorAll('svg[aria-label]')]
                               .map(s => s.getAttribute('aria-label')).slice(0, 20),
                  topLabels: top,
                  head: document.body.innerText.slice(0, 300),
                };
              }"""), indent=1, ensure_ascii=False)[:3000])

        ctx.close()


if __name__ == "__main__":
    main()
