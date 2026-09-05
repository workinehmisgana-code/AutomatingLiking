"""
Config Mode – Record your Zefoy session and save the selectors.

Run this once, interact with Zefoy manually in the browser window,
then follow the terminal prompts to label each action.

The result is saved to  zefoy_selectors.json
automate.py loads that file automatically on every future run.

Usage:
    python config_mode.py
"""

import json
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()

# ── JavaScript injected on every page load ────────────────────────────────────
# Listens for clicks and inputs, emits structured console messages.
RECORDER_JS = r"""
(function () {
    if (window.__recorderAttached) return;
    window.__recorderAttached = true;

    function bestSelector(el) {
        // Priority: data attributes → id → placeholder → button text → class
        for (const attr of ['data-e2e', 'data-testid', 'data-key']) {
            const v = el.getAttribute && el.getAttribute(attr);
            if (v) return `[${attr}="${v}"]`;
        }
        if (el.id) return '#' + el.id;
        if (el.placeholder) return `[placeholder="${el.placeholder}"]`;
        const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50);
        if (text && /^(BUTTON|A)$/i.test(el.tagName))
            return `${el.tagName.toLowerCase()}:has-text("${text}")`;
        if (el.name) return `[name="${el.name}"]`;
        const classes = Array.from(el.classList || []).slice(0, 4).join('.');
        return el.tagName.toLowerCase() + (classes ? '.' + classes : '');
    }

    function emit(obj) {
        console.log('__REC__:' + JSON.stringify(obj));
    }

    document.addEventListener('click', function (e) {
        // Walk up to find the most meaningful clickable ancestor
        let el = e.target;
        for (let i = 0; i < 4; i++) {
            if (!el || el === document.body) break;
            if (/^(BUTTON|A|INPUT|SELECT)$/i.test(el.tagName)) break;
            if (el.getAttribute && (el.getAttribute('role') === 'button' || el.onclick)) break;
            el = el.parentElement;
        }
        if (!el) el = e.target;
        emit({
            t: 'click',
            tag: el.tagName.toLowerCase(),
            sel: bestSelector(el),
            txt: (el.innerText || '').trim().slice(0, 80),
            cls: el.className || '',
            ph:  el.placeholder || '',
            ts:  Date.now(),
        });
    }, true);

    // Use 'change' so we capture the final typed value, not every keystroke
    document.addEventListener('change', function (e) {
        const el = e.target;
        emit({
            t:   'input',
            tag: el.tagName.toLowerCase(),
            sel: bestSelector(el),
            ph:  el.placeholder || '',
            val: el.value || '',
            ts:  Date.now(),
        });
    }, true);
})();
"""

# ── Automation steps that need a selector ─────────────────────────────────────
SLOTS = {
    "captcha_word_input": {
        "label": "Captcha word input",
        "hint":  "The text box where you TYPE the word shown in the captcha image",
        "default": 'input[placeholder="Enter the word"]',
    },
    "comments_hearts_btn": {
        "label": "Comments Hearts button",
        "hint":  "The card / arrow button that opens the Comments Hearts section",
        "default": 'div:has(> :text("Comments Hearts")) >> button',
    },
    "url_input": {
        "label": "Video URL input",
        "hint":  "The text box where you PASTE the TikTok video URL",
        "default": 'input[placeholder="Enter Video URL"]',
    },
    "search_btn": {
        "label": "Search button",
        "hint":  "The Search button next to the URL input",
        "default": 'button:has-text("Search")',
    },
    "count_btn": {
        "label": "Comment count button",
        "hint":  "The dark button showing the comment count (e.g. 🗨 8,417) after searching",
        "default": 'button.btn-dark',
    },
    "heart_btn": {
        "label": "Heart button",
        "hint":  "The blue heart / send button inside a comment card",
        "default": 'button.btn-primary',
    },
}


def format_event(idx: int, ev: dict) -> str:
    if ev["t"] == "click":
        detail = ev.get("txt") or ev.get("ph") or ev.get("cls") or ""
        detail = detail[:60]
        return f"  [{idx:>2}] CLICK   <{ev['tag']}>  sel={ev['sel']!r}  text={detail!r}"
    else:
        return (
            f"  [{idx:>2}] INPUT   <{ev['tag']}>  "
            f"placeholder={ev.get('ph')!r}  value={ev.get('val','')[:40]!r}"
        )


def run_config_mode():
    events: list[dict] = []

    def on_console(msg):
        if msg.text.startswith("__REC__:"):
            try:
                ev = json.loads(msg.text[len("__REC__:"):])
                events.append(ev)
                print(format_event(len(events), ev))
            except Exception:
                pass

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )

        # Inject recorder on EVERY page load (including after navigation)
        context.add_init_script(RECORDER_JS)

        page = context.new_page()
        page.on("console", on_console)

        print("=" * 65)
        print("  CONFIG MODE – Recording your Zefoy session")
        print("=" * 65)
        print("  Every click and input you make will appear below.")
        print("  Go through the full flow:")
        print("    1. Solve the captcha word puzzle")
        print("    2. Click Comments Hearts")
        print("    3. Paste a video URL and click Search")
        print("    4. Click the dark comment-count button")
        print("    5. Click a blue heart button on any comment")
        print()
        print("  When you are done, close the browser window.")
        print("=" * 65 + "\n")

        page.goto("https://zefoy.com", wait_until="domcontentloaded", timeout=30000)

        # Keep running until the browser is closed by the user
        try:
            while context.pages:
                page.wait_for_timeout(300)
        except Exception:
            pass

        context.close()
        browser.close()

    # ── Save raw session ──────────────────────────────────────────────────────
    raw_path = Path("recorded_session.json")
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)
    print(f"\n[+] Raw session saved → '{raw_path}'  ({len(events)} events)\n")

    if not events:
        print("[!] No events were recorded. Did the browser open correctly?")
        return

    # ── Show summary ──────────────────────────────────────────────────────────
    print("=" * 65)
    print("  RECORDED EVENTS")
    print("=" * 65)
    for i, ev in enumerate(events, 1):
        print(format_event(i, ev))
    print()

    # ── Interactive labeling ──────────────────────────────────────────────────
    print("=" * 65)
    print("  LABEL THE EVENTS")
    print("  For each automation step, enter the event number above.")
    print("  Press Enter to keep the default selector.")
    print("=" * 65 + "\n")

    saved_selectors: dict[str, str] = {}

    for slot_key, slot in SLOTS.items():
        print(f"  Step : {slot['label']}")
        print(f"  Hint : {slot['hint']}")
        print(f"  Default selector : {slot['default']}")
        raw = input("  Event # (or blank to keep default): ").strip()

        if raw.isdigit():
            idx = int(raw)
            if 1 <= idx <= len(events):
                ev = events[idx - 1]
                chosen_sel = ev["sel"]
                saved_selectors[slot_key] = chosen_sel
                print(f"  → Saved selector: {chosen_sel!r}\n")
            else:
                print(f"  [!] Event #{idx} not found – keeping default.\n")
                saved_selectors[slot_key] = slot["default"]
        else:
            saved_selectors[slot_key] = slot["default"]
            print(f"  → Keeping default: {slot['default']!r}\n")

    # ── Save selectors file ───────────────────────────────────────────────────
    output = {
        "_recorded_at": datetime.now().isoformat(),
        "_note": "Edit selectors manually if needed. Delete this file to reset to defaults.",
        **saved_selectors,
    }
    sel_path = Path("zefoy_selectors.json")
    with open(sel_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print("=" * 65)
    print(f"  Selectors saved → '{sel_path}'")
    print("  Run  python automate.py  to use them.")
    print("=" * 65)


if __name__ == "__main__":
    run_config_mode()
