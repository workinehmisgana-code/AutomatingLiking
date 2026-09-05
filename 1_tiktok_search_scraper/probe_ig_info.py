"""Where can the post count and bio be read from, now that web_profile_info is shut?

The channel scraper needs both: the count is what tells a finished scan from one
Instagram cut short, and the bio is stamped onto every row. This tries the
candidates in the live, logged-in page and prints what each gives.

    python probe_ig_info.py [handle]
"""
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()
HANDLE = (sys.argv[1] if len(sys.argv) > 1 else "mavgpt").lstrip("@")
PROFILE = Path(os.getenv("BROWSER_PROFILE_DIR", "./browser_profile")).resolve()

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE), headless=False, channel="chrome",
        args=["--disable-blink-features=AutomationControlled", "--no-first-run"],
        viewport={"width": 1280, "height": 900}, locale="en-US",
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(f"https://www.instagram.com/{HANDLE}/", wait_until="domcontentloaded", timeout=60000)
    time.sleep(5)

    print("1. web_profile_info, as the page:")
    print("   ", page.evaluate("""async (h) => {
        try {
          const r = await fetch(`/api/v1/users/web_profile_info/?username=${h}`,
                                {headers: {'X-IG-App-ID': '936619743392459'}, credentials: 'include'});
          const t = await r.text();
          return {status: r.status, bytes: t.length, head: t.slice(0, 160)};
        } catch (e) { return {error: String(e)}; }
      }""", HANDLE))

    print("\n2. the same call with the app id the page itself uses:")
    print("   ", page.evaluate("""async (h) => {
        try {
          const appId = (document.documentElement.innerHTML.match(/"APP_ID":"(\\d+)"/)
                      || document.documentElement.innerHTML.match(/X-IG-App-ID["']?[:=]\\s*["'](\\d+)/) || [])[1];
          if (!appId) return {noAppId: true};
          const r = await fetch(`/api/v1/users/web_profile_info/?username=${h}`,
                                {headers: {'X-IG-App-ID': appId}, credentials: 'include'});
          const t = await r.text();
          let count = null, bio = null;
          try { const u = JSON.parse(t)?.data?.user;
                count = u?.edge_owner_to_timeline_media?.count ?? null; bio = u?.biography ?? null; } catch (e) {}
          return {appId, status: r.status, bytes: t.length, count, bio};
        } catch (e) { return {error: String(e)}; }
      }""", HANDLE))

    print("\n3. the document's own meta tags:")
    print("   ", page.evaluate("""() => ({
        description: document.querySelector('meta[name="description"]')?.content?.slice(0, 200) || null,
        og: document.querySelector('meta[property="og:description"]')?.content?.slice(0, 200) || null,
      })"""))

    print("\n4. the rendered header:")
    print("   ", page.evaluate("""() => {
        const txt = (document.querySelector('header')?.innerText || '').slice(0, 400);
        return {header: txt};
      }"""))

    print("\n5. anything post-count-shaped in the page's own JSON:")
    print("   ", page.evaluate("""() => {
        const html = document.documentElement.innerHTML;
        const out = {};
        for (const k of ['media_count', 'edge_owner_to_timeline_media', 'biography']) {
          const m = html.match(new RegExp('"' + k + '":(\\\\{"count":\\\\d+\\\\}|\\\\d+|"[^"]{0,120}")'));
          out[k] = m ? m[1].slice(0, 130) : null;
        }
        return out;
      }"""))
    ctx.close()
