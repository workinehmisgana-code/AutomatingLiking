"""Where does Instagram keep a reel's view count in the profile feed JSON?

The scrape came back with view_count 0 on every row, which is either "Instagram
does not send it" or "it is under a name we do not read". This dumps every
count-ish field of a real post node so the difference is visible.

    python probe_ig_counts.py [handle]
"""
import json, os, re, sys, time
from pathlib import Path
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
import scrape_channels as sc

load_dotenv()
HANDLE = (sys.argv[1] if len(sys.argv) > 1 else "mavgpt").lstrip("@")
PROFILE = Path(os.getenv("BROWSER_PROFILE_DIR", "./browser_profile")).resolve()
nodes = []

def note(resp):
    if "/graphql/query" not in resp.url or nodes:
        return
    try:
        data = json.loads(resp.body().decode("utf-8", "replace"))
    except Exception:
        return
    sc._ig_media_nodes(data, nodes)

with sync_playwright() as pw:
    ctx = pw.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE), headless=False, channel="chrome",
        args=["--disable-blink-features=AutomationControlled", "--no-first-run"],
        viewport={"width": 1280, "height": 900}, locale="en-US")
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on("response", note)
    page.goto(f"https://www.instagram.com/{HANDLE}/", wait_until="domcontentloaded", timeout=60000)
    for _ in range(6):
        if nodes:
            break
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(3)
    ctx.close()

print(f"{len(nodes)} node(s)")
for n in nodes[:3]:
    print("\n=== ", n.get("code"), n.get("media_type"), n.get("__typename"))
    flat = {}
    def walk(o, p=""):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v, f"{p}.{k}" if p else k)
        elif isinstance(o, list):
            for i, v in enumerate(o[:2]):
                walk(v, f"{p}[{i}]")
        else:
            if re.search(r"count|view|play|watch", p, re.I) and isinstance(o, (int, float)):
                flat[p] = o
    walk(n)
    for k, v in sorted(flat.items()):
        print(f"    {k} = {v}")
