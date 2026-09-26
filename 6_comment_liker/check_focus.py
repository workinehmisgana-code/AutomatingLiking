#!/usr/bin/env python3
"""
Does a window that opens end up somewhere a person can see it?

Two halves, both measured against a real window rather than asserted.

FRONT. A window that is MINIMISED behind eight others is the hard case.
Playwright's own bring_to_front() does not restore one, which is the whole
reason notify.focus_window exists — so this minimises the window first and
checks it comes back.

PLACE. Headed windows used to be tiled: the screen cut into `slots` boxes, one
per account. With seventeen accounts that is three columns and six rows of a
screen that has one, so most windows were positioned hundreds of pixels below
the bottom edge, and the report was that they "get hidden somewhere". They are
put on the main monitor and maximised instead — by asking Windows after the
fact, because the flags alone do not do it: --window-size is in Chrome's
device-independent pixels and the shell's coordinates are in this process's, and
on a scaled display a window asked to be 1707 wide measured 1296.

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

            print("\nthe screen it is told to fill is the MAIN one:")
            x, y, w, h = notify.primary_screen()
            check("  the work area has a size", w > 200 and h > 200, True)
            # The primary monitor's origin is (0, 0) by definition; a second
            # screen sits at an offset from it. Positioning there is what keeps
            # the window off the monitor Chrome happened to close on.
            check("  starting at the primary origin", (x, y), (0, 0))
            # Minus the taskbar: a window sized to the whole screen has its
            # bottom edge under it, and on TikTok that edge is the comment box.
            check("  and it is the work area, not the whole screen",
                  h < user32.GetSystemMetrics(1), True)
            flags = " ".join(notify.screen_args())
            check("  the flags carry that size", f"--window-size={w},{h}" in flags, True)
            check("  and that position", f"--window-position={x},{y}" in flags, True)

            print("\nand the window really lands there:")
            page.evaluate("(t) => { document.title = t }", marker)
            placed = notify.show_window(page, marker)
            time.sleep(1.0)
            check("  show_window found and placed it", placed, True)
            hwnd = find(marker)
            check("  it is maximised", bool(user32.IsZoomed(hwnd)), True)
            r = wintypes.RECT() if hasattr(wintypes, "RECT") else None
            if r is None:
                class RECT(ctypes.Structure):
                    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]
                r = RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
            # A maximised window's frame sits a few pixels outside the work
            # area, which is why this is a range rather than an equality.
            check("  its left edge is on the main screen", -20 <= r.left < sw, True)
            check("  its top edge too", -20 <= r.top < sh, True)
            check("  it covers the width", (r.right - r.left) > sw * 0.9, True)
            check("  and the height", (r.bottom - r.top) > sh * 0.8, True)
            # The one that used to fail silently: Chrome renames its window a
            # moment after the page does, so a lookup at 0ms found nothing and
            # the window was left wherever Chrome had put it.
            check("  the lookup waits for the title", "wait_ms=3000" in
                  Path("notify.py").read_text(encoding="utf-8"), True)

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
