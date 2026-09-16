#!/usr/bin/env python3
"""
The comment panel holds comments /api/comment/list/ never returned.

Replies, anything past --pages, and the ~11% the endpoint returns with an empty
text field: all of it is on screen once the panel is open, and none of it was
ever looked at. The sweep reads the rendered rows and likes the product comments
among them.

THE HARD PART IS NOT FINDING THEM. A heart is a TOGGLE and these comments have
no cid, so there is no user_digged to consult: the only question that matters is
what a press actually did.

That was first answered by the heart's COLOUR, tested for "looks red". On the
live build neither state reads as red, so a comment we had just successfully
liked looked unliked, the code concluded it had been ours all along, and pressed
again to "restore" it — undoing every like the sweep made. 52 real product
comments in one run of profile f, each recorded as a failure and retried the
next run.

It is now the LIKE COUNT beside the heart. Liking adds one, unliking removes
one, and no theme can change that. These checks are mostly about that.

Runs against no browser and no network.

    python check_dom_sweep.py
"""
import re
import sys

import like

FAILS = 0


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


PRODUCTS = ["purifytext", "acoustictext"]
AWEME = "7412345678901234567"


def row(user, text, likes=3, heart=True):
    return {"user": user, "text": text, "likes": likes, "heart": heart}


def api(user, text, already=False):
    return {"cid": "c" + str(abs(hash(text)) % 10**6), "user": user, "text": text,
            "likes": 0, "already": already}


print("the colour heuristic is gone, root and branch:")
src = open("like.py", encoding="utf-8").read()
for name in ("looks_liked", "paint_reference", "row_is_liked", "RGB_IN_PAINT", "paintOf"):
    check(f"  {name}", len(re.findall(rf"\b{name}\b", src)), 0)
check("  the reader is the like count", "const likesOf = (row)" in src, True)
check("  read in both JS blocks", src.count("const likesOf = (row)"), 2)

print("\nthe count is only trusted when it can actually be read:")
# TikTok abbreviates past a thousand, and a +1 is invisible in "1.2K".
js = like.DOM_SCAN_JS
check("  an abbreviated count is refused", "if (/[KMkm]/.test(t)) return null" in js, True)
check("  so is one with no digits", "if (!m) return null" in js, True)
check(
    "  and the click refuses too, before pressing",
    "if (before === null) return { found: true, clicked: false, why: 'like count not readable' }"
    in like.DOM_LIKE_JS,
    True,
)
check(
    "  a row with no readable count is never offered",
    [c["user"] for c in like.dom_extras(
        [row("a", "purifytext is great", likes=None), row("b", "purifytext works", likes=2)],
        AWEME, PRODUCTS, set(), [], set())],
    ["b"],
)

print("\nwhat the sweep picks up, and what it leaves alone:")
panel = [
    row("alice", "purifytext saved me"),           # the api had it
    row("bob", "just use acoustictext honestly"),   # a REPLY the api never listed
    row("carol", "great edit"),                     # names no product
    row("erin", "i switched to purifytext"),        # new, likeable
    row("frank", "purifytext", heart=False),        # nothing to press
]
api_list = [api("alice", "purifytext saved me"), api("carol", "great edit")]
picked = sorted(c["user"] for c in like.dom_extras(panel, AWEME, PRODUCTS, set(), api_list, set()))
check("  the reply the api missed is picked up", "bob" in picked, True)
check("  so is the other new product comment", "erin" in picked, True)
check("  a comment the api already listed is not", "alice" in picked, False)
check("  a comment naming no product is not", "carol" in picked, False)
check("  nor is a row with no heart", "frank" in picked, False)
check("  exactly those two", picked, ["bob", "erin"])

print("\nan api comment that is ALREADY liked is never pressed:")
# The api listed it and said it was liked, so it is not in `wants` — without
# excluding it by the api list the sweep would toggle it off.
already = [api("gina", "purifytext did the job", already=True)]
check("  excluded", like.dom_extras([row("gina", "purifytext did the job")],
                                    AWEME, PRODUCTS, set(), already, set()), [])

print("\nthe api's EMPTY-TEXT comments are the biggest blind spot:")
# Measured at 13 of 116 comments across six real videos: the endpoint returns
# the comment with `text` empty, so it can never match a product name.
blind_api = [api("hana", "")]
check("  the panel's text is used",
      [c["user"] for c in like.dom_extras([row("hana", "purifytext, easily")],
                                          AWEME, PRODUCTS, set(), blind_api, set())],
      ["hana"])
check("  but a text the api did read is still skipped",
      like.dom_extras([row("hana", "purifytext, easily")], AWEME, PRODUCTS, set(),
                      [api("hana", ""), api("hana", "purifytext, easily")], set()),
      [])

print("\nwhat a press means, by the count it moved (the whole fix):")
# The four outcomes the loop distinguishes. Written out so the mapping is
# checkable without a browser.
def outcome(delta, undo_delta=None):
    if delta == 1:
        return "liked"
    if delta == -1:
        return "restored" if undo_delta == 1 else "UNLIKED and could not restore"
    return "did nothing"


check("  +1 is the like landing", outcome(1), "liked")
check("  -1 was already ours, and goes back", outcome(-1, undo_delta=1), "restored")
check("  -1 that will not go back is the loud one", outcome(-1, undo_delta=0),
      "UNLIKED and could not restore")
check("  0 means the press achieved nothing", outcome(0), "did nothing")
check("  and null the same", outcome(None), "did nothing")

print("\nthe loop follows exactly that, and never presses to find out:")
loop = src[src.index("extra_ok = extra_fail = 0"):]
loop = loop[: loop.index("rate = vn / max(")]
check("  +1 records a like", 'if delta == 1:' in loop, True)
check("  -1 restores once", 'elif delta == -1:' in loop, True)
check("  and confirms the restore", 'if undo.get("delta") == 1:' in loop, True)
# The old code pressed a second time whenever the signal was ambiguous. That is
# what turned a good like into an unlike, so it must not come back.
check("  an ambiguous result is NOT pressed again",
      loop.count("DOM_LIKE_JS") , 2)
check("  a restored comment counts as done, not failed",
      'record(url, aweme, c, "ok", "dom sweep: was already liked")' in loop, True)
check("  so it is never swept a second time",
      loop.count('done.add(c["cid"])'), 2)
check("  a lost like is reported as such",
      "UNLIKED and could not restore" in loop, True)

print("\nthe ledger can tell these rows apart and skip them next run:")
cid = like.dom_cid(AWEME, "bob", "just use acoustictext honestly")
check("  the id is stable", cid, like.dom_cid(AWEME, "bob", "just use acoustictext honestly"))
check("  it survives case and punctuation",
      cid, like.dom_cid(AWEME, "BOB", "Just use acoustictext, honestly!"))
check("  it says where it came from", cid.startswith("dom:"), True)
check("  a swept comment is not swept twice",
      [c["user"] for c in like.dom_extras(panel, AWEME, PRODUCTS, set(), api_list, {cid})],
      ["erin"])

print("\n--all stays a decision about the api list, not the whole panel:")
noise = [row("zed", "first"), row("yan", "haha")]
check("  no product, no like", like.dom_extras(noise, AWEME, PRODUCTS, set(), [], set()), [])
check("  a --users handle is still swept",
      [c["user"] for c in like.dom_extras(noise, AWEME, [], {"zed"}, [], set())], ["zed"])

print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
