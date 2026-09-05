"""Does the Instagram account extraction pick the right account, and only that?

The risk here is not "a post goes unresolved" — that is visible and reported.
The risk is a WRONG attribution: a page shape that makes 'explore' or 'reel'
look like a username, and quietly gives one imaginary account four hundred
videos. So most of this is about what must NOT be accepted.

Offline by default. Pass --live to also fetch a handful of real posts.

    python check_instagram_owner.py [--live]
"""
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import instagram_owner as ig
from extract_accounts import account_from_row, account_from_url

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


print("recognising a post link:")
check("plain /p/", ig.post_code("https://www.instagram.com/p/DVEWskvj24R/"), "DVEWskvj24R")
check("/reel/", ig.post_code("https://www.instagram.com/reel/DVEWskvj24R/"), "DVEWskvj24R")
check("/tv/", ig.post_code("https://www.instagram.com/tv/DVEWskvj24R/"), "DVEWskvj24R")
check("no www", ig.post_code("https://instagram.com/p/DVEWskvj24R/"), "DVEWskvj24R")
check("http", ig.post_code("http://www.instagram.com/p/DVEWskvj24R/"), "DVEWskvj24R")
check("with a query string", ig.post_code("https://www.instagram.com/p/DVEWskvj24R/?igsh=x"), "DVEWskvj24R")
check("a hyphen in the code", ig.post_code("https://www.instagram.com/p/DQDEJD-Dst0/"), "DQDEJD-Dst0")
check("a profile, not a post", ig.post_code("https://www.instagram.com/mavgpt/"), None)
check("a tiktok link", ig.post_code("https://www.tiktok.com/@a/video/1"), None)
check("empty", ig.post_code(""), None)
# The form that already names the account must NOT be sent for lookup — it is
# free, and fetching it would be 5,000 wasted requests.
check(
    "the /<user>/reel/<code>/ form is read from the URL",
    account_from_url("https://www.instagram.com/mavgpt/reel/DVEWskvj24R/"),
    ("instagram", "https://www.instagram.com/mavgpt/", "mavgpt"),
)

print("\nreading the owner out of a page:")
DESC = ('<meta name="description" content="816 likes, 414 comments - mavgpt on '
        'February 22, 2026: &quot;How to humanize...&quot;">')
check("the description tag", ig.owner_in(DESC), "mavgpt")
check("a handle with dots and underscores",
      ig.owner_in(DESC.replace("mavgpt", "study.with_jay__")), "study.with_jay__")
check('"owner":{...}', ig.owner_in('{"owner":{"id":"1","username":"someone"}}'), "someone")
check("alternateName", ig.owner_in('"alternateName":"@person_x"'), "person_x")
check("a bare shell has nothing in it", ig.owner_in("<html><title>Instagram</title></html>"), None)
check("an empty page", ig.owner_in(""), None)

# og:title carries the DISPLAY name, not the handle. Accepting it would build
# https://www.instagram.com/Maverick Maltin | AI & ChatGPT/ — so it must be ignored.
OG = '<meta property="og:title" content="Maverick Maltin | AI &amp; ChatGPT on Instagram: &quot;x&quot;">'
check("og:title alone is refused", ig.owner_in(OG), None)

# Paths that are not people.
for word in ("explore", "reel", "p", "accounts", "instagram"):
    check(f"'{word}' is never an account",
          ig.owner_in(f'"owner":{{"username":"{word}"}}'), None)

print("\nreading the owner out of a CSV column:")
check("an account column on a tiktok row",
      account_from_row({"account": "betweenstudybreaks"}, "https://www.tiktok.com/x/video/1"),
      ("tiktok", "https://www.tiktok.com/@betweenstudybreaks", "betweenstudybreaks"))
check("an account column on an instagram row",
      account_from_row({"username": "@mavgpt"}, "https://www.instagram.com/p/ABC/"),
      ("instagram", "https://www.instagram.com/mavgpt/", "mavgpt"))
check("a blank column is not an account",
      account_from_row({"account": "  "}, "https://www.instagram.com/p/ABC/"), None)
check("a column holding a URL is not a handle",
      account_from_row({"account": "https://x.com/y"}, "https://www.instagram.com/p/ABC/"), None)
check("a column holding a sentence is not a handle",
      account_from_row({"author": "Maverick Maltin"}, "https://www.instagram.com/p/ABC/"), None)
check("an unknown host", account_from_row({"account": "x"}, "https://vimeo.com/1"), None)

print("\nthe cache:")
tmp = Path(tempfile.mkdtemp(prefix="igcache-")) / "owners.json"
ig.save_cache({"A": {"user": "someone", "at": ig._now()}}, tmp)
check("saves and loads", ig.load_cache(tmp), {"A": {"user": "someone", "at": ig._now()}})
check("a missing cache is empty, not an error", ig.load_cache(tmp.parent / "nope.json"), {})
tmp.write_text("{ not json", encoding="utf-8")
check("a corrupt cache is empty, not a crash", ig.load_cache(tmp), {})

old = (datetime.now(timezone.utc) - timedelta(days=ig.MISS_RETRY_DAYS + 1)).isoformat()
new = datetime.now(timezone.utc).isoformat()
check("a fresh miss is left alone", ig.stale_miss({"user": None, "at": new}), False)
check("an old miss is retried", ig.stale_miss({"user": None, "at": old}), True)
check("a hit is never retried", ig.stale_miss({"user": "x", "at": old}), False)
check("an unparseable date is retried", ig.stale_miss({"user": None, "at": "???"}), True)

# A cached hit must cost nothing: resolve_many should not touch the network.
calls = []
real = ig.resolve_http
ig.resolve_http = lambda code, attempts=3: calls.append(code) or "should-not-happen"
try:
    out = ig.resolve_many(["A"], cache={"A": {"user": "someone", "at": ig._now()}}, cache_path=tmp)
    check("a cached hit is not re-fetched", calls, [])
    check("and comes back from the cache", out["A"]["user"], "someone")
    calls.clear()
    ig.resolve_many(["B"], cache={"A": {"user": "someone", "at": ig._now()}}, cache_path=tmp)
    check("an unknown code is fetched", calls, ["B"])
finally:
    ig.resolve_http = real

if "--live" in sys.argv:
    print("\nlive, against real posts:")
    live = Path(tempfile.mkdtemp(prefix="iglive-")) / "owners.json"
    codes = ["DQDEJD-Dst0", "DVEWskvj24R", "DaLXAl-qjB8", "DZ3mMvPskOH"]
    got = ig.resolve_many(codes, workers=4, cache={}, cache_path=live)
    for c in codes:
        print(f"   {c:<14} -> {got[c]['user'] or '(unresolved)'}")
    hit = sum(1 for c in codes if got[c]["user"])
    check("most resolve", hit >= 3, True)
    # Whatever came back has to be usable as a profile URL.
    bad = [got[c]["user"] for c in codes
           if got[c]["user"] and (
               "/" in got[c]["user"] or " " in got[c]["user"]
               or got[c]["user"].lower() in ig.NOT_A_HANDLE)]
    check("nothing unusable came back", bad, [])
    check("the cache was written", json.loads(live.read_text())["owners"].keys() == got.keys(), True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
