#!/usr/bin/env python3
"""
What does Reddit's search page actually carry for a post's score and date?

get_reddit_details walks up from the result link looking for a <shreddit-post>
element and reads its `score` and `created-timestamp` attributes. On the search
page it never finds one: every post comes back score "?" and no posted date, so
the links upload with like_count 0 and nothing for the date clustering to use.
The titles look right only because the fallback is the link's own text, which on
a search result happens to BE the title.

This prints the tree above a result link, and anything on the page that looks
like a score or a timestamp, so the selectors can be written from what is there
rather than from what used to be.

    python probe_reddit.py                       the default query
    python probe_reddit.py "ai humanizer"
"""
import os
import sys
import urllib.parse

from playwright.sync_api import sync_playwright

QUERY = sys.argv[1] if len(sys.argv) > 1 else "ai humanizer"
PROFILE = os.getenv("BROWSER_PROFILE_DIR", "./browser_profile")
URL = "https://www.reddit.com/search/?q=" + urllib.parse.quote(QUERY) + "&type=posts"

# Walks up from the link across shadow roots, reporting each host's tag and any
# attribute whose name hints at a score, a vote or a time.
WALK = """
el => {
  const out = [];
  let node = el;
  for (let i = 0; i < 25 && node; i++) {
    const tag = (node.tagName || '').toLowerCase();
    const attrs = [];
    if (node.attributes) {
      for (const a of node.attributes) {
        if (/score|vote|count|time|created|date|karma|comment/i.test(a.name)) {
          attrs.push(a.name + '=' + String(a.value).slice(0, 40));
        }
      }
    }
    out.push({ i, tag, cls: String(node.className || '').slice(0, 60), attrs });
    node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
  }
  return out;
}
"""

# Everything on the page whose tag or attributes smell like a vote count or a
# post time, with its text - the cheapest way to find the element that holds it.
SCAN = """
() => {
  const seen = [];
  const push = (el, why) => {
    if (seen.length > 60) return;
    seen.push({
      why,
      tag: (el.tagName || '').toLowerCase(),
      text: String(el.innerText || el.textContent || '').trim().slice(0, 40),
      attrs: el.attributes
        ? Array.from(el.attributes).map(a => a.name + '=' + String(a.value).slice(0, 30)).slice(0, 6)
        : [],
    });
  };
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'time') push(el, 'time element');
    else if (tag === 'shreddit-post') push(el, 'shreddit-post');
    else if (tag.startsWith('faceplate-')) push(el, tag);
    else if (el.hasAttribute && el.hasAttribute('data-post-click-location')) push(el, 'post-click');
    else if (el.getAttribute && /score/i.test(el.getAttribute('class') || '')) push(el, 'class~score');
  }
  return seen;
}
"""

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        PROFILE, headless=False, channel="chrome",
        args=["--disable-blink-features=AutomationControlled"],
        viewport={"width": 1280, "height": 900},
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    print(f"[*] {URL}")
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(6000)
    page.mouse.wheel(0, 1200)
    page.wait_for_timeout(3000)

    links = page.locator("a[href*='/comments/']")
    n = links.count()
    print(f"[*] {n} result link(s) on the page\n")

    for i in range(min(2, n)):
        a = links.nth(i)
        href = a.get_attribute("href") or ""
        print(f"--- link {i}: {href[:95]}")
        try:
            for step in a.evaluate(WALK):
                extra = ("  " + ", ".join(step["attrs"])) if step["attrs"] else ""
                print(f"    {step['i']:>2} <{step['tag']}> {step['cls']}{extra}")
        except Exception as e:
            print(f"    walk failed: {e}")
        print()

    print("--- anything on the page that looks like a score or a time")
    try:
        for s in page.evaluate(SCAN):
            print(f"    [{s['why']}] <{s['tag']}> text={s['text']!r}")
            if s["attrs"]:
                print(f"        {', '.join(s['attrs'])}")
    except Exception as e:
        print(f"    scan failed: {e}")

    print("\n[*] Leaving the browser open for 20s so you can look too.")
    page.wait_for_timeout(20000)
    ctx.close()
