#!/usr/bin/env python3
"""
Does a heart land on OUR comment, and only on ours?

THE BUG THIS EXISTS FOR WAS LIVE AND SILENT.

The comment scan recorded WHERE our comment sat — page 2, row 7 — and the heart
was then sent to `.nth(7)` after paging back to it. An index is not an identity.
One new comment arriving on that page in the seconds between the scan and the
heart shifts every row down by one, and row 7 is now a stranger's comment. The
batch went to them: a run paid for pushing somebody else up the comment section
it was trying to win, and nothing in the log looked wrong, because every number
printed was read off the row it was about to heart.

Two things stop it now and both are checked here:

  _locate_our_row   finds the comment by its TEXT, and will use the recorded
                    index only when the row standing there is still one of ours
  the final guard   refuses to send anything to a comment that does not carry
                    the keyword, however the row was arrived at

Nothing here opens a browser or touches Zefoy — the page is a stand-in holding
rows of text.

    python check_right_row.py
"""
import sys

import automate as a

FAILS = 0


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


# ── the smallest page that _locate_our_row can read ────────────────────────
#
# _row_comment_text asks a row for `span.text-dark.font-weight-bold`, so that is
# all a row has to answer. Written out rather than mocked with a library because
# the thing under test is which ROW gets picked, and that is clearer when the
# rows are a list of strings.
class _Text:
    def __init__(self, text):
        self._t = text

    @property
    def first(self):
        return self

    def inner_text(self, *a, **k):
        return self._t


class _Row:
    def __init__(self, text):
        self.text = text

    def locator(self, sel):
        if "text-dark" in sel:
            return _Text(self.text)
        return _Text("")


class _Page:
    def __init__(self, texts):
        self.rows = [_Row(t) for t in texts]

    def locator(self, sel):
        page = self

        class _All:
            def all(self):
                return page.rows

        return _All()


OURS = "purify text honestly saved my essay"
KW = "purifytext"


print("our comment is found by what it says, not by where it was:")

# The list as the scan read it: ours at index 2.
scanned = ["lol", "first", OURS, "nice one"]
row, idx = a._locate_our_row(_Page(scanned), OURS, KW, 2)
check("  unchanged page, same row", (row.text, idx), (OURS, 2))

# THE FAILURE. One new comment arrives at the top and every index shifts by one.
# The old code hearted index 2, which is now a stranger.
shifted = ["brand new comment", "lol", "first", OURS, "nice one"]
row, idx = a._locate_our_row(_Page(shifted), OURS, KW, 2)
check("  a new comment arrived, ours moved to 3", (row.text, idx), (OURS, 3))
check("  and index 2 really was a stranger", shifted[2], "first")

# Two arrive, and the stranger now standing at the recorded index happens to be
# a long plausible sentence — which is exactly what made this invisible.
shifted2 = ["new", "newer", "I used another tool and it was fine", OURS]
row, idx = a._locate_our_row(_Page(shifted2), OURS, KW, 2)
check("  two arrived, still ours that is found", (row.text, idx), (OURS, 3))

print("\nwhen the text cannot be matched exactly:")

# Punctuation and case are not a difference: norm() strips both, so this is
# still found by text at step 1.
restyled = ["lol", "first", "PurifyText, honestly, saved my essay!!", "nice"]
row, idx = a._locate_our_row(_Page(restyled), OURS, KW, 2)
check("  punctuation and case still match on text", idx, 2)

# A REAL mismatch: the stored text and the rendered text are different
# sentences, so no normalising will join them. The recorded index still holds
# one of ours, so it is used rather than giving up.
reworded = ["lol", "first", "purify text saved my essay", "nice"]
check("  the two really do not match",
      a.norm(reworded[2])[:60] == a.norm(OURS)[:60], False)
row, idx = a._locate_our_row(_Page(reworded), OURS, KW, 2)
check("  a reworded row that is still ours is used", (row.text, idx), (reworded[2], 2))

# The recorded index is a stranger, but another comment of ours is on the page.
# A different one of ours is still ours.
elsewhere = ["lol", "first", "some stranger", "try purify text, it works"]
row, idx = a._locate_our_row(_Page(elsewhere), OURS, KW, 2)
check("  otherwise another of ours is taken", idx, 3)

print("\nand when none of it is ours, nothing is hearted:")

gone = ["lol", "first", "some stranger", "another stranger"]
row, idx = a._locate_our_row(_Page(gone), OURS, KW, 2)
check("  our comment is gone: no row", row, None)
check("  and no index to fall back on", idx, None)
# THE WHOLE POINT. The old code returned .nth(2) here and hearted it.
check("  the row it used to heart", gone[2], "some stranger")

empty = a._locate_our_row(_Page([]), OURS, KW, 2)
check("  an empty list is not a row either", empty, (None, None))

print("\nthe last guard, which trusts none of the above:")

# matches_keyword is what the guard in zefoy_process_url calls. A row that got
# through everything else still cannot be hearted unless it carries the product.
check("  a stranger's comment is refused",
      a.matches_keyword("some stranger", KW), False)
check("  ours passes, however it is spelled",
      a.matches_keyword(OURS, KW), True)
check("  and spacing does not matter",
      a.matches_keyword("Purify-Text got me through", KW), True)

print("\nthe target carries its text through the scan:")
# A 5-tuple now, so there is something to find the row by. A 4-tuple here would
# mean the position is all that was recorded, which is where this started.
import inspect  # noqa: E402

src = inspect.getsource(a.zefoy_process_url)
check("  target_loc records the comment text", "HEART_THRESHOLD,\n                                              row_text" in src
      or "HEART_THRESHOLD, row_text" in src, True)
check("  and the heart is no longer sent to .nth(target_idx)",
      ".list-group-item\").nth(target_idx)" in src, False)

print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
