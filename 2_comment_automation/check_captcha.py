#!/usr/bin/env python3
"""
Is Gemini actually reading Zefoy's captcha?

The solver has always been there — CAPTCHA_MODE=auto sends the captcha image to
Gemini and submits the word it reads. What was missing was any way to find out
whether it WORKS without starting a real run, watching a browser open, and
waiting for a captcha to appear. So a key that was wrong, or a model name that no
longer exists, looked identical to "the AI is just bad at this": eight failed
attempts and a fall back to typing it yourself.

This answers the three questions separately, so a failure names itself.

    python check_captcha.py                 # is it configured, and which models exist?
    python check_captcha.py --live          # fetch a real captcha and read it
    python check_captcha.py --live --solve  # ...and submit it, to prove the whole path
    python check_captcha.py --image captcha-dump/ai-gaveup-20261001-...png

--live opens a browser; the others do not. Nothing here hearts anything.
"""
import argparse
import io
import sys
from pathlib import Path

import automate as a

HERE = Path(__file__).resolve().parent


def show_config() -> bool:
    """Print what is configured. True when auto mode could run at all."""
    key = a.GEMINI_API_KEY
    print("configuration")
    print(f"   CAPTCHA_MODE   {a.CAPTCHA_MODE}")
    print(f"   GEMINI_MODEL   {a.GEMINI_MODEL}")
    print(f"   GEMINI_API_KEY {'set (' + str(len(key)) + ' chars)' if key else 'EMPTY'}")
    if not key:
        print("\n   The AI solver cannot run: there is no key. Put one in .env:")
        print("     GEMINI_API_KEY=...")
        print("     CAPTCHA_MODE=auto")
        print("   Get one at https://aistudio.google.com/apikey")
        return False
    if a.CAPTCHA_MODE != "auto":
        print(f"\n   A key is set but CAPTCHA_MODE is '{a.CAPTCHA_MODE}', so runs will")
        print("   still ask you to type the word. Set CAPTCHA_MODE=auto in .env.")
        print("   (The checks below run regardless.)")
    return True


def list_models() -> None:
    """Which models this key can actually call.

    Worth asking rather than assuming: a model name that has been retired comes
    back as an ordinary HTTP error from generateContent, which reads like a
    network problem rather than a configuration one.
    """
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models"
        f"?key={a.GEMINI_API_KEY}&pageSize=200"
    )
    try:
        r = a._requests.get(url, timeout=20)
    except Exception as e:  # noqa: BLE001
        print(f"\n   Could not reach Google: {e}")
        return
    if r.status_code != 200:
        try:
            msg = (r.json().get("error") or {}).get("message") or r.text[:200]
        except ValueError:
            msg = r.text[:200]
        print(f"\n   The key was refused — HTTP {r.status_code}: {msg}")
        return
    names = []
    for m in r.json().get("models") or []:
        if "generateContent" not in (m.get("supportedGenerationMethods") or []):
            continue
        names.append(str(m.get("name") or "").replace("models/", ""))
    print(f"\nmodels this key can call ({len(names)} support generateContent)")
    # Flash models first: they are the cheap, fast ones, which is what reading
    # one short word off a picture wants.
    flash = sorted(n for n in names if "flash" in n)
    for n in flash[:12]:
        mark = "  <- GEMINI_MODEL" if n == a.GEMINI_MODEL else ""
        print(f"   {n}{mark}")
    if a.GEMINI_MODEL in names:
        print(f"\n   '{a.GEMINI_MODEL}' is available.")
    else:
        print(f"\n   '{a.GEMINI_MODEL}' is NOT in the list — that is why solving fails.")
        if flash:
            print(f"   Try: GEMINI_MODEL={flash[0]}")


def read_image(path: Path) -> None:
    """Read one saved captcha image, and say what the model made of it."""
    if not path.exists():
        print(f"\n   No such image: {path}")
        return
    print(f"\nreading {path.name}")
    try:
        word = a._gemini_read_captcha(path.read_bytes())
    except Exception as e:  # noqa: BLE001
        print(f"   FAILED: {e}")
        return
    print(f"   Gemini read: '{word}'" if word else
          "   Gemini could not read it (answered 'unknown')")


def live(solve: bool, headed: bool) -> None:
    """Open Zefoy, photograph the real captcha, and read it.

    The image is always kept under captcha-dump/, whether the read works or not:
    with the picture on disk the prompt and the model can be tuned against the
    exact thing that defeated them.
    """
    from playwright.sync_api import sync_playwright

    print("\nopening Zefoy for a real captcha…")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed, args=a.BROWSER_ARGS)
        ctx = browser.new_context(
            user_agent=a.USER_AGENT,
            viewport={"width": a.VIEWPORT_WIDTH, "height": a.VIEWPORT_HEIGHT},
        )
        page = ctx.new_page()
        try:
            page.goto("https://zefoy.com", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_selector(a._CAPTCHA_SEL, timeout=30000)
            # The picture, not the placeholder it carries for the first second
            # and a half. See wait_for_captcha_image.
            if not a.wait_for_captcha_image(page):
                print("   the captcha image never rendered")
                return
            img = page.locator(a._CAPTCHA_SEL).screenshot()
            kept = a.dump_captcha(img, "check")
            print(f"   captcha image: {kept}" if kept else "   (could not save the image)")
            try:
                word = a._gemini_read_captcha(img)
            except Exception as e:  # noqa: BLE001
                print(f"   FAILED: {e}")
                return
            if not word:
                print("   Gemini could not read it (answered 'unknown')")
                return
            print(f"   Gemini read: '{word}'")
            if not solve:
                print("   (not submitted — pass --solve to try it for real)")
                return
            ok = a._captcha_submit_word(page, word, "[check]")
            print("   SUBMITTED and accepted — the whole path works." if ok else
                  "   Submitted and rejected. The word was wrong, or the box moved; "
                  "the image is in captcha-dump/ to look at.")
        except Exception as e:  # noqa: BLE001
            print(f"   Could not get a captcha: {e}")
        finally:
            ctx.close()
            browser.close()


def hidden_page() -> int:
    """A tab nobody is looking at is not a captcha that is hard.

    Chrome does not paint a background tab, and on Android that includes every
    tab while the phone sits on its lock screen. The image never decodes, so the
    picture never arrives — and the run read that as "captcha image never
    rendered", refreshed, and did it again, eight times, before asking the
    terminal for a word that only the phone's screen could show.

    No browser is opened here: the helpers are driven against a fake page.
    """
    fails = 0

    def check(name, got, want):
        nonlocal fails
        ok = got == want
        if not ok:
            fails += 1
        print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}"
              + ("" if ok else f" (want {want!r})"))

    class Page:
        def __init__(self, states):
            self.states = list(states)
            self.slept = 0

        def evaluate(self, js):
            return self.states.pop(0) if self.states else "visible"

        def wait_for_timeout(self, ms):
            self.slept += ms

    class Dead:
        def evaluate(self, js):
            raise RuntimeError("Target page, context or browser has been closed")

        def wait_for_timeout(self, ms):
            pass

    print("\na hidden tab is named as hidden:")
    check("  visible", a.page_hidden(Page(["visible"])), False)
    check("  backgrounded", a.page_hidden(Page(["hidden"])), True)
    check("  prerendering", a.page_hidden(Page(["prerender"])), True)
    # A dead connection is BrowserGone's business. Answering True here would
    # relabel every dropped adb forward as "please unlock your phone".
    check("  a dead page is not called hidden", a.page_hidden(Dead()), False)

    print("\nit waits for the page instead of spending captcha attempts:")
    pg = Page(["hidden"] * 3 + ["visible"])
    check("  returns once visible", a.wait_until_visible(pg, seconds=60, every=5), True)
    check("  having waited for it", pg.slept, 20000)
    pg = Page(["hidden"] * 100)
    check("  gives up after the budget", a.wait_until_visible(pg, seconds=20, every=5), False)
    check("  without waiting longer than it", pg.slept, 20000)

    src = io.open(HERE / "automate.py", encoding="utf-8").read()
    print("\nand the captcha loop acts on it:")
    check("  a hidden page is not refreshed", "if page_hidden(page):" in src, True)
    check("  the run stops rather than prompting into a void",
          "the page stayed hidden for three minutes" in src, True)
    check("  with the unlock instruction over --cdp",
          "Unlock the phone and bring Chrome" in src, True)

    print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
    return 0 if fails == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--live", action="store_true",
                    help="open Zefoy, photograph the real captcha and read it")
    ap.add_argument("--solve", action="store_true",
                    help="with --live: submit the word, to prove the whole path")
    ap.add_argument("--headed", action="store_true",
                    help="with --live: show the browser window")
    ap.add_argument("--image", default="",
                    help="read one saved image instead (e.g. from captcha-dump/)")
    ap.add_argument("--models", action="store_true",
                    help="only list the models this key can call")
    args = ap.parse_args()

    if not show_config():
        return 2
    if args.models or not (args.live or args.image):
        list_models()
    if args.image:
        read_image(Path(args.image))
    if args.live:
        live(args.solve, args.headed)
    return hidden_page()


if __name__ == "__main__":
    sys.exit(main())
