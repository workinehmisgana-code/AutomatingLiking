"""Open one scraper Chrome profile so its accounts can be signed in.

The Control Center runs several searches at once by giving each its own Chrome
profile (a directory next to this file). A new profile starts signed out of
everything, so this opens it on TikTok, Instagram and YouTube; log in to each,
then press Enter (or close the window) and the logins stay in the profile.

    BROWSER_PROFILE_DIR=./browser_profile-2 python open_profile.py
"""
import os
import sys
import threading
import time
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()
PROFILE = os.getenv("BROWSER_PROFILE_DIR", "./browser_profile")
SITES = [
    "https://www.tiktok.com/login",
    "https://www.instagram.com/accounts/login/",
    "https://www.youtube.com/",
]


def main() -> None:
    path = Path(PROFILE).resolve()
    print(f"[*] opening Chrome profile {path.name}")
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(path),
            headless=False,
            channel="chrome",
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            viewport={"width": 1280, "height": 800},
            locale="en-US",
        )
        first = ctx.pages[0] if ctx.pages else ctx.new_page()
        first.goto(SITES[0])
        for url in SITES[1:]:
            ctx.new_page().goto(url)
        print("[*] Log in to TikTok, Instagram and YouTube in this window.")
        print("[*] Then press Enter here (or close the window) - the logins stay in the profile.")

        done = threading.Event()

        def wait_enter() -> None:
            try:
                sys.stdin.readline()
            except Exception:  # noqa: BLE001
                pass
            done.set()

        threading.Thread(target=wait_enter, daemon=True).start()
        # Closing the browser by hand ends it as well as Enter does.
        while not done.is_set():
            try:
                if not ctx.pages:
                    break
                ctx.pages[0].wait_for_timeout(500)
            except Exception:  # noqa: BLE001 - the window was closed
                break
            time.sleep(0.2)
        try:
            ctx.close()
        except Exception:  # noqa: BLE001
            pass
    print(f"[+] saved - {path.name} is ready for searches")


if __name__ == "__main__":
    main()
