#!/usr/bin/env python3
"""
Which transport actually gets signed?

Where we are: the request is well-formed (status_code 5 when it is not, 0 when it
is), the CSRF handshake is done, the real parameter set is attached — and the
like still does not apply. So TikTok is looking at the per-request signature,
X-Gnarly, which we cannot compute and which the page did not add for us.

That last part is the lead. If TikTok's SDK hooks XMLHttpRequest but not fetch,
then issuing the same request through XHR would come out signed, and the fast
path survives. If neither is hooked, the API route is finished and the answer is
to click the heart in the DOM.

This tries each transport on ONE comment and then RE-READS the comment to see
whether the like actually landed. status_code is not evidence — that is the whole
lesson of the last three rounds — so nothing here trusts it.

Usage:
    python probe2.py
    python probe2.py <video-url>
"""
import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from like import (
    UA,
    HERE,
    fetch_comments,
    video_id,
    norm,
    NORM_PRODUCTS,
    load_template,
    from_dashboard,
)

# Each attempt: build the URL, do the CSRF handshake, send it the given way, then
# report. Verification happens separately, by reading the comment back.
ATTEMPT_JS = """
async ([awemeId, cid, params, transport, keepSig]) => {
  const referrer = `https://www.tiktok.com/@x/video/${awemeId}`
  const p = new URLSearchParams(params || {})
  p.set('aweme_id', String(awemeId))
  p.set('cid', String(cid))
  p.set('digg_type', '1')
  p.set('aid', '1988')
  const url = '/api/comment/digg/?' + p.toString()

  // CSRF handshake, same for every transport.
  let token = ''
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      referrer,
      headers: { 'x-secsdk-csrf-request': '1', 'x-secsdk-csrf-version': '1.2.22' },
    })
    const csrf = head.headers.get('x-ware-csrf-token')
    token = csrf ? (csrf.split(',')[1] || csrf) : ''
  } catch (e) { return { msg: 'csrf failed: ' + String(e).slice(0, 80) } }
  if (!token) return { msg: 'no csrf token' }

  if (transport === 'xhr') {
    return await new Promise((resolve) => {
      const x = new XMLHttpRequest()
      x.open('POST', url, true)
      x.withCredentials = true
      x.setRequestHeader('x-secsdk-csrf-token', token)
      x.setRequestHeader('content-type', 'application/x-www-form-urlencoded')
      x.onload = () => {
        let code = null, msg = (x.responseText || '').slice(0, 80)
        try { const j = JSON.parse(x.responseText); code = j.status_code; msg = j.status_msg || '' } catch {}
        resolve({ http: x.status, code, msg })
      }
      x.onerror = () => resolve({ http: 0, code: null, msg: 'xhr error' })
      x.send()
    })
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      referrer,
      headers: {
        'x-secsdk-csrf-token': token,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })
    const body = await r.text()
    if (!body.trim()) return { http: r.status, code: null, msg: '(empty)' }
    try { const j = JSON.parse(body); return { http: r.status, code: j.status_code, msg: j.status_msg || '' } }
    catch { return { http: r.status, code: null, msg: body.slice(0, 80) } }
  } catch (e) { return { http: 0, code: null, msg: String(e).slice(0, 80) } }
}
"""

# The only evidence that counts.
#
# Pages through the comments rather than reading the first fifty: a busy video
# buries our comment well past page one, and "not in what I read" is not the same
# finding as "not liked". Treating the first as failure is exactly the confusion
# this whole exercise has been about.
CHECK_JS = """
async ([awemeId, cid]) => {
  let cursor = 0
  for (let page = 0; page < 6; page++) {
    const r = await fetch(
      `/api/comment/list/?aweme_id=${awemeId}&count=50&cursor=${cursor}&aid=1988`,
      { credentials: 'include', referrer: `https://www.tiktok.com/@x/video/${awemeId}` }
    )
    const body = await r.text()
    if (!body.trim()) return null
    let j
    try { j = JSON.parse(body) } catch { return null }
    const list = j.comments || []
    const c = list.find((x) => String(x.cid) === String(cid))
    if (c) return { mine: c.user_digged, digg: c.digg_count }
    if (!j.has_more || list.length === 0) return null
    cursor = Number(j.cursor) || cursor + list.length
  }
  return null
}
"""


def pick_target(url_arg: str):
    urls = [url_arg] if url_arg else []
    products = NORM_PRODUCTS
    if not urls:
        print("No URL given — asking the dashboard…")
        pulled, live = from_dashboard("date", "1", {"platform": "tiktok", "limit": "80"})
        urls = pulled
        if live:
            products = [norm(p) for p in live]
    for u in urls:
        aweme = video_id(u)
        if not aweme:
            continue
        for c in fetch_comments(aweme, 3):
            if c["already"]:
                continue
            if any(pr in norm(c["text"]) for pr in products):
                print(f"target: {u}\n        @{c['user']}  {c['text'][:70]}\n")
                return aweme, c["cid"]
    raise SystemExit("No un-liked product comment found to probe with.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Find which transport TikTok signs.")
    ap.add_argument("url", nargs="?", default="")
    ap.add_argument("--profile", default="default")
    args = ap.parse_args()

    aweme, cid = pick_target(args.url)
    template = load_template()
    if not template:
        print("No capture.json — run capture.py first.")
        return 1
    print(f"using {len(template)} captured param(s)\n")

    pdir = HERE / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    if not (pdir / "Default").exists():
        print(f"No session at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(pdir),
            headless=True,
            user_agent=UA,
            locale="en-US",
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        # On the video itself, which is where a real like happens.
        page.goto(f"https://www.tiktok.com/@x/video/{aweme}", wait_until="domcontentloaded")
        page.wait_for_timeout(3000)

        for transport in ("fetch", "xhr"):
            res = page.evaluate(ATTEMPT_JS, [aweme, cid, template, transport, False])
            page.wait_for_timeout(2500)
            check = page.evaluate(CHECK_JS, [aweme, cid])
            applied = bool(check and check.get("mine"))
            print(
                f"  {transport:6}  http={res.get('http')} status_code={res.get('code')} "
                f"{(res.get('msg') or '')[:30]:30}  ->  "
                + ("APPLIED" if applied else "not applied")
                + (f"  (digg_count={check['digg']})" if check else "  (could not re-read)")
            )
            if applied:
                print(f"\n{transport} is signed. Set that transport in like.py's LIKE_JS.")
                ctx.close()
                return 0
            page.wait_for_timeout(1500)
        ctx.close()

    print(
        "\nNeither transport is signed, so the API route is finished: X-Gnarly is computed\n"
        "per request by code we cannot call, and TikTok drops anything without it while\n"
        "still answering status_code 0.\n\n"
        "The remaining path is clicking the heart in the DOM — the same thing that works\n"
        "when you do it by hand. It costs one page load per video instead of none, so\n"
        "expect seconds per video rather than fractions, but it is not guesswork."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
