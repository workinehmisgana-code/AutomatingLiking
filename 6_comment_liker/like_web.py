#!/usr/bin/env python3
"""
Like comments on Instagram and YouTube.

TikTok has its own liker (like.py) because TikTok has a signed API: the browser
is only there to sign the request. Neither of these two offers that. YouTube's
Data API has no endpoint for liking a comment at all, and Instagram's is closed
to anything but approved apps — so both are done the way a person does it: find
the comment on the page, click its heart, then read the button back to confirm
it actually took.

WHAT IS SHARED WITH like.py, deliberately, by import rather than by copy:
  * which comments count      (wanted / the product list from the dashboard)
  * how text is matched       (norm — "Purify-Text" and "purifytext" are one)
  * the ledger and its rules  (same columns, same "clear the failures and retry
                               them on the next run" behaviour)
  * the sound + notification  (notify) when something needs a person

WHAT IS DIFFERENT, because the sites are:
  * a comment's identity. TikTok gives every comment a cid. YouTube does too, in
    the permalink (?lc=...). Instagram publishes none, so the ledger key there is
    a hash of the post, the author and the text — stable for as long as the
    comment is not edited, which is what "have I liked this already" needs.
  * verification. A click is not a like: the page can swallow it, or bounce it
    off a login wall. Both sites expose the button's own state (aria-pressed on
    YouTube, the Like/Unlike label on Instagram), so every like is read back
    before it is recorded as one. A click that did not change the state is
    written as a failure, not as a like.

SHORTS are a third page, handled separately and automatically — and they are the
majority of the YouTube links here (1,211 of 2,080 in the scraper's results).
A Short shows NO comments at all until its panel is opened, so a run that simply
scrolled would report every Short as having nothing to like. Once the panel is
open it is an ordinary comment list, so the same collector and the same verified
like button do the rest. Two things differ and both matter:
  * the panel has to be opened first (a comment button, not a scroll)
  * the panel is scrolled, NEVER the window. A wheel event on a Short moves to
    the NEXT short, which would carry on liking comments while believing it was
    still on the link it was given.

Sign in once per site first:
    python login.py --site instagram
    python login.py --site youtube

Then:
    python like_web.py --site youtube --links yt.txt --products
    python like_web.py --site instagram --from-dashboard --platform instagram --clusters 1
    python like_web.py --site youtube --from-dashboard --platform youtube --dry-run
    python like_web.py --site youtube --links shorts.txt --products   # shorts too
    python like_web.py --site instagram --probe --links one.txt   # what does it SEE?

Ledgers are per site and per account: done-yt.csv, done-ig.csv,
done-yt-<profile>.csv, done-ig-<profile>.csv.
"""
import argparse
import csv
import hashlib
import random
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

import notify
from like import (
    COLUMNS,
    NORM_PRODUCTS,
    from_dashboard,
    norm,
    purge_failures,
    read_links,
    report_purge,
    wanted,
)
from login import SITE_PREFIX, profile_dir, signed_in_instagram, signed_in_youtube

HERE = Path(__file__).resolve().parent
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

LEDGER_PREFIX = {"instagram": "done-ig", "youtube": "done-yt"}


def ledger_path(site: str, profile: str) -> Path:
    """One ledger per site per account.

    Same reasoning as like.py's: separate files cannot interleave each other's
    appends, and "already liked" is a fact about an ACCOUNT, not about a comment.
    """
    prefix = LEDGER_PREFIX[site]
    return HERE / (f"{prefix}.csv" if profile == "default" else f"{prefix}-{profile}.csv")


def load_done(path: Path) -> set[str]:
    if not path.exists():
        return set()
    with path.open(encoding="utf-8") as f:
        return {row["cid"] for row in csv.DictReader(f) if row.get("cid")}


def open_ledger(path: Path):
    fresh = not path.exists() or path.stat().st_size == 0
    f = path.open("a", newline="", encoding="utf-8")
    w = csv.writer(f)
    if fresh:
        w.writerow(COLUMNS)
        f.flush()
    return f, w


def fallback_key(post: str, user: str, text: str) -> str:
    """A comment's identity when the site does not publish one.

    Instagram exposes no comment id in the page at all. The author plus the text
    plus the post is what makes a comment that comment, so it is hashed into a
    short stable key. Text is normalised the same way matching normalises it, so
    a stray emoji or a changed space does not make an old comment look new.
    """
    raw = f"{post}|{user.lower()}|{norm(text)[:200]}"
    return "h" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


# ── YouTube ──────────────────────────────────────────────────────────────────
# Verified against a live watch page (probe_web_comments.py):
#   thread : ytd-comment-thread-renderer
#   author : #author-text        -> "@handle", href "/@handle"
#   text   : #content-text
#   like   : #like-button button -> aria-pressed "false"/"true",
#            aria-label "Like this comment along with 4K other people"
# aria-pressed is the whole reason YouTube is the easy one: the button says
# whether it is on, so a like can be confirmed rather than assumed.
YT_COLLECT = """() => {
  const out = [];
  document.querySelectorAll('ytd-comment-thread-renderer').forEach((t, i) => {
    const a = t.querySelector('#author-text');
    const body = t.querySelector('#content-text');
    const btn = t.querySelector('#like-button button');
    let id = '';
    for (const link of t.querySelectorAll('a[href*="lc="]')) {
      const m = (link.getAttribute('href') || '').match(/[?&]lc=([^&]+)/);
      if (m) { id = decodeURIComponent(m[1]); break; }
    }
    out.push({
      idx: i,
      id,
      user: (a?.textContent || '').trim().replace(/^@/, '').toLowerCase(),
      text: (body?.innerText || '').trim(),
      liked: btn?.getAttribute('aria-pressed') === 'true',
      likeable: !!btn,
    });
  });
  return out;
}"""

YT_LIKE = """(i) => {
  const t = document.querySelectorAll('ytd-comment-thread-renderer')[i];
  if (!t) return {ok: false, why: 'thread vanished'};
  const btn = t.querySelector('#like-button button');
  if (!btn) return {ok: false, why: 'no like button'};
  if (btn.getAttribute('aria-pressed') === 'true') return {ok: true, already: true};
  btn.scrollIntoView({block: 'center'});
  btn.click();
  return {ok: true, already: false};
}"""

YT_STATE = """(i) => {
  const t = document.querySelectorAll('ytd-comment-thread-renderer')[i];
  const btn = t?.querySelector('#like-button button');
  return btn ? btn.getAttribute('aria-pressed') === 'true' : null;
}"""

# ── Instagram ────────────────────────────────────────────────────────────────
# Instagram ships no stable ids or class names, so a comment is found by shape:
# a control labelled Like/Unlike, and the nearest ancestor that also holds a
# profile link. The label lives on an <svg> inside a div[role=button] as often
# as on the button itself, so both are looked at.
IG_COLLECT = """() => {
  const norm = (s) => (s || '').trim();
  const labelOf = (el) => {
    const own = norm(el.getAttribute('aria-label'));
    if (own) return own;
    const svg = el.querySelector('svg[aria-label]');
    return svg ? norm(svg.getAttribute('aria-label')) : '';
  };
  const controls = [...document.querySelectorAll('[role="button"], button')]
    .map((el) => ({el, label: labelOf(el)}))
    .filter((c) => /^(like|unlike)$/i.test(c.label));

  const out = [];
  const seen = new Set();
  controls.forEach((c, i) => {
    // Walk up to the block that also carries a profile link — that block is the
    // comment. Bounded, or a failed match walks all the way to <body> and calls
    // the whole page one comment.
    let node = c.el, hops = 0, link = null;
    while (node && hops++ < 10) {
      node = node.parentElement;
      if (!node) break;
      link = node.querySelector('a[href^="/"]:not([href*="/p/"]):not([href*="/reel/"])');
      if (link && (node.innerText || '').trim().length > 1) break;
    }
    if (!node || !link) return;
    const user = (link.getAttribute('href') || '').replace(/\\//g, '').toLowerCase();
    // The block's text is "user\\ntext\\n2d\\n12 likes\\nReply"; the comment is
    // what sits between the author and the age.
    const lines = (node.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const body = lines.filter((l) => l.toLowerCase() !== user
      && !/^\\d+\\s*(likes?|repl(y|ies))$/i.test(l)
      && !/^(reply|see translation|view replies.*|hide replies|\\d+[smhdw])$/i.test(l)
      && !/^\\d+\\s*(second|minute|hour|day|week)s?( ago)?$/i.test(l)).join(' ');
    const key = user + '|' + body.slice(0, 80);
    if (!user || seen.has(key)) return;
    seen.add(key);
    out.push({idx: i, id: '', user, text: body,
              liked: /^unlike$/i.test(c.label), likeable: true});
  });
  return out;
}"""

IG_LIKE = """(i) => {
  const labelOf = (el) => {
    const own = (el.getAttribute('aria-label') || '').trim();
    if (own) return own;
    const svg = el.querySelector('svg[aria-label]');
    return svg ? (svg.getAttribute('aria-label') || '').trim() : '';
  };
  const controls = [...document.querySelectorAll('[role="button"], button')]
    .filter((el) => /^(like|unlike)$/i.test(labelOf(el)));
  const el = controls[i];
  if (!el) return {ok: false, why: 'control vanished'};
  if (/^unlike$/i.test(labelOf(el))) return {ok: true, already: true};
  el.scrollIntoView({block: 'center'});
  el.click();
  return {ok: true, already: false};
}"""

IG_STATE = """(i) => {
  const labelOf = (el) => {
    const own = (el.getAttribute('aria-label') || '').trim();
    if (own) return own;
    const svg = el.querySelector('svg[aria-label]');
    return svg ? (svg.getAttribute('aria-label') || '').trim() : '';
  };
  const controls = [...document.querySelectorAll('[role="button"], button')]
    .filter((el) => /^(like|unlike)$/i.test(labelOf(el)));
  const el = controls[i];
  return el ? /^unlike$/i.test(labelOf(el)) : null;
}"""

SITES = {
    "youtube": {"collect": YT_COLLECT, "like": YT_LIKE, "state": YT_STATE,
                "signed_in": signed_in_youtube, "home": "https://www.youtube.com/"},
    "instagram": {"collect": IG_COLLECT, "like": IG_LIKE, "state": IG_STATE,
                  "signed_in": signed_in_instagram, "home": "https://www.instagram.com/"},
}


def is_shorts(url: str) -> bool:
    return "/shorts/" in (url or "").lower()


# The Shorts comment panel, once opened, is an ordinary comment list — the same
# ytd-comment-thread-renderer, #author-text, #content-text and #like-button that
# a watch page uses (verified with probe_shorts.py: 38 threads, every one with an
# aria-pressed like button). So Shorts need no separate collector. What they need
# is a separate way of getting the comments on screen at all.
SHORTS_OPEN = """() => {
  // Already open?
  const open = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
    .some((p) => (p.getAttribute('visibility') || '').includes('EXPANDED')
                 && p.querySelector('ytd-comment-thread-renderer'));
  if (open) return 'already open';
  const btn = document.querySelector(
    '#comments-button button, ytd-reel-player-overlay-renderer #comments-button button, '
    + 'button[aria-label*="Comment" i]');
  if (!btn) return 'no comment button';
  btn.click();
  return 'clicked';
}"""

# Scroll the PANEL, never the window. A wheel event on a Shorts page moves to the
# NEXT short — which would carry on liking comments while believing it was still
# on the link it was given, writing another video's comments into this one's row.
SHORTS_SCROLL = """() => {
  const panels = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
    .filter((p) => p.querySelector('ytd-comment-thread-renderer'));
  let best = null, area = 0;
  for (const p of panels) {
    for (const el of p.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 100) {
        const a = el.clientHeight * el.clientWidth;
        if (a > area) { area = a; best = el; }
      }
    }
  }
  if (!best) return false;
  best.scrollTop = best.scrollHeight;
  return true;
}"""


def load_comments(page, site: str, rounds: int, url: str = "") -> None:
    """Get as many comments onto the page as `rounds` allows."""
    if site == "youtube" and is_shorts(url):
        # A Short shows no comments until its panel is opened.
        state = page.evaluate(SHORTS_OPEN)
        if state == "no comment button":
            return
        page.wait_for_timeout(3000)
        for _ in range(max(1, rounds)):
            if not page.evaluate(SHORTS_SCROLL):
                break
            page.wait_for_timeout(1100)
        return
    if site == "youtube":
        # Comments are below the fold and render only when scrolled to.
        for _ in range(max(2, rounds)):
            page.mouse.wheel(0, 1600)
            page.wait_for_timeout(900)
        return
    # Instagram: a "load more" plus-button between batches, then scroll the panel.
    for _ in range(max(1, rounds)):
        try:
            more = page.query_selector(
                'svg[aria-label="Load more comments"], [aria-label="Load more comments"]'
            )
            if more:
                more.click()
                page.wait_for_timeout(1600)
                continue
        except Exception:
            pass
        page.evaluate(
            """() => {
              // The comment list is the tallest scrollable box on the page.
              let best = null, area = 0;
              for (const el of document.querySelectorAll('div, ul, section')) {
                if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 120) {
                  const a = el.clientHeight * el.clientWidth;
                  if (a > area) { area = a; best = el; }
                }
              }
              if (best) best.scrollTop = best.scrollHeight;
              else window.scrollTo(0, document.body.scrollHeight);
            }"""
        )
        page.wait_for_timeout(1200)


def post_key(site: str, url: str) -> str:
    if site == "instagram":
        m = re.search(r"instagram\.com/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)", url, re.I)
        return m.group(1) if m else url
    # A Short and a watch page are the same video with the same comments, so both
    # must reduce to the same key — otherwise the same comment counts as two.
    for pat in (r"[?&]v=([A-Za-z0-9_-]{6,})",
                r"youtube\.com/shorts/([A-Za-z0-9_-]{6,})",
                r"youtu\.be/([A-Za-z0-9_-]{6,})"):
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return url


def main() -> int:
    ap = argparse.ArgumentParser(description="Like Instagram / YouTube comments.")
    ap.add_argument("--site", required=True, choices=["instagram", "youtube"])
    ap.add_argument("urls", nargs="*", help="post/video URLs, inline")
    ap.add_argument("--links", type=Path, help="file of URLs (.txt or .csv)")
    ap.add_argument("--from-dashboard", action="store_true", help="pull links from the dashboard")
    ap.add_argument("--cluster-by", default="rank", choices=["rank", "date", "combined"])
    ap.add_argument("--clusters", default="", help="cluster numbers, e.g. 1,2 (blank = all)")
    ap.add_argument("--platform", default="", help="dashboard platform filter (defaults to --site)")
    ap.add_argument("--category", default="")
    ap.add_argument("--max-links", type=int, default=200)
    ap.add_argument("--products", action="store_true", help="like comments naming a product")
    ap.add_argument("--all-products", action="store_true", help="like every product, live list included")
    ap.add_argument("--users", default="", help="comma-separated handles whose comments to like")
    ap.add_argument("--all", action="store_true", help="like EVERY comment (careful)")
    ap.add_argument("--profile", default="default", help="which login.py profile to use")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many likes (0 = no cap)")
    ap.add_argument("--per-link", type=int, default=0, help="most likes per link (0 = no cap)")
    ap.add_argument("--rounds", type=int, default=4, help="comment-loading rounds per link")
    ap.add_argument("--delay", default="2,5", help="seconds between likes, 'min,max'")
    ap.add_argument("--link-delay", default="4,9", help="seconds between links, 'min,max'")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--dry-run", action="store_true", help="find targets, like nothing")
    ap.add_argument("--probe", action="store_true",
                    help="print every comment the page yields and stop — for checking selectors")
    ap.add_argument("--keep-failures", action="store_true",
                    help="leave failed rows in the ledger instead of retrying them")
    args = ap.parse_args()

    site = args.site
    users = {u.strip().lstrip("@").lower() for u in args.users.split(",") if u.strip()}
    if not (args.products or args.all_products or users or args.all or args.probe):
        print("Nothing selected. Pass --products, --all-products, --users or --all.")
        return 2

    # ── links ────────────────────────────────────────────────────────────────
    links = list(args.urls)
    products = list(NORM_PRODUCTS) if (args.products or args.all_products) else []
    if args.from_dashboard:
        pulled, live = from_dashboard(
            args.cluster_by, args.clusters,
            {"platform": args.platform or site, "category": args.category,
             "limit": str(args.max_links)},
        )
        links += pulled
        if args.all_products and live:
            # The dashboard's list is the live one; union so a product added
            # there is liked without editing this file.
            products = sorted(set(products) | {norm(p) for p in live})
    if args.links:
        links += read_links(args.links)
    links = list(dict.fromkeys(l for l in links if l.strip()))
    if not links:
        print("No links. Pass URLs, --links or --from-dashboard.")
        return 2

    ledger = ledger_path(site, args.profile)
    if not args.keep_failures and not args.dry_run and not args.probe:
        line = report_purge(purge_failures(ledger), ledger.name)
        if line:
            print(line)
    done = load_done(ledger)

    pdir = profile_dir(args.profile, site)
    if not (pdir / "Default").exists():
        print(f"No {site} session at {pdir}.\n"
              f"Run: python login.py --site {site}"
              + ("" if args.profile == "default" else f" --profile {args.profile}"))
        return 1

    try:
        lo, hi = (float(x) for x in args.delay.split(","))
        llo, lhi = (float(x) for x in args.link_delay.split(","))
    except ValueError:
        print("--delay / --link-delay want 'min,max'")
        return 2

    print(f"{len(links)} link(s) on {site}. {len(done)} comment(s) already done. "
          f"Ledger: {ledger.name}")
    if products:
        print(f"liking comments that name: {', '.join(products)}")

    S = SITES[site]
    ok = failed = 0
    seen_login_wall = False

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(pdir),
            headless=not args.headed and not args.probe,
            channel="chrome",
            user_agent=UA,
            locale="en-US",
            viewport={"width": 1280, "height": 950},
            args=["--disable-blink-features=AutomationControlled", "--no-first-run",
                  "--no-default-browser-check"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        f = w = None
        if not args.dry_run and not args.probe:
            f, w = open_ledger(ledger)

        def record(url, key, c, status, note):
            if w is None:
                return
            w.writerow([time.strftime("%Y-%m-%dT%H:%M:%S"), url, post_key(site, url),
                        key, c["user"], c["text"][:200], status, note[:120]])
            f.flush()

        try:
            # One session check up front. A run against a signed-out profile
            # would otherwise "work" — every click bouncing off a login wall and
            # every comment recorded as a failure.
            page.goto(S["home"], wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(4000)
            live, who = S["signed_in"](page)
            if not live:
                print(f"Not signed in to {site} ({who}).")
                notify.toast(f"{site}: not signed in",
                             f"Run: python login.py --site {site}")
                notify.sound()
                return 1
            print(f"signed in as {who}")

            for i, url in enumerate(links, 1):
                if args.limit and ok >= args.limit:
                    print(f"reached --limit {args.limit}")
                    break
                print(f"[{i}/{len(links)}] {url}")
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=45000)
                except PWTimeout:
                    print("    · page did not load")
                    continue
                page.wait_for_timeout(2500)
                load_comments(page, site, args.rounds, url)

                try:
                    comments = page.evaluate(S["collect"]) or []
                except Exception as e:  # noqa: BLE001
                    print(f"    · could not read comments: {str(e)[:80]}")
                    continue

                if args.probe:
                    print(f"    {len(comments)} comment(s) visible:")
                    for c in comments[:25]:
                        flag = "liked" if c["liked"] else ("likeable" if c["likeable"] else "NO BUTTON")
                        print(f"      @{c['user'][:22]:<22} [{flag:<8}] {c['text'][:60]}")
                    if not comments:
                        print("      (none — the page may be signed out, or the "
                              "selectors need updating)")
                    continue

                if not comments and not seen_login_wall:
                    # Zero comments on the first link is the signature of a wall.
                    seen_login_wall = True
                    print("    · no comments visible at all — check the session with "
                          f"`python login.py --site {site} --check`")

                picks = [c for c in comments if wanted(c, products, users, args.all)]
                todo = [c for c in picks
                        if not c["liked"]
                        and (c["id"] or fallback_key(post_key(site, url), c["user"], c["text"]))
                        not in done]
                print(f"    {len(comments)} comment(s), {len(picks)} match, {len(todo)} to like")

                if args.dry_run:
                    for c in todo:
                        print(f"      @{c['user']:<20} {c['text'][:60]}")
                    continue

                liked_here = 0
                for c in todo:
                    if args.limit and ok >= args.limit:
                        break
                    if args.per_link and liked_here >= args.per_link:
                        break
                    key = c["id"] or fallback_key(post_key(site, url), c["user"], c["text"])
                    try:
                        res = page.evaluate(S["like"], c["idx"])
                    except Exception as e:  # noqa: BLE001
                        failed += 1
                        record(url, key, c, "fail:click", str(e)[:100])
                        continue
                    if not res.get("ok"):
                        failed += 1
                        record(url, key, c, "fail:dom", res.get("why", ""))
                        continue
                    if res.get("already"):
                        ok += 1
                        done.add(key)
                        record(url, key, c, "ok", "already liked before this run")
                        continue

                    # A click is not a like. Read the button back.
                    page.wait_for_timeout(900)
                    try:
                        now = page.evaluate(S["state"], c["idx"])
                    except Exception:  # noqa: BLE001
                        now = None
                    if now is True:
                        ok += 1
                        liked_here += 1
                        done.add(key)
                        record(url, key, c, "ok", "verified")
                        print(f"      liked @{c['user']}: {c['text'][:50]}")
                    else:
                        failed += 1
                        record(url, key, c, "fail:noverify",
                               "clicked but the button did not switch")
                    time.sleep(random.uniform(lo, hi))

                    # Three failures and nothing liked means the run is broken,
                    # not the comments — stop rather than spend an account on it.
                    if ok == 0 and failed >= 3:
                        print("\nFirst three likes all failed — stopping. "
                              f"Check {ledger.name}, and the session.")
                        notify.toast(f"{site} liker stopped",
                                     "three failures and no likes — needs a look")
                        notify.sound()
                        return 1

                time.sleep(random.uniform(llo, lhi))
        finally:
            if f is not None:
                f.close()
            ctx.close()

    if args.probe:
        return 0
    print(f"\n{ok} liked, {failed} failed. Ledger: {ledger}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
