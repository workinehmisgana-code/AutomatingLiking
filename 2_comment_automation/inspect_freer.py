"""
Diagnostic: walk through the full Freer (nreer.com) Comment Hearts flow
and dump actual DOM HTML at every step so selectors can be verified.

Run:  python inspect_freer.py
You handle the captcha; the script handles everything else once elements appear.
"""

import asyncio, re, sys, time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

asyncio.set_event_loop(asyncio.new_event_loop())

TIMEOUT = 300_000  # 5 min per wait
TIKTOK_URL = sys.argv[1] if len(sys.argv) > 1 else ""

def dump(label, html):
    print(f"\n{'─' * 60}")
    print(f"  [{label}]")
    print(html[:2000])
    if len(html) > 2000:
        print(f"  ... (truncated, total {len(html)} chars)")
    print('─' * 60)

def pause(msg):
    print(f"\n>>> {msg}")
    print("    (waiting up to 5 minutes for this to appear automatically...)")

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

    # ── Step 1: Load site ────────────────────────────────────────────────────
    print("\n[1/7] Opening nreer.com ...")
    page.goto("https://nreer.com", wait_until="commit", timeout=30000)
    time.sleep(2)

    # ── Step 2: Captcha ──────────────────────────────────────────────────────
    pause("[2/7] CAPTCHA — solve it in the browser (type word + submit).")
    try:
        page.wait_for_selector("form#cat", state="visible", timeout=10000)
        dump("Captcha form HTML", page.locator("form#cat").first.evaluate("el => el.outerHTML"))
        page.wait_for_selector("form#cat", state="hidden", timeout=TIMEOUT)
        print("[+] Captcha gone.")
    except PWTimeout:
        print("[~] No captcha detected — continuing.")
    time.sleep(2)

    # ── Step 3: Timer after captcha ──────────────────────────────────────────
    try:
        el = page.locator("[data-clock='main_timer']").first
        if el.is_visible(timeout=3000):
            dump("Post-captcha timer HTML", el.evaluate("el => el.outerHTML"))
            dt = el.get_attribute("data-time") or "?"
            print(f"[!] Timer showing – data-time={dt}s. Waiting it out...")
            page.wait_for_selector("[data-clock='main_timer']", state="hidden", timeout=TIMEOUT)
            print("[+] Timer gone.")
    except Exception:
        print("[~] No post-captcha timer.")
    time.sleep(2)

    # ── Step 4: Dashboard — Comment Hearts Use button ────────────────────────
    pause("[4/7] Dashboard — looking for 'Comment Hearts' Use button...")
    try:
        btn = page.locator("button[onclick*='tok_free']").filter(has_text="Use").first
        btn.wait_for(state="visible", timeout=TIMEOUT)
        dump("Use button HTML", btn.evaluate("el => el.outerHTML"))
        # Also dump all sibling service buttons
        all_btns = page.locator("button[onclick*='tok_free']").all()
        print(f"\n  All service buttons ({len(all_btns)}):")
        for i, b in enumerate(all_btns):
            print(f"    #{i}: {b.evaluate('el => el.outerHTML')[:200]}")
        btn.click()
        print("[+] Clicked Use.")
        time.sleep(2)
    except PWTimeout:
        print("[!] Use button not found in 5 min.")

    # ── Step 5: URL input form ───────────────────────────────────────────────
    pause("[5/7] URL form — paste a TikTok URL and click Submit in the browser.")
    try:
        page.wait_for_selector("form#form1", state="visible", timeout=TIMEOUT)
        dump("URL form HTML", page.locator("form#form1").first.evaluate("el => el.outerHTML"))
    except PWTimeout:
        print("[!] form#form1 not found.")

    url = TIKTOK_URL
    if url:
        try:
            page.locator("form#form1 input[type='search']").first.fill(url)
            time.sleep(0.5)
            page.locator("form#form1 button[type='submit']").first.click()
            print(f"[+] URL submitted: {url}")
        except Exception as e:
            print(f"[!] Could not submit URL automatically: {e}")
    else:
        print("[!] No URL provided. Pass one as: python inspect_freer.py <tiktok_url>")
    time.sleep(3)

    # ── Step 6: Video info / comment button ──────────────────────────────────
    pause("[6/7] Looking for video info & comment buttons...")
    try:
        page.wait_for_selector("button[data-type='com_op']", state="visible", timeout=TIMEOUT)
        dump("com_op button HTML", page.locator("button[data-type='com_op']").first.evaluate("el => el.outerHTML"))
        # Dump all data-type buttons
        all_dt = page.locator("button[data-type]").all()
        print(f"\n  All data-type buttons ({len(all_dt)}):")
        for b in all_dt:
            print(f"    {b.evaluate('el => el.outerHTML')[:300]}")
    except PWTimeout:
        print("[!] button[data-type='com_op'] not found.")

    # Show comments button
    try:
        page.locator("button[data-type='com_op']").first.click()
        time.sleep(2)
        page.wait_for_selector("button[onclick*='show_comments']", state="visible", timeout=10000)
        dump("show_comments button HTML", page.locator("button[onclick*='show_comments']").first.evaluate("el => el.outerHTML"))
        page.locator("button[onclick*='show_comments']").first.click()
        print("[+] Clicked show_comments.")
        time.sleep(3)
    except Exception as e:
        print(f"[!] show_comments step: {e}")

    # ── Step 7: Comment rows ─────────────────────────────────────────────────
    pause("[7/7] Looking for comment rows (.input-group.mb-1)...")
    try:
        page.wait_for_selector(".input-group.mb-1", state="visible", timeout=TIMEOUT)
        rows = page.locator(".input-group.mb-1").all()
        print(f"\n  Found {len(rows)} comment row(s). Dumping first 3:")
        for i, row in enumerate(rows[:3]):
            dump(f"Comment row #{i+1}", row.evaluate("el => el.outerHTML"))

        # Heart button details
        print("\n  Heart button details (first 5 rows):")
        for i, row in enumerate(rows[:5]):
            try:
                hb = row.locator("button.btn-info").first
                onclick = hb.get_attribute("onclick") or ""
                small = hb.locator("small").first.inner_text().strip()
                ctext = row.locator("p small").first.inner_text().strip()[:60]
                print(f"    Row {i+1}: hearts={small!r}  onclick={onclick!r}  text={ctext!r}")
            except Exception as e:
                print(f"    Row {i+1}: error – {e}")

        # Pagination
        try:
            next_li = page.locator("li[title='next']").first
            dump("Pagination next button HTML", next_li.evaluate("el => el.outerHTML"))
        except Exception:
            print("\n  [~] No pagination next button found.")

    except PWTimeout:
        print("[!] .input-group.mb-1 not found in 5 min.")

    # ── Bonus: click heart on first row and dump success modal ───────────────
    if True:  # auto-click first heart
        try:
            rows = page.locator(".input-group.mb-1").all()
            if rows:
                hb = rows[0].locator("button.btn-info").first
                onclick = hb.get_attribute("onclick") or ""
                m = re.match(r"zxndnnndje\('(.+)'\)", onclick)
                if m:
                    page.evaluate(f"zxndnnndje('{m.group(1)}')")
                else:
                    hb.click()
                time.sleep(3)

                # Success modal
                try:
                    modal = page.locator(".modal.show .modal-body").first
                    if modal.is_visible(timeout=5000):
                        dump("Success modal HTML", modal.evaluate("el => el.outerHTML"))
                except Exception:
                    print("[~] No success modal found.")

                # Timer after sending
                try:
                    el = page.locator("[data-clock='main_timer']").first
                    if el.is_visible(timeout=3000):
                        dump("Post-send timer HTML", el.evaluate("el => el.outerHTML"))
                        dt = el.get_attribute("data-time") or "?"
                        print(f"[!] Timer: data-time={dt}s")
                except Exception:
                    print("[~] No post-send timer.")
        except Exception as e:
            print(f"[!] Heart click step: {e}")

    print("\n\n[DONE] All steps complete. Review the output above.")
    time.sleep(5)
    browser.close()
