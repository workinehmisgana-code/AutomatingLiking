"""Where is TikTok's comment box, and what posts it?

Read-only. Opens one video with a logged-in profile, opens the comment panel,
and reports every candidate for the editable field and the post button, with the
attributes that identify them. Nothing is typed and nothing is posted.

    python probe_comment_box.py --profile e --url https://www.tiktok.com/@x/video/123
"""
import argparse

from playwright.sync_api import sync_playwright

from like import launch_liker, open_comments, open_video

JS = """() => {
  const out = {editables: [], buttons: [], panel: !!document.querySelector('[data-e2e="comment-level-1"]')};
  for (const el of document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]')) {
    const r = el.getBoundingClientRect();
    out.editables.push({
      tag: el.tagName.toLowerCase(),
      e2e: el.getAttribute('data-e2e'),
      placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-label') || '',
      role: el.getAttribute('role'),
      visible: r.width > 0 && r.height > 0,
      w: Math.round(r.width), h: Math.round(r.height),
    });
  }
  for (const el of document.querySelectorAll('[data-e2e*="comment"], button, [role="button"]')) {
    const t = (el.textContent || '').trim();
    const e2e = el.getAttribute('data-e2e') || '';
    if (!/post|send|comment/i.test(t + ' ' + e2e)) continue;
    const r = el.getBoundingClientRect();
    out.buttons.push({ tag: el.tagName.toLowerCase(), e2e, text: t.slice(0, 24),
                       disabled: el.getAttribute('aria-disabled') || el.disabled || false,
                       visible: r.width > 0 && r.height > 0 });
  }
  return out;
}"""

ap = argparse.ArgumentParser()
ap.add_argument("--profile", default="default")
ap.add_argument("--url", required=True)
ap.add_argument("--block-media", action="store_true", help="block images/video as the liker does")
args = ap.parse_args()

import json

with sync_playwright() as p:
    ctx = launch_liker(p, args.profile, block_media=args.block_media, headed=True)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto("https://www.tiktok.com/", wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    if not open_video(page, args.url):
        # Say WHY rather than just that it failed: a captcha, a logged-out page
        # and a dead video all look the same from here.
        print("open_video() timed out waiting for the comment icon.")
        print("  url now      :", page.url)
        print("  captcha      :", __import__('like').captcha_present(page))
        print("  logged out   :", __import__('like').page_is_logged_out(page))
        print("  title        :", (page.title() or '')[:70])
        print("  text (head)  :", page.evaluate("document.body.innerText.slice(0,160)").replace(chr(10), ' | '))
        ctx.close()
        raise SystemExit(1)
    print("comment panel opened:", open_comments(page))
    page.wait_for_timeout(2500)
    print(json.dumps(page.evaluate(JS), indent=1)[:2500])
    ctx.close()
