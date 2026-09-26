#!/usr/bin/env python3
"""Are the comments we posted still there?

WHY THIS EXISTS. Posting is confirmed at the time: like.py reads the comment
back off the page before it records one, so nothing lands in the ledger that was
not on screen. That says nothing about an hour later. TikTok removes comments
quietly — a filter catches one, a creator deletes it, an account gets limited and
everything it wrote goes with it — and none of that is reported to anybody. A
run can post two hundred comments, every one verified as it happened, and have
thirty of them left by the morning.

So this asks the question again, later, and from OUTSIDE the browser that wrote
them: open each video the ledger says we commented on, read its comments, and
look for ours.

WHAT COUNTS AS OURS. The account's own handle first — a comment by this profile
on that video — and the text second, because the account can post more than one
comment on a video and the ledger knows which text it wrote. A handle match with
different text is still counted, and said so: the comment survived, the ledger's
copy of it is stale.

IT MUST NOT BE THE ACCOUNT THAT WROTE IT. That was this script's first mistake
and it made every answer useless: TikTok shows a restricted comment to its
author exactly as if nothing were wrong, so the author's own browser reports
"still there" for a comment nobody else in the world can see.

The reading that settles it is another account's. But ONE other account is a
coin toss, which is the second thing this got wrong. The same comments by
profile a, read three ways:

    as Misgana Workineh   1 and 4 comments read — a's not among them
    as Martha A943        8 comments read       — a's not among them
    as Misgana a          found, every one of them

The third reading looked like proof the comments were fine and was the author
in disguise: `profile-default` and `profile-a` are two directories holding the
SAME login, "Misgana a". Nothing was learned from it at all.

So: a reader is identified by the ACCOUNT it is signed in to and never by the
directory it lives in, and a miss by one account is still not evidence — two
accounts that genuinely were not the author both missed these, and that is what
gets reported.

WHAT THIS DOES WITH THAT. A hit anywhere is the answer and ends the question —
somebody other than the author can see it, so it is really there, and nothing
else needs asking. A miss is handed to the next account, and only when every
reader has missed it, while all of them were reading other people's comments on
the same video quite happily, is it reported — as UNSEEN, which is a report of
what the readers saw and not a diagnosis.

IT IS DELIBERATELY NOT CALLED "RESTRICTED", because the readings above do not
support that word: @expertwriters022 saw the same four comments that @m.a8855
and @marthaayan could not, so a comment missed by two accounts may be filtered,
or may simply not be in the lists those two were served. What "unseen" does mean
is the thing worth acting on either way — the comment was posted, it cost a run,
and it is not reaching the accounts that went looking for it.

The one reading that would earn the word is the signed-out one, which is the
dashboard's, below: found by its author and absent from a solid signed-out read
is a comment TikTok is showing to nobody else.

AND EVERY READER HERE IS ON THIS MACHINE. Same address, same browser build,
often accounts that have watched the same videos — which is the audience TikTok
is most likely to serve one of our comments to, not the least. So a hit from a
reader proves the comment exists and is served to somebody; it does not prove it
is reaching strangers. The dashboard's signed-out read, from its own server, is
the one that answers that, which is the other reason it is asked first.

A READER IS NOT A PROFILE. This machine has `default` and `a` on one login and
`3` and `c` on another, so the same account gets asked twice under two names
unless somebody checks. Profiles recorded on the author's account are skipped
before any browser opens, and — because that record can be missing, as a's was —
a reader that finds the comment under ITS OWN name is dropped mid-pass, its
account is barred for the rest of the run, and another account is asked.

ONE ACCOUNT, THREE NAMES, ALL DIFFERENT. Measured on the account behind
profile-default:

    @handle (nav link, comment attribution)   drnardime
    screen_name (/passport/…/account/info/)   misgana a
    nickname (on its own comments)            dr. nardi

So the test for "this reader wrote it" is the HANDLE against the comment's
attribution, and the nickname is only a second opinion. The handle is read from
the nav and from nowhere else: it used to fall back to the first a[href^="/@"]
on the page, which on a video page is the creator of the video, and that printed
two different strangers' handles for one directory on two runs. With the fallback
gone it reads the same handle every time, and it caught what the fallback hid —
profile-default is @drnardime, which is profile a, and it had been "confirming"
a's comments as visible by finding them under its own name.

sessions-tiktok.txt records the screen_name, so that is what the candidate list
can filter on before any browser opens; the handle check is what catches the rest
once a browser is looking.

The author's view is still available, as --as-author, for the different
question of whether a comment was deleted outright.

WHAT THIS IS NOT. It is not a re-post. Nothing is written; a comment found
missing is reported and the ledger row is marked, so a later run can decide
whether to write again.

    python verify_comments.py --list                    # the links, no browser
    python verify_comments.py --profile a --list        # ...just this account's
    python verify_comments.py --profile a               # read by other accounts
    python verify_comments.py --profile a --as c,d      # ...by these
    python verify_comments.py --profile a --readers 3   # ask up to three
    python verify_comments.py --all                     # every profile with posts
    python verify_comments.py --profile a --as-author   # what a itself can see
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright

import busy
import console
from login import UA, profile_dir
from like import (
    done_path,
    launch_liker,
    norm,
    open_comments,
    open_video,
    safe_eval,
    video_id,
)

console.fix()

HERE = Path(__file__).resolve().parent

# Every comment on the video, with who wrote it. The same endpoint like.py reads
# to decide what to like, so a comment this cannot see is one the liker could
# not have seen either.
LIST_JS = """async ([awemeId, pages]) => {
  const out = []
  let cursor = 0
  for (let i = 0; i < pages; i++) {
    const r = await fetch(
      `/api/comment/list/?aweme_id=${awemeId}&count=50&cursor=${cursor}&aid=1988`,
      { credentials: 'include', referrer: `https://www.tiktok.com/@x/video/${awemeId}` }
    )
    const body = await r.text()
    if (!body.trim()) break
    let j
    try { j = JSON.parse(body) } catch { break }
    const list = j.comments || []
    for (const c of list) out.push({
      user: ((c.user || {}).unique_id || '').toLowerCase(),
      nick: ((c.user || {}).nickname || '').toLowerCase(),
      text: c.text || '',
    })
    if (!j.has_more || list.length === 0) break
    cursor = Number(j.cursor) || cursor + list.length
  }
  return out
}"""

# WHO IS THIS BROWSER? Two answers, and the weaker one is the one that reads
# cleanly, which is how it did damage.
#
# THE @HANDLE, WHICH IS NOT OUR NAME. The passport endpoint answers with
# screen_name — "misgana a" — and a comment is attributed to a unique_id —
# "drnardime". Comparing the two says every comment we ever wrote is gone: the
# first run of this reported 4 of 4 removed, and all four were on the page.
#
# So the handle is read from the nav — and ONLY from the nav. It used to fall
# back to the first a[href^="/@"] on the page, which on a video page is the
# creator of the video: that printed two different handles for one directory on
# two runs, both of them strangers. An empty handle is the honest answer here and
# the name below carries the identity.
WHOAMI_JS = """async () => {
  const a = document.querySelector('[data-e2e="nav-profile"], [data-e2e="profile-icon"] a')
  const href = a ? (a.getAttribute('href') || '') : ''
  const m = href.match(/^\\/@([^/?#]+)/)
  let name = ''
  try {
    const r = await fetch('/passport/web/account/info/?aid=1459', { credentials: 'include' })
    if (r.ok) {
      const j = await r.json().catch(() => null)
      const d = (j || {}).data || {}
      name = (d.screen_name || d.username || '').toLowerCase()
    }
  } catch (e) { /* the name is a nicety; the handle is the thing */ }
  return { handle: (m ? m[1] : '').toLowerCase(), name }
}"""


def ask_dashboard(rows: list[dict]) -> dict[str, dict]:
    """Ask the dashboard whether these comments are on the videos.

    THE SAME READ THE ADMIN USES on a worker's comments: one plain request to
    TikTok's comment list from the dashboard's own server, nobody signed in.
    Two reasons it is the better answer, and both were measured:

      IT WORKS. From this machine the same request comes back with one to four
      comments on a video with hundreds — throttled — and a check that reads
      four comments reports everything as gone. The dashboard's server reads
      about fifty a link.

      IT IS WHAT EVERYONE ELSE SEES. A comment read from the account that wrote
      it proves only that its author can see it, and TikTok shows a filtered
      comment to its author and to nobody else. The question worth asking is
      whether the world can see it.

    Returns {url: result} for the rows it could ask about, and {} when the
    dashboard is not configured or will not answer — the caller then falls back
    to the browser, which is a weaker answer but still an answer.
    """
    from like import load_env  # local: keeps the import graph one-way

    env = load_env()
    base = (env.get("DASHBOARD_URL") or "").rstrip("/")
    token = env.get("LINKS_EXPORT_TOKEN") or ""
    if not base or not token:
        return {}
    out: dict[str, dict] = {}
    # In batches: the endpoint has sixty seconds and each item is a round trip
    # to TikTok. Twenty-five is its own cap.
    for i in range(0, len(rows), 25):
        chunk = rows[i:i + 25]
        payload = {"items": [{"url": r["url"], "text": r["text"]} for r in chunk]}
        req = urllib.request.Request(
            base + "/api/links/comment-check?" + urlencode({"token": token}),
            data=json.dumps(payload).encode("utf-8"),
            headers={"User-Agent": UA, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:110]
            print(f"  the dashboard would not check: HTTP {e.code} {detail}")
            return {}
        except Exception as e:  # noqa: BLE001
            print(f"  could not reach the dashboard: {str(e)[:70]}")
            return {}
        for res in data.get("results") or []:
            out[str(res.get("url"))] = res
    return out


# WHAT THE LAST CHECK FOUND, kept because the check is expensive and its answer
# is not. Reading twenty comments takes twenty page loads and two browsers; the
# verdict is one line. Without this, --list can only say what we posted, which is
# the half anybody could get from the ledger.
CHECKS = HERE / "comment-checks.csv"


def note_checks(profile: str, by_url: dict[str, dict],
                answer: dict[str, tuple[str, str]], used: list[str]) -> None:
    """Append this run's verdicts. One row per comment, newest last."""
    if not answer:
        return
    when = time.strftime("%Y-%m-%dT%H:%M:%S")
    new = not CHECKS.exists()
    try:
        with CHECKS.open("a", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["checked", "profile", "aweme", "url", "state",
                            "readers", "detail"])
            for url, (state, detail) in answer.items():
                row = by_url.get(url) or {}
                w.writerow([when, profile, row.get("aweme", ""), url, state,
                            " ".join(used), detail])
    except OSError as e:  # noqa: BLE001
        # A check that cannot write its notes is still a check. Say so and
        # carry on.
        print(f"  (could not record the verdicts: {str(e)[:60]})")


def last_checks(profile: str) -> dict[str, tuple[str, str, str, str]]:
    """url -> (when, state, readers, detail) from the most useful past check.

    THE MOST RECENT CONCLUSIVE ONE, not simply the most recent. A later run that
    could find nobody free to look would otherwise erase a real answer with
    "could not check".
    """
    out: dict[str, tuple[str, str, str, str]] = {}
    if not CHECKS.exists():
        return out
    try:
        with CHECKS.open(encoding="utf-8", newline="") as f:
            for r in csv.reader(f):
                if len(r) < 7 or r[0] == "checked" or (profile and r[1] != profile):
                    continue
                url, state = r[3], r[4]
                if state == "unknown" and (out.get(url) or ("", "unknown"))[1] != "unknown":
                    continue
                out[url] = (r[0], state, r[5], r[6])
    except OSError:
        return out
    return out


def list_comments(profile: str) -> int:
    """Every link this account commented on, newest first. Returns how many.

    No browser and no network: the ledger already holds the url, the video, the
    product and the exact words, and the check file holds whatever was last
    learned about each one.
    """
    rows = posted_rows(profile)
    if not rows:
        print(f"[{profile}] has not commented on anything")
        return 0
    seen = last_checks(profile)
    by_state: dict[str, int] = {}
    print(f"[{profile}] commented on {len(rows)} link(s), newest first")
    for row in rows:
        when = (row["when"] or "").replace("T", " ")[:16]
        print(f"  {when}  {row['product'] or '-'}")
        print(f"    {row['url']}")
        print(f"    \u201c{row['text']}\u201d")
        got = seen.get(row["url"])
        if got:
            checked, state, readers, detail = got
            by_state[state] = by_state.get(state, 0) + 1
            print(f"    {MARKS.get(state, state)} — checked {checked.replace('T', ' ')[:16]}"
                  + (f" by {readers}" if readers else "")
                  + (f", {detail}" if detail else ""))
        else:
            by_state["never"] = by_state.get("never", 0) + 1
            print("    not checked yet")
    if by_state:
        print("  " + ", ".join(f"{n} {k}" for k, n in sorted(by_state.items())))
    return len(rows)


def posted_rows(profile: str) -> list[dict]:
    """Every comment this profile's ledger says it posted, newest first.

    The ledger is the record of what was written; it is keyed "post:<aweme>",
    which is what tells a posted comment apart from a liked one.
    """
    path = done_path(profile)
    if not path.exists():
        return []
    out: list[dict] = []
    with path.open(encoding="utf-8", newline="") as f:
        for r in csv.reader(f):
            if len(r) < 8 or not str(r[3]).startswith("post:") or r[6] != "ok":
                continue
            out.append({"when": r[0], "url": r[1], "aweme": r[2],
                        "product": r[4], "text": r[5]})
    out.reverse()
    return out


def account_names() -> dict[str, str]:
    """profile -> the account it is signed in as, as last recorded. {} if none.

    sessions-tiktok.txt is the record, and it is incomplete by design: a profile
    that was in a run when the scan ran could not be opened, so it has no line
    at all. `a` is one of those, which is why a reader on a's own account got
    through the filter and reported a's comments as visible.
    """
    import sessions

    return sessions.read_file(HERE / "sessions-tiktok.txt")


def reader_candidates(author: str, wanted: str = "",
                      wait_min: int = 0) -> tuple[list[str], str]:
    """The profiles that could do the looking, best first. (names, why-not).

    ANY ACCOUNT BUT THE ONE THAT WROTE THE COMMENT. That is the whole point:
    the author is the one viewer TikTok still shows a restricted comment to, so
    its answer is "still there" either way and settles nothing.

    A reader is also far easier to come by than the author's own browser. It
    posts nothing, likes nothing and is recorded nowhere — it only looks — so
    any idle signed-in profile will do, and the profile being checked can stay
    busy with the run that is posting. The old check refused to run at all
    while its profile was in use, which is exactly when it was wanted.

    TWO DIRECTORIES CAN BE ONE ACCOUNT. sessions-tiktok.txt records what each
    profile is signed in as, and profiles on the author's own account are no
    use here, so they come out. That list can be stale, so it is a first cut
    and not the guarantee — the guarantee is in read_pass, which drops a reader
    that turns out to have written the comment it was sent to find.
    """
    known = account_names()
    names = list(known) or __import__("sessions").discover("tiktok")
    if wanted:
        asked = [n.strip() for n in wanted.split(",") if n.strip()]
        if author in asked:
            return [], (f"--as {author} is the account that WROTE these comments. "
                        "It is the one reader that cannot answer the question:\n"
                        "  TikTok shows a restricted comment to its author and to "
                        "nobody else. Use --as-author if that is really what you want.")
        names = asked
    else:
        mine = (known.get(author) or "").strip().lower()
        names = [n for n in names
                 if n != author
                 and not (mine and (known.get(n) or "").strip().lower() == mine)]
        # One profile per account. A second directory on the same login is a
        # second look with the same eyes, and this would rather spend the pass
        # on a different account.
        seen: set[str] = set()
        unique = []
        for n in names:
            acct = (known.get(n) or "").strip().lower()
            if acct and acct in seen:
                continue
            seen.add(acct)
            unique.append(n)
        names = unique
    if not names:
        return [], "there is no other signed-in profile on this machine to read with"

    free = [n for n in names if not busy.is_busy(profile_dir(n))]
    if not free and wait_min > 0:
        print(f"  every account that could look is in a run — waiting up to "
              f"{wait_min} min for one to come free")
        deadline = time.time() + wait_min * 60
        while time.time() < deadline:
            time.sleep(20)
            free = [n for n in names if not busy.is_busy(profile_dir(n), force=True)]
            if free:
                break
    if not free:
        held = ", ".join(names[:6])
        return [], (f"no free profile to read with — {held} are all open in a browser. "
                    "A profile in use cannot be opened twice;\n"
                    "  give this --wait MIN, or --as NAME for one that is idle.")
    return free, ""


def check_one(page, row: dict, handle: str, nick: str, pages: int,
              as_author: bool = False, reader_handle: str = "",
              reader_name: str = "") -> tuple[str, str]:
    """Is our comment under this video, as this browser sees it?

    there       this reader can see it, and this reader did not write it
    unseen      the reader read the comment section, other people's comments
                were in it, and ours was not. One reader's miss; the caller
                asks another before it reports anything
    gone        the same read, when the reader IS the author: not even there
                for them, which is the one account that would still be shown it
    changed     ours, but not the words the ledger recorded
    unknown     nothing was learned — the video would not open, or the read came
                back empty, which is not the same as the comment being absent
    self        the comment is there and it is attributed to THE READER's own
                account — two profile directories, one login. Not a witness at
                all; the caller bars that account and asks another

    THE DIFFERENCE BETWEEN `unseen` AND `unknown` IS THE OTHER COMMENTS.
    A reader that came back with nothing tells us nothing. A reader that came
    back with eight comments by other people, and not ours, has told us
    something specific.
    """
    if not open_video(page, row["url"]):
        return "unknown", "the video would not load"
    open_comments(page)
    rows = safe_eval(page, LIST_JS, [row["aweme"], pages])
    if rows is None:
        return "unknown", "could not read the comments"
    # THE TEXT IS THE IDENTIFIER. The ledger holds the exact words this profile
    # wrote on this video, and no other comment on it will match them. The
    # handle is a second opinion, not the test — it is missing when the nav did
    # not render, and a comment can be ours with the ledger's copy of its text
    # slightly off.
    want = norm(row["text"])[:40]
    if want:
        for c in rows:
            if want in norm(c.get("text") or ""):
                # WRITTEN BY THE READER ITSELF? Then this directory holds the
                # account being checked, and it has found its own comment.
                # The handle is the test: a comment is attributed to a
                # unique_id, and the nav gives this browser's. The nickname is
                # a second opinion and not the same string as either — the
                # account that is @drnardime has screen_name "misgana a" and
                # comments as "dr. nardi".
                writer = (c.get("user") or "").strip()
                if not as_author and (
                        (reader_handle and writer == reader_handle)
                        or (reader_name and (c.get("nick") or "").strip() == reader_name)):
                    return "self", f"@{writer or reader_handle or reader_name}"
                return "there", ""
    mine = [c for c in rows if handle and c.get("user") == handle]
    if mine:
        # This account HAS a comment on this video, but not the words the ledger
        # holds. The comment survived; the record of it is stale.
        return "changed", (mine[0].get("text") or "")[:60]
    # Nothing of ours. Whether that is news depends entirely on whether the
    # reader could see anything at all.
    others = [c for c in rows if not handle or c.get("user") != handle]
    if len(rows) < 1 or not others:
        return "unknown", "the reader saw no comments at all — nothing learned"
    if as_author:
        return "gone", f"not even its author sees it, among {len(rows)} comment(s)"
    return "unseen", (f"{len(others)} other people's comment(s) reached this "
                      "reader, ours did not")


MARKS = {
    "there": "still there",
    "changed": "there, different text",
    "unseen": "UNSEEN — it did not reach the accounts that looked",
    "gone": "GONE",
    "unknown": "could not check",
}


def read_pass(pw, reader: str, rows: list[dict], pages: int, headed: bool,
              as_author: bool, author: str = "") -> tuple[dict[str, tuple[str, str]], str]:
    """One account's look at these rows. ({url: (state, detail)}, same_account).

    The second value is the reader's own ACCOUNT NAME when it turned out to be
    the one that wrote the comments — nothing it saw counts, the caller bars
    that account and moves on to another one.
    """
    out: dict[str, tuple[str, str]] = {}
    ctx = launch_liker(pw, reader, block_media=True, headed=headed)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    try:
        if not open_video(page, rows[0]["url"]):
            print(f"  [{reader}] could not open a video to start from")
            return out, ""
        who = safe_eval(page, WHOAMI_JS) or {}
        handle = str(who.get("handle") or "")
        name = str(who.get("name") or "")
        print(f"  [{reader}] looking as {name or '(account unknown)'}"
              + (f" (@{handle})" if handle else ""))
        # WHOSE HANDLE IS WORTH ANYTHING HERE. Only the author's: it is what
        # tells "our comment, different words" from "not our comment at all".
        # A reader's own handle would only find the reader's own comments.
        mine = handle if as_author else ""
        for i, row in enumerate(rows, 1):
            state, detail = check_one(page, row, mine, name, pages,
                                      as_author=as_author, reader_handle=handle,
                                      reader_name=name)
            if state == "self":
                print(f"  [{reader}] IS the account being checked — it found the "
                      f"comment under its own name, {detail}.\n"
                      f"      profile-{reader} and profile-{author or '?'} hold one "
                      "login, so it cannot tell whether anybody else\n"
                      "      can see this. Dropping it, barring that account, and "
                      "asking somebody else.")
                return {}, name or detail.lstrip("@")
            out[row["url"]] = (state, detail)
            if state in ("there", "changed"):
                print(f"  [{i}/{len(rows)}] {row['aweme']}  {MARKS[state]}"
                      + (f" — {detail}" if detail else "")
                      + ("" if as_author else f", seen by @{handle or reader}"))
            else:
                # NOT A VERDICT YET. Another account may well see it; the
                # verdict is printed once every reader has had its look.
                print(f"  [{i}/{len(rows)}] {row['aweme']}  not visible to "
                      f"@{handle or reader}")
    finally:
        try:
            ctx.close()
        except Exception:  # noqa: BLE001
            pass
    return out, ""


def run(profile: str, limit: int, pages: int, headed: bool, wait_min: int = 0,
        no_dashboard: bool = False, as_profile: str = "", as_author: bool = False,
        readers: int = 2) -> dict:
    rows = posted_rows(profile)
    if limit:
        rows = rows[:limit]
    # `rows` is narrowed to the ones still in question as the sources answer, so
    # the full set is kept here for the record written at the end.
    by_url = {r["url"]: r for r in rows}
    tally = {"profile": profile, "posted": len(rows), "browser": 0,
             "there": 0, "changed": 0, "unseen": 0, "gone": 0, "unknown": 0}
    if not rows:
        print(f"[{profile}] no posted comments in its ledger")
        return tally

    # THE DASHBOARD FIRST, and not for convenience. It reads the comment list
    # signed out, from another machine: no account, nothing to personalise,
    # nothing to restrict. That is the widest view there is, and a comment found
    # in it is a comment the world can see. It needs no browser either, so no
    # profile has to be free for it.
    from_public: set[str] = set()
    answer: dict[str, tuple[str, str]] = {}
    if not no_dashboard:
        print(f"[{profile}] asking the dashboard about {len(rows)} posted comment(s)")
        said = ask_dashboard(rows)
        if said:
            seen_publicly, unsure = [], []
            for row in rows:
                res = said.get(row["url"]) or {}
                (seen_publicly if res.get("found") else unsure).append(row)
            for row in seen_publicly:
                who = (said.get(row["url"]) or {}).get("username") or "?"
                answer[row["url"]] = ("there", f"in the public list, as @{who}")
                print(f"  {row['aweme']}  still there — in the public list, as @{who}")
            if not unsure:
                for state, _ in answer.values():
                    tally[state] += 1
                note_checks(profile, by_url, answer, ["the signed-out read"])
                return tally
            # A MISS IS NOT AN ANSWER. On a throttled read it mostly means the
            # list came back short, not that the comment is absent — so the
            # misses go to the signed-in readers rather than being called gone.
            solid = {r["url"] for r in unsure
                     if not (said.get(r["url"]) or {}).get("thin", True)}
            print(f"[{profile}] {len(unsure)} not in the public read"
                  + (f" ({len(solid)} of them on a read worth trusting)" if solid else
                     " — every one of those reads came back thin")
                  + " — asking signed-in accounts to look")
            rows = unsure
            from_public = solid
        else:
            print(f"[{profile}] the dashboard could not answer — "
                  "opening a browser instead")

    # WHO LOOKS. Not this profile, unless it was asked for: the account that
    # wrote a comment is shown it whatever TikTok has done with it.
    if as_author:
        candidates, readers = [profile], 1
    else:
        candidates, why = reader_candidates(profile, as_profile, wait_min)
        if not candidates:
            print(f"[{profile}] {why}")
            for row in rows:
                answer[row["url"]] = ("unknown", "nobody was free to look")
            for state, _ in answer.values():
                tally[state] += 1
            note_checks(profile, by_url, answer, [])
            return tally

    print(f"[{profile}] checking {len(rows)} posted comment(s) "
          + ("in its OWN browser — the author's view, the one view a restricted "
             "comment still appears in" if as_author
             else f"with up to {readers} other account(s)"))
    tally["browser"] = 1
    pending = list(rows)
    used: list[str] = []
    # ACCOUNTS THAT MAY NOT BE THE WITNESS. The author's, by whatever name the
    # last session scan recorded for it — and then any account a reader turns
    # out to share with it, learned the hard way, from a comment found under the
    # reader's own name. Barring the name and not the directory is the point:
    # this machine keeps two directories on several of these logins.
    known = account_names()
    blocked = {(known.get(profile) or "").strip().lower()} - {""}
    with sync_playwright() as pw:
        for reader in candidates:
            if not pending or len(used) >= readers:
                break
            if busy.is_busy(profile_dir(reader), force=True):
                continue    # it went into a run while we were reading with another
            if (known.get(reader) or "").strip().lower() in blocked:
                print(f"[{profile}] skipping {reader} — it is signed in to the same "
                      "account as the profile being checked")
                continue
            if used:
                print(f"[{profile}] {len(pending)} still unseen — asking {reader}")
            got, same = read_pass(pw, reader, pending, pages, headed, as_author,
                                  profile)
            if same:
                # The author under another directory name. Nothing it saw counts,
                # and no other directory on that account is worth opening.
                blocked.add(same.strip().lower())
                continue
            used.append(reader)
            still = []
            for row in pending:
                state, detail = got.get(
                    row["url"], ("unknown", "the reader did not get to this one"))
                answer[row["url"]] = (state, detail)
                # A HIT ENDS IT: somebody who did not write the comment can see
                # it, which is the whole question. Anything else is one
                # account's miss, and the next account may not miss it.
                if state not in ("there", "changed"):
                    still.append(row)
            pending = still

    # EVERY ROW GETS AN ANSWER, including the ones no reader reached — a run
    # where nobody could look must still add up to the number of comments
    # posted, or the summary quietly loses them.
    for row in pending:
        answer.setdefault(row["url"], ("unknown", "nobody was able to look at it"))
    if pending and not as_author:
        print(f"[{profile}] {len(pending)} seen by none of "
              f"{', '.join(used)}:" if used else
              f"[{profile}] {len(pending)} that nobody could look at:")
    for row in pending:
        state, detail = answer.get(row["url"], ("unknown", ""))
        # THE AUTHOR SEES IT AND THE SIGNED-OUT READ DID NOT. From any other
        # reader that pairing is ambiguous; from the author it is the definition
        # of a restricted comment — where the public read was solid enough to be
        # worth contradicting.
        if as_author and state == "there" and row["url"] in from_public:
            # THE ONE READING THAT EARNS THE WORD: its author has it and a solid
            # signed-out read does not.
            answer[row["url"]] = ("unseen",
                                  "RESTRICTED: its author sees it, the signed-out "
                                  "read does not")
        elif state == "unseen" and len(used) > 1:
            detail += f"; none of {len(used)} accounts were served ours"
            answer[row["url"]] = (state, detail)
        state, detail = answer[row["url"]]
        print(f"  {row['aweme']}  {MARKS[state]}" + (f" — {detail}" if detail else ""))

    for state, _ in answer.values():
        tally[state] += 1
    note_checks(profile, by_url, answer, used)
    return tally


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Check whether the comments we posted are still on the videos.")
    ap.add_argument("--profile", default="", help="one name, or a comma-separated list")
    ap.add_argument("--all", action="store_true",
                    help="every profile whose ledger holds a posted comment")
    ap.add_argument("--list", action="store_true", dest="just_list",
                    help="print the links this account commented on, with the words "
                         "and what the last check found, and stop. No browser")
    ap.add_argument("--limit", type=int, default=0,
                    help="check only the newest N per profile (0 = all of them)")
    ap.add_argument("--pages", type=int, default=3,
                    help="comment pages to read per video; ours can be buried")
    ap.add_argument("--as", dest="as_profile", default="", metavar="PROFILE",
                    help="read with these profiles (comma-separated) instead of "
                         "whichever idle ones are picked. Not the account being checked")
    ap.add_argument("--readers", type=int, default=2, metavar="N",
                    help="how many accounts may look before a comment nobody was "
                         "served is reported. One account's miss is not evidence")
    ap.add_argument("--as-author", action="store_true",
                    help="read with the account that wrote the comments. That answers "
                         "a DIFFERENT question — whether its author can see it — and "
                         "a restricted comment looks perfectly healthy from there")
    ap.add_argument("--browser", action="store_true",
                    help="skip the dashboard and go straight to a signed-in browser")
    ap.add_argument("--wait", type=int, default=0, metavar="MIN",
                    help="if every profile that could do the reading is in a run, wait "
                         "this many minutes for one to come free")
    ap.add_argument("--headed", action="store_true", help="show the browser")
    args = ap.parse_args()

    if args.all or (args.just_list and not args.profile):
        import sessions
        names = [n for n in sessions.discover("tiktok") if posted_rows(n)]
        if not names and args.just_list:
            print("No account has commented on anything yet.")
            return 0
    else:
        names = [p.strip() for p in args.profile.split(",") if p.strip()]
    if not names:
        print("Nothing to check. Give --profile NAME or --all.")
        return 2

    if args.just_list:
        # THE LIST ON ITS OWN. Nothing is opened and nothing is asked: it is the
        # ledger and the last check file, which is what makes it instant and
        # safe to press while every profile is in a run.
        total = 0
        for n in names:
            total += list_comments(n)
            print()
        print(f"{total} commented link(s) across {len(names)} profile(s)")
        if not CHECKS.exists():
            print("None of them have been checked yet — \"Check posted comments\" does that.")
        return 0

    totals = {"posted": 0, "there": 0, "changed": 0, "unseen": 0, "gone": 0,
              "unknown": 0, "browser": 0}
    for n in names:
        t = run(n, args.limit, args.pages, args.headed, args.wait, args.browser,
                args.as_profile, args.as_author, max(1, args.readers))
        for k in totals:
            totals[k] += t[k]
        print()

    # Which question was actually answered. "Still there" from the author's own
    # browser is a weaker claim than "still there" from the public list, and a
    # summary that reads the same either way is the one nobody re-reads.
    if totals.get("browser"):
        if args.as_author:
            print("Read from the profiles' OWN browsers. A comment is shown to its author")
            print("whatever TikTok has done with it, so \"still there\" here means only")
            print("that it has not been deleted — not that anybody else can see it.")
        else:
            print(f"Read by up to {max(1, args.readers)} other signed-in accounts, because a")
            print("comment its author can see is not a comment anybody else can. A hit by any")
            print("of them is proof it is there; a miss by all of them is not proof it is not.")
    kept = totals["there"] + totals["changed"]
    checked = kept + totals["gone"] + totals["unseen"]
    print(f"{totals['posted']} posted comment(s) across {len(names)} profile(s)")
    print(f"  {kept} still on the video"
          + (f" ({totals['changed']} with text the ledger does not match)"
             if totals["changed"] else ""))
    if totals["unseen"]:
        # The state worth acting on, and the one the old check could not see at
        # all: the comment was written, its author sees it, and it reached none
        # of the accounts that went looking — so whatever the mechanism, that
        # run bought nothing.
        print(f"  {totals['unseen']} UNSEEN — not served to any of the accounts that looked")
        print("     (their authors still see them; only a signed-out read can call that")
        print("      a restriction, which is what deploying the dashboard adds)")
    print(f"  {totals['gone']} gone")
    if totals["unknown"]:
        print(f"  {totals['unknown']} could not be checked — nothing learned about those")
    if checked:
        print(f"  {kept * 100 // checked}% of the ones we could check survived")
    return 0


if __name__ == "__main__":
    sys.exit(main())
