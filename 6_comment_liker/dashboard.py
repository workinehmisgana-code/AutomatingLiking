#!/usr/bin/env python3
"""A local control panel for the liker.

    python dashboard.py            # then open http://127.0.0.1:8765

Everything this project does, from one page: which profiles are signed in and
as whom, what each one's settings are, starting and stopping runs, and the live
output of every profile as it works.

TWO WAYS TO RUN, which is the distinction the page is built around:

  IN COLLECTION   one run_parallel.py over one pool of links, shared between
                  the profiles (split) or given to all of them (stack). One set
                  of settings, because there is one run.

  INDEPENDENTLY   one like.py per profile, each with its own settings and its
                  own links. Nothing shared, nothing co-ordinated — for when
                  the profiles are doing different jobs.

WHY NO FRAMEWORK. requirements.txt says `playwright` and nothing else, and a
control panel is not a reason to add a web stack to a scraping project. This is
http.server from the standard library, which is enough for one page and a
handful of JSON endpoints.

BOUND TO LOCALHOST, DELIBERATELY. This page can start browsers that are signed
in to real accounts and can post public comments. It listens on 127.0.0.1 only
and refuses to bind anywhere else without --i-know, because "just for a minute"
is how a thing like this ends up reachable from a hotel wifi.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import busy
import dashboard_settings as ds
from login import SITE_PREFIX, profile_dir  # noqa: F401  (profile_dir used below)

import console

console.fix()

HERE = Path(__file__).resolve().parent
STORE = HERE / "dashboard.json"
PAGE = HERE / "dashboard.html"
LOGS = HERE / "logs"

# Output lines kept per profile for the page. The whole thing is on disk; this
# is what the browser is handed, and a browser that has been open for six hours
# must not be holding six hours of scrollback in memory.
TAIL = 400


# ── settings ────────────────────────────────────────────────────────────────
def load_store() -> dict:
    if STORE.exists():
        try:
            raw = json.loads(STORE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            raw = {}
    else:
        raw = {}
    # WHO WAS LAST RUN, per platform: {"tiktok": ["a", "b"], ...}.
    #
    # Per platform because the rosters are different — the profiles signed in on
    # Instagram are not the ones signed in on TikTok, and one list would offer a
    # selection that cannot run.
    picked = raw.get("selected")
    selected = {}
    if isinstance(picked, dict):
        for plat, names in picked.items():
            if isinstance(names, list):
                selected[str(plat)] = [str(n) for n in names if str(n).strip()]
    return {
        "shared": ds.clean(raw.get("shared") or {}),
        # {profile: {"enabled": bool, "overrides": {...}}}
        "profiles": raw.get("profiles") or {},
        "selected": selected,
    }


def save_store(store: dict) -> None:
    # Written whole, through a temp file: a half-written settings file is a
    # dashboard that will not start, and it is the only state this thing keeps.
    tmp = STORE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(store, indent=2), encoding="utf-8")
    tmp.replace(STORE)


def profile_entry(store: dict, name: str) -> dict:
    """Everything the dashboard knows about one Chrome profile.

    `overrides` is how it RUNS. The rest is what it IS: a label so a directory
    called profile-j means something six weeks later, whether it is switched on
    at all, and where "Open browser" should land — usually the site's home page,
    but the settings page is the one people actually want.
    """
    e = store["profiles"].get(name) or {}
    return {
        "enabled": bool(e.get("enabled", True)),
        "label": str(e.get("label") or ""),
        "start_url": str(e.get("start_url") or ""),
        "overrides": e.get("overrides") or {},
    }


# ── what is on disk ─────────────────────────────────────────────────────────
def known_profiles(site: str = "tiktok") -> list[str]:
    """Profiles on disk for this site, from the same rule sessions.py uses."""
    import sessions

    return sessions.discover(site)


def profiles_for(site: str) -> list[str]:
    """Every profile NAME this site could work — its own, plus TikTok's.

    THE NAMES ARE THE ROSTER; the directories are one per site. Seventeen
    accounts were set up on TikTok as a, b, c…, and the Instagram and YouTube
    work is the same seventeen people's other accounts. Listing only the
    directories that exist meant Instagram opened on an empty page with nothing
    to press, and the names would have had to be typed in again — twice, once
    per site, matching by hand.

    So a name known to TikTok is offered here too, and signing in is what makes
    the directory. Nothing is copied: profile-ig-a is a fresh browser, because
    it is a different account and a copied TikTok session would be neither.
    """
    here = known_profiles(site)
    if site == "tiktok":
        return here
    seen = set(here)
    carried = [n for n in known_profiles("tiktok") if n not in seen]
    names = here + carried
    names.sort(key=lambda n: (n != "default", n))
    return names


def session_checked(site: str = "tiktok") -> set[str]:
    """Profiles the session list has an opinion about, signed in or not."""
    import sessions

    return sessions.read_checked(HERE / f"sessions-{site}.txt")


def session_list(site: str = "tiktok") -> dict[str, str]:
    """profile -> account, from sessions-<site>.txt if it has been written.

    READ, NEVER RUN. Scanning opens eighteen browsers and takes two minutes; a
    page that did it on every refresh would be unusable and would hammer TikTok.
    The page shows when the file was written and offers a button to refresh it.
    """
    import sessions

    return sessions.read_file(HERE / f"sessions-{site}.txt")


def file_age(f: Path) -> str | None:
    """When a file was last written, or None if it never has been."""
    if not f.exists():
        return None
    return datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M")


def session_file_age(site: str = "tiktok") -> str | None:
    return file_age(HERE / f"sessions-{site}.txt")


def registered_emails() -> dict[str, dict]:
    """profile -> the address its account was registered with, from emails.csv.

    READ, NEVER RUN, for the same reason the session list is: finding these
    opens every profile's browser and asks Google. The page shows when the file
    was written and has a button to redo it.
    """
    import csv

    f = HERE / "emails.csv"
    if not f.exists():
        return {}
    out: dict[str, dict] = {}
    try:
        with f.open(encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                name = (row.get("profile") or "").strip()
                if not name:
                    continue
                out[name] = {
                    "email": (row.get("google_email") or "").strip(),
                    "masked": (row.get("tiktok_email_masked") or "").strip(),
                    # "yes" only when the full address fits TikTok's mask. An
                    # unconfirmed one is a guess from the account chooser, and
                    # the page must not present it as fact.
                    "confirmed": (row.get("confirmed") or "").strip(),
                    "username": (row.get("tiktok_username") or "").strip(),
                    "note": (row.get("note") or "").strip(),
                }
    except Exception:  # noqa: BLE001
        return {}
    return out


def ledger_counts(site: str = "tiktok") -> dict[str, dict]:
    """How much each profile has done ON THIS SITE, from its own ledger.

    The three sites' ledgers sit in one directory and their names nest —
    done-a.csv, done-ig-a.csv, done-yt-a.csv — so a plain glob for done*.csv
    reads "ig-a" and "yt-a" as TikTok profiles called ig-a and yt-a, and misses
    the real ones entirely. Same trap the profile directories have, and the same
    rule: longest prefix wins.
    """
    import csv

    tag = {"tiktok": "", "instagram": "-ig", "youtube": "-yt"}[site]
    others = [t for t in ("-ig", "-yt") if t != tag]
    out: dict[str, dict] = {}
    for f in HERE.glob(f"done{tag}*.csv"):
        stem = f.stem                       # done | done-a | done-ig-b
        if not tag and any(stem.startswith(f"done{o}") for o in others):
            continue                        # another site's, not a profile of ours
        name = "default" if stem == f"done{tag}" else stem[len(f"done{tag}-"):]
        if not name:
            continue
        ok = fail = 0
        try:
            with f.open(encoding="utf-8", newline="") as fh:
                for row in csv.reader(fh):
                    if len(row) < 7:
                        continue
                    if row[6] == "ok":
                        ok += 1
                    elif row[6] and row[6] != "status":
                        fail += 1
        except Exception:  # noqa: BLE001
            continue
        out[name] = {"ok": ok, "failed": fail,
                     "at": datetime.fromtimestamp(f.stat().st_mtime).strftime("%m-%d %H:%M")}
    return out


# ── what a run is doing, while it does it ───────────────────────────────────
#
# The ledger column says what a profile has done ever. During a run the question
# is what it is doing NOW — is this account working, is it stuck, is it liking
# anything — and "4,184" does not move enough to answer it.
#
# The ledger is the source rather than the printed output: like.py flushes a row
# per comment as it goes, and both runners write the same file, so this works
# for a collection run where seventeen profiles share one job's stdout.
#
# SINCE is a timestamp, not a row count. Every run begins by purging failed rows
# so they are tried again, which makes the file SHORTER — a count taken before
# that would skip real work afterwards.
class Live:
    """One profile's share of the current run, read from its own ledger."""

    def __init__(self, profile: str, since: str, platform: str = "tiktok"):
        self.profile = profile
        self.platform = platform
        self.path = ledger_file(profile, platform)
        self.since = since
        self.likes = 0
        self.failed = 0
        self.links = 0
        self.at = ""
        self._stamp = None

    def refresh(self) -> None:
        import csv

        try:
            st = self.path.stat()
        except OSError:
            return
        stamp = (st.st_mtime, st.st_size)
        if stamp == self._stamp:
            return          # nothing appended since the last look
        self._stamp = stamp
        likes = failed = 0
        videos = set()
        try:
            with self.path.open(encoding="utf-8", newline="") as fh:
                # csv.reader over the whole file, not a line split: a comment
                # can contain a newline, and it is quoted rather than escaped.
                for row in csv.reader(fh):
                    if len(row) < 7 or row[0] < self.since:
                        continue
                    if row[6] == "ok":
                        likes += 1
                        videos.add(row[2])
                    elif row[6] and row[6] != "status":
                        failed += 1
        except Exception:  # noqa: BLE001
            return
        self.likes, self.failed, self.links = likes, failed, len(videos)
        self.at = datetime.fromtimestamp(st.st_mtime).strftime("%H:%M:%S")


LIVE: dict[str, Live] = {}


def ledger_file(profile: str, platform: str = "tiktok") -> Path:
    """The ledger this platform's liker writes for this profile.

    Three files per profile, one per site, because three browsers are working
    three different sets of links — like_web.ledger_path picks these names and
    this has to agree with it exactly or the page counts nothing.
    """
    site = ds.site_of(platform)
    tag = {"tiktok": "", "instagram": "-ig", "youtube": "-yt"}[site]
    stem = f"done{tag}" + ("" if profile == "default" else f"-{profile}")
    return HERE / f"{stem}.csv"


def begin_live(names: list[str], platform: str = "tiktok") -> None:
    """Start counting again, from now, for the profiles about to run.

    NOW, with no slack. The children start after this call, so nothing they
    write can predate it, and a second of leeway would instead count the rows of
    whatever finished a moment ago — which is how a fresh run starts out
    claiming likes it did not make.

    Timestamps are whole seconds, so a row written earlier in this same second
    counts. One second of overlap, against a wrong number that never corrects
    itself.
    """
    since = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    for n in names:
        # Keyed by platform too: the same letter can be working TikTok and
        # Instagram at once, and they are two runs with two ledgers.
        LIVE[job_key(n, platform)] = Live(n, since, platform)


def live_counts(platform: str = "tiktok") -> dict[str, dict]:
    """What each profile has done on THIS platform since its run started."""
    out = {}
    for key, lv in LIVE.items():
        name, plat = job_parts(key)
        if plat != platform:
            continue
        lv.refresh()
        at, of = SEEN_AT.get(key, (0, 0))
        out[name] = {"likes": lv.likes, "links": lv.links, "failed": lv.failed,
                     "at": lv.at, "since": lv.since, "seen": at, "total": of}
    return out


# THE ACCOUNT A PROFILE IS REALLY SIGNED IN AS.
#
# The column used to come only from sessions-tiktok.txt, which is whenever the
# last scan ran — and a scan that ran while a liker held the profile could not
# read its cookies at all, so it recorded the wrong thing (see busy.py). Names
# went stale, and two profiles could end up showing one account.
#
# A run says who it is, in its own first lines, from inside the browser that
# has the session open:
#
#     signed in as Misgana a · using 32 param(s) from capture.json
#
# That is the one source that cannot be stale, so it wins.
import re as _re_acct

# run_parallel prefixes every child line with the profile it came from —
# "[k         ] signed in as user3995128760667 · using 32 param(s)" — so one
# pattern reads both an independent run (no prefix, the job IS the profile) and
# a collection one.
SAID_ACCOUNT = _re_acct.compile(
    r"^(?:\[\s*(?P<from>[^\]\s]+)\s*\]\s*)?signed in as (?P<who>.+?)(?:\s+·|\s*$)"
)
SEEN_ACCOUNT: dict[str, str] = {}

# HOW FAR DOWN THE LIST, which the ledger cannot say.
#
# Most of a run is videos that are already done: like.py prints "all done
# already" and writes nothing, so a profile can work steadily for ten minutes
# while its likes-this-run stays at zero. Reading that as "doing nothing" — or
# as "failing", when the only new row is one failure — is exactly the wrong
# conclusion, and it is the one the numbers invited.
#
#     [43/1368] 7681832692882640135: 1 match, all done already
AT_VIDEO = _re_acct.compile(
    r"^(?:\[\s*(?P<from>[^\]\s]+)\s*\]\s*)?\[(?P<at>\d+)/(?P<of>\d+)\]"
)
SEEN_AT: dict[str, tuple[int, int]] = {}

# A WORKER THAT FINISHED ITS LIST IS NOT A WORKER THAT DIED.
#
# like.py exits 1 when any like failed, and Python exits 1 on an uncaught
# traceback, so from outside the two are identical — and every job that had a
# single failed like was painted red as "failed" beside jobs that had actually
# crashed. On a run where most videos were already done, that was most of them.
#
# What separates them is the closing summary, the last thing like.py prints and
# only when it reached the end of its list:
#
#     70 liked, 2 failed. Log: ...done-j.csv
#
# The same marker run_parallel uses to tell a crash from a finish — see
# check_runlog.py, which exists because the exit code cannot answer this.
FINISHED = _re_acct.compile(
    r"^(?:\[\s*(?P<from>[^\]\s]+)\s*\]\s*)?(?P<ok>\d+) liked, (?P<failed>\d+) failed"
)


def note_finished(job, line: str) -> None:
    if FINISHED.match(line.strip()):
        job.finished_list = True


def note_progress(job, line: str) -> None:
    m = AT_VIDEO.match(line.strip())
    if not m:
        return
    name, platform = job_parts(job.name)
    name = m.group("from") or name
    if name and job.kind in ("like", "web", "parallel"):
        SEEN_AT[job_key(name, platform)] = (int(m.group("at")), int(m.group("of")))


def note_account(job, line: str) -> None:
    """Learn a profile's account from what its own run just printed."""
    m = SAID_ACCOUNT.match(line.strip())
    if not m:
        return
    who = (m.group("who") or "").strip().lstrip("@")
    # like.py says this when TikTok would not answer but the page is signed in.
    # It is an admission of not knowing, not a name.
    if not who or who.lower().startswith("unknown"):
        return
    name, platform = job_parts(job.name)
    name = m.group("from") or name
    if name and job.kind in ("like", "web", "parallel"):
        SEEN_ACCOUNT[job_key(name, platform)] = who


# ── running ─────────────────────────────────────────────────────────────────
class Job:
    """One child process, and everything the page needs to say about it."""

    def __init__(self, name: str, kind: str, cmd: list[str], log: Path):
        self.name = name          # profile name, or "collection"
        self.kind = kind          # like | parallel | tool
        self.cmd = cmd
        self.log = log
        self.started = time.time()
        self.finished: float | None = None
        self.code: int | None = None
        self.lines: deque[str] = deque(maxlen=TAIL)
        self.seq = 0              # total lines ever, so the page can ask for new ones
        self.proc: subprocess.Popen | None = None
        self.stopping = False
        # Did it print its closing summary? That is the difference between a
        # list worked to the end and a worker that died somewhere in it.
        self.finished_list = False

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def state(self) -> str:
        if self.running:
            return "stopping" if self.stopping else "running"
        if self.code is None:
            return "starting"
        # A job somebody stopped is not a job that failed. terminate() leaves a
        # non-zero exit code on every platform, so without this every deliberate
        # stop would be painted red and reported as a fault.
        if self.stopping:
            return "stopped"
        if self.code == 0:
            return "done"
        # It said its piece before exiting, so it got to the end of its list.
        # The non-zero code means some likes failed, which the ledger already
        # records comment by comment.
        return "some-failed" if self.finished_list else "failed"


class Runner:
    """Every job the dashboard has started this session."""

    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.run_dir = LOGS / f"dash-{datetime.now():%Y%m%d-%H%M%S}"

    def start(self, name: str, kind: str, cmd: list[str]) -> tuple[bool, str]:
        with self.lock:
            old = self.jobs.get(name)
            if old is not None and old.running:
                return False, f"{name} is already running."
            self.run_dir.mkdir(parents=True, exist_ok=True)
            job = Job(name, kind, cmd, self.run_dir / f"{name}.log")
            self.jobs[name] = job
        try:
            job.proc = subprocess.Popen(
                cmd, cwd=str(HERE), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                # Without this the child gets cp1252 on Windows, because its
                # stdout is a pipe rather than a console, and dies on the first
                # box-drawing character it prints. See console.py.
                env=console.child_env(),
            )
        except Exception as e:  # noqa: BLE001
            job.code = -1
            job.finished = time.time()
            job.lines.append(f"could not start: {e}")
            return False, str(e)
        threading.Thread(target=self._pump, args=(job,), daemon=True).start()
        return True, ""

    def _pump(self, job: Job) -> None:
        fh = job.log.open("a", encoding="utf-8", newline="")
        fh.write(f"\n===== {datetime.now():%Y-%m-%d %H:%M:%S} =====\n")
        fh.write("$ " + " ".join(job.cmd) + "\n")
        try:
            assert job.proc is not None and job.proc.stdout is not None
            for line in job.proc.stdout:
                text = line.rstrip()
                fh.write(line if line.endswith("\n") else line + "\n")
                fh.flush()
                if text.strip():
                    job.lines.append(text)
                    job.seq += 1
                    note_account(job, text)
                    note_progress(job, text)
                    note_finished(job, text)
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                job.code = job.proc.wait() if job.proc else -1
            except Exception:  # noqa: BLE001
                job.code = -1
            job.finished = time.time()
            fh.write(f"----- exit {job.code}\n")
            fh.close()

    def stop(self, name: str) -> bool:
        job = self.jobs.get(name)
        if job is None or not job.running or job.proc is None:
            return False
        job.stopping = True
        # terminate, not kill: the workers close their browser context and
        # flush their ledger on the way out, and a killed one leaves a
        # half-written profile directory behind.
        try:
            job.proc.terminate()
        except Exception:  # noqa: BLE001
            return False
        return True

    def stop_all(self) -> int:
        return sum(1 for n in list(self.jobs) if self.stop(n))

    def snapshot(self, since: dict[str, int]) -> dict:
        out = {}
        for name, job in self.jobs.items():
            have = int(since.get(name, 0) or 0)
            new = list(job.lines)[max(0, have - (job.seq - len(job.lines))):] if job.seq > have else []
            out[name] = {
                "kind": job.kind,
                "state": job.state(),
                "code": job.code,
                "seq": job.seq,
                "seconds": int((job.finished or time.time()) - job.started),
                "cmd": " ".join(job.cmd),
                "log": str(job.log),
                "new": new,
            }
        return out


RUNNER = Runner()


# ── the API ─────────────────────────────────────────────────────────────────
def build_state(since: dict[str, int]) -> dict:
    store = load_store()
    # EVERYTHING BELOW IS PER PLATFORM. The profiles on disk, the session file,
    # the accounts, the ledgers and the jobs are all a different set for
    # Instagram than for TikTok — showing TikTok's profile list beside an
    # Instagram run is how somebody starts a run on a profile that has never
    # been signed in to the site they chose.
    platform = ds.platform_of(store["shared"])
    site = ds.site_of(platform)
    # Which of the names actually have a browser directory HERE. The rest are
    # TikTok's, offered so they can be set up on this site without being typed
    # in again.
    on_disk = set(known_profiles(site))
    names = profiles_for(site)
    accounts = session_list(site)
    checked = session_checked(site)
    ledgers = ledger_counts(site)
    live = live_counts(platform)
    mails = registered_emails()
    profiles = []
    for n in names:
        e = profile_entry(store, n)
        profiles.append({
            "name": n,
            "enabled": e["enabled"],
            "label": e["label"],
            "start_url": e["start_url"],
            "overrides": e["overrides"],
            "dir": profile_dir(n, site).name,
            # False = this name exists on TikTok but has no browser here yet.
            # Signing in creates it; until then there is nothing to run.
            "here": n in on_disk,
            "email": mails.get(n, {}),
            # What a run of this profile said about itself, if one has: read
            # from inside the browser holding the session, so it outranks a scan
            # that may have been taken while the profile was busy.
            "account": SEEN_ACCOUNT.get(job_key(n, platform)) or accounts.get(n, ""),
            "said": SEEN_ACCOUNT.get(job_key(n, platform), ""),
            "known": n in accounts or job_key(n, platform) in SEEN_ACCOUNT,
            # Checked and signed out, versus never checked at all. A profile
            # created after the last scan is not a profile with a dead session,
            # and telling somebody to sign it in again would be wrong twice.
            "checked": n in checked and n in on_disk,
            "ledger": ledgers.get(n, {"ok": 0, "failed": 0, "at": ""}),
            # Empty until this profile has been in a run started from here.
            "live": live.get(n, {}),
        })
    return {
        "profiles": profiles,
        "shared": store["shared"],
        "fields": [
            {"key": f.key, "label": f.label, "kind": f.kind, "default": f.default,
             "choices": list(f.choices), "per_profile": f.per_profile,
             "targets": list(f.targets), "group": f.group, "help": f.help}
            for f in ds.FIELDS
        ],
        "groups": [{"key": k, "label": v} for k, v in ds.GROUPS],
        "jobs": RUNNER.snapshot(since),
        "platform": platform,
        "site": site,
        # The profiles the last run on this platform used. Names only — whether
        # each still exists and can run is decided by the page against the list
        # beside it, so a profile deleted since then simply is not there.
        "selected": store.get("selected", {}).get(platform, []),
        "platforms": [{"key": k, "label": v["label"], "site": v["site"],
                       "script": v["script"]} for k, v in ds.PLATFORMS.items()],
        "sessionsAt": session_file_age(site),
        "emailsAt": file_age(HERE / "emails.csv"),
        "runDir": str(RUNNER.run_dir),
    }


# A profile name becomes a directory name, and the three sites\' prefixes nest:
# a TikTok profile called "ig-b" would create profile-ig-b, which everything
# here would then read as Instagram\'s "b". Refused rather than allowed to
# create a directory that means something else.
import re as _re

NAME_RE = _re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")


def add_profile(name: str, site: str = "tiktok") -> tuple[bool, str]:
    """Make room for a new Chrome profile. It is empty until somebody signs in."""
    import sessions

    if not NAME_RE.match(name):
        return False, "Letters, digits, dot, dash and underscore only; 32 max."
    if name in known_profiles(site):
        return False, f"{name} already exists."
    pdir = profile_dir(name, site)
    owner, _ = sessions.site_of_dir(pdir.name)
    if owner != site:
        others = ", ".join(p for s, p in SITE_PREFIX.items() if s != site)
        return False, (f"That name would create {pdir.name}, which reads as a {owner} "
                       f"profile rather than a {site} one. Avoid names starting with "
                       f"{others.replace('profile-', '')}.")
    try:
        pdir.mkdir(parents=True, exist_ok=True)
    except Exception as e:  # noqa: BLE001
        return False, str(e)
    store = load_store()
    store["profiles"].setdefault(name, {"enabled": True, "overrides": {}})
    save_store(store)
    # Deliberately NOT signed in here: that opens a browser somebody has to sit
    # in front of, and the page has a button for it.
    return True, f"{pdir.name} created. Press Sign in to put an account in it."


def delete_profile(name: str, site: str = "tiktok") -> tuple[bool, str]:
    """Remove one profile's browser directory for this site.

    THE DIRECTORY IS THE ACCOUNT. Deleting it signs that account out on this
    machine and there is no undo — no recycle bin, because a Chrome user data
    directory is thousands of files and Windows will not send them there
    quickly. Whoever presses this needs the account's password to get back in.

    What it does NOT touch, deliberately:

      * the LEDGER (done-x.csv). That is the record of work already done and
        paid for, and it is also what stops the same comments being liked
        twice if the profile is ever set up again. Deleting a browser is not a
        reason to lose it.
      * the other sites' directories. profile-a, profile-ig-a and profile-yt-a
        are three browsers with three accounts; removing the Instagram one has
        nothing to say about the other two.
      * the name's settings (label, overrides), for the same reason — unless
        this was its last directory anywhere, in which case the name is gone
        and keeping its settings is keeping a ghost.

    Refused while a browser has it open: the files are locked, the delete would
    half-finish, and what is left is a corrupt profile rather than no profile.
    """
    import shutil

    import sessions

    if not NAME_RE.match(name):
        return False, "Not a profile name."
    pdir = profile_dir(name, site)
    if not pdir.exists():
        return False, f"{pdir.name} does not exist."
    if busy.is_busy(pdir):
        return False, (f"{pdir.name} is open in a browser right now. Stop that run "
                       "first — deleting a directory Chrome is holding leaves a "
                       "half-deleted profile rather than none.")
    held = profiles_held()
    if f"{name}@{site}" in held:
        return False, f"{name} is running ({held[f'{name}@{site}']}). Stop it first."
    try:
        shutil.rmtree(pdir)
    except Exception as e:  # noqa: BLE001
        return False, f"could not remove {pdir.name}: {e}"

    # The name survives as long as it has a browser somewhere.
    elsewhere = [s2 for s2 in SITE_PREFIX
                 if s2 != site and profile_dir(name, s2).exists()]
    note = f"{pdir.name} deleted."
    if elsewhere:
        note += (" Its " + " and ".join(elsewhere) + " profile(s) are untouched.")
    else:
        store = load_store()
        if store["profiles"].pop(name, None) is not None:
            save_store(store)
        note += " That was its last browser, so its settings went with it."
    led = ledger_file(name, "tiktok" if site == "tiktok"
                      else ("instagram" if site == "instagram" else "youtube_shorts"))
    if led.exists():
        note += f" {led.name} is kept — it is the record of work already done."
    return True, note


# A JOB IS A PROFILE ON A PLATFORM, not a profile.
#
# The same letter can work all four platforms at once — profile-a, profile-ig-a
# and profile-yt-a are three directories and three browsers, and it is only two
# runs over ONE directory that cannot coexist. Keyed by name alone, starting
# Instagram would have replaced the TikTok job in the table and the page would
# have shown one where there were two.
def job_key(profile: str, platform: str) -> str:
    return f"{profile}@{platform}"


def job_parts(key: str) -> tuple[str, str]:
    """(profile, platform) from a job key. A key with no platform is TikTok's."""
    name, _, plat = key.partition("@")
    return name, (plat or "tiktok")


def profiles_held() -> dict[str, str]:
    """Which profiles a running job currently has a browser open on.

    Chromium locks a user data directory while it holds it, so two runs over
    the same profile do not share it — the second simply cannot open a browser.
    A collection run holds every profile it was given, which is why starting an
    independent run on top of one produces a row of processes that die without
    printing anything.
    """
    # Keyed "profile@site", NOT by profile: what a run holds is a DIRECTORY, and
    # profile-a and profile-ig-a are two of them. Site rather than platform,
    # because YouTube shorts and YouTube videos are one directory and really do
    # collide with each other.
    held: dict[str, str] = {}
    for key, job in RUNNER.jobs.items():
        if not job.running:
            continue
        name, platform = job_parts(key)
        site = ds.site_of(platform)
        if job.kind in ("like", "web"):
            held[f"{name}@{site}"] = key   # an independent run holds its own
        elif job.kind == "parallel":
            # run_parallel was given --profiles a,b,c and starts a child per
            # profile, so it holds all of them.
            try:
                i = job.cmd.index("--profiles")
                for p in job.cmd[i + 1].split(","):
                    if p.strip():
                        held[f"{p.strip()}@{site}"] = key
            except (ValueError, IndexError):
                pass
    return held


def start_run(mode: str, names: list[str]) -> tuple[bool, str]:
    store = load_store()
    shared = ds.clean(store["shared"])
    if not names:
        return False, "No profiles selected."
    platform = ds.platform_of(shared)
    site = ds.site_of(platform)
    # Remember who was run, so the next visit starts where this one left off.
    # Written on START rather than on every tick: the set that actually ran is a
    # decision somebody made, while a half-finished selection is not.
    store.setdefault("selected", {})[platform] = list(names)
    save_store(store)

    # Refused rather than attempted. Launching over a held profile is not a
    # race that sometimes works: the browser cannot open, so the run dies
    # having done nothing, and eighteen of those at once look like the
    # dashboard being broken.
    held = profiles_held()
    clash = sorted({f"{p} (held by {held[f'{p}@{site}']})" for p in names
                    if f"{p}@{site}" in held})
    # And a run somebody started in another terminal holds the directory just as
    # firmly, which this table cannot know about (busy.py asks the machine).
    elsewhere = sorted(n for n in names
                       if f"{n}@{site}" not in held
                       and busy.is_busy(profile_dir(n, site)))
    if elsewhere:
        return False, ("Already open in another browser: " + ", ".join(elsewhere)
                       + ". Two browsers cannot share one profile directory.")
    if clash:
        return False, ("Already running: " + ", ".join(clash)
                       + ". Two browsers cannot share one profile directory — "
                         "stop that job first.")

    if mode == "collection":
        # run_parallel starts like.py children, so it is TikTok's. The web liker
        # has no equivalent, and pretending otherwise would start a run that
        # cannot work — said plainly instead.
        if platform != "tiktok":
            return False, (
                f"{ds.label_of(platform)} has no collection mode: run_parallel.py "
                "shares one pool of links between like.py workers, and this platform "
                "runs like_web.py. Choose 'independently' — the profiles do the same "
                "work, they just do not divide the list between them."
            )
        cmd = ds.parallel_command(sys.executable, str(HERE / "run_parallel.py"), names, shared)
        begin_live(names, platform)
        return RUNNER.start(job_key("collection", platform), "parallel", cmd)

    # Independently: one like.py each, with that profile's own settings, and a
    # window slot each so headed runs tile rather than stack.
    started, problems = 0, []
    begin_live(names, platform)
    for i, n in enumerate(names):
        s = ds.merged(shared, profile_entry(store, n)["overrides"])
        # The platform is the run's, not a profile's: an override of it would
        # send one profile to another site with the others' settings.
        s["platform"] = platform
        script = str(HERE / ds.script_of(platform))
        if ds.target_of(platform) == "web":
            cmd = ds.web_command(sys.executable, script, n, s)
        else:
            cmd = ds.like_command(sys.executable, script, n, s,
                                  slot=i, count=len(names))
        ok, why = RUNNER.start(job_key(n, platform),
                               "web" if ds.target_of(platform) == "web" else "like", cmd)
        if ok:
            started += 1
        else:
            problems.append(f"{n}: {why}")
    if started == 0:
        return False, "; ".join(problems) or "Nothing started."
    return True, ("; ".join(problems) if problems else "")


# SITE-AWARE, because every one of these opens a browser on a profile
# DIRECTORY. "Sign in" from an Instagram page that ran login.py with no --site
# would open TikTok, sign the person in there, and leave the Instagram profile
# exactly as empty as it was — with a green tick next to it.
TOOLS = {
    # name -> (job name template, argv builder). Everything the project can do
    # from a terminal, reachable from the page.
    "sessions": lambda p, site="tiktok": (
        f"sessions-scan@{site}",
        [sys.executable, "-u", str(HERE / "sessions.py"), "--site", site]
        + (["--profiles", p] if p else []),
    ),
    "login": lambda p, site="tiktok": (
        f"login-{p}@{site}",
        [sys.executable, "-u", str(HERE / "login.py"), "--site", site, "--profile", p],
    ),
    "open": lambda p, url="", site="tiktok": (
        f"open-{p}@{site}",
        [sys.executable, "-u", str(HERE / "open_profile.py"), "--site", site, "--profile", p]
        + (["--url", url] if url else []),
    ),
    # TikTok's own: verify.py reads TikTok's API and solve_captcha is TikTok's
    # puzzle. Offered on the other platforms would be a button that cannot work.
    "verify": lambda p, site="tiktok": (f"verify-{p}", [sys.executable, "-u", str(HERE / "verify.py"),
                                         "--profile", p]),
    # Are the comments we POSTED still on the videos? Posting is confirmed at
    # the time — the comment is read back off the page before it is recorded —
    # which says nothing about an hour later, when a filter or a creator may
    # have removed it and told nobody.
    "comments": lambda p, site="tiktok": (
        f"comments-{p or 'all'}",
        [sys.executable, "-u", str(HERE / "verify_comments.py")]
        + (["--profile", p] if p else ["--all"])
        # Pressed DURING a run, which is the normal case — the moment somebody
        # wants to know is right after a run posts comments. The profile being
        # checked can stay busy: the reading is done signed-out by the
        # dashboard, and by SOME OTHER account's browser for whatever that read
        # missed, because TikTok shows a restricted comment to its author and
        # to nobody else. The wait is only for the case where every profile on
        # the machine is in a run and there is nobody left to look.
        + ["--wait", "180"],
    ),
    # WHICH LINKS DID THIS ACCOUNT COMMENT ON. The same ledger the check reads,
    # printed: the link, the product, the words, and whatever the last check
    # found about each one. No browser and no network, so it answers instantly
    # and can be pressed while every profile is in a run.
    "commented": lambda p, site="tiktok": (
        f"commented-{p or 'all'}",
        [sys.executable, "-u", str(HERE / "verify_comments.py"), "--list"]
        + (["--profile", p] if p else []),
    ),
    "why": lambda p, site="tiktok": ("why-skipped",
                                     [sys.executable, "-u", str(HERE / "why_skipped.py")]),
    # Which address each account was registered with. Cross-checks TikTok's
    # masked email against the Google chooser, so an address is only reported
    # as confirmed when it fits the mask.
    "emails": lambda p, site="tiktok": ("emails", [sys.executable, "-u", str(HERE / "emails.py"),
                                    "--write-accounts"]
                         + (["--profile", p] if p else [])),
    "captcha": lambda p, site="tiktok": (f"captcha-{p}",
                                         [sys.executable, "-u", str(HERE / "solve_captcha.py"),
                                          "--profile", p]),
}

# The two that are TikTok's alone, whatever platform the page is showing.
TIKTOK_ONLY = ("verify", "captcha", "why", "emails", "comments", "commented")


class Handler(BaseHTTPRequestHandler):
    # The default logs a line per request to stderr, which drowns the one thing
    # worth seeing there: the URL to open.
    def log_message(self, *a):  # noqa: D102, ANN002
        pass

    def handle_one_request(self):  # noqa: D102
        # The page polls every 1.5s, so a reload or a closed tab regularly
        # leaves a response half-written. That is normal and means nothing, but
        # http.server prints a full traceback for it and buries the one line
        # worth reading in this console: the URL to open.
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # The browser went away mid-response. Nothing to report and nothing
            # to do: it will ask again in a second and a half.
            self.close_connection = True

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json")

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            if not PAGE.exists():
                self._send(500, b"dashboard.html is missing", "text/plain")
                return
            self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
            return
        if u.path == "/api/state":
            q = parse_qs(u.query)
            try:
                since = json.loads(q.get("since", ["{}"])[0])
            except Exception:  # noqa: BLE001
                since = {}
            self._json(build_state(since if isinstance(since, dict) else {}))
            return
        if u.path == "/api/log":
            # THE PARAMETER IS A JOB NAME, NEVER A PATH.
            #
            # The file sent back is the one this process opened for that job, so
            # no request can name a file of its own — which matters more here
            # than usual, because this server answers without a password.
            q = parse_qs(u.query)
            job = RUNNER.jobs.get((q.get("job", [""])[0] or "").strip())
            if job is None:
                self._send(404, b"no such job", "text/plain; charset=utf-8")
                return
            try:
                body = Path(job.log).read_bytes()
            except OSError as e:
                self._send(404, f"cannot read the log: {e}".encode("utf-8"),
                           "text/plain; charset=utf-8")
                return
            self._send(200, body, "text/plain; charset=utf-8")
            return
        self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:  # noqa: BLE001
            self._json({"error": "bad JSON"}, 400)
            return

        if u.path == "/api/settings":
            store = load_store()
            if isinstance(body.get("shared"), dict):
                store["shared"] = ds.clean(body["shared"])
            for name, entry in (body.get("profiles") or {}).items():
                cur = profile_entry(store, name)
                if "enabled" in entry:
                    cur["enabled"] = bool(entry["enabled"])
                if "label" in entry:
                    cur["label"] = str(entry["label"])[:80]
                if "start_url" in entry:
                    u = str(entry["start_url"]).strip()
                    # A start URL is handed to a browser. Anything that is not
                    # plainly http(s) is refused rather than sanitised: file://
                    # and javascript: both do something here, and neither is
                    # what anybody meant to type.
                    cur["start_url"] = u if u.startswith(("http://", "https://")) else ""
                if isinstance(entry.get("overrides"), dict):
                    # Only per-profile fields, and only keys we know. An
                    # override of a run-level field would let one profile change
                    # how the whole run is shared out.
                    cur["overrides"] = {
                        k: ds.coerce(k, v)
                        for k, v in entry["overrides"].items()
                        if k in ds.BY_KEY and ds.BY_KEY[k].per_profile
                    }
                store["profiles"][name] = cur
            save_store(store)
            self._json({"ok": True})
            return

        if u.path == "/api/profile":
            name = str(body.get("name") or "").strip()
            site = str(body.get("site") or "tiktok")
            if body.get("clone"):
                # Copy TikTok's browser into this site's directory, so the
                # Google account that made the TikTok account is already signed
                # in and the new site takes one click rather than a password.
                import clone as clone_mod

                if site == "tiktok":
                    self._json({"ok": False,
                                "note": "TikTok's profiles are the ones being copied FROM."},
                               400)
                    return
                names = ([name] if name else
                         [n for n in known_profiles("tiktok")
                          if not profile_dir(n, site).exists()])
                done, notes = 0, []
                for n in names:
                    ok, why = clone_mod.clone(n, site, "tiktok",
                                              bool(body.get("overwrite")))
                    done += ok
                    notes.append(f"{n}: {why}")
                self._json({"ok": done > 0,
                            "note": (f"{done} of {len(names)} copied.\n"
                                     + "\n".join(notes[:12])
                                     + ("\n…" if len(notes) > 12 else ""))},
                           200 if done else 400)
                return

            if body.get("delete"):
                # The page asks for the name to be typed before it sends this,
                # which is the confirmation. The checks here are the ones that
                # matter whatever pressed the button: it exists, and nothing has
                # it open.
                ok, why = delete_profile(name, site)
            else:
                ok, why = add_profile(name, site)
            self._json({"ok": ok, "note": why, "name": name}, 200 if ok else 400)
            return

        if u.path == "/api/run":
            mode = str(body.get("mode") or "collection")
            names = [str(x) for x in (body.get("profiles") or [])]
            ok, why = start_run(mode, names)
            self._json({"ok": ok, "note": why}, 200 if ok else 400)
            return

        if u.path == "/api/stop":
            name = body.get("name")
            if name:
                self._json({"ok": RUNNER.stop(str(name))})
            else:
                self._json({"ok": True, "stopped": RUNNER.stop_all()})
            return

        if u.path == "/api/tool":
            tool = str(body.get("tool") or "")
            prof = str(body.get("profile") or "")
            if tool not in TOOLS:
                self._json({"error": f"unknown tool {tool}"}, 400)
                return
            url = str(body.get("url") or "")
            site = ds.site_of(ds.platform_of(load_store()["shared"]))
            if tool in TIKTOK_ONLY and site != "tiktok":
                self._json({"ok": False,
                            "note": f"'{tool}' only works on TikTok — it reads TikTok's "
                                    f"own API. Switch the platform back to run it."}, 400)
                return
            fn = TOOLS[tool]
            name, cmd = fn(prof, url, site) if tool == "open" else fn(prof, site)
            ok, why = RUNNER.start(name, "tool", cmd)
            self._json({"ok": ok, "note": why, "job": name}, 200 if ok else 400)
            return

        if u.path == "/api/preview":
            # What would actually be run, before anything is. The page shows it
            # under the buttons: a dashboard that hides the command it is about
            # to run is a dashboard you cannot check.
            store = load_store()
            shared = ds.clean(store["shared"])
            names = [str(x) for x in (body.get("profiles") or [])] or ["a"]
            # THE SAME ROUTING start_run USES. A preview that shows like.py for
            # a run that will start like_web.py is worse than no preview: it is
            # a dashboard telling you something untrue about itself.
            platform = ds.platform_of(shared)
            script = ds.script_of(platform)
            web = ds.target_of(platform) == "web"

            def one(n):
                st = ds.merged(shared, profile_entry(store, n)["overrides"])
                st["platform"] = platform
                return (ds.web_command("python", script, n, st) if web
                        else ds.like_command("python", script, n, st))

            out = {
                "collection": (
                    " ".join(ds.parallel_command("python", "run_parallel.py", names, shared))
                    if not web else
                    f"{ds.label_of(platform)} has no collection mode — run_parallel.py "
                    f"shares links between like.py workers, and this platform runs {script}."
                ),
                "independent": [{"profile": n, "cmd": " ".join(one(n))} for n in names],
            }
            self._json(out)
            return

        self._json({"error": "not found"}, 404)


def main() -> int:
    ap = argparse.ArgumentParser(description="Local control panel for the liker.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="only 127.0.0.1 without --i-know; see the note in the docstring")
    ap.add_argument("--i-know", action="store_true",
                    help="allow binding somewhere other than localhost")
    ap.add_argument("--no-open", action="store_true", help="do not open a browser")
    args = ap.parse_args()

    if args.host not in ("127.0.0.1", "localhost", "::1") and not args.i_know:
        print(f"Refusing to bind {args.host}.")
        print("This page starts browsers signed in to real accounts and can post public")
        print("comments. It has no password. If you genuinely want it reachable from")
        print("another machine, pass --i-know and put it behind something that asks for one.")
        return 2

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"Liker dashboard on {url}")
    print(f"  profiles: {', '.join(known_profiles()) or 'none found'}")
    print(f"  settings: {STORE.name}   logs: {RUNNER.run_dir}")
    print("  Ctrl+C to stop. Runs you started keep going unless you stop them here first.")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping the server. Any runs still going are left alone —")
        print("stop them from the page first if you want them stopped.")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
