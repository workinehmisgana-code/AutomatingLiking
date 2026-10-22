#!/usr/bin/env python3
"""
Does a Reddit search card give up its score and its age?

WHAT WENT WRONG. get_reddit_details walked up from the result link looking for a
<shreddit-post> element and read its `score` and `created-timestamp`. That is
right on a post's own page and there is no such element on the SEARCH page — the
tree above a result is `a > h2 > search-telemetry-tracker > div` — so the walk
fell through to its last resort on every row. Every Reddit link was written with
like_count 0 and no posted_date: the heart ceiling had no like count to work
from and the date clustering had no date. It read as working because the
fallback title is the link's own text, which on a search result IS the title.

The card renders all of it as plain text, so that is what is parsed now. These
are the two pieces that do the parsing, and the strings below are copied from
what Reddit actually served.

Nothing here opens a browser.

    python check_reddit_details.py
"""
import sys
from pathlib import Path

import scraper as s

# The relative age has to come out in a spelling the OTHER side understands:
# parse_posted_date in 2_comment_automation turns it into a timestamp for the
# date clustering, and it is the only consumer that matters.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "2_comment_automation"))
try:
    from automate import parse_posted_date  # type: ignore
except Exception:  # noqa: BLE001
    parse_posted_date = None

FAILS = 0


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


# Verbatim from the page, bullet separator and all.
CARD = (
    "Best 3 AI Humanizers (Tested Against GPTZero & Turnitin)\n"
    "r/humanizing\n•\n2mo ago\n"
    "Best 3 AI Humanizers (Tested Against GPTZero & Turnitin)\n"
    "If your goal is to bypass AI detectors without sacrificing writing quality, "
    "Verva is the best AI humanizer right now.\n"
    "11 votes•88 comments"
)

print("the real card, as Reddit served it:")
m = s._REDDIT_VOTES_RE.search(CARD)
check("  the score is read", m.group(1).strip() if m else "", "11")
# 88 comments sits right next to it; the score must not be the comment count.
check("  and it is the votes, not the comments",
      s.parse_count_text(m.group(1).strip() if m else ""), 11)
check("  the age is read", s._reddit_age_to_relative(CARD), "2mo ago")

print("\nthe ages Reddit writes:")
for text, want in [
    ("2mo ago", "2mo ago"),
    ("13d ago", "13d ago"),
    ("3 hr. ago", "3h ago"),
    ("45 min. ago", "45m ago"),
    ("1 yr. ago", "1y ago"),
    ("7 months ago", "7mo ago"),
    ("2 weeks ago", "2w ago"),
    ("just now", "just now"),
    ("no age here at all", ""),
]:
    check(f"  {text!r}", s._reddit_age_to_relative(text), want)

# "mo" BEFORE "m". parse_posted_date matches `(mo|s|m|h|d|w|y)`, so a month
# written as "2m ago" would be read as two MINUTES — a post from August dated to
# this afternoon, and a date cluster built on it.
print("\nmonths are not minutes:")
check("  a month stays a month", s._reddit_age_to_relative("2 months ago"), "2mo ago")
check("  and is not shortened to m",
      s._reddit_age_to_relative("2 months ago").endswith("mo ago"), True)

print("\nthe vote counts Reddit abbreviates:")
for text, want in [
    ("11 votes•88 comments", 11),
    ("1.2K votes•3 comments", 1200),
    ("834 upvotes", 834),
    ("1 vote", 1),
]:
    mm = s._REDDIT_VOTES_RE.search(text)
    check(f"  {text!r}", s.parse_count_text(mm.group(1).strip()) if mm else 0, want)

if parse_posted_date:
    print("\nand the other side can read what we write:")
    scraped = "2026-10-13T10:00:00+00:00"
    base = parse_posted_date("just now", scraped)
    for age, days in [("2mo ago", 60), ("13d ago", 13), ("3h ago", 0)]:
        t = parse_posted_date(age, scraped)
        check(f"  {age} parses", t is not None, True)
        if t is not None and base is not None:
            back = (base - t) / 86_400_000
            check(f"  {age} is about {days} day(s) back", round(back) in range(days - 2, days + 3), True)
    # The one that would have been silent: a month read as a minute.
    month = parse_posted_date("2mo ago", scraped)
    minute = parse_posted_date("2m ago", scraped)
    check("  2mo and 2m are not the same date", month != minute, True)
else:
    print("\n   (skipping the round-trip: 2_comment_automation/automate.py not importable)")

print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
