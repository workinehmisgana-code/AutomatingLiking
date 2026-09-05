#!/usr/bin/env python3
"""
Did the likes actually stick?

done.csv records what TikTok's API answered — status_code 0, "accepted". That is
not the same claim as "the heart is on". An endpoint can accept a request and
apply nothing, which is a normal anti-automation response and looks identical
from the caller's side.

This settles it by reading the comments back and checking two fields:

  user_digged  1 if THIS account has liked the comment. The decisive one.
  digg_count   the public like total.

The read happens INSIDE the logged-in page, not from plain Python. user_digged is
answered relative to whoever is asking, and an unauthenticated read always says
0 — which would look exactly like failure whether or not the like worked.

Usage:
    python verify.py                    # check every 'ok' row in done.csv
    python verify.py --all              # check failures too
    python verify.py --limit 10
"""
import argparse
import csv
import sys
from collections import defaultdict
from pathlib import Path

from playwright.sync_api import sync_playwright

from like import UA, HERE, done_path

READ_JS = """
async ([awemeId]) => {
  const url = `/api/comment/list/?aweme_id=${awemeId}&count=50&cursor=0&aid=1988`
  try {
    const r = await fetch(url, {
      credentials: 'include',
      referrer: `https://www.tiktok.com/@x/video/${awemeId}`,
    })
    const body = await r.text()
    if (!body.trim()) return { error: 'empty body' }
    const j = JSON.parse(body)
    return {
      comments: (j.comments || []).map((c) => ({
        cid: String(c.cid || ''),
        digg: c.digg_count,
        mine: c.user_digged,
        user: (c.user || {}).unique_id || '',
      })),
    }
  } catch (e) { return { error: String(e).slice(0, 120) } }
}
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="Check whether recorded likes really landed.")
    ap.add_argument("--profile", default="default")
    ap.add_argument("--all", action="store_true", help="include rows that failed")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many comments")
    args = ap.parse_args()

    # Each account keeps its own ledger, and user_digged is read as that account,
    # so verifying one profile's likes against another's session would report
    # every row as a failure.
    done = done_path(args.profile)
    if not done.exists():
        print(f"No {done.name} yet.")
        return 1

    with done.open(encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r.get("cid")]
    if not args.all:
        rows = [r for r in rows if (r.get("status") or "").startswith("ok")]
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        print("Nothing to check.")
        return 0

    # One read per video, however many comments of ours it holds.
    by_video: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_video[r.get("aweme_id", "")].append(r)
    print(f"{len(rows)} recorded like(s) across {len(by_video)} video(s)\n")

    pdir = HERE / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    if not (pdir / "Default").exists():
        print(f"No session at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    stuck = gone = missing = 0
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
        page.goto("https://www.tiktok.com/", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        who = page.evaluate(
            """async () => {
                const r = await fetch('/passport/web/account/info/?aid=1459', { credentials: 'include' })
                if (!r.ok) return null
                const j = await r.json().catch(() => null)
                const d = (j || {}).data || {}
                return d.user_id_str || d.user_id ? (d.screen_name || d.username || 'yes') : null
            }"""
        )
        if not who:
            print(f"Not signed in. Run: python login.py --profile {args.profile}")
            ctx.close()
            return 1
        print(f"reading as {who}\n")

        for aweme, entries in by_video.items():
            res = page.evaluate(READ_JS, [aweme])
            if res.get("error"):
                print(f"  {aweme}: could not read ({res['error']})")
                missing += len(entries)
                continue
            live = {c["cid"]: c for c in res.get("comments") or []}
            for r in entries:
                c = live.get(r["cid"])
                if not c:
                    print(f"  {r['cid']}  @{r.get('user',''):<20} NOT IN THE READ (fell past page 1?)")
                    missing += 1
                    continue
                if c["mine"]:
                    stuck += 1
                    print(f"  {r['cid']}  @{r.get('user',''):<20} LIKED   digg_count={c['digg']}")
                else:
                    gone += 1
                    print(f"  {r['cid']}  @{r.get('user',''):<20} not liked   digg_count={c['digg']}")
            page.wait_for_timeout(600)
        ctx.close()

    print(f"\n{stuck} really liked, {gone} accepted but NOT applied, {missing} could not be checked")
    if gone and not stuck:
        print(
            "\nEvery like was accepted and none applied. That is TikTok taking the request "
            "and dropping it — the parameters are right, the account is not being allowed "
            "to act. Try one like by hand in the same browser profile to see whether the "
            "account itself is restricted."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
