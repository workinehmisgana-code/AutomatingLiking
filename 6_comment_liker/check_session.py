"""A page that renders logged out is usually not a session that died.

TikTok sometimes serves a logged-out shell part-way through a run: a Log in
button in the nav, the side panel pinned to "You may like", and not one comment
rendered. The cookies on disk are untouched. A HARD REFRESH brings it straight
back — which is exactly what happens by hand when it is noticed.

What the code used to do instead:

    dom mode   run the whole Google re-login flow. Minutes of navigation, a good
               chance of tripping a captcha, and all of it to fix a page that
               needed reloading.
    api mode   stop the run outright and print "THIS PROFILE IS LOGGED OUT",
               abandoning the rest of that profile's shard.

So the order is now: refresh, refresh again, refresh once more, and only if the
page is STILL logged out believe it and re-login. Three refreshes cost about
five seconds; a re-login costs minutes and sometimes a captcha, and stopping
costs the whole shard.

Two things this must not do, and both are checked below:

  * reload a page that is fine. A refresh on every video would double the page
    loads of the entire run for nothing.
  * come back on a DIFFERENT video. A reload lands wherever TikTok decides, and
    liking comments on whatever it landed on would be liking a stranger's.

    python check_session.py
"""
import re
import sys
from pathlib import Path

import like

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


class FakeCdp:
    def __init__(self, page):
        self.page = page

    def send(self, method, params=None):
        self.page.cdp_calls.append((method, dict(params or {})))
        self.page.reloads += 1
        self.page.step()


class FakeContext:
    def __init__(self, page, cdp_ok=True):
        self.page = page
        self.cdp_ok = cdp_ok

    def new_cdp_session(self, page):
        if not self.cdp_ok:
            raise RuntimeError("no CDP session on this target")
        return FakeCdp(self.page)


class FakePage:
    """A page whose logged-out state can be made to change on reload.

    `states` is what page_is_logged_out reads, one entry per look. `renders`
    says whether waiting for the comment icon succeeds.
    """

    def __init__(self, states, cdp_ok=True, renders=True, url="https://www.tiktok.com/@a/video/999"):
        self.states = list(states)
        self.context = FakeContext(self, cdp_ok)
        self.renders = renders
        self.url = url
        self.reloads = 0
        self.plain_reloads = 0
        self.gotos = 0
        self.cdp_calls = []
        self.looks = 0

    def step(self):
        # A reload consumes nothing by itself; the next look reads the next state.
        pass

    def evaluate(self, js, arg=None):
        # The only evaluate in this path is page_is_logged_out's.
        self.looks += 1
        return self.states.pop(0) if self.states else False

    def reload(self, wait_until=None):
        self.plain_reloads += 1
        self.reloads += 1

    def goto(self, url, wait_until=None):
        self.gotos += 1
        self.url = url

    def wait_for_selector(self, sel, timeout=None):
        if not self.renders:
            raise RuntimeError("never rendered")
        return object()

    def wait_for_timeout(self, ms):
        pass

    def query_selector(self, sel):
        return None


URL = "https://www.tiktok.com/@a/video/999"

print("a page that is fine is left alone")
p = FakePage([False])
check("  it reports signed in", like.recover_session(p, URL, verbose=False), True)
# The expensive half of this feature is not reloading. A refresh on every video
# would double the page loads of the whole run to fix a page that was never
# broken.
check("  and nothing was reloaded", p.reloads, 0)
check("  it only looked once", p.looks, 1)

print("\na page that looks logged out is refreshed, not believed")
# Logged out, then signed in after the first refresh — the case the user hit.
p = FakePage([True, False])
before = like._recovered
check("  it comes back", like.recover_session(p, URL, verbose=False), True)
check("  after exactly one refresh", p.reloads, 1)
check("  the refresh ignored the cache", p.cdp_calls, [("Page.reload", {"ignoreCache": True})])
check("  and the recovery is counted", like._recovered - before, 1)

# Ignoring the cache is the point: a plain reload can be answered from the same
# cached logged-out shell that caused the problem.
print("\nthe refresh is a HARD one")
src = Path("like.py").read_text(encoding="utf-8")
check("  ignoreCache is asked for", '"Page.reload", {"ignoreCache": True}' in src, True)
check("  and the reason is written down",
      re.search(r"answered from the[\s\S]{0,40}cached logged-out shell", src) is not None, True)
# CDP is the only way Chromium will do it, so a target that cannot open one
# falls back rather than giving up.
p = FakePage([True, False], cdp_ok=False)
check("  without CDP it still reloads", like.recover_session(p, URL, verbose=False), True)
check("  through an ordinary reload", p.plain_reloads, 1)

print("\na session that really is gone is not pretended away")
p = FakePage([True] * 10)
check("  three refreshes, then False", like.recover_session(p, URL, verbose=False), False)
check("  it did try three times", p.reloads, like.SESSION_RELOAD_TRIES)
check("  which is 3", like.SESSION_RELOAD_TRIES, 3)

print("\na reload that renders nothing falls back to loading the video outright")
p = FakePage([True, False], renders=False)
check("  recovered anyway", like.recover_session(p, URL, verbose=False), True)
check("  by navigating to it", p.gotos > 0, True)

print("\nasking a dead page where it is does not raise")


class DeadPage:
    @property
    def url(self):
        raise RuntimeError("Target page, context or browser has been closed")


check("  it answers ''", like.current_url(DeadPage()), "")
check("  and a live page answers its url", like.current_url(FakePage([], url=URL)), URL)

print("\nthe refresh comes FIRST, and re-login only after it fails")
# dom mode: the Google re-login is minutes of navigation and a fair chance of a
# captcha. It must not be the reflex for a page that needed reloading.
dom = src.split('if args.mode == "dom":')[1].split("# ── api mode")[0]
check("  dom mode refreshes before re-login",
      re.search(r"if todo and not recover_session\(page, url\):[\s\S]{0,900}?relogin\.relogin", dom) is not None,
      True)
check("  and says why", "worth running" in dom or "worth running" in src, True)
# api mode used to stop the whole run on the first bad render.
check("  api mode refreshes before stopping",
      re.search(r"if not recover_session\(page, url\)", src.split('if args.mode == "dom":')[0]) is not None,
      True)
# page_is_logged_out is still the reader; what must not survive is a CALL SITE
# IN THE VIDEO LOOP that acts on it directly, because that is the code path that
# re-logged in (or stopped the run) on a page that only needed reloading.
main_body = src.split("def main(")[1]
loops = main_body.split("for vn, (url, aweme) in enumerate(targets_videos, 1):", 1)[1]
check("  no call site in the video loop acts on the raw flag",
      len(re.findall(r"page_is_logged_out\(", loops)), 0)
# The one place outside the loop that may: the sign-in check at startup, where
# the API has REFUSED to answer (a 403 from throttling) and the page is the only
# other source. It is a tiebreaker for a question the endpoint would not answer,
# not a verdict on a page mid-run — and it never re-logs in either way. See
# check_throttled.py.
before_loops = main_body.split("for vn, (url, aweme) in enumerate(targets_videos, 1):", 1)[0]
check("  the startup check may, exactly once",
      len(re.findall(r"page_is_logged_out\(", before_loops)), 1)
check("  and it does not re-login on what it finds",
      "relogin" in before_loops.split("page_is_logged_out(")[1][:600], False)
check("  only recover_session reads it",
      len(re.findall(r"page_is_logged_out\(page\)",
                     src.split("def recover_session")[1].split("def has_comment_rows")[0])), 2)

print("\nafter a refresh we are still on the video we were given")
# A reload lands wherever TikTok decides. Everything after this reads THIS
# video, so landing elsewhere would mean liking a stranger's comments under it.
check("  the landing url is checked against the video id",
      "elif todo and aweme not in current_url(page):" in dom, True)
check("  and it goes back before reading anything",
      re.search(r"aweme not in current_url\(page\)[\s\S]{0,700}?open_video\(page, url\)", dom) is not None,
      True)
# Whatever was read from a logged-out shell is worthless, so it is read again.
check("  what was read before the refresh is re-read",
      len(re.findall(r"before = safe_eval\(page, READ_MINE_JS, \[aweme, 4\]\) or \{\}", dom)), 3)

print("\na headless run does not have to give up on a captcha")
# A HEADLESS BROWSER CANNOT BE MADE HEADED. Playwright decides at launch, and
# headless is a different binary — headless_shell.exe, not chrome.exe — so
# there is no setting to flip. The browser is closed and the same profile is
# opened again with a window; the session lives in the profile directory, not
# in the process, so it is the same account either way.
check("  the swap exists", "def show_for_captcha" in src, True)
check("  and says why it is a relaunch, not a toggle",
      "CANNOT BE MADE HEADED" in src, True)
check("  naming the other binary", "headless_shell.exe" in src, True)
# Two Chromiums cannot share one user data directory, so the close has to
# finish before the relaunch starts.
check("  the directory is released first",
      re.search(r"def show_for_captcha[\s\S]*?ctx\.close\(\)[\s\S]{0,500}?headed=True",
                src) is not None, True)
check("  and the relaunch is headed", "headed=True, slot=args.window_slot" in src, True)
# And back again: staying headed would quietly double the memory of a run
# somebody chose headless for.
check("  it goes back to headless afterwards",
      re.search(r"# Back to headless\.[\s\S]{0,600}?headed=False", src) is not None, True)
check("  saying why that matters",
      "quietly double the memory" in src and "somebody chose headless for" in src, True)

# WHAT SUMMONED THE PUZZLE HAS TO BE DONE AGAIN IN THE WINDOW.
#
# It is gated on the ACTION, not on the page: it appears when the comments are
# opened. A fresh window sitting on a freshly loaded video is not being asked
# anything, so the check found nothing, called it solved, went back to headless
# — and the next click brought it straight back. On video after video, which is
# how it was noticed: "the captcha was gone by the time the window opened",
# every time.
swap = src.split("def show_for_captcha")[1].split("def wait_out_captcha")[0]
check("  the window opens the comments too",
      re.search(r"if not captcha_present\(page\):[\s\S]{0,400}?open_comments\(page\)",
                swap) is not None, True)
check("  and only then decides there is nothing to solve",
      re.search(r"open_comments\(page\)[\s\S]{0,300}?if captcha_present\(page\):",
                swap) is not None, True)
check("  the old claim is gone from the code",
      "gating the SESSION, not the page" in src, False)

# THE CHEAP WAY IS TRIED FIRST.
#
# The puzzle is triggered by RATE, not by the account or by the browser being
# headless: measured on one browser doing what a run does — load a video, open
# the comments — over eight videos on a profile that had been challenged
# repeatedly during a seventeen-account run, and not one puzzle appeared. A
# browser that pauses and reloads is usually not asked again, which is exactly
# why the window kept opening onto nothing: the thirty seconds it took to open
# had already cleared it.
faded = src.split("def captcha_faded")[1].split("def show_for_captcha")[0]
check("  a pause and a reload comes first",
      re.search(r"def show_for_captcha[\s\S]{0,2600}?if captcha_faded\(page, url\):",
                src) is not None, True)
check("  before anything is closed",
      swap.index("captcha_faded(page, url)") < swap.index("ctx.close()"), True)
check("  and it opens the comments too, for the same reason",
      "open_comments(page)" in faded, True)
check("  the pause is seconds, not a browser restart", "wait_s: int = 8" in faded, True)
check("  and the rate explanation is written down", "triggered by RATE" in faded, True)

# AND WINDOWS THAT FIND NOTHING STOP BEING OPENED.
check("  fruitless swaps are counted", "_fruitless_swaps" in swap, True)
check("  but only when a window really opened", "if window_ok and not found:" in swap, True)
check("  two is enough to conclude", "_fruitless_swaps >= 2" in swap, True)
check("  after which no more are opened", "_window_pointless = True" in swap, True)
check("  and a later captcha skips straight past the swap",
      re.search(r"if _window_pointless:[\s\S]{0,300}?return ctx, page, False", swap)
      is not None, True)
check("  saying what actually stops them", "--at-once" in swap, True)
# A run that waited out nine of these was rate-limited nine times. Every like
# can still have landed and that is still worth knowing at the end.
check("  and the run counts the ones it waited out",
      "captcha(s) waited out" in src, True)
# The caller has to rebind: neither the context nor the page survives.
check("  both are handed back", "return ctx, page, solved" in src, True)
check("  and both call sites rebind them",
      len(re.findall(r"ctx, page, \w+ = show_for_captcha\(", src)), 2)
# Someone running this unattended wants the old behaviour: fail fast rather
# than hold a window open for four minutes nobody will look at.
check("  it can be turned off", "--no-captcha-window" in src, True)
check("  and only applies to headless",
      "not args.headed and not args.no_captcha_window" in src, True)
# The window must be openable at all, which is the part that would break
# silently: a failure there has to leave a usable headless context behind.
check("  a failed window still returns a working browser",
      re.search(r"could not open a window[\s\S]*?headed=False", swap) is not None, True)

print("\nthe run says how often it happened")
# A profile that needed reloading on every other video is not healthy even when
# every like landed, and one line at the end says so where a scroll back through
# a nine-way parallel log would not.
check("  every summary carries the count", src.count("{recovered_note()}"), 3)
check("  it names the number", "refresh(es)" in like.recovered_note(), True)
# And says nothing at all on a clean run, so the normal case reads exactly as it
# always did.
kept = like._recovered
like._recovered = 0
check("  and says nothing on a clean run", like.recovered_note(), "")
like._recovered = kept

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
