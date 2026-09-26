#!/usr/bin/env python3
"""Which profiles are actually signed in, and to which account.

Every profile here is a signed-in browser on disk, and there is no way to tell
from the outside which ones still work: `profile-o` and `profile-p` look
identical in a directory listing whether the session inside is live, expired, or
was abandoned halfway through a login. The only way to know is to open each one
and ask the site.

That is what this does, and it writes the answer to a file so the next person
(or the next run) does not have to ask again:

    python sessions.py                      # tiktok -> sessions-tiktok.txt
    python sessions.py --site instagram
    python sessions.py --profiles a,b,c     # just these
    python sessions.py --out live.txt

The file lists one profile per line, signed-in ones only, with the account it is
signed in as after a #. That is the same shape the other list files in this
project use, so it can be read by eye or by `cut -d' ' -f1`. The header carries
a ready-to-paste --profiles line for run_parallel.py.

A PROFILE THAT IS IN USE IS NOT A PROFILE THAT IS SIGNED OUT.

Chromium locks a user data directory while it has it open, so a profile being
worked by a running liker cannot be opened here. That is reported as "in use"
and it is the one distinction that matters: called "signed out" instead, it
would send somebody to re-login nine perfectly good accounts in the middle of a
run — which is how you lose them.

Nothing is written INTO any profile. Every page is opened read-only, headless,
and closed.
"""
import argparse
import sys
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

from login import (
    HERE,
    is_refusal,
    SITE_HOME,
    SITE_PREFIX,
    UA,
    profile_dir,
    signed_in,
    signed_in_instagram,
    signed_in_youtube,
)

import busy
import console

console.fix()

PROBES = {
    "tiktok": signed_in,
    "instagram": signed_in_instagram,
    "youtube": signed_in_youtube,
}

# What Chromium says when the directory is already open elsewhere. Matched
# loosely because the wording differs by platform and by Playwright version, and
# getting this wrong in the safe direction (calling a busy profile "in use"
# rather than "signed out") costs nothing.
# Words that carry no information, so they are not shown as a reason.
#
# TikTok's passport endpoint answers {"message": "error"} to a visitor who is
# simply not logged in, so its own word for "signed out" is "error" — and
# "SIGNED OUT (error)" reads as though the check itself broke rather than as the
# answer it is.
UNINFORMATIVE = {"", "error", "success", "not signed in", "none"}


def reason(detail: str) -> str:
    """A detail worth printing, or '' when it only repeats the verdict."""
    return "" if detail.strip().lower() in UNINFORMATIVE else detail.strip()


IN_USE_MARKERS = (
    "processsingleton",
    "already in use",
    "cannot create a file when that file already exists",
    "failed to create",
    "singletonlock",
)


def site_of_dir(dirname: str) -> tuple[str | None, str]:
    """Which site a profile directory belongs to, by LONGEST matching prefix.

    THE PREFIXES NEST. TikTok's is "profile", Instagram's "profile-ig",
    YouTube's "profile-yt" — so every Instagram and YouTube directory also
    matches TikTok's prefix, and `profile-ig-b` reads as a TikTok profile named
    "ig-b" unless something says otherwise.

    Longest match is that something, and it has to be longest match rather than
    "exclude the other prefixes": excluding them the other way round throws away
    every Instagram directory, because "profile-" is a prefix of "profile-ig-b"
    too. Both directions are wrong in one direction each; this is right in both.
    """
    best_site: str | None = None
    best = ""
    for s, pfx in SITE_PREFIX.items():
        if dirname == pfx or dirname.startswith(pfx + "-"):
            if len(pfx) > len(best):
                best_site, best = s, pfx
    return best_site, best


def discover(site: str) -> list[str]:
    """Every profile name on disk for one site, in a sensible order."""
    names: list[str] = []
    for d in HERE.iterdir():
        if not d.is_dir():
            continue
        owner, pfx = site_of_dir(d.name)
        if owner != site:
            continue
        name = "default" if d.name == pfx else d.name[len(pfx) + 1 :]
        if name:
            names.append(name)
    # "default" first, then the rest alphabetically — the order somebody would
    # write them in themselves.
    names.sort(key=lambda n: (n != "default", n))
    return names


class Result:
    __slots__ = ("profile", "state", "account", "detail", "seconds", "carried")

    def __init__(self, profile, state, account="", detail="", seconds=0.0, carried=False):
        self.profile = profile
        # refused: the site would not answer (a 403/429 at the probe). NOT a
        # verdict on the session — see is_refusal() in login.py.
        self.state = state          # in | out | in-use | error | no-session | refused
        self.account = account
        self.detail = detail
        self.seconds = seconds
        # True when this row was not checked on this run — it was read back out
        # of the file from a previous one. Kept apart from a fresh answer
        # because it is a weaker claim, and the header says so.
        self.carried = carried


def read_checked(path: Path) -> set[str]:
    """Every profile this file has an OPINION about — signed in or not.

    A profile missing from this set has never been scanned, which is a
    different thing from having been scanned and found signed out. The
    dashboard says which, because the two need different buttons pressed.
    """
    if not path.exists():
        return set()
    seen: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#not-signed-in "):
            seen.update(n.strip() for n in line[len("#not-signed-in "):].split(",") if n.strip())
        else:
            body = line.split("#")[0].strip()
            if body:
                seen.add(body.split()[0])
    return seen


def read_file(path: Path) -> dict[str, str]:
    """The profile -> account pairs already in a list file. {} if there is none.

    Only the data lines: everything from a # onwards is for the reader.
    """
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        body = line.split("#")[0].strip()
        if not body:
            continue
        # Everything after the # is for the reader, and a carried row carries a
        # note as well as the account — "@name   (not re-checked)". The account
        # is the first token; the rest is prose.
        note = line.split("#", 1)[1].strip() if "#" in line else ""
        account = note.split("   ")[0].strip().lstrip("@")
        out[body.split()[0]] = account
    return out


def check_one(pw, site: str, name: str, timeout_ms: int) -> Result:
    """Open one profile, ask the site who it is, close it. Writes nothing."""
    started = time.time()
    pdir = profile_dir(name, site)
    # login.py's own test: the directory is created before the browser launches,
    # so its existence proves nothing — "Default" inside it is what proves a
    # browser ever ran there.
    if not (pdir / "Default").exists():
        return Result(name, "no-session", detail="no browser has ever run in this directory")

    ctx = None
    # Before opening anything: a profile another browser holds cannot be read,
    # and the answer it would give is "signed out" for a session that is fine.
    # This is how the file came to disagree with reality — a scan run while a
    # liker was working.
    if busy.is_busy(pdir):
        return Result(name, "in-use", detail="open in another browser",
                      seconds=time.time() - started)

    try:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(pdir),
            headless=True,
            user_agent=UA,
            locale="en-US",
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
    except Exception as e:  # noqa: BLE001
        msg = str(e).replace("\n", " ")
        low = msg.lower()
        if any(m in low for m in IN_USE_MARKERS):
            return Result(name, "in-use", detail="open in another process",
                          seconds=time.time() - started)
        return Result(name, "error", detail=msg[:160], seconds=time.time() - started)

    try:
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(SITE_HOME[site], wait_until="domcontentloaded", timeout=timeout_ms)
        # The newer sites hydrate after the document lands; probing the instant
        # it loads reports "signed out" for a session that is fine. Same wait
        # login.py uses, for the same reason.
        page.wait_for_timeout(4000)
        ok, who = PROBES[site](page)
        if not ok and is_refusal(who):
            # The site declined to answer. Calling that "signed out" is how a
            # throttled scan sends somebody to re-login accounts that were fine.
            return Result(name, "refused", detail=str(who),
                          seconds=time.time() - started)
        return Result(name, "in" if ok else "out", account=who if ok else "",
                      detail="" if ok else who, seconds=time.time() - started)
    except Exception as e:  # noqa: BLE001
        return Result(name, "error", detail=str(e).replace("\n", " ")[:160],
                      seconds=time.time() - started)
    finally:
        try:
            ctx.close()
        except Exception:  # noqa: BLE001
            pass


def live_profiles(results: list[Result]) -> list[Result]:
    """The signed-in ones, in the order they are always written.

    One ordering, used by the file AND by the --profiles line printed at the
    end: two answers to the same question in the same run is how somebody
    pastes a list that does not match the file beside it.
    """
    live = [r for r in results if r.state == "in"]
    live.sort(key=lambda r: (r.profile != "default", r.profile))
    return live


def write_file(path: Path, site: str, results: list[Result]) -> None:
    live = live_profiles(results)
    checked = [r for r in results if not r.carried]
    busy = [r for r in results if r.state == "in-use"]
    refused = [r for r in results if r.state == "refused"]
    out = [r for r in results if r.state == "out"]
    none = [r for r in results if r.state == "no-session"]
    bad = [r for r in results if r.state == "error"]

    carried = [r for r in results if r.carried]
    # How the run went, in the words of what was actually done. A partial run
    # ("--profiles l") and a full one produce the same file, so the header is
    # the only thing that says which this was — and "3 signed in of 1 checked"
    # is not a sentence anybody can act on.
    # ...and it counts only what this run actually looked at. `out` and friends
    # carry the rows read back out of the old file too, so counting them here
    # produced "1 checked just now, 1 signed out" for a run that checked one
    # profile and found it signed IN — the signed-out one having been somebody
    # else's answer, weeks ago.
    def now(rows):
        return [r for r in rows if not r.carried]

    tail = (
        (f", {len(now(busy))} in use by a running liker" if now(busy) else "")
        + (f", {len(now(out))} signed out" if now(out) else "")
        + (f", {len(now(none))} never logged in" if now(none) else "")
        + (f", {len(now(bad))} could not be opened" if now(bad) else "")
        + (f", {len(now(refused))} the site would not answer about" if now(refused) else "")
    )
    lines = [f"# {site} profiles with a live session — {datetime.now():%Y-%m-%d %H:%M}"]
    if carried:
        # A carried row was NOT checked on this run. Saying so is the difference
        # between a list and a guess: it was true the last time somebody looked,
        # which is not the same as true now.
        lines.append(
            f"# {len(live)} listed. {len(checked)} checked just now{tail}; "
            f"{len(carried)} carried over from an earlier run and not re-checked."
        )
    else:
        lines.append(f"# {len(live)} signed in of {len(checked)} checked{tail}.")
    if busy:
        # The one thing a reader must not conclude from this file is that a busy
        # profile is a dead one. Said here as well as in the terminal, because
        # the file outlives the terminal.
        lines += [
            "#",
            "# IN USE, so not checked — these are almost certainly fine, they were",
            "# simply open in another process when this ran:",
            "#   " + ", ".join(r.profile for r in busy),
        ]
    if refused:
        lines += [
            "#",
            "# NO ANSWER — the site returned a 4xx/5xx to the check on these, which is",
            "# what it does to a machine it is throttling. Nothing was learned about",
            "# their sessions. Wait and check again; do not sign them in on this:",
            "#   " + ", ".join(r.profile for r in refused),
        ]
    # Checked, and NOT signed in. Recorded because the file otherwise lists only
    # the profiles that passed, and a reader then cannot tell "we looked and it
    # was signed out" from "nobody has ever looked at this one". Those are
    # different problems: the first needs a login, the second needs a scan.
    #
    # On a comment line with a fixed prefix so it is readable by eye and by
    # read_checked() without becoming a second data format.
    # NOT the refused ones. A profile the site would not answer about has not
    # been judged, and this line is read back by read_checked() as "we looked
    # and there was no session" — an opinion this run does not have.
    negative = out + none + bad
    if negative:
        lines += [
            "#",
            "# CHECKED AND NOT SIGNED IN — a scan looked at these and found no session:",
            "#not-signed-in " + ",".join(r.profile for r in negative),
        ]
    if live:
        lines += [
            "#",
            "# For run_parallel.py:",
            "#   --profiles " + ",".join(r.profile for r in live),
        ]
    lines.append("#")
    # Padded so the accounts line up. This file is read by eye more often than
    # by anything else, and "which profile is @Kinprose" is the question it
    # exists to answer.
    w = max((len(r.profile) for r in live), default=0)
    for r in live:
        note = f"  # @{r.account}" if r.account else ""
        if r.carried and note:
            note += "   (not re-checked)"
        lines.append(f"{r.profile:<{w}}" + note)
    if not live:
        lines.append("# (none)")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Check which profiles are signed in, and write the list to a file."
    )
    ap.add_argument("--site", default="tiktok", choices=["tiktok", "instagram", "youtube"])
    ap.add_argument("--profiles", default="",
                    help="comma-separated names to check (default: every profile on disk)")
    ap.add_argument("--out", type=Path, default=None,
                    help="where to write the list (default: sessions-<site>.txt)")
    ap.add_argument("--timeout", type=int, default=30000,
                    help="milliseconds to wait for each profile's page (default 30000)")
    args = ap.parse_args()

    names = (
        [p.strip() for p in args.profiles.split(",") if p.strip()]
        if args.profiles
        else discover(args.site)
    )
    if not names:
        print(f"No {args.site} profiles on disk. Sign one in first:")
        print(f"  python login.py --site {args.site} --profile a")
        return 1

    out_path = args.out or (HERE / f"sessions-{args.site}.txt")
    # CHECKING SOME OF THEM MUST NOT DELETE THE REST.
    #
    # `--profiles l` writes the same file as a full scan, and without this it
    # would write a file containing only `l` — throwing away fifteen profiles
    # that were never in question. Everything already listed and not checked on
    # this run is carried over, and marked as carried.
    # Read whatever is already there even for a full scan: a profile the site
    # refuses to answer about keeps its previous entry rather than falling out
    # of the list on the strength of a non-answer.
    previous = read_file(out_path)
    # The negatives are carried too, for the same reason the positives are:
    # checking profile l must not make the file forget that o was looked at.
    previously_checked = read_checked(out_path) if args.profiles else set()
    print(f"Checking {len(names)} {args.site} profile(s): {', '.join(names)}")
    print()

    results: list[Result] = [
        Result(name, "in", account=account, carried=True)
        for name, account in (previous if args.profiles else {}).items()
        if name not in set(names)
    ] + [
        Result(name, "out", carried=True)
        for name in sorted(previously_checked - set(previous) - set(names))
    ]
    if results:
        print(f"Carrying over {len(results)} profile(s) already in {out_path.name} "
              "that this run does not check.")
    width = max(len(n) for n in names)
    try:
        with sync_playwright() as pw:
            for i, name in enumerate(names, 1):
                r = check_one(pw, args.site, name, args.timeout)
                if r.state in ("refused", "in-use") and name in previous:
                    # Nothing was learned, so nothing is unlearned: it keeps the
                    # entry it already had, marked as not re-checked. Both cases
                    # are non-answers — the site would not say, or another
                    # browser had the profile and this one could not read it.
                    r = Result(name, "in", account=previous[name], detail=r.detail,
                               seconds=r.seconds, carried=True)
                results.append(r)
                mark = {
                    "in": "signed in",
                    "out": "SIGNED OUT",
                    "in-use": "in use — not checked",
                    "no-session": "never logged in",
                    "refused": "no answer — the site would not say",
                    "error": "could not open",
                }[r.state]
                why = reason(r.detail)
                extra = f" as @{r.account}" if r.account else (f" ({why})" if why else "")
                print(f"  [{i}/{len(names)}] {name:<{width}}  {mark}{extra}   {r.seconds:.0f}s",
                      flush=True)
    except KeyboardInterrupt:
        # Write what was learned rather than throwing it away: a partial answer
        # about nine profiles is worth more than no answer about eighteen, and
        # the header says how many were checked.
        print("\nStopped early — writing what was checked so far.")

    write_file(out_path, args.site, results)

    live = live_profiles(results)
    busy = [r for r in results if r.state == "in-use"]
    fresh = [r for r in results if not r.carried]
    carried = len(results) - len(fresh)
    print(
        f"\n{len(fresh)} checked, {len(live)} signed in"
        + (f" ({carried} carried over, not re-checked)" if carried else "")
        + f". Written to {out_path}"
    )
    if live:
        print("  --profiles " + ",".join(r.profile for r in live))
    if busy:
        print(f"\n{len(busy)} profile(s) were in use and could not be checked: "
              + ", ".join(r.profile for r in busy))
        print("  They are open in another process — almost certainly a running liker.")
        print("  Being in use says nothing about whether they are signed in; stop the run,")
        print("  or check those separately, before treating any of them as logged out.")
    refused = [r for r in results if r.state == "refused"]
    if refused:
        print(f"\n{args.site} would not answer about {len(refused)} profile(s): "
              + ", ".join(r.profile for r in refused))
        print("  A 403 or 429 at the check is the site throttling this machine — running")
        print("  many browsers at once is what causes it. It is not a dead session.")
        print("  Wait a while and check those again. Do NOT sign them in on this.")
    dead = [r for r in results if r.state in ("out", "no-session") and not r.carried]
    if dead:
        print("\nSign these in again:")
        for r in dead:
            print(f"  python login.py --site {args.site} --profile {r.profile}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
