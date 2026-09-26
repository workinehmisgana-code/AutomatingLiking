"""Does the Instagram/YouTube liker read pages and keep books correctly?

Two halves.

OFFLINE — identity and bookkeeping. The thing that must never break is "have I
liked this already": the ledger key. Get it wrong one way and the same comment
is liked twice a week forever; wrong the other way and every comment looks new
after a page re-render.

LIVE (--live) — the YouTube collector, against a real watch page. Selectors are
the part that cannot be unit-tested into correctness: YouTube changes its DOM,
and a collector that silently returns nothing looks exactly like a video with no
comments. Nothing is clicked; the page is only read.

    python check_like_web.py
    python check_like_web.py --live
"""
import sys
import tempfile
from pathlib import Path

import like_web as lw
from like import wanted

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


print("which post is this?")
check("an instagram post", lw.post_key("instagram", "https://www.instagram.com/p/DVEWskvj24R/"),
      "DVEWskvj24R")
check("an instagram reel", lw.post_key("instagram", "https://www.instagram.com/reel/DVEWskvj24R/"),
      "DVEWskvj24R")
check("a youtube watch url", lw.post_key("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      "dQw4w9WgXcQ")
check("a youtube url with other params",
      lw.post_key("youtube", "https://www.youtube.com/watch?list=X&v=dQw4w9WgXcQ&t=3"),
      "dQw4w9WgXcQ")
check("a youtu.be short link", lw.post_key("youtube", "https://youtu.be/dQw4w9WgXcQ"),
      "dQw4w9WgXcQ")
# A Short and a watch page are the same video with the same comments, so they
# must reduce to the same key or one comment would count as two.
check("a shorts link", lw.post_key("youtube", "https://www.youtube.com/shorts/-45WzxMDoWs"),
      "-45WzxMDoWs")
check("shorts and watch agree on the same video",
      lw.post_key("youtube", "https://www.youtube.com/shorts/-45WzxMDoWs")
      == lw.post_key("youtube", "https://www.youtube.com/watch?v=-45WzxMDoWs"), True)
check("a shorts link is recognised", lw.is_shorts("https://www.youtube.com/shorts/abc"), True)
check("a watch link is not", lw.is_shorts("https://www.youtube.com/watch?v=abc"), False)

print("\nhas this comment been liked before?")
A = lw.fallback_key("POST1", "someone", "purifytext is the best humanizer")
check("the same comment gives the same key",
      lw.fallback_key("POST1", "someone", "purifytext is the best humanizer"), A)
check("case in the handle does not change it",
      lw.fallback_key("POST1", "SomeOne", "purifytext is the best humanizer"), A)
# Text is normalised the way MATCHING normalises it, so cosmetic edits by the
# renderer (an emoji, a doubled space) do not resurrect an already-liked comment.
check("punctuation and spacing do not change it",
      lw.fallback_key("POST1", "someone", "PurifyText, is  the best humanizer!"), A)
check("a different author is a different comment",
      lw.fallback_key("POST1", "someone_else", "purifytext is the best humanizer") == A, False)
check("the same words on another post are a different comment",
      lw.fallback_key("POST2", "someone", "purifytext is the best humanizer") == A, False)
check("different words are a different comment",
      lw.fallback_key("POST1", "someone", "acoustictext is the best") == A, False)
check("the key is short enough to live in a CSV", len(A), 21)

print("\nledgers stay apart")
check("instagram, default account", lw.ledger_path("instagram", "default").name, "done-ig.csv")
check("youtube, default account", lw.ledger_path("youtube", "default").name, "done-yt.csv")
check("instagram, a named account", lw.ledger_path("instagram", "b").name, "done-ig-b.csv")
check("youtube, a named account", lw.ledger_path("youtube", "b").name, "done-yt-b.csv")
# The TikTok liker's ledger must not be touched by either.
check("neither collides with TikTok's done.csv",
      "done.csv" in {lw.ledger_path(s, p).name
                     for s in ("instagram", "youtube") for p in ("default", "a")},
      False)

print("\nprofiles stay apart")
from login import profile_dir  # noqa: E402
check("tiktok keeps the name it has always had", profile_dir("default", "tiktok").name, "profile")
check("instagram gets its own", profile_dir("default", "instagram").name, "profile-ig")
check("youtube gets its own", profile_dir("default", "youtube").name, "profile-yt")
check("named accounts too", profile_dir("b", "youtube").name, "profile-yt-b")

print("\nwhich comments get liked (shared with like.py, so the rule is one rule)")
P = ["purifytext", "acoustictext"]
c = lambda u, t: {"user": u, "text": t}  # noqa: E731
check("a comment naming a product", wanted(c("x", "purifytext is great"), P, set(), False), True)
check("spelled with a space", wanted(c("x", "purify text is great"), P, set(), False), True)
check("spelled with a hyphen", wanted(c("x", "Purify-Text!"), P, set(), False), True)
check("a comment naming nothing", wanted(c("x", "nice video"), P, set(), False), False)
check("a watched handle", wanted(c("me", "anything"), P, {"me"}, False), True)
check("--all takes everything", wanted(c("x", "nice"), [], set(), True), True)

print("\nledger round-trip")
tmp = Path(tempfile.mkdtemp(prefix="lw-")) / "done-yt.csv"
check("a missing ledger reads as empty", lw.load_done(tmp), set())
f, w = lw.open_ledger(tmp)
w.writerow(["2026-09-05T00:00:00", "https://x/1", "vid1", "KEY1", "someone",
            "purifytext", "ok", "verified"])
w.writerow(["2026-09-05T00:00:01", "https://x/1", "vid1", "KEY2", "other",
            "acoustictext", "fail:noverify", "clicked but the button did not switch"])
f.close()
check("both rows are read back", lw.load_done(tmp), {"KEY1", "KEY2"})
# Failures are cleared on the next run so they are tried again — same rule as
# the TikTok ledger, and the same code doing it.
from like import purge_failures  # noqa: E402
check("the failure is cleared", purge_failures(tmp), {"fail:noverify": 1})
check("and the like is kept", lw.load_done(tmp), {"KEY1"})

# ── live ─────────────────────────────────────────────────────────────────────
if "--live" in sys.argv:
    print("\nthe YouTube collector, on a real page (nothing is clicked)")
    from playwright.sync_api import sync_playwright

    URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(user_agent=lw.UA, locale="en-US",
                                   viewport={"width": 1280, "height": 950}).new_page()
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        lw.load_comments(page, "youtube", 6)
        rows = page.evaluate(lw.YT_COLLECT) or []
        browser.close()

    print(f"   {len(rows)} comment(s) read")
    for r in rows[:4]:
        print(f"      @{r['user'][:20]:<20} id={(r['id'] or '-')[:14]:<14} "
              f"liked={r['liked']} likeable={r['likeable']}  {r['text'][:40]}")
    check("comments were found at all", len(rows) > 0, True)
    check("every one has an author", [r for r in rows if not r["user"]], [])
    check("every one has text", [r["user"] for r in rows if not r["text"]], [])
    check("every one has a like button", [r["user"] for r in rows if not r["likeable"]], [])
    # A signed-out page can like nothing, so nothing may read as already liked.
    check("nothing reads as already liked when signed out",
          [r["user"] for r in rows if r["liked"]], [])
    # A Short is a different page with a different way in: its comments do not
    # exist until the panel is opened. Same collector once they do.
    print("\nthe same, on a real Short")
    SHORT = "https://www.youtube.com/shorts/-45WzxMDoWs"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(user_agent=lw.UA, locale="en-US",
                                   viewport={"width": 1280, "height": 950}).new_page()
        page.goto(SHORT, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        before = len(page.evaluate(lw.YT_COLLECT) or [])
        lw.load_comments(page, "youtube", 4, SHORT)
        srows = page.evaluate(lw.YT_COLLECT) or []
        landed = page.url
        browser.close()

    print(f"   {before} comment(s) before opening the panel, {len(srows)} after")
    for r in srows[:3]:
        print(f"      @{r['user'][:20]:<20} id={(r['id'] or '-')[:14]:<14} "
              f"likeable={r['likeable']}  {r['text'][:40]}")
    check("a Short shows nothing until the panel is opened", before, 0)
    check("opening it yields comments", len(srows) > 0, True)
    check("every one has a like button", [r["user"] for r in srows if not r["likeable"]], [])
    # Scrolling the WINDOW on a Short moves to the next video. Ending up on a
    # different one would mean liking a stranger's comments under this link.
    check("we are still on the Short we were given", landed.endswith("-45WzxMDoWs"), True)

    with_id = [r for r in rows if r["id"]]
    print(f"   {len(with_id)} of {len(rows)} carry a native comment id "
          f"(the rest fall back to a hash)")

print("\nthe Instagram collector must never reach the POST'S OWN like")
# Measured signed out on a real post: the post's Like button was the ONLY
# control found, and it was presented as a comment by the post's author whose
# text was the caption. Liking it would have liked the POST, publicly, on
# somebody else's content.
for name in ("IG_COLLECT", "IG_LIKE", "IG_STATE"):
    js = getattr(lw, name)
    check(f"  {name} uses the shared control list", "igCommentControls()" in js, True)
    check(f"  {name} excludes the post action bar", "inPostBar" in js, True)
# The three index into that list by POSITION. Built differently, index 3 would
# be a different control in each — and the one that CLICKS would be clicking
# something the one that READ never saw.
bodies = [
    getattr(lw, n).split("const igCommentControls")[1].split("};")[0]
    for n in ("IG_COLLECT", "IG_LIKE", "IG_STATE")
]
check("  and all three build it identically", len(set(bodies)), 1)

print("\na probe needs no session, because it clicks nothing")
src = Path("like_web.py").read_text(encoding="utf-8")
check("  a missing profile still probes", "probing signed OUT" in src, True)
check("  a login wall does not stop it", "Probing anyway." in src, True)
check("  but a real run still stops", 'f"{site}: not signed in"' in src, True)
check("  and it never claims to be signed in when it is not",
      'f"signed in as {who}" if live else' in src, True)

print("\nand a site that will not answer is not a session that died")
# A 4xx/5xx to the sign-in probe is the site throttling this machine, which
# running many browsers at once causes. "Not signed in to tiktok" sends
# somebody to re-authenticate an account that was never signed out; see
# check_throttled.py for the run this came from.
check("  the two are told apart", "refused = is_refusal(who)" in src, True)
check("  the message blames the machine", "throttling this machine" in src, True)
check("  and says what to do instead",
      "browsers at once, wait a while, and try again." in src, True)
check("  the toast says it too", "check got no answer" in src, True)
check("  rather than telling anyone to log in", "Throttled — wait and retry" in src, True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
