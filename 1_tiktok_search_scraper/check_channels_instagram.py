"""Does the channel scraper read Instagram correctly — and not break TikTok?

Instagram has shipped three different JSON shapes for a profile's posts and
still serves all three, so the response handler walks for post-shaped objects
instead of reading a fixed path. That walker is where the risk is:

  * miss a shape           -> a channel silently scrapes as empty
  * over-match             -> a carousel's children saved as separate posts, or
                              a suggested-user's post filed under this account
  * key by handle alone    -> @studywitharyana exists on BOTH sites, and one
                              shared key would let one account's posts end the
                              other's scan and corrupt its stored state

Nothing here opens a browser.

    python check_channels_instagram.py
"""
import csv
import sys
import tempfile
from pathlib import Path

import scrape_channels as sc

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


# ── The three shapes Instagram serves ────────────────────────────────────────
MODERN = {  # xdt_api__v1__feed__user_timeline_graphql_connection
    "data": {"xdt_api__v1__feed__user_timeline_graphql_connection": {"edges": [
        {"node": {
            "code": "DVEWskvj24R", "taken_at": 1771718400,
            "like_count": 816, "comment_count": 414, "play_count": 120345,
            "media_repost_count": 31,
            "caption": {"text": "How to humanize your AI writing\nline two"},
            "user": {"username": "mavgpt"},
        }},
    ]}}
}
LEGACY = {  # edge_owner_to_timeline_media
    "data": {"user": {"edge_owner_to_timeline_media": {"count": 137, "edges": [
        {"node": {
            "shortcode": "DQDEJD-Dst0", "taken_at_timestamp": 1759276800,
            "edge_liked_by": {"count": 92}, "edge_media_to_comment": {"count": 7},
            "video_view_count": 5100,
            "edge_media_to_caption": {"edges": [{"node": {"text": "finally found it"}}]},
            "owner": {"username": "studywithjake_"},
        }},
    ]}}}
}
REST = {  # /api/v1/feed/user/<id>/
    "items": [{
        "code": "DaLXAl-qjB8", "taken_at": 1774310400,
        "like_count": 12, "comment_count": 0,
        "caption": {"text": "photo post, no plays"},
        "user": {"username": "mavgpt"},
    }]
}

print("the three JSON shapes:")
for label, payload, want in (
    ("modern graphql", MODERN, {
        "account": "mavgpt", "url": "https://www.instagram.com/p/DVEWskvj24R/",
        "view_count": 120345, "heart_count": 816, "comment_count": 414,
        "share_count": 31, "posted_date": "2026-02-22",
        "title": "How to humanize your AI writing line two"}),
    ("legacy graphql", LEGACY, {
        "account": "studywithjake_", "url": "https://www.instagram.com/p/DQDEJD-Dst0/",
        "view_count": 5100, "heart_count": 92, "comment_count": 7,
        "share_count": 0, "posted_date": "2025-10-01", "title": "finally found it"}),
    ("rest feed", REST, {
        "account": "mavgpt", "url": "https://www.instagram.com/p/DaLXAl-qjB8/",
        "view_count": 0, "heart_count": 12, "comment_count": 0,
        "share_count": 0, "posted_date": "2026-03-24", "title": "photo post, no plays"}),
):
    nodes = []
    sc._ig_media_nodes(payload, nodes)
    check(f"{label}: one post found", len(nodes), 1)
    check(f"{label}: read correctly", sc.ig_row(nodes[0], "fallback"), want)

print("\nwhat must NOT be counted as a post:")
# A carousel repeats the parent's fields in its children. Walking into them
# would save one post several times.
CAROUSEL = {"items": [{
    "code": "ABCDEFGHI", "taken_at": 1774310400, "like_count": 5,
    "carousel_media": [
        {"pk": "1", "code": "ABCDEFGHI", "taken_at": 1774310400},
        {"pk": "2", "code": "ABCDEFGHI", "taken_at": 1774310400},
    ],
}]}
nodes = []
sc._ig_media_nodes(CAROUSEL, nodes)
check("a carousel is one post, not three", len(nodes), 1)

for label, payload in (
    ("a user with no posts", {"data": {"user": {"username": "x", "biography": "hi"}}}),
    ("an error body", {"status": "fail", "message": "rate limited"}),
    ("an empty feed", {"items": []}),
    ("a code with no timestamp", {"items": [{"code": "ABCDEFGHI"}]}),
    ("a timestamp with no code", {"items": [{"taken_at": 1774310400}]}),
    ("a code too short to be one", {"items": [{"code": "ab", "taken_at": 1774310400}]}),
):
    nodes = []
    sc._ig_media_nodes(payload, nodes)
    check(label, len(nodes), 0)

check("a node with no usable code yields no row",
      sc.ig_row({"taken_at": 1, "like_count": 2}, "x"), None)
check("a missing username falls back to the account being scraped",
      sc.ig_row({"code": "ABCDEFGHI", "taken_at": 1774310400}, "someone")["account"],
      "someone")

print("\nwhose post is it? (a profile page also fetches suggestions)")
# A profile page is not only the profile: while it is open, Instagram fetches
# suggested reels and the signed-in user's own feed over the SAME endpoint, in
# the same post shape. Four strangers' posts landed in a 400-row scrape of
# @laia.learning that way, filed under her name and carrying her bio.
OWN = {"code": "ABCDEFGHI", "taken_at": 1774310400, "user": {"username": "laia.learning"}}
FOREIGN = {"code": "JKLMNOPQR", "taken_at": 1774310400, "user": {"username": "yonasmohh"}}
COLLAB = {"code": "STUVWXYZA", "taken_at": 1774310400,
          "user": {"username": "someoneelse"},
          "coauthor_producers": [{"username": "laia.learning"}]}
LEGACY_OWN = {"shortcode": "BCDEFGHIJ", "taken_at_timestamp": 1774310400,
              "owner": {"username": "laia.learning"}}
NAMELESS = {"code": "CDEFGHIJK", "taken_at": 1774310400}

check("the account's own post is kept", sc.ig_owned_by(OWN, "laia.learning"), True)
check("a suggested post from someone else is dropped",
      sc.ig_owned_by(FOREIGN, "laia.learning"), False)
check("a collaboration on this profile is kept", sc.ig_owned_by(COLLAB, "laia.learning"), True)
check("the legacy shape names its owner too", sc.ig_owned_by(LEGACY_OWN, "laia.learning"), True)
check("a post naming nobody is refused", sc.ig_owned_by(NAMELESS, "laia.learning"), False)
check("matching ignores case", sc.ig_owned_by(OWN, "Laia.Learning"), True)
check("a near-miss handle is not a match", sc.ig_owned_by(OWN, "laia.learnings"), False)
check("no handle to check against means no", sc.ig_owned_by(OWN, ""), False)

# The exact four that leaked into the real scrape.
LEAKED = ["nikatehilina_", "ethiopiafightnight", "worldfutureenergysummit", "yonasmohh"]
check("all four strangers from the real run are now refused",
      [sc.ig_owned_by({"code": "ABCDEFGHI", "taken_at": 1, "user": {"username": u}},
                      "laia.learning") for u in LEAKED],
      [False, False, False, False])

print("\nreading an accounts file:")
tmp = Path(tempfile.mkdtemp(prefix="acct-"))
f = tmp / "accounts.csv"
with f.open("w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["account_url", "platform", "handle", "video_count", "search_queries"])
    w.writerow(["https://www.tiktok.com/@studywitharyana", "tiktok", "studywitharyana", "462", "q"])
    w.writerow(["https://www.instagram.com/studywitharyana/", "instagram", "studywitharyana", "43", "q"])
    w.writerow(["https://www.instagram.com/mavgpt/", "instagram", "mavgpt", "40", "q"])
got = sc.load_accounts(str(f), [])
check("both platforms load", [(a["platform"], a["handle"]) for a in got],
      [("tiktok", "studywitharyana"), ("instagram", "studywitharyana"), ("instagram", "mavgpt")])
# The same name on both sites must NOT collapse into one account.
check("the same handle on both sites stays two accounts", len(got), 3)
check("profile URLs are built per site", [a["url"] for a in got][:2],
      ["https://www.tiktok.com/@studywitharyana", "https://www.instagram.com/studywitharyana/"])

check("a bare URL list still works",
      [(a["platform"], a["handle"]) for a in sc.load_accounts("", [
          "https://www.tiktok.com/@abc", "https://www.instagram.com/def/",
          "https://www.instagram.com/p/DVEWskvj24R/"])],
      [("tiktok", "abc"), ("instagram", "def")])

print("\nkeeping the two sites apart:")
check("tiktok keeps its bare key, so existing scan state still matches",
      sc.account_key("tiktok", "Studywitharyana"), "studywitharyana")
check("instagram is prefixed", sc.account_key("instagram", "Studywitharyana"), "ig:studywitharyana")
check("a stored tiktok row keys to tiktok",
      sc.account_key(sc.platform_of("https://www.tiktok.com/@x/video/1"), "x"), "x")
check("a stored instagram row keys to instagram",
      sc.account_key(sc.platform_of("https://www.instagram.com/p/ABC/"), "x"), "ig:x")

# The real accounts file, if extract_accounts.py has produced one.
newest = sorted(Path("results").glob("unique_accounts_*.csv"))
if newest:
    real = sc.load_accounts(str(newest[-1]), [])
    ig_n = sum(1 for a in real if a["platform"] == "instagram")
    tt_n = sum(1 for a in real if a["platform"] == "tiktok")
    print(f"\n   {newest[-1].name}: {tt_n} TikTok + {ig_n} Instagram account(s) loaded")
    check("every account has a usable profile URL",
          [a for a in real if not a["url"].startswith("https://")], [])
    check("no account was loaded twice",
          len({sc.account_key(a["platform"], a["handle"]) for a in real}), len(real))

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
