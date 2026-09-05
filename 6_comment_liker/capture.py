#!/usr/bin/env python3
"""
Record a REAL comment-like request, made by hand, so we can copy its shape.

Where this stands: our request is signed (HTTP 200, not 403), correctly formed
(status_code 0, not 5), and does nothing — while the same account liking by hand
in the same browser works. So the account is fine and the parameters are not.
Something in the genuine request is missing from ours, and TikTok's answer of
"accepted" is not going to tell us what.

So: open a video, like one comment yourself, and this records exactly what the
page sent — full URL, method, body, and headers. It then prints what the real
request carries that ours does not, which is the answer.

Usage:
    python capture.py                       # picks a video from the dashboard
    python capture.py <video-url>
    python capture.py <video-url> --timeout 180

A browser window opens. Scroll to the comments, click the heart on any comment,
and the script prints what it saw and writes capture.json.
"""
import argparse
import json
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

from playwright.sync_api import sync_playwright

from like import UA, HERE, from_dashboard, video_id

OUT = HERE / "capture.json"

# What like.py sends today, for the comparison at the end.
OURS = {"aweme_id", "cid", "digg_type", "aid"}

# Headers worth seeing. The rest is boilerplate, and Cookie is deliberately not
# recorded — this file is a debugging artefact, not a credential store.
INTERESTING = (
    "x-bogus",
    "x-gnarly",
    "x-argus",
    "x-ladon",
    "x-gorgon",
    "x-khronos",
    "x-tt-params",
    "referer",
    "content-type",
    "origin",
)


def main() -> int:
    ap = argparse.ArgumentParser(description="Capture a real comment-like request.")
    ap.add_argument("url", nargs="?", default="", help="video URL to open")
    ap.add_argument("--profile", default="default")
    ap.add_argument("--timeout", type=int, default=180, help="seconds to wait for your click")
    args = ap.parse_args()

    target = args.url
    if not target:
        print("No URL given — asking the dashboard for one…")
        pulled, _ = from_dashboard("date", "1", {"platform": "tiktok", "limit": "5"})
        target = next((u for u in pulled if video_id(u)), "")
        if not target:
            print("Dashboard returned no usable link. Pass a video URL instead.")
            return 1
    print(f"opening {target}\n")

    pdir = HERE / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    if not (pdir / "Default").exists():
        print(f"No session at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    seen: list[dict] = []

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(pdir),
            headless=False,  # you have to click, so this one is visible
            user_agent=UA,
            locale="en-US",
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_request(req):
            if "/api/comment/digg" not in req.url:
                return
            seen.append(
                {
                    "url": req.url,
                    "method": req.method,
                    "post_data": req.post_data,
                    "headers": {
                        k: v
                        for k, v in req.headers.items()
                        if k.lower() in INTERESTING or k.lower().startswith("x-")
                    },
                }
            )
            print("  captured a digg request")

        page.on("request", on_request)
        page.goto(target, wait_until="domcontentloaded")

        print("Now: open the comments and click the heart on ONE comment.")
        print(f"Waiting up to {args.timeout}s…\n")
        waited = 0
        while waited < args.timeout and not seen:
            page.wait_for_timeout(1000)
            waited += 1
        # A beat, so the response and any follow-up request land too.
        page.wait_for_timeout(1500)
        ctx.close()

    if not seen:
        print("Nothing captured. Did the click register as a like?")
        return 1

    req = seen[0]
    OUT.write_text(json.dumps(seen, indent=2), encoding="utf-8")

    parsed = urlparse(req["url"])
    params = dict(parse_qsl(parsed.query))
    print(f"\nmethod : {req['method']}")
    print(f"path   : {parsed.path}")
    if req.get("post_data"):
        print(f"body   : {req['post_data'][:300]}")

    print(f"\nquery params ({len(params)}):")
    for k in sorted(params):
        v = params[k]
        mark = "  <- we send this" if k in OURS else ""
        print(f"  {k:24} = {v[:70]}{mark}")

    extra = sorted(set(params) - OURS)
    print(f"\nthe real request carries {len(extra)} param(s) we do not send:")
    print("  " + ", ".join(extra) if extra else "  (none — the difference is elsewhere)")

    print("\nheaders of note:")
    for k in sorted(req["headers"]):
        print(f"  {k:24} = {str(req['headers'][k])[:70]}")

    print(f"\nsaved to {OUT.name}. Send me that output and I will match like.py to it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
