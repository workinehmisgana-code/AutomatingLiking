#!/usr/bin/env python3
"""
Can one loaded page like comments on OTHER videos?

probe3 proved a signed POST works: minimal params, CSRF handshake, TikTok's
wrapped fetch signs it. That already removes the DOM. This decides how much it
removes:

  * if the request only works while the browser is ON that video, we still pay
    one page load per video — better than clicking, but not by much.
  * if it works from any loaded TikTok page, the whole run costs ONE page load
    and every like after that is a request. Hundreds of videos a minute.

So: load a single page, then like comments belonging to three DIFFERENT videos
without navigating, and verify each by reading it back.

Usage:
    python probe4.py --profile a
"""
import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from like import (
    HERE,
    NORM_PRODUCTS,
    fetch_comments,
    from_dashboard,
    launch_liker,
    norm,
    open_video,
    video_id,
)

LIKE_JS = """
async ([awemeId, cid, referrer]) => {
  const url = `/api/comment/digg/?aweme_id=${awemeId}&cid=${cid}&digg_type=1&aid=1988`
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
    const j = JSON.parse(body)
    return { http: r.status, code: j.status_code, msg: j.status_msg || '' }
  } catch (e) { return { http: 0, code: null, msg: String(e).slice(0, 70) } }
}
"""

PICK_JS = """
async ([awemeId, products]) => {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  let cursor = 0
  for (let page = 0; page < 4; page++) {
    const r = await fetch(
      `/api/comment/list/?aweme_id=${awemeId}&count=50&cursor=${cursor}&aid=1988`,
      { credentials: 'include', referrer: `https://www.tiktok.com/@x/video/${awemeId}` }
    )
    const body = await r.text()
    if (!body.trim()) return null
    let j
    try { j = JSON.parse(body) } catch { return null }
    for (const c of j.comments || []) {
      if (c.user_digged) continue
      const hay = norm(c.text)
      if (products.some((p) => hay.includes(p))) {
        return {
          cid: String(c.cid),
          user: String((c.user || {}).unique_id || ''),
          text: String(c.text || ''),
        }
      }
    }
    if (!j.has_more) return null
    cursor = Number(j.cursor) || cursor + 50
  }
  return null
}
"""

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


def main() -> int:
    ap = argparse.ArgumentParser(description="Like comments on other videos from one page.")
    ap.add_argument("--profile", default="a")
    ap.add_argument("--targets", type=int, default=3)
    args = ap.parse_args()

    pulled, live = from_dashboard("date", "1", {"platform": "tiktok", "limit": "120"})
    products = [norm(x) for x in live] if live else NORM_PRODUCTS

    # Candidate videos. Which comments are ALREADY liked cannot be known from
    # out here — the unauthenticated read reports user_digged as 0 for everyone,
    # so picking targets from it hands us comments this account liked days ago
    # and then "verifies" a like that was already there. Selection happens
    # in-page below, where user_digged is answered for us.
    candidates = []
    for u in pulled:
        aweme = video_id(u)
        if not aweme:
            continue
        if any(any(pr in norm(c["text"]) for pr in products) for c in fetch_comments(aweme, 3)):
            candidates.append((u, aweme))
        if len(candidates) >= args.targets * 6:
            break
    picks = []
    if not candidates:
        print("No candidate videos found.")
        return 1


    pdir = HERE / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    if not (pdir / "Default").exists():
        print(f"No session at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    with sync_playwright() as p:
        ctx = launch_liker(p, args.profile)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # ONE page load for the whole probe, before anything else: the picker
        # and the liker both use relative URLs, which need a page to resolve
        # against. It is a video page because that is what the like requires.
        first_url = candidates[0][0]
        print(f"loading one page: {first_url}")
        if not open_video(page, first_url):
            print("page did not render")
            ctx.close()
            return 1
        page.wait_for_timeout(3000)

        # Pick targets from INSIDE the session, so "not yet liked" is a fact.
        for u, aweme in candidates:
            got = page.evaluate(PICK_JS, [aweme, products])
            if got:
                picks.append((u, aweme, got))
            if len(picks) >= args.targets:
                break
        if not picks:
            print("every matching comment on these videos is already liked by this account")
            ctx.close()
            return 1
        print(f"\n{len(picks)} genuinely un-liked target(s):")
        for u, _, c in picks:
            print(f"  @{c['user']:<20} {c['text'][:50]}")
        print()

        applied = 0
        for n, (u, aweme, c) in enumerate(picks, 1):
            same = " (the loaded video)" if u == first_url else " (a DIFFERENT video)"
            res = page.evaluate(LIKE_JS, [aweme, c["cid"], u])
            page.wait_for_timeout(2000)
            state = page.evaluate(CHECK_JS, [aweme, c["cid"]])
            landed = bool(state and state.get("mine"))
            applied += 1 if landed else 0
            print(
                f"  [{n}] {aweme}{same}\n"
                f"      status_code={res.get('code')} -> "
                + ("APPLIED" if landed else "not applied")
                + (f"  digg_count={state['digg']}" if state else "  (could not re-read)")
            )
        ctx.close()

    print(f"\n{applied}/{len(picks)} applied from a single loaded page.")
    if applied == len(picks):
        print(
            "So the browser does not need to be on the video. One page load for the\n"
            "whole run; every like after that is just a request."
        )
    return 0 if applied else 1


if __name__ == "__main__":
    sys.exit(main())
