#!/usr/bin/env python3
"""
Does the captcha actually bring its window to the front?

The case that matters is the hard one: a window that is MINIMISED behind eight
others. Playwright's own bring_to_front() does not restore a minimised window,
which is the whole reason notify.focus_window exists — so this test minimises the
window first and checks it comes back.

    python check_focus.py
"""
import ctypes
import sys
import time
from ctypes import wintypes
from pathlib import Path

import notify
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


def find(title_contains: str):
    """The hwnd of the first visible window whose title contains this."""
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    out = []
    needle = title_contains.lower()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if needle in buf.value.lower():
            out.append(hwnd)
            return False
        return True

    user32.EnumWindows(each, 0)
    return out[0] if out else None


def main() -> int:
    if not notify.WINDOWS:
        print("not Windows — nothing to test")
        return 0
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    SW_MINIMIZE = 6

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(HERE / ".focus-test-profile"),
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto("about:blank")
            marker = "CAPTCHA profile test-focus"
            page.evaluate("(t) => { document.title = t }", marker)
            time.sleep(1.5)

            print("the marker makes the window findable:")
            hwnd = find(marker)
            check("  a window carries the unique title", hwnd is not None, True)
            if not hwnd:
                return 1

            print("\nminimised, then brought back:")
            user32.ShowWindow(hwnd, SW_MINIMIZE)
            time.sleep(1.0)
            check("  it is minimised", bool(user32.IsIconic(hwnd)), True)

            raised = notify.focus_window(marker)
            time.sleep(1.0)
            check("  focus_window found it", raised, True)
            check("  it is no longer minimised", bool(user32.IsIconic(hwnd)), False)
            # Foreground is the part Windows can refuse; report rather than
            # assert, since a focus-stealing policy is the user's to set.
            fg = user32.GetForegroundWindow()
            print(f"   {'ok  ' if fg == hwnd else '??  '} it is the foreground window: {fg == hwnd}")
            if fg != hwnd:
                print("        (Windows can refuse the raise; it is un-minimised and flashing)")

            print("\nthe title is restorable:")
            page.evaluate("(t) => { document.title = t }", "about:blank")
            time.sleep(0.8)
            check("  the marker is gone", find(marker) is None, True)
        finally:
            ctx.close()

    print(f"\n{'all correct' if fails == 0 else f'{fails} FAILED'}")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
