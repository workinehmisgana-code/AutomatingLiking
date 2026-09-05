#!/usr/bin/env python3
"""
Verify ALL users in ONE Freer browser session — the window stays open the whole
time and users are processed one by one.

Reads a JSON list of users from STDIN:
    [{"userId": "...", "username": "@handle", "sampleUrls": ["https://...", ...]}, ...]

Opens Freer once (solve the captcha once), then for each user checks their sample
links' comments for the user's @username, stopping the moment it's found. Prints
ONE JSON result line per user to stdout (the dashboard route marks the valid ones):

    {"userId": "...", "username": "handle", "found": true, "matched_link": "...", "checked": 1}

Reuses the Freer flow from automate.py / extract_comments.py / verify_user.py.
"""
import json
import sys

from playwright.sync_api import sync_playwright

from automate import new_browser_page, freer_open_service, FREER_URL
from extract_comments import freer_go_back, open_url_form
from verify_user import find_user_in_comments, norm_user


def main():
    try:
        users = json.load(sys.stdin)
    except Exception:
        users = []
    if not isinstance(users, list):
        users = []
    print(f"verify_all: {len(users)} user(s)", file=sys.stderr)

    with sync_playwright() as p:
        browser, _ctx, page = new_browser_page(p)
        page.goto(FREER_URL, wait_until="domcontentloaded", timeout=30000)
        freer_open_service(page)  # blocks once until the captcha is solved → URL form

        first = True
        for i, u in enumerate(users):
            uid = u.get("userId")
            target = norm_user(u.get("username"))
            name = (u.get("name") or "").strip() or "(no name)"
            links = [l for l in (u.get("sampleUrls") or []) if l and "tiktok.com" in str(l).lower()]
            res = {"userId": uid, "username": target, "name": name, "found": False, "matched_link": None, "checked": 0}
            print(f"\n── [{i + 1}/{len(users)}] verifying account: {name}  (tiktok @{target}, {len(links)} sample link(s)) ──", file=sys.stderr, flush=True)

            for url in links:
                # Return to the URL form before every check (except the very first),
                # without closing the browser.
                if not first:
                    try:
                        freer_go_back(page)
                        open_url_form(page)
                    except Exception as e:  # noqa: BLE001
                        print(f"  nav error: {e}", file=sys.stderr)
                first = False
                found = False
                try:
                    found, _seen = find_user_in_comments(page, url, target, 30)
                except Exception as e:  # noqa: BLE001
                    print(f"  error on {url}: {e}", file=sys.stderr)
                res["checked"] += 1
                if found:
                    res["found"] = True
                    res["matched_link"] = url
                    break

            print(json.dumps(res), flush=True)  # one line per user → route parses these

        browser.close()

    print("verify_all: done", file=sys.stderr)


if __name__ == "__main__":
    main()
