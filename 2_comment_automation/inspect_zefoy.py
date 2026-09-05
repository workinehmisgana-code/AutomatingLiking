"""
Diagnostic: open Zefoy, let you log in + search one URL,
then dump the full dropdown HTML and all option values.

Run:  python inspect_zefoy.py
"""

import asyncio, os, time
from playwright.sync_api import sync_playwright

asyncio.set_event_loop(asyncio.new_event_loop())

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        headless=False,
        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    )
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 800},
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        locale="en-US",
    )
    page = ctx.new_page()
    page.goto("https://zefoy.com", wait_until="commit", timeout=30000)

    print("\n" + "=" * 60)
    print("  In the browser:")
    print("  1. Solve the captcha")
    print("  2. Click 'Comments Hearts'")
    print("  3. Paste any TikTok URL and click Search")
    print("  4. Wait for the comment list to appear")
    print("\n  The script will detect the dropdown and dump its HTML.")
    print("=" * 60 + "\n")

    # Wait up to 5 minutes for the quantity dropdown to appear
    sel = ".t-chearts-menu .list-group-item select[name='select_lmt']"
    print("Waiting for dropdown to appear (up to 5 min)...")
    try:
        page.wait_for_selector(sel, timeout=300_000)
    except Exception:
        print("[!] Timed out waiting for dropdown.")
        browser.close()
        raise

    time.sleep(1)  # let JS finish processing

    dropdowns = page.locator(sel).all()
    print(f"\n[+] Found {len(dropdowns)} dropdown(s).\n")

    for i, dd in enumerate(dropdowns):
        outer = dd.evaluate("el => el.outerHTML")
        info = dd.evaluate("""el => Array.from(el.options).map(o => ({
            value: o.value,
            text: o.text.trim(),
            disabled: o.disabled,
            selected: o.selected,
        }))""")
        print(f"── Dropdown #{i + 1} ──────────────────────────────────")
        print(f"outerHTML:\n{outer}\n")
        print("Options:")
        for opt in info:
            flags = []
            if opt["disabled"]: flags.append("DISABLED")
            if opt["selected"]: flags.append("SELECTED")
            flag_str = f"  [{', '.join(flags)}]" if flags else ""
            print(f"  value={opt['value']!r}  text={opt['text']!r}{flag_str}")
        print()

    input("\nPress Enter to close the browser...")
    browser.close()
