#!/usr/bin/env python3
"""
Control Center — one window for the whole pipeline.

WHAT THIS IS NOT: a new scraper, a new uploader, or a second copy of the heart
runner. Every job it starts is one of the programs that already exist in this
workspace, run with the flags they already document:

    Search extraction   1_tiktok_search_scraper/scraper.py
    Upload to the pool  3_dashboard/upload.py
    Instagram channels  1_tiktok_search_scraper/harvest_instagram.py
    Account liker       6_comment_liker/like.py
    Hearts              2_comment_automation/automate.py

A second implementation of any of them would drift from the first, and the thing
it would drift on is which links reach the dashboard. So this process owns the
settings, the window, and the jobs; it owns none of the work.

Everything runs in PARALLEL. A search can be scraping while a harvest scrolls
Instagram and the heart runner waits out a Zefoy cooldown — they are separate
processes with separate logs, started and stopped independently.

    python app.py                 # native window if pywebview is installed
    python app.py --browser       # force the default browser instead
    python app.py --port 8750     # pick the port
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import queue
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from datetime import datetime, timezone
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
UI_FILE = HERE / "ui.html"
SETTINGS_FILE = HERE / "settings.json"

# The projects this drives. Named once: a rename shows up here as a tool that
# reports itself missing, rather than as a button that fails when pressed.
SCRAPER_DIR = ROOT / "1_tiktok_search_scraper"
HEARTS_DIR = ROOT / "2_comment_automation"
DASH_DIR = ROOT / "3_dashboard"
LIKER_DIR = ROOT / "6_comment_liker"

SCRIPTS = {
    "search": SCRAPER_DIR / "scraper.py",
    "upload": DASH_DIR / "upload.py",
    "harvest": SCRAPER_DIR / "harvest_instagram.py",
    "hearts": HEARTS_DIR / "automate.py",
    "liker": LIKER_DIR / "like.py",
}

# WHICH TOOLS DRIVE THE SHARED CHROME PROFILE.
#
# scraper.py and scrape_channels.py both open BROWSER_PROFILE_DIR as a persistent
# context, and Chromium allows exactly one instance per profile directory. Start
# two and the second dies on the spot:
#
#   BrowserType.launch_persistent_context: Opening in existing browser session.
#   This usually means that the profile is already in use by another instance.
#
# So these queue behind one another. Everything else still runs alongside them —
# the heart runner launches its own throwaway browser, or attaches to the phone,
# the account liker opens a profile of its own under 6_comment_liker (one
# directory per signed-in account, none of them this one), and an upload opens
# nothing at all.
BROWSER_TOOLS = ("search", "harvest")
BROWSER_LOCK = threading.Lock()

# How many log lines each job keeps. Enough to scroll back through a long run
# without letting a week-long one eat the machine.
LOG_LINES = 4000


# ── settings ────────────────────────────────────────────────────────────────
# Written to disk on every change, because the alternative is retyping a long
# keyword list after every restart.
# WHICH PRODUCT GENRE A SEARCH IS FOR.
#
# The keyword sets do not overlap: "turnitin bypass" finds humanizer videos and
# nothing a website builder would want to be under. So the phrases are stored per
# genre, the window searches one genre at a time, and the upload tells the
# dashboard which pool the links belong to.
#
# Kept in step with GENRES in 3_dashboard/lib/config.ts by hand — the same hand
# as upload.py's copy. The dashboard validates, so drift costs an upload filed
# under humanizer rather than a lost scrape.
#
# The three built in are below; genres ADDED in the dashboard (Admin → Genres)
# are fetched from it by refresh_genres() at startup and on every page load, and
# appended here IN PLACE — so every `in GENRES` check and every genre list in the
# window includes them with no edit to this file.
GENRES = ["humanizer", "website", "slides"]
GENRE_LABELS = {
    "humanizer": "Humanizer",
    "website": "Website builder (cocodly)",
    "slides": "Slides (pptera)",
}
BUILTIN_GENRES = tuple(GENRES)

DEFAULTS = {
    "search": {
        # A LIST, because one search usually means all of them. Each platform is
        # a separate run of scraper.py — it takes one --platform and writes one
        # file — so the window starts one job per platform and they go at once.
        "platforms": ["tiktok"],
        # Which genre this search is for, and one phrase set per genre.
        "genre": "humanizer",
        "queries_by_genre": {
            "humanizer": "ai humanizer\nhumanize ai text\nturnitin bypass",
            "website": "ai website builder\nbuild a website with ai\nno code website",
            "slides": "ai presentation maker\nai powerpoint generator\nmake slides fast",
        },
        "min": 40,
        "max": 120,
        "content": "all",
        "output": "",
        "upload_after": True,
        "upload_mode": "replace",
    },
    "harvest": {
        "limit": 50,
        "accounts": "",
        # Which product genre to harvest for. Blank is every genre.
        #
        # It picks the channels AND stamps the staged posts, so a website
        # harvest visits the accounts already feeding the website pool and files
        # what it finds back into it.
        "genre": "",
        "dry_run": False,
        "upload": True,
    },
    # THE OTHER LIKER, and it is a different thing from "hearts" above.
    #
    #   hearts  goes through Zefoy or Freer: a free service, no account of ours,
    #           and it hearts the comment from whoever that service uses.
    #   liker   signs in as OUR OWN TikTok accounts (login.py saves a profile per
    #           account) and clicks the heart itself.
    #
    # So they cost different things and fail differently: the first runs out of
    # free quota and captchas, the second spends our own accounts' standing.
    # They are separate tabs for that reason rather than one tab with a switch.
    "liker": {
        # Where the links come from. 'dashboard' asks the admin pool for a
        # cluster selection; 'file' uses a list you point at.
        "source": "dashboard",
        "links": "",
        # Rank clustering is ALSO a filter and keeps only links carrying a
        # search rank - 1.5% of the pool. See the hearts default for the whole
        # story; combined is right here for the same reason.
        "cluster_by": "combined",
        "clusters": "all",
        "platform": "tiktok",
        "genre": "",
        "category": "",
        "max_links": 500,
        # WHAT TO LIKE. Products means "comments naming one of the active
        # products", which is the normal run. Users means specific handles.
        # Liking everything is almost never wanted and is not offered here.
        "target": "products",
        "users": "",
        # WHICH SAVED LOGINS TO ACT AS, comma-separated.
        #
        # Plural, and one run each: login.py writes one profile directory per
        # TikTok account, and two accounts liking the same list is two browsers,
        # two sessions and two sets of done rows. Started together like the
        # search tab's platforms, so the slowest is the wait rather than the sum.
        #
        # Every account likes every matching comment; nothing is divided
        # between them. The only comment of ours an account passes is one tied
        # on likes with another of ours.
        "profiles": "default",
        # HOW MANY OF THOSE RUN AT ONCE. 0 = all of them together. With more
        # accounts ticked than this, the first N start and each of the others
        # takes the place of one that finishes — so a laptop that can hold
        # three browsers can still work ten accounts through in one press.
        "at_once": 0,
        # The words that make a comment ours. Blank uses the dashboard's active
        # products, which is the normal run.
        "keywords": "",
        "mode": "dom",
        "pages": 3,
        "scrolls": 6,
        "delay": "1,3",
        "limit": 0,
        "headed": False,
        "dry_run": False,
        "unlike": False,
        "keep_going": True,
        # LIKE EVERY COMMENT IN A TIED GROUP.
        #
        # Off by default, which is the liker's own default and the safer one.
        # By default it gives ONE like per like-count per video: three of our
        # comments sitting on 5 likes get one taken to 6 and the other two left
        # alone. The rule exists because the old behaviour took three comments
        # on 5 to three comments on 14 — turning a coincidence into a pattern
        # on every video, which is the shape somebody looking for a network
        # finds.
        #
        # On, every comment in the group is liked. Right when the comments are
        # genuinely different and independently earned - a run aimed at named
        # handles, say - and the tie is just an accident of where they happened
        # to be.
        "like_ties": False,
    },
    "hearts": {
        "service": "zefoy",
        "source": "dashboard",
        "csv": "",
        # COMBINED, NOT RANK.
        #
        # Rank clustering keeps only links that carry a search rank, and almost
        # nothing does: 2,648 of 177,628 in the pool, which is 1.5%. The other
        # 98.5% came from channel scrapes and are date-only, so asking for rank
        # silently throws them away. The admin Links page defaulted to rank for
        # the same reason and was showing 2% of the pool until it was changed.
        #
        # It bit hardest with a genre: every rank-bearing link happened to be
        # from one website search, so a humanizer run on rank matched exactly
        # zero and exited with "No links to work" - a correct filter, an empty
        # result, and no way to tell which.
        "cluster_by": "combined",
        "clusters": "all",
        "platform": "tiktok",
        "category": "",
        # Which product genre's links to work. Blank is every genre.
        "genre": "",
        "max_links": 2000,
        "keyword": "",
        "to_top": True,
        "margin": 3,
        "floor": 0.25,
        "rounds": 4,
        "watch": 45,
        "workers": 1,
        "delay": 30,
        "loop": False,
        "loop_delay": 60,
        "resume": True,
        "fresh": False,
        "tag": "",
        # WHERE. Either, or both — and both is the interesting one: two runs on
        # one list, so the phone's hearts and the PC's are not spent twice on the
        # same video.
        "on_pc": True,
        "on_phone": False,
        "share": True,
        "cdp": "http://127.0.0.1:9222",
        "recover": 5,
    },
}


def load_settings() -> dict:
    """Saved settings, with anything missing filled in from DEFAULTS.

    Merged key by key rather than replaced wholesale: a settings file written by
    an older version is missing whatever was added since, and the alternative to
    merging is a form with empty boxes nobody asked to empty.
    """
    out = {k: dict(v) for k, v in DEFAULTS.items()}
    try:
        saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        for tool, vals in (saved or {}).items():
            if tool in out and isinstance(vals, dict):
                out[tool].update({k: v for k, v in vals.items() if k in out[tool]})
        # ONE LEVEL DEEPER FOR queries_by_genre. The merge above replaces a value
        # wholesale, and this one is a dict — so a file saved when there were two
        # genres would drop the third's starter phrases and show an empty box
        # nobody emptied, which is the exact thing this function exists to avoid.
        saved_search = (saved or {}).get("search") or {}
        saved_q = saved_search.get("queries_by_genre")
        if isinstance(saved_q, dict):
            merged = dict(DEFAULTS["search"]["queries_by_genre"])
            # An empty saved box does not hide an added genre's starting phrases.
            merged.update({k: v for k, v in saved_q.items() if k in GENRES and (v or not merged.get(k))})
            out["search"]["queries_by_genre"] = merged
        elif str(saved_search.get("queries", "")).strip():
            # MIGRATION, ONCE. A file written before genres has the real phrase
            # list in `queries` - sixteen of them on this machine - and no
            # per-genre sets. Without this the humanizer box would come back
            # showing the three starter phrases from DEFAULTS and the sixteen
            # would be gone from the window, which is the kind of loss nobody
            # notices until a search comes back thin.
            out["search"]["queries_by_genre"] = dict(
                DEFAULTS["search"]["queries_by_genre"],
                humanizer=saved_search["queries"],
            )
    except Exception:  # noqa: BLE001 - a corrupt file is not worth a crash
        pass
    return out


def save_settings(s: dict) -> None:
    try:
        SETTINGS_FILE.write_text(json.dumps(s, indent=2), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


# ── jobs ────────────────────────────────────────────────────────────────────
# The states a job never comes back from. Named once, because the bug below was
# a list of the OTHER states written out by hand and missing one.
OVER = ("done", "failed", "stopped")


class Job:
    """One running program, its output, and how it ended."""

    _seq = 0
    _lock = threading.Lock()

    def __init__(self, tool: str, title: str, cmd: list[str], cwd: Path):
        with Job._lock:
            Job._seq += 1
            self.id = f"job{Job._seq}"
        self.tool = tool
        self.title = title
        self.cmd = cmd
        self.cwd = str(cwd)
        self.lines: deque[str] = deque(maxlen=LOG_LINES)
        self.seq = 0            # lines produced, ever — the UI polls from this
        self.status = "starting"
        self.exit_code: int | None = None
        self.started = time.time()
        self.ended: float | None = None
        self.proc: subprocess.Popen | None = None
        self._lines_lock = threading.Lock()
        self._holds_lock = False

    def finished(self) -> bool:
        return self.status in OVER

    # The UI asks "what is new since line N", so every line gets a number.
    def write(self, text: str) -> None:
        with self._lines_lock:
            self.lines.append(text)
            self.seq += 1

    def tail(self, since: int) -> tuple[list[str], int]:
        with self._lines_lock:
            have = len(self.lines)
            first = self.seq - have          # the number of lines.popleft() ate
            start = max(0, since - first)
            if since > self.seq:             # the job restarted its numbering
                start = 0
            return list(self.lines)[start:], self.seq

    def run(self) -> None:
        if self.tool in BROWSER_TOOLS:
            # Not blocking straight away keeps the common case silent: the lock
            # is free, nothing is said, and the job starts.
            if not BROWSER_LOCK.acquire(blocking=False):
                self.status = "queued"
                self.write("[*] waiting for the Chrome profile — the scraper and "
                           "the harvester share one, and Chromium allows a single "
                           "window per profile")
                BROWSER_LOCK.acquire()
            self._holds_lock = True
            if self.status == "stopped":
                # Cancelled while it sat in the queue.
                BROWSER_LOCK.release()
                self._holds_lock = False
                return
        try:
            self._run_process()
        finally:
            if self._holds_lock:
                BROWSER_LOCK.release()
                self._holds_lock = False

    def _run_process(self) -> None:
        env = dict(os.environ)
        # LEARNED THE HARD WAY. A TikTok comment is full of emoji and a Windows
        # console is cp1252; a child that prints one dies with UnicodeEncodeError
        # halfway through its work. Telling it to speak UTF-8 costs nothing.
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        creation = 0
        if platform.system() == "Windows":
            # Its own process group, so stopping this job cannot take the window
            # with it.
            creation = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        try:
            self.proc = subprocess.Popen(
                self.cmd,
                cwd=self.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                # A PIPE, NOT DEVNULL. scraper.py stops on TikTok and waits for
                # you to log in and press Enter; with no stdin that input() got
                # EOF immediately and the run died before it searched anything.
                stdin=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
                creationflags=creation,
            )
        except Exception as e:  # noqa: BLE001
            self.write(f"[!] could not start: {e}")
            self.status = "failed"
            self.ended = time.time()
            return

        self.status = "running"
        self.write(f"$ {' '.join(self.cmd)}")
        self.write(f"  in {self.cwd}")
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.write(line.rstrip("\n"))
        self.proc.wait()
        self.exit_code = self.proc.returncode
        self.ended = time.time()
        if self.status == "stopping":
            self.status = "stopped"
        else:
            self.status = "done" if self.exit_code == 0 else "failed"
        self.write(f"[exited with code {self.exit_code}]")

    def send(self, text: str) -> bool:
        """Answer a prompt the program is waiting on. Enter is the common one."""
        if not self.proc or self.proc.poll() is not None or not self.proc.stdin:
            return False
        try:
            self.proc.stdin.write(text + "\n")
            self.proc.stdin.flush()
        except Exception:  # noqa: BLE001 - a closed pipe is an answer too
            return False
        # Echoed into the log: otherwise the only record of the run is a pause
        # that ended for no visible reason.
        self.write(f"> {text}" if text else "> (Enter)")
        return True

    def stop(self) -> bool:
        if self.status == "queued" and not self.proc:
            # Never started; the thread waiting on the lock checks this.
            self.status = "stopped"
            self.ended = time.time()
            self.write("[*] cancelled before it started")
            return True
        if not self.proc or self.proc.poll() is not None:
            return False
        self.status = "stopping"
        try:
            # KILLED, NOT ASKED. A browser-driving child ignores a polite signal
            # while Playwright is mid-call, and a "stopped" job that keeps
            # clicking is worse than no stop button at all.
            self.proc.kill()
        except Exception:  # noqa: BLE001
            return False
        return True


class Runner:
    """Every job this window has started, running or finished."""

    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self.lock = threading.Lock()

    def start(self, tool: str, title: str, cmd: list[str], cwd: Path) -> Job:
        job = Job(tool, title, cmd, cwd)
        with self.lock:
            self.jobs[job.id] = job
            self.order.append(job.id)
        threading.Thread(target=job.run, daemon=True).start()
        return job

    def start_limited(self, tool: str, built: list[tuple[str, list[str], Path]],
                      at_once: int) -> list[Job]:
        """Start these runs, at most `at_once` of them at a time.

        The first `at_once` start now. The rest are listed as QUEUED straight
        away — so the window shows the whole batch and any of them can be
        cancelled with Stop — and each one starts the moment a running one in
        this batch finishes. `at_once` of 0 (or at least the batch size) starts
        everything together, which is how it worked before there was a limit.
        """
        if at_once <= 0 or at_once >= len(built):
            return [self.start(tool, t, c, d) for t, c, d in built]
        running = [self.start(tool, t, c, d) for t, c, d in built[:at_once]]
        waiting: list[Job] = []
        for t, c, d in built[at_once:]:
            job = Job(tool, t, c, d)
            job.status = "queued"
            job.write(f"[*] waiting for a free slot — {at_once} account(s) run at once; "
                      "this one starts when one of them finishes")
            with self.lock:
                self.jobs[job.id] = job
                self.order.append(job.id)
            waiting.append(job)

        def feed() -> None:
            active = list(running)
            for job in waiting:
                # A slot is free when a job of this batch has ended, however it
                # ended — done, failed or stopped by hand.
                while sum(1 for j in active if not j.finished()) >= at_once:
                    time.sleep(1)
                if job.status == "stopped":
                    continue  # cancelled while it waited
                job.status = "starting"
                job.started = time.time()
                job.write("[*] a slot is free — starting")
                threading.Thread(target=job.run, daemon=True).start()
                active.append(job)

        threading.Thread(target=feed, daemon=True).start()
        return running + waiting

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def listing(self) -> list[dict]:
        with self.lock:
            ids = list(self.order)
        out = []
        for i in ids:
            j = self.jobs[i]
            out.append({
                "id": j.id, "tool": j.tool, "title": j.title, "status": j.status,
                "exit": j.exit_code, "seq": j.seq,
                "started": j.started, "ended": j.ended,
                "cmd": " ".join(j.cmd),
                "can_type": bool(j.proc and j.proc.poll() is None and j.proc.stdin),
            })
        return out

    def running(self) -> int:
        """Jobs that have not finished — including the ones waiting their turn."""
        return sum(1 for j in self.jobs.values() if not j.finished())

    def stop_all(self) -> int:
        return sum(1 for j in self.jobs.values() if j.stop())


RUNNER = Runner()


# ── building the commands ───────────────────────────────────────────────────
# Each builder mirrors one program's documented flags. They are the only place
# that knows how to invoke anything, so a flag that changes upstream is changed
# here once.
def _py(script: Path) -> list[str]:
    return [sys.executable, "-u", str(script)]


PLATFORMS = ("tiktok", "youtube", "instagram", "reddit")


def chosen_platforms(s: dict) -> list[str]:
    """The platforms ticked, in a fixed order and with nothing invented."""
    picked = s.get("platforms")
    if isinstance(picked, str):          # a settings file from before the list
        picked = [picked]
    picked = [p for p in (picked or []) if p in PLATFORMS]
    return [p for p in PLATFORMS if p in picked]


def search_runs(s: dict) -> list[tuple[str, str]]:
    """Every (platform, content) this search should run, in order.

    YOUTUBE'S "ALL" IS TWO RUNS, NOT ONE. The results page shows Shorts and
    videos mixed, and the scraper only clicks a filter tab when it is told which
    one — `{"shorts": "Shorts", "videos": "Videos"}.get(content)` is None for
    "all", so nothing is clicked and the mixed page is scraped as it comes,
    which is mostly long videos. Clicking the Shorts tab and then the Videos tab
    is how YouTube is actually read, so "all" expands into a Shorts run followed
    by a Videos run.

    Shorts go first because they are the ones that look like the other platforms'
    results, and the first run is the one that finishes while somebody is still
    watching.
    """
    runs: list[tuple[str, str]] = []
    for platform in chosen_platforms(s):
        if platform != "youtube":
            runs.append((platform, ""))
            continue
        want = str(s.get("content") or "all").strip().lower()
        if want in ("", "all"):
            runs.append(("youtube", "shorts"))
            runs.append(("youtube", "videos"))
        else:
            runs.append(("youtube", want))
    return runs


def genre_of(s: dict) -> str:
    """The genre this search is for, falling back to the first one."""
    g = str(s.get("genre", "")).strip().lower()
    return g if g in GENRES else GENRES[0]


def queries_for(s: dict) -> list[str]:
    """The search phrases for the chosen genre, one per line.

    Falls back to the old flat `queries` so a settings file from before genres
    keeps working, and so does a window that has not been reloaded.
    """
    by_genre = s.get("queries_by_genre")
    raw = ""
    if isinstance(by_genre, dict):
        raw = str(by_genre.get(genre_of(s), "") or "")
    # The flat `queries` is NOT a second store — it is not in DEFAULTS, so it is
    # never saved and never shown. It is read here only for a caller that hands
    # one over directly, and for the pre-genre settings file that load_settings
    # migrates. If it were in DEFAULTS it would shadow this: a non-empty default
    # per-genre set would mean a caller's own phrases were ignored in silence.
    if not raw.strip():
        raw = str(s.get("queries", "") or "")
    return [q.strip() for q in raw.splitlines() if q.strip()]


def output_for(s: dict, platform: str, content: str, many: bool) -> str:
    """Where one run should write, when a name was given.

    TWO SCRAPERS MUST NOT SHARE A FILE. A name given for a search that is more
    than one run gets the run put into it — the platform, and the tab as well
    where YouTube is being read twice. One run keeps the name as typed.
    """
    name = str(s.get("output", "")).strip()
    if not name or not many:
        return name
    path = Path(name)
    # The genre is in the tag too: the same platform searched for two genres
    # would otherwise write the same file twice and the second would overwrite
    # the first, which looks like a scrape that found nothing.
    tag = f"{genre_of(s)}_{platform}" if not content else f"{genre_of(s)}_{platform}_{content}"
    return str(path.with_name(f"{path.stem}_{tag}{path.suffix or '.csv'}"))


def build_search_for(s: dict, platform: str, content: str = "",
                     many: bool = False) -> tuple[str, list[str], Path]:
    """One run: one platform, and for YouTube one tab."""
    queries = queries_for(s)
    if not queries:
        raise ValueError(
            f"Give at least one search phrase for {GENRE_LABELS.get(genre_of(s), genre_of(s))}."
        )
    cmd = _py(SCRIPTS["search"]) + ["--platform", platform]
    # Start searching at once: no "log in, then press Enter" stop on TikTok or
    # Instagram. The Chrome profile keeps the logins; Instagram waits by itself
    # only if it finds itself signed out.
    cmd += ["--no-login-wait"]
    cmd += ["--query"] + queries
    if int(s.get("min", 0)) > 0:
        cmd += ["--min", str(int(s["min"]))]
    if int(s.get("max", 0)) > 0:
        cmd += ["--max", str(int(s["max"]))]
    # --content is YouTube's alone, and it is always sent for YouTube: it is what
    # makes the scraper click a tab instead of reading the mixed page.
    if platform == "youtube" and content:
        cmd += ["--content", content]
    out = output_for(s, platform, content, many)
    if out:
        cmd += ["--output", out]
    what = f"{platform} {content}".strip()
    title = f"Search · {genre_of(s)} · {what} · {len(queries)} phrase(s)"
    return title, cmd, SCRAPER_DIR


def build_search(s: dict) -> tuple[str, list[str], Path]:
    """The first run, for callers that want a single command. Starting a search
    builds one per entry in search_runs()."""
    runs = search_runs(s)
    if not runs:
        raise ValueError("Tick at least one platform.")
    platform, content = runs[0]
    return build_search_for(s, platform, content, many=len(runs) > 1)


def build_upload(s: dict) -> tuple[str, list[str], Path]:
    cmd = _py(SCRIPTS["upload"])
    csv = str(s.get("csv", "")).strip()
    if csv:
        cmd += [csv]
    else:
        # No file named: upload.py's own default is the newest CSV, which is what
        # a search that has just finished produced.
        plat = str(s.get("platform", ""))
        if plat in ("tiktok", "youtube"):
            cmd += [f"--{plat}"]
    if s.get("upload_mode") == "append":
        cmd += ["--append"]
    # WHICH POOL. Without it every scrape lands in the humanizer pool, which is
    # upload.py's default and is right for exactly one of the three genres.
    genre = str(s.get("genre", "")).strip().lower()
    if genre in GENRES:
        cmd += ["--genre", genre]
    mode = "append to" if s.get("upload_mode") == "append" else "replace"
    label = GENRE_LABELS.get(genre, genre) if genre in GENRES else "the pool"
    return f"Upload · {mode} · {label}", cmd, DASH_DIR


def build_harvest(s: dict) -> tuple[str, list[str], Path]:
    cmd = _py(SCRIPTS["harvest"]) + ["--limit", str(int(s.get("limit", 50)))]
    # WHICH POOL. Blank is every genre - the behaviour before genres - and
    # anything unrecognised is dropped rather than passed on, because the
    # harvester rejects an unknown value and would fail the whole run.
    genre = str(s.get("genre", "")).strip().lower()
    if genre in GENRES:
        cmd += ["--genre", genre]
    if str(s.get("accounts", "")).strip():
        cmd += ["--accounts", str(s["accounts"]).strip()]
    # No --headed: scrape_channels.py has no such flag and refuses the run over
    # it, and it never needed one — its browser is always on screen.
    if s.get("dry_run"):
        cmd += ["--dry-run"]
    if not s.get("upload", True):
        cmd += ["--no-upload"]
    where = "dry run" if s.get("dry_run") else ("staged for review" if s.get("upload", True) else "saved locally")
    # The genre is in the title for the same reason it is in the search job's:
    # two harvests can be running at once and the record list is how they are
    # told apart.
    which = GENRE_LABELS.get(genre, genre) if genre in GENRES else "all genres"
    return (
        f"Instagram channels · {which} · {int(s.get('limit', 50))} · {where}",
        cmd,
        SCRAPER_DIR,
    )


def hearts_places(s: dict) -> list[str]:
    """Where this press should run: 'pc', 'phone', or both in that order."""
    places = []
    if s.get("on_pc"):
        places.append("pc")
    if s.get("on_phone"):
        places.append("phone")
    return places


def hearts_tag(s: dict, place: str, many: bool, share: bool) -> str:
    """The record name for one run.

    Sharing means ONE record and one claims file — that is what makes two runs
    one piece of work. Not sharing means two, and they must not be the same file
    or each would skip the links the other finished and call the list done.
    """
    tag = str(s.get("tag", "")).strip()
    if not many:
        return tag
    if share:
        return tag or "team"
    return f"{tag}-{place}" if tag else place


def build_hearts_for(s: dict, place: str = "", many: bool = False) -> tuple[str, list[str], Path]:
    """One run, in one place."""
    place = place or (hearts_places(s) or ["pc"])[0]
    share = bool(s.get("share")) and many
    one = dict(s)
    one["tag"] = hearts_tag(s, place, many, share)
    one["share"] = share
    # The phone is the only thing --cdp means; a PC run must never carry it, or
    # both runs would drive the same phone.
    if place == "phone":
        one["cdp"] = str(s.get("cdp", "")).strip() or "http://127.0.0.1:9222"
    else:
        one["cdp"] = ""
    return _build_hearts_one(one)


def build_hearts(s: dict) -> tuple[str, list[str], Path]:
    """The first place, for callers that want a single command."""
    places = hearts_places(s)
    if not places:
        raise ValueError("Tick somewhere to run: this PC, the phone, or both.")
    return build_hearts_for(s, places[0], many=len(places) > 1)


def _build_hearts_one(s: dict) -> tuple[str, list[str], Path]:
    cmd = _py(SCRIPTS["hearts"]) + ["--service", str(s.get("service", "zefoy"))]
    if s.get("source") == "csv":
        csv = str(s.get("csv", "")).strip()
        if not csv:
            raise ValueError("Choose a CSV, or take the links from the dashboard.")
        cmd += ["--csv", csv]
    else:
        cmd += ["--from-dashboard",
                "--cluster-by", str(s.get("cluster_by", "rank")),
                "--clusters", str(s.get("clusters", "all")).strip() or "all",
                "--platform", str(s.get("platform", "tiktok"))]
        if str(s.get("category", "")).strip():
            cmd += ["--category", str(s["category"]).strip()]
        # WHICH POOL. Blank is every genre - the behaviour before genres - and
        # anything else aims the run at one product's videos, which is the only
        # way the keyword set can be one product's.
        if str(s.get("genre", "")).strip() in GENRES:
            cmd += ["--genre", str(s["genre"]).strip()]
        if int(s.get("max_links", 0)) > 0:
            cmd += ["--max-links", str(int(s["max_links"]))]
    if str(s.get("keyword", "")).strip():
        cmd += ["--keyword", str(s["keyword"]).strip()]
    if s.get("to_top"):
        cmd += ["--to-top", "--margin", str(int(s.get("margin", 3))),
                "--rounds", str(int(s.get("rounds", 4))),
                "--watch", str(s.get("watch", 45)),
                # The floor: the least a comment may carry as a share of the
                # VIDEO's likes, worked even when it already leads. Always sent,
                # because 0 is a real choice here — it means leading is enough.
                "--floor", str(s.get("floor", 0.25))]
    if int(s.get("workers", 1)) > 1:
        cmd += ["--workers", str(int(s["workers"]))]
    if s.get("service") in ("freer", "both"):
        cmd += ["--delay", str(s.get("delay", 30))]
    cmd += ["--loop", "--loop-delay", str(s.get("loop_delay", 60))] if s.get("loop") else ["--no-loop"]
    if s.get("fresh"):
        cmd += ["--fresh"]
    elif s.get("resume"):
        cmd += ["--resume"]
    if str(s.get("tag", "")).strip():
        cmd += ["--tag", str(s["tag"]).strip()]
    # Sharing is what makes two runs one piece of work: same source, same tag,
    # and a link claimed by one is skipped by the other. Without it two runs on
    # the same list simply both do all of it.
    if s.get("share"):
        cmd += ["--share"]
    if str(s.get("cdp", "")).strip():
        cmd += ["--cdp", str(s["cdp"]).strip(), "--recover", str(int(s.get("recover", 5)))]
    where = "on the phone" if str(s.get("cdp", "")).strip() else "on this PC"
    return f"Hearts · {s.get('service')} · {where}", cmd, HEARTS_DIR


def liker_profiles(s: dict) -> list[str]:
    """The saved logins this press should run, in the order they were typed.

    Deduped, because a name twice is two browsers on ONE profile directory and
    Chromium refuses the second outright. Empty means the single default
    profile, which is what the script does on its own.
    """
    seen: list[str] = []
    for raw in str(s.get("profiles", "") or "").replace("\n", ",").split(","):
        name = raw.strip()
        if name and name not in seen:
            seen.append(name)
    return seen or ["default"]


def build_liker_for(s: dict, profile: str, all_profiles: list[str]) -> tuple[str, list[str], Path]:
    """One run of 6_comment_liker/like.py.

    It signs in as one of our own accounts and clicks the heart on our comments,
    so the settings that matter are WHICH LINKS, WHAT TO LIKE and AS WHOM. The
    long tail of tuning flags like.py accepts is deliberately not exposed: this
    window is for the run somebody does every day, and a form with forty boxes is
    a form nobody reads.
    """
    cmd = _py(SCRIPTS["liker"])

    # ── which links ───────────────────────────────────────────────────────
    if str(s.get("source", "dashboard")) == "file":
        path = str(s.get("links", "")).strip()
        if not path:
            raise ValueError("Give a links file, or switch the source back to the dashboard.")
        cmd += ["--links", path]
    else:
        cmd += ["--from-dashboard",
                "--cluster-by", str(s.get("cluster_by", "combined")),
                "--clusters", str(s.get("clusters", "all") or "all")]
        if str(s.get("platform", "")).strip():
            cmd += ["--platform", str(s["platform"]).strip()]
        # Blank is every genre; an unrecognised value is dropped rather than
        # passed on, because like.py declares choices= and would refuse the run.
        genre = str(s.get("genre", "")).strip().lower()
        if genre in GENRES:
            cmd += ["--genre", genre]
        if str(s.get("category", "")).strip():
            cmd += ["--category", str(s["category"]).strip()]
        cmd += ["--max-links", str(int(s.get("max_links", 500)))]

    # ── what to like ──────────────────────────────────────────────────────
    target = str(s.get("target", "products"))
    if target == "users":
        handles = str(s.get("users", "")).strip()
        if not handles:
            raise ValueError("Name at least one @handle, or switch back to our products.")
        cmd += ["--users", handles]
    else:
        cmd += ["--products"]

    # ── as whom, and how ──────────────────────────────────────────────────
    if profile:
        cmd += ["--profile", profile]
    # NO --peers: every account likes every matching comment. Passing the
    # roster would make like.py divide each video's comments between the
    # accounts (spread_keep), so an account would pass a comment of ours and
    # print "left to other accounts". The only comment of ours that is passed is
    # one tied on likes with another of ours (the tie rule, like_ties).
    if str(s.get("keywords", "")).strip():
        cmd += ["--keywords", str(s["keywords"]).strip()]
    cmd += ["--mode", str(s.get("mode", "dom"))]
    cmd += ["--pages", str(int(s.get("pages", 3)))]
    if str(s.get("mode", "dom")) == "dom":
        cmd += ["--scrolls", str(int(s.get("scrolls", 6)))]
    if str(s.get("delay", "")).strip():
        cmd += ["--delay", str(s["delay"]).strip()]
    if int(s.get("limit", 0) or 0) > 0:
        cmd += ["--limit", str(int(s["limit"]))]
    if s.get("headed"):
        cmd += ["--headed"]
    if s.get("keep_going", True):
        cmd += ["--keep-going"]
    if s.get("like_ties"):
        cmd += ["--like-ties"]
    if s.get("unlike"):
        cmd += ["--unlike"]
    if s.get("dry_run"):
        cmd += ["--dry-run"]

    which = GENRE_LABELS.get(genre, genre) if str(s.get("source")) != "file" and genre in GENRES \
        else ("a file" if str(s.get("source")) == "file" else "all genres")
    what = ("named handles" if target == "users"
            else (str(s.get("keywords")).strip() if str(s.get("keywords", "")).strip()
                  else "our products"))
    doing = "unliking" if s.get("unlike") else ("dry run" if s.get("dry_run") else "liking")
    # The profile is in the title because two runs of this are two accounts, and
    # the record list is the only place they are told apart.
    return (
        f"Account liker \u00b7 {profile} \u00b7 {which} \u00b7 {what} \u00b7 {doing}",
        cmd,
        LIKER_DIR,
    )


def build_liker(s: dict) -> tuple[str, list[str], Path]:
    """The FIRST profile's run, for anything that wants one command.

    The window starts one job per profile; this exists so the generic paths -
    the preview, the health check, anything iterating BUILDERS - still have a
    single answer to give.
    """
    names = liker_profiles(s)
    return build_liker_for(s, names[0], names)


BUILDERS = {
    "search": build_search,
    "upload": build_upload,
    "harvest": build_harvest,
    "hearts": build_hearts,
    "liker": build_liker,
}


def preview(tool: str, s: dict) -> str:
    """The command(s) a press would run, before it runs.

    Shown under every form. A window that hides what it is about to execute is a
    window you cannot check, and these commands reach live accounts. A search
    over three platforms is three runs, so it shows three lines rather than one
    that stands for all of them.
    """
    try:
        if tool == "hearts":
            places = hearts_places(s)
            if not places:
                raise ValueError("Tick somewhere to run: this PC, the phone, or both.")
            many = len(places) > 1
            return "\n".join(
                " ".join(build_hearts_for(s, pl, many)[1][1:]) for pl in places
            )
        if tool == "liker":
            names = liker_profiles(s)
            return "\n".join(
                " ".join(build_liker_for(s, n, names)[1][1:]) for n in names
            )
        if tool == "search":
            runs = search_runs(s)
            if not runs:
                raise ValueError("Tick at least one platform.")
            many = len(runs) > 1
            return "\n".join(
                " ".join(build_search_for(s, pl, ct, many)[1][1:]) for pl, ct in runs
            )
        _, cmd, _ = BUILDERS[tool](s)
        return " ".join(cmd[1:])  # the interpreter path is noise
    except Exception as e:  # noqa: BLE001
        return f"({e})"


def liker_logins() -> list[dict]:
    """The TikTok logins login.py has saved, newest activity first.

    READ FROM DISK, not typed. login.py names a profile directory `profile` for
    "default" and `profile-<name>` for everything else, so the directories ARE
    the list; a box you type a name into is a box you can typo, and a typo here
    is a browser opening a brand-new signed-out profile and liking nothing.

    Instagram and YouTube profiles (`profile-ig-*`, `profile-yt-*`) are left out:
    this tool likes TikTok comments, and offering a login it cannot use is
    offering a run that fails.
    """
    out = []
    if not LIKER_DIR.exists():
        return out
    for p in LIKER_DIR.iterdir():
        if not p.is_dir() or not p.name.startswith("profile"):
            continue
        rest = p.name[len("profile"):].lstrip("-")
        if rest.startswith(("ig-", "yt-")):
            continue
        name = rest or "default"
        # A profile that has never been opened has no Default/ inside it, which
        # is a signed-out directory rather than an account.
        used = (p / "Default").exists()
        try:
            at = p.stat().st_mtime
        except OSError:
            at = 0.0
        out.append({"name": name, "ready": used, "at": at})
    out.sort(key=lambda d: (-d["at"], d["name"]))
    return out


# ── asking the dashboard whether a selection has anything in it ──────────
#
# WHY THE WINDOW HAS TO CHECK, and not just the script.
#
# Clustering is also a FILTER, which is the part nobody guesses: "Search rank"
# keeps only links carrying a search rank, about 1.5% of the pool, because
# everything scraped from a channel is date-only. Combine it with a genre and it
# can come to nothing at all - every rank-bearing link happens to be from one
# website search, so rank + humanizer is exactly zero.
#
# Pressing Start on that opened a browser, asked the dashboard, got nothing and
# exited 2. The scripts now say which filter is to blame, but they say it in a
# job log after the fact. The selection is made HERE, so it is checked here, and
# a press that cannot do any work is refused with the reason instead of being
# started.
#
# One HTTP call per press. The press is about to open a browser and work a
# thousand videos; a round trip is not the expensive part.
# Curly quotes around a setting's value, so a name with a space in it reads
# as one thing.
LQ, RQ = "\u2018", "\u2019"


def dashboard_env() -> dict:
    """DASHBOARD_URL and LINKS_EXPORT_TOKEN, from the same files the scripts read.

    The dashboard's own .env last, so the token lives in one place and the two
    projects cannot drift apart.
    """
    out: dict[str, str] = {}
    for path in (HEARTS_DIR / ".env", LIKER_DIR / ".env", DASH_DIR / ".env"):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return out


_genres_at = 0.0


def refresh_genres(max_age: float = 60.0) -> None:
    """Pull the dashboard's genre list (built-in + added) into GENRES.

    Added genres arrive with their label and starting search phrases; the
    phrases seed this window's per-genre phrase box the first time it sees the
    genre, and are never written over what has been typed since. A dashboard
    that cannot be reached leaves the current list alone.
    """
    global _genres_at
    if time.time() - _genres_at < max_age:
        return
    _genres_at = time.time()
    env = dashboard_env()
    base = (env.get("DASHBOARD_URL") or "").rstrip("/")
    token = env.get("LINKS_EXPORT_TOKEN") or ""
    if not base or not token:
        return
    try:
        req = urllib.request.Request(
            base + "/api/genres?" + urlencode({"token": token}),
            # The token in a header as well as the URL: a dashboard deployed
            # before it read ?token= on this route accepts only the header.
            headers={"User-Agent": "control-center/1.0", "x-links-token": token},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace") or "{}")
    except Exception:  # noqa: BLE001
        return
    remote = [g for g in (data.get("genres") or []) if isinstance(g, dict) and g.get("id")]
    if not remote:
        return
    keep = list(BUILTIN_GENRES) + [str(g["id"]) for g in remote if g["id"] not in BUILTIN_GENRES]
    GENRES[:] = keep
    for g in remote:
        gid = str(g["id"])
        if gid in BUILTIN_GENRES:
            continue
        products = ", ".join(g.get("products") or [])
        GENRE_LABELS[gid] = f"{g.get('label') or gid}" + (f" ({products})" if products else "")
        DEFAULTS["search"]["queries_by_genre"].setdefault(gid, str(g.get("searchPhrases") or ""))


def dashboard_matches(params: dict) -> int | None:
    """How many links the dashboard holds for this selection, or None if unknown.

    None, not 0, when the dashboard cannot be reached or is not configured: a
    guard that reads "nothing matched" from its own network error would block
    every press the moment the laptop lost Wi-Fi.
    """
    env = dashboard_env()
    base = (env.get("DASHBOARD_URL") or "").rstrip("/")
    token = env.get("LINKS_EXPORT_TOKEN") or ""
    if not base or not token:
        return None
    query = {"token": token, **{k: v for k, v in params.items() if v not in ("", None)}}
    url = base + "/api/links/clusters?" + urlencode({**query, "limit": "1"})
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "control-center/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace") or "{}")
    except Exception:  # noqa: BLE001
        return None
    if not data.get("ok"):
        return None
    return int(data.get("matched") or 0)


def check_selection(s: dict) -> None:
    """Refuse a dashboard selection that holds no links, naming the filter.

    Raises ValueError, which /api/start already turns into the message the
    window shows. Silent when the dashboard cannot be asked.
    """
    base = {
        "clusterBy": str(s.get("cluster_by", "combined")),
        "clusters": "" if str(s.get("clusters", "")).strip().lower() in ("", "all", "0")
                    else str(s.get("clusters")),
        "platform": str(s.get("platform", "") or ""),
        "genre": str(s.get("genre", "") or ""),
        "category": str(s.get("category", "") or ""),
    }
    n = dashboard_matches(base)
    if n is None or n > 0:
        return

    # Nothing matched. Drop each filter in turn and keep EVERY one that would
    # unblock it - not the first.
    #
    # NAMING ONLY THE FIRST IS A LIE WHEN TWO ARE RESPONSIBLE. The message used
    # to read "Cluster by rank is why - 174,980 match without it", which anybody
    # reads as "there are no ranked links". There were 2,648 of them; they are
    # simply all in a different genre than the one asked for. Blaming the
    # clustering sent you to fix a box that was not wrong on its own.
    freeing: list[tuple[str, int, str]] = []
    for label, key, drop in (
        (f"Cluster by {LQ}{base['clusterBy']}{RQ}", "clusterBy", "combined"),
        (f"Genre {LQ}{GENRE_LABELS.get(base['genre'], base['genre'])}{RQ}", "genre", ""),
        (f"Platform {LQ}{base['platform']}{RQ}", "platform", ""),
        (f"Category {LQ}{base['category']}{RQ}", "category", ""),
        (f"Clusters {LQ}{s.get('clusters')}{RQ}", "clusters", ""),
    ):
        # clusterBy is always set, so it is always worth testing; the rest only
        # when they are actually narrowing something.
        if key != "clusterBy" and not str(base.get(key, "")).strip():
            continue
        without = dashboard_matches({**base, key: drop})
        if without:
            freeing.append((label, without, key))

    if not freeing:
        raise ValueError(
            "Nothing to work: no link matches this selection, and no single filter "
            "explains it - the pool may simply be empty for this platform."
        )

    if len(freeing) == 1:
        label, without, key = freeing[0]
        extra = ""
        if key == "clusterBy" and base["clusterBy"] == "rank":
            extra = (f" Rank clustering keeps only links that carry a search rank, "
                     f"and almost the whole pool came from channel scrapes and is "
                     f"date-only — use Combined.")
        raise ValueError(
            f"Nothing to work: no link matches this selection. {label} is why — "
            f"{without:,} link(s) match without it.{extra}"
        )

    # SEVERAL would unblock it, so none of them is wrong on its own and the
    # COMBINATION is the answer. Say what each one has behind it, then what to
    # change.
    parts = " ".join(f"Without {lbl}: {n:,} link(s)." for lbl, n, _ in freeing)
    hint = ""
    keys = {k for _, _, k in freeing}
    if {"clusterBy", "genre"} <= keys and base["clusterBy"] == "rank":
        # Which genre those ranked links actually are in. Three more calls, only
        # on the failure path, and it is the sentence that ends the hunt.
        has = []
        for g in GENRES:
            m = dashboard_matches({**base, "genre": g})
            if m:
                has.append(f"{GENRE_LABELS.get(g, g)} ({m:,})")
        if has:
            hint = (f" The links that carry a search rank are in: {', '.join(has)}. "
                    f"Pick one of those, or switch Cluster by to Combined to reach "
                    f"the date-only links as well.")
        else:
            hint = (" Switch Cluster by to Combined: nothing with a search rank is in "
                    "any genre right now.")
    raise ValueError(
        f"Nothing to work: this COMBINATION holds no links, though each part has "
        f"some on its own. {parts}{hint}"
    )


def tool_health() -> list[dict]:
    """Which of the programs in SCRIPTS are actually there."""
    out = []
    for name, path in SCRIPTS.items():
        out.append({"tool": name, "path": str(path), "ok": path.exists()})
    return out


# ── the phone ───────────────────────────────────────────────────────────────
# BORROWED, NOT REBUILT. automate.py already knows how to find adb, ask a
# DevTools endpoint whether it is alive, and put a dropped phone back — including
# the part nobody guesses, that Chrome opens its debugging socket once at startup
# and a Chrome which ran through a disconnect has none. A second copy of that
# here would drift from the one doing the work.
def hearts_module():
    """automate.py, imported on demand. None if it is not there."""
    try:
        if str(HEARTS_DIR) not in sys.path:
            sys.path.insert(0, str(HEARTS_DIR))
        import automate  # type: ignore

        return automate
    except Exception:  # noqa: BLE001 - a missing sibling project is not a crash
        return None


def adb_devices() -> list[str]:
    """Device lines adb can see — automate.py's parser, not a second one.

    It drops adb's own chatter: starting the daemon prints "* daemon not running"
    ABOVE the header, and listing that as a connected phone is worse than listing
    nothing.
    """
    h = hearts_module()
    return h.adb_attached() if h else []


def adb_trouble(h) -> tuple[list[str], str]:
    """The devices, and the reason there are none when the reason is not the phone.

    ADB CAN BE THE THING THAT IS BROKEN. Another program holding its port 5037
    kills every command with "could not read ok from ADB Server", and this card
    showed that as "no phone" — so the next thing anybody does is pick up the
    phone, which is the one place the fault is not. automate.py steps around a
    hijacked port by itself; this is for saying so, and for the case where the
    fallback port is taken too.
    """
    devices, rc, out = h.adb_attached_detail()
    if devices or rc == 0:
        return devices, ""
    first = next((l.strip() for l in out.splitlines()
                  if l.strip() and not l.strip().startswith("*")), out.strip())
    return devices, first[:160]


def phone_state(cdp: str) -> dict:
    """Is there a phone, and is its Chrome reachable at this address?"""
    h = hearts_module()
    if not h:
        return {"ok": False, "detail": "2_comment_automation is not there",
                "devices": [], "adb": ""}
    devices, adb_error = adb_trouble(h)
    ok, detail = h.cdp_alive(cdp) if cdp.strip() else (False, "no address given")
    # Only asked when nothing is attached: mDNS discovery takes a second or two,
    # and a phone already on the cable has nothing to discover. Skipped outright
    # when adb itself is the problem — discovery would just fail the same way.
    found = "" if devices or adb_error else h.adb_discover()
    return {"ok": ok, "detail": detail, "devices": devices, "adb": h.adb_bin(),
            "found": found, "adbError": adb_error,
            "adbPort": h.adb_port() if hasattr(h, "adb_port") else 5037}


# ── the server ──────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    # The default logs a line per request to stderr, which in a window with a
    # polling UI is a line every second, forever.
    def log_message(self, *a):  # noqa: D102
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            try:
                self._send(200, UI_FILE.read_bytes(), "text/html; charset=utf-8")
            except OSError:
                self._send(500, b"ui.html is missing", "text/plain")
            return
        if u.path == "/api/state":
            # The dashboard's genre list, refreshed in the background so a
            # slow dashboard never holds the window's polling up.
            threading.Thread(target=refresh_genres, daemon=True).start()
            self._json({
                "genres": [{"id": g, "label": GENRE_LABELS.get(g, g)} for g in GENRES],
                "jobs": RUNNER.listing(),
                "settings": load_settings(),
                "tools": tool_health(),
                "running": RUNNER.running(),
            })
            return
        if u.path == "/api/logins":
            self._json({"logins": liker_logins()})
            return

        if u.path == "/api/phone":
            q = parse_qs(u.query)
            self._json(phone_state((q.get("cdp") or [""])[0]))
            return
        if u.path == "/api/log":
            q = parse_qs(u.query)
            job = RUNNER.get((q.get("id") or [""])[0])
            if not job:
                self._json({"error": "no such job"}, 404)
                return
            since = int((q.get("since") or ["0"])[0])
            lines, seq = job.tail(since)
            self._json({"lines": lines, "seq": seq, "status": job.status,
                        "exit": job.exit_code})
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            self._json({"error": "bad json"}, 400)
            return

        if u.path == "/api/settings":
            s = load_settings()
            tool = str(body.get("tool") or "")
            if tool in s and isinstance(body.get("values"), dict):
                s[tool].update({k: v for k, v in body["values"].items() if k in s[tool]})
                # ASKING FOR THE PREVIEW IS NOT A CHANGE. The page wants the
                # command line as soon as it opens, and writing the form back at
                # that moment is a write nobody asked for — one that could only
                # ever replace a saved setting with whatever the form happened
                # to show.
                if not body.get("preview_only"):
                    save_settings(s)
                self._json({"ok": True, "preview": preview(tool, s[tool])})
                return
            self._json({"error": "unknown tool"}, 400)
            return

        if u.path == "/api/phone/connect":
            h = hearts_module()
            if not h:
                self._json({"error": "2_comment_automation is not there"}, 400)
                return
            cdp = str(body.get("cdp") or "").strip()
            addr = str(body.get("address") or "").strip()
            steps = []
            # A phone on Wi-Fi has to be dialled before anything can be forwarded
            # to it. One over USB is already listed and this is skipped.
            if addr:
                rc, out = h._adb("connect", addr)
                steps.append(f"adb connect {addr}: {out.splitlines()[0] if out else rc}")
            # Everything after that — reconnect, forward, and restarting a Chrome
            # whose debugging socket is gone — is cdp_relink's job.
            prev = h.CDP_URL
            h.CDP_URL = cdp or prev
            try:
                # Two rounds, not three: the second is the one that restarts
                # Chrome, so two covers every case this can fix while keeping
                # the button under about half a minute.
                got = h.cdp_relink(tries=2, every=2)
            finally:
                h.CDP_URL = prev
            state = phone_state(cdp)
            steps.append("connected" if got else "could not reach the phone's Chrome")
            self._json({"ok": got, "steps": steps, **state})
            return

        if u.path == "/api/start":
            tool = str(body.get("tool") or "")
            if tool not in BUILDERS:
                self._json({"error": f"unknown tool {tool}"}, 400)
                return
            s = load_settings()
            dirty = isinstance(body.get("values"), dict)
            if dirty:
                s[tool].update({k: v for k, v in body["values"].items() if k in s[tool]})
            # SAVED ONLY ONCE THE RUN IS GOING AHEAD.
            #
            # This used to write the form to disk right here, before any check.
            # A press refused for holding no links still saved the selection
            # that had just been refused, so a corrected setting was overwritten
            # by the stale form of whatever page happened to be open - and the
            # correction never survived long enough to be used.
            def commit() -> None:
                if dirty:
                    save_settings(s)

            script = SCRIPTS[tool]
            if not script.exists():
                self._json({"error": f"{script} is not there"}, 400)
                return
            if tool == "hearts":
                # ONE PRESS, ONE OR TWO RUNS. The PC's liker opens its own
                # throwaway browser and the phone's attaches over adb, so nothing
                # is shared between them except — on purpose — the list.
                try:
                    # Same guard, same reason - this one reads the dashboard
                    # through the same endpoint and fails the same way.
                    if str(s["hearts"].get("source", "dashboard")) == "dashboard":
                        check_selection(s["hearts"])
                    places = hearts_places(s["hearts"])
                    if not places:
                        raise ValueError("Tick somewhere to run: this PC, the "
                                         "phone, or both.")
                    many = len(places) > 1
                    built = [build_hearts_for(s["hearts"], pl, many) for pl in places]
                except ValueError as e:
                    self._json({"error": str(e)}, 400)
                    return
                commit()
                started = [RUNNER.start(tool, title, cmd, cwd).id
                           for title, cmd, cwd in built]
                self._json({"ok": True, "job": started[0], "jobs": started})
                return

            if tool == "liker":
                # ONE JOB PER PROFILE. Each is a separate TikTok account with
                # its own browser, its own session and its own done rows, so two
                # accounts on one list is two runs - started together, and each
                # liking every matching comment (only ties are passed).
                try:
                    # Checked BEFORE anything is started: a selection with no
                    # links in it opens N browsers, asks the dashboard, and
                    # exits 2 - N times. Only when the links come from the
                    # dashboard; a file is its own answer.
                    if str(s["liker"].get("source", "dashboard")) != "file":
                        check_selection(s["liker"])
                    names = liker_profiles(s["liker"])
                    built = [build_liker_for(s["liker"], n, names) for n in names]
                except ValueError as e:
                    self._json({"error": str(e)}, 400)
                    return
                commit()
                # AT MOST `at_once` ACCOUNTS AT A TIME; the rest wait their turn
                # and take the place of whichever finishes first.
                try:
                    at_once = max(0, int(s["liker"].get("at_once", 0) or 0))
                except (TypeError, ValueError):
                    at_once = 0
                started = [j.id for j in RUNNER.start_limited(tool, built, at_once)]
                self._json({"ok": True, "job": started[0], "jobs": started})
                return

            if tool == "search":
                # ONE JOB PER PLATFORM. scraper.py takes a single --platform and
                # writes a single file; four platforms is four runs, started
                # together so the slowest one is the wait rather than the sum.
                try:
                    runs = search_runs(s["search"])
                    if not runs:
                        raise ValueError("Tick at least one platform.")
                    many = len(runs) > 1
                    built = [build_search_for(s["search"], pl, ct, many)
                             for pl, ct in runs]
                except ValueError as e:
                    self._json({"error": str(e)}, 400)
                    return
                commit()
                started = []
                for (plat, _content), (title, cmd, cwd) in zip(runs, built):
                    job = RUNNER.start(tool, title, cmd, cwd)
                    started.append(job.id)
                    # Each search chains its OWN upload, of its OWN file. A
                    # second job rather than one job doing two things: two logs,
                    # two exit codes, and an upload you can stop without killing
                    # the scrape that is still running next to it.
                    if s["search"].get("upload_after"):
                        threading.Thread(
                            target=_chain_upload,
                            args=(job, dict(s["search"]), plat),
                            daemon=True,
                        ).start()
                self._json({"ok": True, "job": started[0], "jobs": started})
                return
            try:
                title, cmd, cwd = BUILDERS[tool](s[tool])
            except ValueError as e:
                self._json({"error": str(e)}, 400)
                return
            commit()
            job = RUNNER.start(tool, title, cmd, cwd)
            self._json({"ok": True, "job": job.id})
            return

        if u.path == "/api/input":
            job = RUNNER.get(str(body.get("id") or ""))
            if not job:
                self._json({"error": "no such job"}, 404)
                return
            self._json({"ok": job.send(str(body.get("text") or ""))})
            return

        if u.path == "/api/stop":
            job = RUNNER.get(str(body.get("id") or ""))
            if not job:
                self._json({"error": "no such job"}, 404)
                return
            self._json({"ok": job.stop()})
            return

        if u.path == "/api/stop-all":
            self._json({"ok": True, "stopped": RUNNER.stop_all()})
            return

        self._json({"error": "not found"}, 404)


# scraper.py ends every platform's run with this line, and the path in it is
# the only thing that says for certain which file this job wrote.
SAVED_RE = __import__("re").compile(r"Saved\s+[\d,]+\s+unique URLs to '([^']+)'")


def csv_rows(path: str) -> int:
    """How many data rows a CSV holds, or 0 if it cannot be read."""
    if not path:
        return 0
    try:
        with open(path, encoding="utf-8", errors="ignore", newline="") as f:
            return max(0, sum(1 for _ in f) - 1)   # minus the header
    except OSError:
        return 0


def written_file(job: Job) -> str:
    """The CSV a finished search job wrote, as an ABSOLUTE path.

    "THE NEWEST CSV" IS NOT GOOD ENOUGH ANY MORE. With four platforms scraping at
    once, the newest file at the moment one of them finishes belongs to whichever
    finished last — so a TikTok run could hand upload.py an Instagram file, and
    in replace mode that removes the rank links of a platform nobody was
    uploading. The scraper says where it wrote; this reads it back.

    ABSOLUTE, because the two programs do not agree on what a relative path means
    and neither is wrong. The scraper prints its own, relative to where it runs:

        Saved 1,204 unique URLs to 'results\\tiktok_….csv'

    and upload.py joins a relative path onto ITS idea of the results folder,
    which is that same folder again:

        [!] File not found: …\\1_tiktok_search_scraper\\results\\results\\tiktok_….csv

    Resolved here against the job's own working directory, which is the one
    place that knows what the scraper meant.
    """
    lines, _ = job.tail(0)
    for line in reversed(lines):
        m = SAVED_RE.search(line)
        if m:
            raw = m.group(1).strip()
            if not raw:
                continue
            path = Path(raw)
            return str(path if path.is_absolute() else (Path(job.cwd) / path).resolve())
    return ""


def _chain_upload(search_job: Job, settings: dict, platform: str = "") -> None:
    """Upload what one search found, once it has finished and only if it worked.

    A failed scrape has nothing to upload and a stopped one has half a file;
    sending either at the pool is how a replace-mode upload removes links that
    are still perfectly good.
    """
    # WAITING MEANT "starting OR running", AND A QUEUED JOB IS NEITHER.
    #
    # Browser jobs queue behind the shared Chrome profile, so a four-platform
    # search starts one run and leaves the rest `queued`. This loop fell straight
    # through for every one of those, read a status that was not "done", and
    # announced "not uploading" before the search had even begun — so TikTok (the
    # one that ran immediately) uploaded and YouTube and Instagram never did.
    #
    # Asking whether the job is OVER cannot miss a state the same way.
    while not search_job.finished():
        time.sleep(1)
    if search_job.status != "done":
        # NOT UPLOADED, BUT NOT SILENTLY LOST EITHER. The scraper writes as it
        # goes, so a run that died on its ninth keyword still left eight
        # keywords' worth of links on disk. Replace-mode on a part-written file
        # would drop the rank links the missing keywords would have carried, so
        # this does not send it — but it says what is there, because "the search
        # failed" on its own reads as "nothing was collected".
        csv = written_file(search_job)
        rows = csv_rows(csv)
        search_job.write(f"[*] not uploading: the search {search_job.status}")
        if rows > 0:
            search_job.write(
                f"[*] {rows:,} link(s) were written before it stopped: {csv}")
            search_job.write(
                "[*] They are not lost. Upload that file by hand if you want "
                "them — in APPEND mode, since a part-written file in replace "
                "mode would remove the links the keywords it never reached "
                "would have carried.")
        return
    csv = written_file(search_job)
    if not csv:
        # Without a filename there is no safe upload to run: see written_file.
        search_job.write("[!] not uploading: the search did not say which file "
                         "it wrote, and guessing the newest one can upload "
                         "another platform's results")
        return
    title, cmd, cwd = build_upload({
        "csv": csv, "platform": platform,
        "upload_mode": settings.get("upload_mode", "replace"),
        # The genre the search ran under, not whatever the window says now — it
        # can be changed while the scrape is still going.
        "genre": settings.get("genre", ""),
    })
    search_job.write(f"[*] search finished — uploading {csv}")
    RUNNER.start("upload", title, cmd, cwd)


def free_port(preferred: int) -> int:
    """The port asked for, or any free one.

    A fixed port is friendlier (the window can be reopened at the same address)
    until something else already holds it, at which point refusing to start is
    the least useful thing this could do.
    """
    for port in (preferred, 0):
        try:
            s = socket.socket()
            s.bind(("127.0.0.1", port))
            got = s.getsockname()[1]
            s.close()
            return got
        except OSError:
            continue
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--port", type=int, default=8740)
    ap.add_argument("--browser", action="store_true",
                    help="open in the default browser instead of a native window")
    args = ap.parse_args()

    missing = [t["tool"] for t in tool_health() if not t["ok"]]
    if missing:
        print(f"[!] not found: {', '.join(missing)} — those tabs will refuse to start")

    # The genres added in the dashboard, before the window first asks for them.
    refresh_genres(max_age=0)

    port = free_port(args.port)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"
    print(f"[*] Control Center on {url}")

    if not args.browser:
        try:
            import webview  # type: ignore

            # A real window: its own icon in the taskbar, no address bar, and it
            # closes when you close it. pywebview uses Edge WebView2 here, which
            # ships with Windows 11 — nothing to install for the user.
            window = webview.create_window(
                "Control Center", url,
                width=1380, height=900, min_size=(1040, 680),
                background_color="#0b0f14",
            )
            webview.start()
            RUNNER.stop_all()
            return 0
        except ImportError:
            print("[*] pywebview is not installed, opening the browser instead")
            print("    (pip install pywebview for a native window)")

    webbrowser.open(url)
    print("[*] Close this terminal to stop every running job.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        RUNNER.stop_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
