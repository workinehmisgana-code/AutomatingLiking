#!/usr/bin/env python3
"""
Find the parameter shape /api/comment/digg/ actually wants.

The first real run proved the hard part works: requests issued from inside a
logged-in TikTok page come back HTTP 200 with a parsed API response, not the 403
"Web SDK blocked by Argus TLB Plugin" that every outside call gets. Signing is
handled. What came back instead was status_code 5, "Invalid parameters" — so the
endpoint is reachable and simply disagrees with how we are addressing it.

Rather than guess repeatedly, this tries a list of candidate shapes against ONE
comment and reports what each returns. status_code 0 means that shape worked
(and that comment is now liked — it is a real request, on purpose).

Two things are varied: the like parameter name (type vs digg_type), and whether
the common web-client params TikTok normally sends are present. Some endpoints
tolerate their absence; digg may not.

Usage:
    python probe.py                       # picks a video from the dashboard
    python probe.py <video-url>           # or use one you name
    python probe.py <video-url> --unlike  # undo, once you know which shape works

Whatever works, put it in like.py's LIKE_JS. The winning line is printed at the
end in the form you need.
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

from like import UA, HERE, fetch_comments, video_id, norm, NORM_PRODUCTS, load_env, from_dashboard

# Each candidate is (label, method, query-template). {a} = aweme_id, {c} = cid,
# {t} = 1 to like / 0 to unlike.
COMMON = (
    "&app_language=en&app_name=tiktok_web&channel=tiktok_web&device_platform=web_pc"
    "&region=US&priority_region=US&os=windows&screen_width=1280&screen_height=900"
    "&browser_language=en-US&browser_platform=Win32&browser_name=Mozilla"
    "&cookie_enabled=true&focus_state=true&is_fullscreen=false&is_page_visible=true"
)

CANDIDATES = [
    ("type, minimal          ", "POST", "/api/comment/digg/?aweme_id={a}&cid={c}&type={t}&aid=1988"),
    ("digg_type, minimal     ", "POST", "/api/comment/digg/?aweme_id={a}&cid={c}&digg_type={t}&aid=1988"),
    ("type + common params   ", "POST", "/api/comment/digg/?aweme_id={a}&cid={c}&type={t}&aid=1988" + COMMON),
    ("digg_type + common     ", "POST", "/api/comment/digg/?aweme_id={a}&cid={c}&digg_type={t}&aid=1988" + COMMON),
    ("cid only, digg_type    ", "POST", "/api/comment/digg/?cid={c}&digg_type={t}&aid=1988" + COMMON),
    ("GET, type + common     ", "GET", "/api/comment/digg/?aweme_id={a}&cid={c}&type={t}&aid=1988" + COMMON),
    ("GET, digg_type + common", "GET", "/api/comment/digg/?aweme_id={a}&cid={c}&digg_type={t}&aid=1988" + COMMON),
]

TRY_JS = """
async ([method, url, referrer]) => {
  try {
    // Same-origin referrer, set explicitly. Some TikTok endpoints read the page
    // the request claims to come from, and a request that says "home page" while
    // asking about a comment on a video is one plausible reading of the empty
    // 200 bodies we saw.
    const opts = { method, credentials: 'include', referrer }
    const r = await fetch(url, opts)
    const body = await r.text()
    if (!body.trim()) return { http: r.status, code: null, msg: '(empty body)' }
    try {
      const j = JSON.parse(body)
      return { http: r.status, code: j.status_code, msg: j.status_msg || '' }
    } catch { return { http: r.status, code: null, msg: body.slice(0, 100) } }
  } catch (e) { return { http: 0, code: null, msg: String(e).slice(0, 100) } }
}
"""


def pick_target(url_arg: str) -> tuple[str, str, str]:
    """A video and one of our comments on it. Returns (aweme_id, cid, who)."""
    urls = [url_arg] if url_arg else []
    if not urls:
        print("No URL given — asking the dashboard for date cluster 1…")
        pulled, live = from_dashboard("date", "1", {"platform": "tiktok", "limit": "60"})
        urls = pulled
        products = [norm(p) for p in live] if live else NORM_PRODUCTS
    else:
        products = NORM_PRODUCTS

    for u in urls:
        aweme = video_id(u)
        if not aweme:
            continue
        for c in fetch_comments(aweme, 3):
            if c["already"]:
                continue
            hay = norm(c["text"])
            if any(p in hay for p in products):
                print(f"target: {u}\n        @{c['user']}  {c['text'][:70]}")
                return aweme, c["cid"], c["user"]
    raise SystemExit("Found no un-liked product comment to probe with.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Find the working digg parameter shape.")
    ap.add_argument("url", nargs="?", default="", help="video URL to probe on")
    ap.add_argument("--profile", default="default")
    ap.add_argument("--unlike", action="store_true", help="probe the unlike direction")
    args = ap.parse_args()

    aweme, cid, who = pick_target(args.url)
    t = 0 if args.unlike else 1

    pdir = HERE / ("profile" if args.profile == "default" else f"profile-{args.profile}")
    if not (pdir / "Default").exists():
        print(f"No session at {pdir}. Run: python login.py --profile {args.profile}")
        return 1

    winners = []
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
        # Land ON the video, not the home page. Some endpoints read the referring
        # page, and this costs one navigation for the whole probe.
        page.goto(f"https://www.tiktok.com/@x/video/{aweme}", wait_until="domcontentloaded")
        page.wait_for_timeout(3000)

        who_am_i = page.evaluate(
            """async () => {
                const r = await fetch('/passport/web/account/info/?aid=1459', { credentials: 'include' })
                if (!r.ok) return null
                const j = await r.json().catch(() => null)
                const d = (j || {}).data || {}
                return d.user_id_str || d.user_id ? (d.screen_name || d.username || 'yes') : null
            }"""
        )
        if not who_am_i:
            print(f"Not signed in. Run: python login.py --profile {args.profile}")
            ctx.close()
            return 1
        print(f"signed in as {who_am_i}\n")

        for label, method, tpl in CANDIDATES:
            url = tpl.format(a=aweme, c=cid, t=t)
            res = page.evaluate(TRY_JS, [method, url, f"https://www.tiktok.com/@x/video/{aweme}"])
            code, msg, http = res.get("code"), res.get("msg") or "", res.get("http")
            mark = "  <-- WORKS" if code == 0 else ""
            print(f"  {label}  {method:4}  HTTP {http}  status_code={code}  {msg[:44]}{mark}")
            if code == 0:
                winners.append((label, method, tpl))
                # Stop on the first success: every further attempt would be a
                # second like on the same comment, which proves nothing.
                break
            page.wait_for_timeout(1200)
        ctx.close()

    if not winners:
        print(
            "\nNone worked. Next step is capture: run login.py, open a video, like a comment "
            "by hand with devtools' Network tab filtered to 'digg', and send me the request URL."
        )
        return 1

    label, method, tpl = winners[0]
    print(f"\nWorking shape: {label.strip()} ({method})")
    print("Put this in like.py's LIKE_JS url line:\n")
    print("  const url = `" + tpl.replace("{a}", "${awemeId}").replace("{c}", "${cid}").replace("{t}", "${type}") + "`")
    print(f"  …and the fetch method to '{method}'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
