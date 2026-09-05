#!/usr/bin/env python3
"""
Is TikTok's request signer reachable from the page?

This is the question that decides whether liking has to be slow. Right now every
like costs a page load, because the only way to get a signed request is to make
TikTok's own code issue it — a click. If the function that computes X-Gnarly /
X-Bogus is reachable on `window`, we can sign our own URLs and fire every like
from ONE loaded page: no navigation, no DOM, no scrolling. That would take a
video from ~8 seconds to a fraction of one.

So this looks for it. It walks `window` for anything whose name or source looks
like a signer, tries the known historical entry points, and — the decisive test —
watches what TikTok itself attaches when the page makes a real signed request.

It also reports whether a captcha is on screen, since that is the other open
question about the accounts that fail.

Usage:
    python probe_signer.py --profile a
    python probe_signer.py --profile b --headed
"""
import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from like import HERE, UA, launch_liker, open_video, from_dashboard, video_id

FIND_JS = """
() => {
  const out = { captcha: null, candidates: [], hooks: [] }

  // ── captcha ────────────────────────────────────────────────────────────
  const capSel = [
    '#captcha-verify-image', '[class*="captcha" i]', '[id*="captcha" i]',
    '[class*="secsdk" i]', '[data-testid*="captcha" i]',
  ]
  for (const s of capSel) {
    const el = document.querySelector(s)
    if (el) {
      const r = el.getBoundingClientRect()
      out.captcha = { selector: s, visible: r.width > 0 && r.height > 0, text: (el.innerText || '').slice(0, 120) }
      break
    }
  }

  // ── anything on window that smells like a signer ───────────────────────
  const NAME = /acrawler|bogus|gnarly|ladon|argus|gorgon|khronos|signature|msToken|webmssdk|frontier|secsdk/i
  const seen = new Set()
  const look = (obj, path, depth) => {
    if (depth > 2 || !obj || seen.has(obj)) return
    let keys = []
    try { keys = Object.getOwnPropertyNames(obj) } catch { return }
    for (const k of keys) {
      if (!NAME.test(k)) continue
      let v
      try { v = obj[k] } catch { continue }
      const t = typeof v
      const entry = { path: path + '.' + k, type: t }
      if (t === 'function') {
        try { entry.arity = v.length; entry.src = String(v).slice(0, 120) } catch {}
      } else if (t === 'object' && v) {
        try { entry.keys = Object.getOwnPropertyNames(v).slice(0, 20) } catch {}
      } else if (t === 'string') {
        entry.value = v.slice(0, 60)
      }
      out.candidates.push(entry)
    }
    // One level down, only into plain objects that matched nothing above.
    for (const k of keys.slice(0, 400)) {
      let v
      try { v = obj[k] } catch { continue }
      if (v && typeof v === 'object' && !seen.has(v) && NAME.test(k)) {
        seen.add(v)
        look(v, path + '.' + k, depth + 1)
      }
    }
  }
  look(window, 'window', 0)

  // ── has anything patched fetch / XHR? ──────────────────────────────────
  // A native implementation stringifies as "[native code]". Anything else means
  // TikTok wrapped it, and a wrapper is exactly what would be adding the
  // signature — in which case our own fetch calls SHOULD have been signed.
  try {
    out.hooks.push({ what: 'fetch', native: String(window.fetch).includes('[native code]') })
    out.hooks.push({
      what: 'XMLHttpRequest.send',
      native: String(XMLHttpRequest.prototype.send).includes('[native code]'),
    })
    out.hooks.push({
      what: 'XMLHttpRequest.open',
      native: String(XMLHttpRequest.prototype.open).includes('[native code]'),
    })
  } catch (e) { out.hooks.push({ error: String(e).slice(0, 80) }) }

  return out
}
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="Look for TikTok's signer and any captcha.")
    ap.add_argument("--profile", default="a")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("url", nargs="?", default="")
    args = ap.parse_args()

    target = args.url
    if not target:
        pulled, _ = from_dashboard("date", "1", {"platform": "tiktok", "limit": "3"})
        target = next((u for u in pulled if video_id(u)), "")
    if not target:
        print("No video URL to open.")
        return 1

    pdir = HERE / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    if not (pdir / "Default").exists():
        print(f"No session at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    signed_urls = []
    with sync_playwright() as p:
        # Media left ON: the question is what the real page does, and blocking
        # resources could change which bundles load.
        ctx = launch_liker(p, args.profile, block_media=False, headed=args.headed)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # Record the query params TikTok puts on its OWN requests. Whatever it
        # adds that we cannot is the exact gap we are trying to close.
        def on_request(req):
            if "/api/" in req.url and ("X-Gnarly" in req.url or "X-Bogus" in req.url):
                signed_urls.append(req.url)

        page.on("request", on_request)

        print(f"opening {target}")
        if not open_video(page, target):
            print("page did not render")
            ctx.close()
            return 1
        page.wait_for_timeout(4000)

        r = page.evaluate(FIND_JS)
        ctx.close()

    print(f"\ncaptcha: {json.dumps(r['captcha'])}")

    print("\nfetch / XHR wrappers:")
    for h in r["hooks"]:
        if "error" in h:
            print(f"  error: {h['error']}")
        else:
            print(f"  {h['what']:24} native={h['native']}")

    print(f"\nsigner-ish names on window ({len(r['candidates'])}):")
    for c in r["candidates"][:40]:
        extra = c.get("src") or (",".join(c.get("keys", []))[:90]) or c.get("value") or ""
        print(f"  {c['path']:56} {c['type']:8} {str(extra)[:90]}")
    if not r["candidates"]:
        print("  (none)")

    print(f"\nsigned requests TikTok made by itself ({len(signed_urls)}):")
    for u in signed_urls[:3]:
        print(f"  {u[:200]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
