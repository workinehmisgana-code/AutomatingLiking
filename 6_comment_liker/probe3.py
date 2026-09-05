#!/usr/bin/env python3
"""
Can a like be issued without a page load per video?

probe_signer.py found two things that change the picture:

  * window.fetch is NOT native — TikTok has wrapped it. A wrapper is exactly
    what adds X-Gnarly, so our own fetch calls may have been signed all along.
  * window.byted_acrawler exists, with the signing API on it.

Which means the earlier failure may not have been "unsignable" at all. We were
replaying 32 parameters out of capture.json — including a stale msToken and
device_id — over a request the wrapper wanted to build itself. Feeding it stale
signature-adjacent values is a good way to get a request that parses, answers
status_code 0, and is quietly dropped.

So this tries the variants against ONE comment and, after each, re-reads the
comment to see whether the like actually landed. Nothing here trusts a response
code; that mistake cost four rounds already.

If a variant works, liking stops needing the DOM: one page load for the whole
run, then a signed POST per comment.

Usage:
    python probe3.py --profile a
"""
import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from like import (
    HERE,
    fetch_comments,
    from_dashboard,
    launch_liker,
    load_template,
    norm,
    NORM_PRODUCTS,
    open_video,
    video_id,
)

# One attempt: build the URL, CSRF handshake, POST, report. Verification is
# separate, by reading the comment back.
TRY_JS = """
async ([awemeId, cid, params, referrer]) => {
  const p = new URLSearchParams(params || {})
  p.set('aweme_id', String(awemeId))
  p.set('cid', String(cid))
  p.set('digg_type', '1')
  p.set('aid', '1988')
  const url = '/api/comment/digg/?' + p.toString()
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      referrer,
      headers: { 'x-secsdk-csrf-request': '1', 'x-secsdk-csrf-version': '1.2.22' },
    })
    const csrf = head.headers.get('x-ware-csrf-token')
    if (!csrf) return { msg: 'no csrf token' }
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      referrer,
      headers: {
        'x-secsdk-csrf-token': csrf.split(',')[1] || csrf,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })
    const body = await r.text()
    if (!body.trim()) return { http: r.status, code: null, msg: '(empty)' }
    try { const j = JSON.parse(body); return { http: r.status, code: j.status_code, msg: j.status_msg || '' } }
    catch { return { http: r.status, code: null, msg: body.slice(0, 70) } }
  } catch (e) { return { http: 0, code: null, msg: String(e).slice(0, 70) } }
}
"""

# The only evidence that counts. Pages deep enough to find a buried comment.
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
    if (c) return { mine: !!c.user_digged, digg: c.digg_count }
    if (!j.has_more || !list.length) return null
    cursor = Number(j.cursor) || cursor + list.length
  }
  return null
}
"""

KEYS_JS = """
() => {
  const dump = (o) => { try { return Object.getOwnPropertyNames(o) } catch { return [] } }
  return {
    acrawler: dump(window.byted_acrawler),
    secsdk: dump(window.secsdk),
    csrf: dump((window.secsdk || {}).csrf),
  }
}
"""


def pick_target(products):
    pulled, live = from_dashboard("date", "1", {"platform": "tiktok", "limit": "80"})
    if live:
        products = [norm(x) for x in live]
    for u in pulled:
        aweme = video_id(u)
        if not aweme:
            continue
        for c in fetch_comments(aweme, 3):
            if c["already"]:
                continue
            if any(pr in norm(c["text"]) for pr in products):
                return u, aweme, c
    raise SystemExit("No un-liked product comment found to probe with.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Try to like without a page load per video.")
    ap.add_argument("--profile", default="a")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    url, aweme, comment = pick_target(NORM_PRODUCTS)
    print(f"target: {url}\n        @{comment['user']}  {comment['text'][:70]}\n")

    pdir = HERE / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    if not (pdir / "Default").exists():
        print(f"No session at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    template = load_template()
    # The minimal set is the interesting one: no stale msToken, no stale
    # device_id, nothing for the wrapper to trip over.
    variants = [
        ("minimal (4 params)", {}),
        (f"capture.json ({len(template)} params)", template),
    ]

    with sync_playwright() as p:
        ctx = launch_liker(p, args.profile, headed=args.headed)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        if not open_video(page, url):
            print("page did not render")
            ctx.close()
            return 1
        page.wait_for_timeout(3000)

        keys = page.evaluate(KEYS_JS)
        print("window.byted_acrawler:", ", ".join(keys["acrawler"])[:200])
        print("window.secsdk:", ", ".join(keys["secsdk"])[:120])
        print("window.secsdk.csrf:", ", ".join(keys["csrf"])[:160])
        print()

        for label, params in variants:
            res = page.evaluate(TRY_JS, [aweme, comment["cid"], params, url])
            page.wait_for_timeout(2500)
            check = page.evaluate(CHECK_JS, [aweme, comment["cid"]])
            applied = bool(check and check.get("mine"))
            print(
                f"  {label:32} http={res.get('http')} status_code={res.get('code')} "
                f"{(res.get('msg') or '')[:20]:20} -> "
                + ("APPLIED" if applied else "not applied")
                + (f"  digg_count={check['digg']}" if check else "  (could not re-read)")
            )
            if applied:
                print(
                    "\nThat works. Liking no longer needs the DOM: one page load for the\n"
                    "whole run, then a signed POST per comment."
                )
                ctx.close()
                return 0
            page.wait_for_timeout(1500)
        ctx.close()

    print(
        "\nNeither variant applied. The DOM click stays the only route that works,\n"
        "and the cost is one page load per video."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
