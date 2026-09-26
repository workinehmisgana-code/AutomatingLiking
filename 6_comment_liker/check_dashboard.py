"""Does the dashboard run what it says it will run?

A control panel's whole value is that the switch on screen is the flag on the
command line. The ways that quietly stops being true:

  1. A SWITCH THAT REACHES NOTHING. The page offers `--foo`, the script has
     never heard of it, and the run either dies on an unrecognised argument or
     — worse — the flag is silently dropped and the switch does nothing for
     months. This reads `--help` from like.py and run_parallel.py and fails if
     the table offers either of them a flag it would reject.

  2. A PROFILE CHANGING THE RUN. Overrides are per profile, but "how the work
     is shared out" is a property of the run. An override of `share` would let
     profile b quietly turn the whole thing from split into stack.

  3. AN OVERRIDE THAT IS NOT AN OVERRIDE. Independently is the mode where
     per-profile settings matter. If the builder read the shared value there,
     the entire feature would be decoration.

  4. A STOP LOOKING LIKE A CRASH. terminate() leaves a non-zero exit code
     everywhere, so a deliberate stop must not be painted as a failure.

Runs a real server on a spare port and drives it over HTTP, because the API is
the thing the page actually uses.

    python check_dashboard.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import dashboard_settings as ds

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


# ── 1. every flag the table offers is one the script accepts ────────────────
def accepted(script: str) -> set[str]:
    out = subprocess.run([sys.executable, script, "--help"], capture_output=True, text=True).stdout
    return set(re.findall(r"(--[a-z0-9][a-z0-9-]*)", out))


print("every setting reaches a script that understands it")
like_flags = accepted("like.py")
par_flags = accepted("run_parallel.py")
check("  like.py answered --help", len(like_flags) > 10, True)
check("  run_parallel.py did too", len(par_flags) > 10, True)

bad = []
for f in ds.FIELDS:
    for target, allowed in (("like", like_flags), ("parallel", par_flags)):
        if target not in f.targets:
            continue
        flag = ds.PARALLEL_FLAG_OVERRIDE.get(f.key, f.flag) if target == "parallel" else f.flag
        if flag not in allowed:
            bad.append(f"{f.key} -> {flag} ({target})")
check("  none is rejected", bad, [])
check("  and none reaches neither", [f.key for f in ds.FIELDS if not f.targets], [])

# The commands themselves, not just the table: a builder can still emit a flag
# for a target the field does not claim.
s = ds.defaults()
lc = ds.like_command("py", "like.py", "a", s)
pc = ds.parallel_command("py", "run_parallel.py", ["a", "b"], s)
check("  the like command uses only like.py's flags",
      [a for a in lc if a.startswith("--") and a not in like_flags], [])
check("  the parallel command only run_parallel's",
      [a for a in pc if a.startswith("--") and a not in par_flags], [])
# --products is like.py only: run_parallel hard-codes it for every child, so
# offering it there would be a switch that changes nothing.
check("  --products goes to like.py", "--products" in lc, True)
check("  and not to run_parallel", "--products" in pc, False)
# run_parallel documents the per-account cap under a different name.
check("  the like cap is --limit for one profile", "--limit" in lc, True)
check("  and --per-account for a collection", "--per-account" in pc, True)

# ── 2. and 3. what an override may and may not do ───────────────────────────
print("\nan override changes that profile and nothing else")
shared = dict(ds.defaults(), delay="2,5", share="split")
m = ds.merged(shared, {"delay": "9,15"})
check("  a per-profile field is taken", m["delay"], "9,15")
check("  the rest still come from shared", m["scrolls"], shared["scrolls"])
# `share` describes how ONE pool is divided between several profiles. Letting a
# profile override it would let profile b turn the whole run into a stack.
m2 = ds.merged(shared, {"share": "stack", "loop": True, "stagger": 99})
check("  a run-level field is refused", m2["share"], "split")
check("  even a switch", m2["loop"], False)
check("  and a number", m2["stagger"], shared["stagger"])
check("  the table says which is which",
      sorted(f.key for f in ds.FIELDS if not f.per_profile),
      ["at_once", "loop", "loop_pause", "platform", "sequential", "share", "stagger",
       "timeout_min", "videos"])
# Platform is the newest of these and the most consequential: it decides the
# script, the profile directory and the links at once, so a profile cannot sit
# in a run on a different site from the rest of it.
check("  including the platform", ds.BY_KEY["platform"].per_profile, False)
# The memory lever is run-level by nature: it says how many browsers exist at
# once, which is a fact about the run and meaningless for one profile.
check("  including how many browsers at once", ds.BY_KEY["at_once"].per_profile, False)
check("  which run_parallel accepts", "--at-once" in par_flags, True)
# Changing it must not change what gets done, only how many at a time.
check("  and it is not sent to a single like.py",
      "--at-once" in ds.like_command("py", "l.py", "a", dict(s, at_once=4)), False)

# ── values are pinned, not trusted ──────────────────────────────────────────
print("\nwhat comes off the page is coerced before it reaches a command line")
check("  a checkbox string", ds.coerce("headed", "true"), True)
check("  and its opposite", ds.coerce("headed", "off"), False)
check("  a number that is not one", ds.coerce("scrolls", "abc"), ds.BY_KEY["scrolls"].default)
check("  a negative", ds.coerce("scrolls", "-4"), 0)
# A select that is not one of its own options would otherwise reach the command
# line as --mode whatever-was-typed.
check("  a choice off the list", ds.coerce("mode", "nonsense"), "dom")
check("  a choice on it", ds.coerce("mode", "api"), "api")
check("  an unknown key is dropped", "nope" in ds.clean({"nope": 1}), False)
# An empty string means "not set". --category "" would filter on the empty
# category rather than on none.
check("  a blank string is left off the command line",
      "--category" in ds.like_command("py", "l.py", "a", dict(s, category="")), False)
check("  and a set one is on it",
      "--category" in ds.like_command("py", "l.py", "a", dict(s, category="generic")), True)

# ── links: the two modes source them differently ────────────────────────────
print("\nrunning independently gives each profile its own window")
# Without a slot every headed window opens in the same place, stacked exactly
# on top of the others, and "running independently" looks like one browser
# doing nothing. run_parallel hands these to every child it starts; a set of
# independent runs has to do the same.
for i, n in enumerate(["a", "b", "c"]):
    cmd = ds.like_command("py", "like.py", n, s, slot=i, count=3)
    check(f"  {n} gets slot {i}", cmd[cmd.index("--window-slot") + 1], str(i))
    check(f"  of 3", cmd[cmd.index("--window-count") + 1], "3")
check("  and the dashboard numbers them",
      "slot=i, count=len(names)" in Path("dashboard.py").read_text(encoding="utf-8"), True)
# The flags exist on like.py, which is what makes them do anything.
check("  like.py takes them", "--window-slot" in like_flags and "--window-count" in like_flags, True)
# Headless is the default, so a run that produces no windows is not broken.
check("  headless unless asked", ds.defaults()["headed"], False)
check("  and --headed is what asks", "--headed" in ds.like_command("py", "l.py", "a", dict(s, headed=True)), True)

print("\nwhere each mode gets its links")
check("  one profile with no file asks the dashboard",
      "--from-dashboard" in ds.like_command("py", "l.py", "a", s), True)
check("  with a file it does not",
      "--from-dashboard" in ds.like_command("py", "l.py", "a", s, "links.txt"), False)
check("  and uses the file", "links.txt" in ds.like_command("py", "l.py", "a", s, "links.txt"), True)
# run_parallel reads the dashboard itself when given no file, so there is no
# --from-dashboard to pass.
check("  a collection with no file passes neither",
      "--from-dashboard" in pc or "--links" in pc, False)
check("  a collection with a file passes it",
      "--links" in ds.parallel_command("py", "r.py", ["a"], dict(s, links_file="x.txt")), True)

# ── 4. the server, driven the way the page drives it ────────────────────────
print("\nthe server, over HTTP")
PORT = 8931
B = f"http://127.0.0.1:{PORT}"


def get(p):
    return json.loads(urllib.request.urlopen(B + p, timeout=20).read())


def post(p, body):
    r = urllib.request.Request(B + p, data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json"}, method="POST")
    try:
        return json.loads(urllib.request.urlopen(r, timeout=30).read())
    except urllib.error.HTTPError as e:
        return {"http": e.code, **json.loads(e.read() or b"{}")}


# The settings file is the one piece of state; keep the real one out of this.
store = Path("dashboard.json")
backup = store.read_bytes() if store.exists() else None
srv = subprocess.Popen([sys.executable, "-u", "dashboard.py", "--port", str(PORT), "--no-open"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
try:
    for _ in range(40):
        try:
            get("/api/state?since=%7B%7D")
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.25)

    st = get("/api/state?since=%7B%7D")
    check("  it serves a state", isinstance(st.get("profiles"), list), True)
    check("  with the profiles on disk", len(st["profiles"]) > 0, True)
    check("  and every field", len(st["fields"]), len(ds.FIELDS))
    page = urllib.request.urlopen(B + "/", timeout=20).read()
    check("  and the page itself", b"<title>Liker</title>" in page, True)

    # platform pinned: the collection preview is TikTok's (run_parallel starts
    # like.py workers), so a check of it must not inherit whichever platform
    # happens to be saved on this machine.
    post("/api/settings", {"shared": dict(st["shared"], delay="3,7", platform="tiktok")})
    check("  shared settings save", get("/api/state?since=%7B%7D")["shared"]["delay"], "3,7")

    name = st["profiles"][0]["name"]
    post("/api/settings", {"profiles": {name: {"overrides": {"delay": "11,12", "share": "stack"}}}})
    got = [p for p in get("/api/state?since=%7B%7D")["profiles"] if p["name"] == name][0]
    check("  a per-profile override saves", got["overrides"].get("delay"), "11,12")
    # The server has to refuse it too, not just the merge: the page is not the
    # only thing that can POST here.
    check("  a run-level one is refused at the door", "share" in got["overrides"], False)

    pv = post("/api/preview", {"profiles": [name]})
    check("  the collection preview uses the shared delay", "--delay 3,7" in pv["collection"], True)
    check("  the independent preview uses the override",
          "--delay 11,12" in pv["independent"][0]["cmd"], True)
    # The page shows the command before running it. A panel that hides what it
    # is about to run is a panel you cannot check.
    check("  and names the profile", f"--profile {name}" in pv["independent"][0]["cmd"], True)

    # ── two runs over one profile ───────────────────────────────────────────
    print("\ntwo runs cannot share a profile")
    # Chromium locks a user data directory, so the second run does not share
    # it — it simply cannot open a browser, and dies having printed nothing.
    # Eighteen of those at once look like the dashboard being broken.
    first = st["profiles"][0]["name"]
    other = st["profiles"][1]["name"]
    post("/api/settings", {"shared": dict(get("/api/state?since=%7B%7D")["shared"],
                                          dry_run=True, max_links=5, headed=False)})
    go = post("/api/run", {"mode": "independent", "profiles": [first]})
    check("  the first one starts", go.get("ok"), True)
    clash = post("/api/run", {"mode": "independent", "profiles": [first]})
    check("  a second on the same profile is refused", clash.get("http"), 400)
    # A collection holds every profile it was given, not just one.
    coll = post("/api/run", {"mode": "collection", "profiles": [first, other]})
    check("  and so is a collection that includes it", coll.get("http"), 400)
    check("  saying which profile and which job holds it",
          "held by" in (coll.get("note") or ""), True)
    check("  and why", "cannot share one profile directory" in (coll.get("note") or ""), True)
    free = post("/api/run", {"mode": "independent", "profiles": [other]})
    check("  a profile nobody holds still starts", free.get("ok"), True)
    post("/api/stop", {})
    src_now = Path("dashboard.py").read_text(encoding="utf-8")
    check("  a collection is known to hold all of its profiles",
          'job.cmd.index("--profiles")' in src_now, True)

    # ── a browser hanging up is not an error ────────────────────────────────
    # The page polls every 1.5s, so a reload leaves a response half-written.
    # http.server prints a full traceback for that and buries the URL.
    check("  a dropped connection is swallowed",
          "except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):" in src_now,
          True)
    check("  in both places it can happen",
          src_now.count("ConnectionAbortedError"), 2)

    check("  an unknown tool is refused", post("/api/tool", {"tool": "rm -rf"}).get("http"), 400)
    check("  running nothing is refused",
          post("/api/run", {"mode": "independent", "profiles": []}).get("http"), 400)

    # ── configuring one Chrome profile ──────────────────────────────────────
    print("\nconfiguring a specific profile")
    check("  a profile carries what it IS, not only how it runs",
          sorted(k for k in st["profiles"][0]) ,
          ["account", "checked", "dir", "email", "enabled", "here", "known", "label",
           "ledger", "live", "name", "overrides", "said", "start_url"])
    # "known" alone conflated a profile with a dead session and a profile
    # nobody has scanned — a new one was being told to sign in again, which is
    # wrong twice.
    html0 = Path("dashboard.html").read_text(encoding="utf-8")
    check("  a checked-and-empty profile reads as signed out", ">signed out<" in html0, True)
    check("  an unscanned one reads as not checked yet", ">not checked yet<" in html0, True)
    check("  and its Re-check button is the one highlighted",
          "p.known || p.checked ? '' : 'go'" in html0, True)
    post("/api/settings", {"profiles": {name: {
        "label": "spare account", "enabled": False,
        "start_url": "https://www.tiktok.com/setting"}}})
    got = [p for p in get("/api/state?since=%7B%7D")["profiles"] if p["name"] == name][0]
    check("  a label saves", got["label"], "spare account")
    check("  switching it off saves", got["enabled"], False)
    check("  and a start url", got["start_url"], "https://www.tiktok.com/setting")
    # A start URL is handed to a browser. file:// and javascript: both do
    # something, and neither is what anybody meant to type.
    post("/api/settings", {"profiles": {name: {"start_url": "javascript:alert(1)"}}})
    got = [p for p in get("/api/state?since=%7B%7D")["profiles"] if p["name"] == name][0]
    check("  anything that is not http(s) is refused", got["start_url"], "")

    # The address each account was REGISTERED with, read from emails.csv rather
    # than looked up: finding it opens every profile's browser and asks Google.
    got = [p for p in get("/api/state?since=%7B%7D")["profiles"] if p["name"] == name][0]
    check("  and the registered address, if it is on file",
          sorted(got["email"]) if got["email"] else [],
          ["confirmed", "email", "masked", "note", "username"] if got["email"] else [])
    dash_src = Path("dashboard.py").read_text(encoding="utf-8")
    check("  emails.csv is read, not re-run", dash_src.count("READ, NEVER RUN"), 2)
    check("  and when it was last written is shown",
          "emailsAt" in get("/api/state?since=%7B%7D"), True)
    # An address that does not fit TikTok's mask is a guess from the account
    # chooser. Shown as one, not as fact.
    html = Path("dashboard.html").read_text(encoding="utf-8")
    check("  a confirmed address says so", "confirmed</span>" in html, True)
    check("  and an unconfirmed one says that instead", "unconfirmed</span>" in html, True)
    check("  saying why it is not certain", "may be another account" in html, True)
    # Reading one profile's email must not wipe the other eighteen.
    em = Path("emails.py").read_text(encoding="utf-8")
    check("  reading one profile keeps the rest",
          "READING SOME OF THEM MUST NOT DELETE THE REST" in em, True)
    check("  carried rows are kept verbatim", "kept.pop(n, None)" in em, True)
    check("  and the header is fixed, not taken from the first row",
          "fieldnames=list(FIELDS)" in em, True)
    # emails.py had the same prefix-nesting trap sessions.py had, and the same
    # missing lock detection.
    check("  it finds profiles the one way", 'sessions.discover("tiktok")' in em, True)
    check("  and a busy profile is not an account with no address",
          "in use by another process" in em, True)
    # accounts.json drives which Google account relogin.py clicks. A wrong
    # entry signs a profile into the wrong account, which is worse than none.
    check("  only confirmed addresses reach accounts.json",
          'if r["confirmed"] == "yes" and r["google_email"]:' in em, True)

    print("\nadding one")
    # The name becomes a directory name, and the three sites' prefixes nest:
    # a TikTok profile called "ig-x" would create profile-ig-x, which every
    # other part of this reads as Instagram's "x".
    check("  a name that would land on another site is refused",
          post("/api/profile", {"name": "ig-x"}).get("http"), 400)
    check("  saying which site it would land on",
          "instagram" in post("/api/profile", {"name": "ig-x"}).get("note", ""), True)
    check("  a name with spaces is refused",
          post("/api/profile", {"name": "no spaces"}).get("http"), 400)
    check("  an existing one is refused",
          post("/api/profile", {"name": name}).get("http"), 400)
    made = post("/api/profile", {"name": "zzcheck"})
    check("  a good one is made", made.get("ok"), True)
    check("  and appears straight away",
          "zzcheck" in [p["name"] for p in get("/api/state?since=%7B%7D")["profiles"]], True)
    # Creating it must NOT open a browser somebody then has to sit in front of.
    check("  without signing in for you", "Press Sign in" in made.get("note", ""), True)
    import shutil
    shutil.rmtree(Path("profile-zzcheck"), ignore_errors=True)
finally:
    srv.terminate()
    try:
        srv.wait(timeout=10)
    except Exception:  # noqa: BLE001
        srv.kill()
    if backup is None:
        store.unlink(missing_ok=True)
    else:
        store.write_bytes(backup)

# ── the things that must stay true of the code ──────────────────────────────
print("\nwhat the panel is careful about")
src = Path("dashboard.py").read_text(encoding="utf-8")
html = Path("dashboard.html").read_text(encoding="utf-8")
# It starts signed-in browsers and can post public comments. It has no password.
check("  it binds localhost", 'default="127.0.0.1"' in src, True)
check("  and refuses anywhere else without being told twice", "--i-know" in src, True)
check("  saying why", "can post public" in src, True)
# A stopped job is not a failed one.
check("  a stop is not a failure", 'if self.stopping:\n            return "stopped"' in src, True)
check("  and terminate, not kill, so the ledger is flushed", "job.proc.terminate()" in src, True)
check("  the page has a colour for it", ".p-stopped" in html, True)
# The same profile twice would fight over one locked user data directory.
check("  one job per profile at a time", "is already running." in src, True)
# Settings are the only state; a half-written file is a panel that will not start.
check("  settings are written through a temp file", "tmp.replace(STORE)" in src, True)
# Scanning sessions opens every browser; doing it on each poll would be unusable.
check("  the session list is read, not re-run", "READ, NEVER RUN" in src, True)
# Independently, profiles without their own links file all pull the same query.
check("  the page says so rather than letting it surprise you",
      "they will work the same list" in html, True)
# Saving one profile stores only what DIFFERS, or a later change to the shared
# settings would silently skip that profile.
check("  an override stores only the difference",
      "String(v) !== String(S.shared[k])" in html, True)

# ── printing must not be able to end a run ──────────────────────────────────
print("\nprinting a box character cannot kill a script")
# Windows gives a child cp1252 stdout when it is attached to a PIPE, and every
# rule and em dash in this project is outside cp1252 — so a script that is fine
# in a terminal died the moment the dashboard captured its output, on the line
# that draws a heading.
import console  # noqa: E402

cons = Path("console.py").read_text(encoding="utf-8")
check("  there is a fix, and it says what it is for", "cp1252" in cons, True)
check("  it replaces rather than raises", 'errors="replace"' in cons, True)
check("  the child environment is forced too", "PYTHONIOENCODING" in cons, True)
# Both spawners, because either one can start a script that prints one.
check("  the dashboard uses it", "env=console.child_env()" in src, True)
check("  and run_parallel does",
      "env=console.child_env()" in Path("run_parallel.py").read_text(encoding="utf-8"), True)
# And every entry point fixes its own streams, so piping one by hand is safe.
missing = [f for f in ("open_profile.py", "sessions.py", "login.py", "like.py",
                       "run_parallel.py", "why_skipped.py", "verify.py",
                       "solve_captcha.py", "dashboard.py")
           if "console.fix()" not in Path(f).read_text(encoding="utf-8")]
check("  every entry point calls it", missing, [])
# The real thing: run a child through a pipe and make it print the characters
# that used to end it.
out = subprocess.run(
    [sys.executable, "-u", "-c",
     "import console; console.fix(); print('\u2500\u2500 h \u2500\u2500 \u2014 \u2026')"],
    capture_output=True, text=True, encoding="utf-8", errors="replace")
check("  a child survives printing them", out.returncode, 0)
check("  and they arrive intact", "\u2500\u2500 h \u2500\u2500 \u2014 \u2026" in (out.stdout or ""), True)

print("\nthe output can be taken off the screen")
# Reading a run means pasting it somewhere: into a message, a file, a bug
# report. Selecting 600 lines out of a scrolling <pre> with a mouse, while it
# is still being written to, is not a thing anybody does successfully.
html = Path("dashboard.html").read_text(encoding="utf-8")
check("  a button for what is on screen", 'onclick="copyShown(this)"' in html, True)
# Seventeen profiles is seventeen tabs, and a question about a run is nearly
# always a question about all of them.
check("  one for every job at once", 'onclick="copyEveryJob(this)"' in html, True)
check("  which labels each job", '"===== ${n} ' in html or '===== ${n}' in html, True)
check("  with its state and exit code", "j.state}${j.code === null" in html, True)
# THE PANE IS A TAIL — 400 lines kept by the server, 600 by the page. The
# beginning of a run is where the command, the link count and the first failure
# are, and by the time anybody asks, the pane has dropped it.
check("  and one for the whole log off disk", 'onclick="copyWholeLog(this)"' in html, True)
check("  which says why the pane is not enough", "THE PANE IS A TAIL" in html, True)
check("  the server serves it", '"/api/log"' in src, True)
# The parameter is a job NAME. This server answers without a password, so a
# request must not be able to name a file of its own.
check("  by job name, never by path", "THE PARAMETER IS A JOB NAME" in src, True)
check("  looking the job up", "RUNNER.jobs.get(" in src, True)
check("  and saying so when there is none", "no such job" in src, True)
# A clipboard write can fail — an unfocused page, a refused permission — and a
# Copy button that silently does nothing is worse than no button.
check("  a failed clipboard falls back", "document.execCommand('copy')" in html, True)
check("  and says so if even that fails", "could not copy" in html, True)
check("  every copy confirms what it took", "copied ${" in html or "copied " in html, True)

print("\na switch you ticked is a switch that is on")
# It used to need Save. Ticking "Comment only, never like" and pressing Start
# ran the SAVED settings — liking away, with the box still ticked on screen,
# because the page went on showing a value that was not in force. Found by
# reading the run's own command line: no --no-like on it, and dashboard.json
# had every one of the new switches still false.
check("  every change saves itself", "void saveSettings()" in html, True)
check("  switches at once", "onchange=\"edited()\"" in html, True)
# Saving on every keystroke would write the file thirty times while somebody
# types a delay range.
check("  typing waits for a pause", 'oninput="edited(true)"' in html, True)
check("  which is what the timer is for", "saveTimer = setTimeout" in html, True)
# A change made a fraction of a second before Start is still on its way to disk,
# and the run reads the file.
check("  starting flushes a pending save",
      re.search(r"async function run\(\)[\s\S]{0,400}?await saveSettings\(\)", html) is not None,
      True)
# Rebuilding the form after every save would move the caret to the end of the
# box somebody is typing in.
check("  and the form is not rebuilt under the cursor",
      "NOT renderFields()" in html, True)

print("\nthe accounts a run used are ticked again next time")
# A run is a decision. Repeating it should not mean re-ticking seventeen boxes,
# and the old default — everything signed in — is rarely the set anybody wants
# twice in a row.
check("  the store keeps them", '"selected": selected' in src, True)
# Per platform: the profiles signed in on Instagram are not the ones on TikTok,
# and one list would offer a selection that cannot run.
check("  per platform",
      'store.setdefault("selected", {})[platform] = list(names)' in src, True)
# Written when a run STARTS, not on every tick: a half-finished selection is not
# a decision.
check("  written when a run starts",
      re.search(r"def start_run[\s\S]{0,1200}?store\.setdefault\(\"selected\"", src)
      is not None, True)
check("  and sent to the page", '"selected": store.get("selected", {})' in src, True)
check("  which opens with them", "SEL = openingSelection(st)" in html, True)
# A profile deleted since then, or one whose browser is on another platform,
# would otherwise be ticked and then refused.
check("  dropping any that cannot run", "p.here !== false" in html, True)
check("  and falling back to everything signed in",
      "p.enabled && p.known && p.here !== false" in html, True)

print("\na setting added while the page is open shows up by itself")
# The form was built once, on first load, and never again — so a tab left open
# across a restart of this server went on showing the old set of settings while
# the server offered the new one on every poll. The answer was "press F5", which
# is only obvious to somebody who already knows.
check("  the page notices the set changed", "fieldSig(st) !== FIELDSIG" in html, True)
check("  and rebuilds the form",
      re.search(r"fieldSig\(st\) !== FIELDSIG[\s\S]{0,700}?renderFields\(\)", html) is not None,
      True)
# But not mid-edit: rebuilding would throw away what somebody is typing, and a
# setting that appears a second later beats a value that vanishes.
check("  unless something is unsaved", "&& !dirty" in html, True)
check("  the signature is the field keys", "map(f => f.key).join(',')" in html, True)

print("\nwhat each profile is doing while it runs")
# The ledger column is a career total: "4,184" does not visibly move, so it
# cannot answer the question somebody has during a run — is this account
# working, and is it liking anything.
import csv as _csv
import time as _time

import dashboard as dash

live_name = "livecheck"
led = dash.ledger_file(live_name)
check("  the ledger name matches like.py's", dash.ledger_file("default").name, "done.csv")
check("  for a named profile too", led.name, "done-livecheck.csv")


def _row(aweme, status, when=None):
    return [when or _time.strftime("%Y-%m-%dT%H:%M:%S"),
            f"https://www.tiktok.com/@x/video/{aweme}", aweme, f"c{aweme}{status}",
            "someone", "purifytext is great\nwith a newline in it", status, ""]


assert not led.exists(), led
try:
    with led.open("w", encoding="utf-8", newline="") as fh:
        w = _csv.writer(fh)
        # Yesterday's work. None of this belongs to the run about to start.
        for r in [_row("111", "ok", "2000-01-01T00:00:00"),
                  _row("111", "ok", "2000-01-01T00:00:01"),
                  _row("222", "fail:dom", "2000-01-01T00:00:02")]:
            w.writerow(r)
    dash.begin_live([live_name])
    got = dash.live_counts()[live_name]
    check("  a run starts at zero", (got["likes"], got["links"], got["failed"]), (0, 0, 0))

    with led.open("a", encoding="utf-8", newline="") as fh:
        w = _csv.writer(fh)
        for r in [_row("333", "ok"), _row("333", "ok"), _row("444", "ok"),
                  _row("555", "fail:dom")]:
            w.writerow(r)
    got = dash.live_counts()[live_name]
    check("  three likes are three likes", got["likes"], 3)
    # Two videos, not three rows: "how many links" is what somebody means by
    # how far through the list an account is.
    check("  on two links", got["links"], 2)
    check("  and a failure is not a like", got["failed"], 1)
    # A comment can contain a newline and is quoted, not escaped, so the file
    # must be read as CSV rather than split into lines.
    check("  a comment with a newline in it does not become two rows",
          dash.live_counts()[live_name]["likes"], 3)
finally:
    led.unlink(missing_ok=True)

# SINCE IS A TIMESTAMP, NOT A ROW COUNT. Every run begins by purging failed rows
# so they are tried again, which makes the ledger SHORTER — a count taken before
# that would skip real work afterwards.
check("  counting is by timestamp", "row[0] < self.since" in src, True)
check("  and the purge is the reason", "makes the file SHORTER" in src, True)
# No slack: the children start after begin_live, so nothing they write can
# predate it, and leeway would count whatever finished a moment ago.
check("  the clock is read as-is", "since = datetime.now()" in src, True)
check("  which both run modes set", src.count("begin_live("), 3)
# Re-reading seventeen ledgers every 1.5s is the cost here, so a file that has
# not changed is not read again.
check("  an unchanged ledger is not re-parsed", "if stamp == self._stamp:" in src, True)

check("  the page has a column for it", ">this run</th>" in html, True)
check("  showing likes and links", "on ${lv.links}" in html, True)
check("  a running profile is marked", "running ? '● ' : ''" in html, True)
# A run that has liked nothing for ten minutes is exactly what you want to
# notice, and a blank cell does not say it.
check("  zero is shown rather than hidden", "lv.likes ? '#5eead4' : '#71717a'" in html, True)
check("  and the run's own total is in the header", "like(s) on ${links" in html, True)

print("\na worker that finished its list is not one that died")
# like.py exits 1 when any like failed, and Python exits 1 on an uncaught
# traceback, so from outside the two are identical. Every job with a single
# failed like was painted red as "failed" beside jobs that had actually
# crashed — and on a run where most videos were already done, that was most of
# them. The closing summary is what separates them (check_runlog.py).
import pathlib as _pl

import dashboard as _dash

_finished = _dash.Job("j", "like", ["x"], _pl.Path("x.log"))
_dash.note_finished(_finished, "70 liked, 2 failed. Log: C:\\x\\done-j.csv")
_finished.code = 1
check("  a summary means it got to the end", _finished.finished_list, True)
check("  so it is not called failed", _finished.state(), "some-failed")

_crashed = _dash.Job("k", "like", ["x"], _pl.Path("x.log"))
_dash.note_finished(_crashed, "playwright._impl._errors.TimeoutError: Page.goto: Timeout 30000ms")
_crashed.code = 1
check("  no summary is a crash", _crashed.state(), "failed")

_clean = _dash.Job("a", "like", ["x"], _pl.Path("x.log"))
_clean.code = 0
check("  and a clean exit is done", _clean.state(), "done")

# A collection run prefixes each child's line with the profile.
_coll = _dash.Job("collection", "parallel", ["x"], _pl.Path("x.log"))
_dash.note_finished(_coll, "[k         ] 12 liked, 3 failed. Log: ...")
check("  a prefixed summary counts too", _coll.finished_list, True)

# "failed" and "some-failed" are one character apart and mean opposite things,
# so neither is shown as its own name.
check("  the page spells them out", "STATE_LABEL" in html, True)
check("  a crash says so", "CRASHED" in html, True)
check("  and the other says what actually happened",
      "done \u00b7 some likes failed" in html, True)
check("  in its own colour, not the red one", ".p-some-failed" in html, True)

print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
