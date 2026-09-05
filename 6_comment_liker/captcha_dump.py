#!/usr/bin/env python3
"""
Record what TikTok's captcha actually IS, so the solver can be written against
facts instead of guesses.

The solver has now failed twice in different ways — "could not find the puzzle
or slider" on some attempts, a confidently wrong angle on others — and both are
consistent with several different widgets. TikTok serves at least three
(rotate-the-disc, slide-the-jigsaw-piece, click-the-shapes) and may render any of
them inside an iframe, where every query_selector in captcha.py silently finds
nothing.

This opens a real window, waits for a captcha to appear, and writes everything
needed to tell them apart into captcha-dump/:

    page.png            the whole window
    frame-<n>.html      outerHTML of each captcha container, iframes included
    img-<n>.png         every image in the widget, screenshotted separately
    report.txt          frames, images, sizes, classes, the instruction text

Usage:
    python captcha_dump.py --profile e
"""
import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

import like

OUT = like.HERE / "captcha-dump"

# What the widget looks like from the outside, whichever type it is.
PROBE_JS = """
() => {
  const out = { url: location.href, nodes: [], imgs: [], text: '' }
  const seen = new Set()
  const sel = ['[id*="captcha" i]', '[class*="captcha" i]', '[class*="secsdk" i]',
               '[class*="verify" i]', '[id*="verify" i]']
  for (const s of sel) {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 20) continue
      const key = el.tagName + ':' + el.className + ':' + Math.round(r.width)
      if (seen.has(key)) continue
      seen.add(key)
      out.nodes.push({
        tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 120),
        w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.x), y: Math.round(r.y),
      })
    }
  }
  for (const im of document.querySelectorAll('img')) {
    const r = im.getBoundingClientRect()
    if (r.width < 30 || r.height < 30) continue
    out.imgs.push({
      src: (im.src || '').slice(0, 160), cls: String(im.className || '').slice(0, 120),
      id: im.id || '', w: Math.round(r.width), h: Math.round(r.height),
      natW: im.naturalWidth, natH: im.naturalHeight, complete: im.complete,
    })
  }
  const t = document.body ? document.body.innerText : ''
  for (const line of t.split('\n')) {
    const l = line.trim()
    if (/drag|slide|rotate|puzzle|verif|shape|select/i.test(l) && l.length < 120) {
      out.text += l + ' | '
    }
  }
  return out
}
"""


def dump_frame(frame, tag: str, report) -> None:
    try:
        info = frame.evaluate(PROBE_JS)
    except Exception as e:  # noqa: BLE001
        report.append(f"[{tag}] evaluate failed: {str(e)[:80]}")
        return
    if not info["nodes"] and not info["imgs"]:
        return
    report.append(f"\n[{tag}] {info['url'][:100]}")
    report.append(f"  instruction: {info['text'][:200] or '(none found)'}")
    report.append(f"  containers ({len(info['nodes'])}):")
    for n in info["nodes"][:14]:
        report.append(f"    {n['tag']:<6} {n['w']:>4}x{n['h']:<4} at {n['x']},{n['y']}"
                      f"  id={n['id'][:28]:<28} class={n['cls'][:60]}")
    report.append(f"  images ({len(info['imgs'])}):")
    for im in info["imgs"]:
        report.append(f"    {im['w']:>4}x{im['h']:<4} natural {im['natW']}x{im['natH']}"
                      f" complete={im['complete']}  id={im['id'][:24]:<24}"
                      f" class={im['cls'][:44]}")
        report.append(f"        src={im['src']}")

    # The markup, which is the only way to see how the pieces are stacked.
    for i, n in enumerate(info["nodes"][:3]):
        try:
            sel = f"#{n['id']}" if n["id"] else f"[class='{n['cls']}']"
            el = frame.query_selector(sel)
            if el:
                (OUT / f"{tag}-node{i}.html").write_text(
                    el.evaluate("e => e.outerHTML")[:120000], encoding="utf-8"
                )
        except Exception:  # noqa: BLE001
            pass

    # Each image on its own, which is what the solver has to work from.
    for i, im in enumerate(info["imgs"]):
        try:
            sel = f"#{im['id']}" if im["id"] else f"img[src='{im['src']}']"
            el = frame.query_selector(sel)
            if el:
                (OUT / f"{tag}-img{i}.png").write_bytes(el.screenshot())
        except Exception as e:  # noqa: BLE001
            report.append(f"    (could not screenshot img{i}: {str(e)[:50]})")


def main() -> int:
    ap = argparse.ArgumentParser(description="Dump TikTok's captcha for study.")
    ap.add_argument("--profile", default="e")
    ap.add_argument("--wait", type=int, default=180, help="seconds to wait for a captcha")
    ap.add_argument("--links", type=int, default=6, help="videos to try before giving up")
    args = ap.parse_args()

    OUT.mkdir(exist_ok=True)
    pulled, _ = like.from_dashboard("date", "1", {"platform": "tiktok", "limit": "40"})
    urls = [u for u in pulled if like.video_id(u)][: args.links]

    with sync_playwright() as p:
        # Nothing blocked: the point is to see the widget as TikTok sends it.
        ctx = like.launch_liker(p, args.profile, block_media=False, headed=True)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        found = False
        for url in urls:
            print(f"opening {url}")
            if not like.open_video(page, url, 30000):
                continue
            page.wait_for_timeout(2000)
            if not like.captcha_present(page):
                # Opening the comments is the usual trigger.
                like.open_comments(page, 12000)
                page.wait_for_timeout(3000)
            if like.captcha_present(page):
                found = True
                break
        if not found:
            print(f"\nNo captcha appeared on {len(urls)} videos.")
            print(f"Leaving the window open for {args.wait}s — browse until one shows up.")
            for _ in range(args.wait // 3):
                page.wait_for_timeout(3000)
                if like.captcha_present(page):
                    found = True
                    break
        if not found:
            print("Still no captcha. Nothing to dump.")
            ctx.close()
            return 1

        page.wait_for_timeout(2500)
        print("\ncaptcha on screen — dumping…")
        report = [f"main url: {page.url}"]
        page.screenshot(path=str(OUT / "page.png"), full_page=False)
        dump_frame(page, "main", report)
        for i, fr in enumerate(page.frames):
            if fr is page.main_frame:
                continue
            report.append(f"\n(iframe {i}: {fr.url[:110]})")
            dump_frame(fr, f"frame{i}", report)

        text = "\n".join(report)
        (OUT / "report.txt").write_text(text, encoding="utf-8")
        print(text)
        print(f"\nwritten to {OUT}")
        print("Solve it by hand now if you like; closing in 20s.")
        page.wait_for_timeout(20000)
        ctx.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
