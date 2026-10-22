#!/usr/bin/env python3
"""
Can a run be picked up where the last one stopped?

THE STATE FILE ALREADY EXISTED AND ALREADY SKIPPED LINKS. What it recorded was
links that were FINISHED — hearted to the target, stopped by the ceiling, or
carrying no comment of ours. Under --to-top that is deliberately not the same as
links that were VISITED: a video our comment is still losing on is left pending
so the next pass goes back to it.

That is right for a pass over the whole list and wrong for a run that was killed
a third of the way down, which is the case somebody means by "start where I left
off": the first forty links get worked again before the run reaches new ground.

So the state file now records both, and --resume chooses which one to skip:

    --resume      skip every link the last run OPENED  (carry on from there)
    (default)     skip only the links it FINISHED      (re-chase the rest)
    --fresh       skip nothing, and forget the record

Nothing here opens a browser or touches Zefoy.

    python check_resume.py
"""
import io
import json
import sys
import time
from pathlib import Path

import automate as a

HERE = Path(__file__).resolve().parent
FAILS = 0
KEY = "__check_resume__"  # logs/state___check_resume__.json, removed at the end


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


def cleanup():
    for suffix in ("", "_freer"):
        sp = a._state_path(KEY, suffix)
        if sp.exists():
            sp.unlink()


cleanup()
src = io.open(HERE / "automate.py", encoding="utf-8").read()

# ── the two lists are kept apart ───────────────────────────────────────────
print("a state file holds what was finished and what was merely opened:")
a.save_state(KEY, {"u1", "u2"}, visited={"u1", "u2", "u3", "u4"})
check("  finished", sorted(a.load_state(KEY)), ["u1", "u2"])
check("  visited", sorted(a.load_visited(KEY)), ["u1", "u2", "u3", "u4"])
raw = json.loads(a._state_path(KEY).read_text(encoding="utf-8"))
check("  and it is stamped", "updated" in raw, True)

# The caller that does not track visits must not erase the list. Freer marks
# every link done, so for it the two sets are the same thing — but a
# `--service both` run writes through both paths against one key.
print("\na writer that tracks no visits does not wipe the ones recorded:")
a.save_state(KEY, {"u1", "u2", "u5"})
check("  visited survives", sorted(a.load_visited(KEY)), ["u1", "u2", "u3", "u4", "u5"])
check("  and finished is what was passed", sorted(a.load_state(KEY)), ["u1", "u2", "u5"])

# ── what each mode skips ───────────────────────────────────────────────────
# The selection run_zefoy makes, in the same terms: a list of six links where the
# last run finished two and got as far as the fourth.
urls = [{"url": f"u{i}"} for i in range(1, 7)]
cleanup()
a.save_state(KEY, {"u1", "u2"}, visited={"u1", "u2", "u3", "u4"})


def pending(resume: bool) -> list[str]:
    done = a.load_state(KEY)
    seen = a.load_visited(KEY)
    skip = (done | seen) if resume else done
    return [e["url"] for e in urls if e["url"] not in skip]


print("\nsix links, two finished, four opened:")
check("  default re-chases the unfinished two", pending(False), ["u3", "u4", "u5", "u6"])
check("  --resume carries on from the fifth", pending(True), ["u5", "u6"])
check("  --fresh works the whole list", (cleanup(), pending(True))[1],
      ["u1", "u2", "u3", "u4", "u5", "u6"])

# ── an old state file ──────────────────────────────────────────────────────
# Written before any of this existed: processed only, no visited key. --resume
# must fall back to the finished list rather than raising or skipping nothing.
print("\na state file from before this existed still works:")
sp = a._state_path(KEY)
sp.parent.mkdir(parents=True, exist_ok=True)
sp.write_text(json.dumps({"processed": ["u1", "u2"]}), encoding="utf-8")
check("  nothing is recorded as visited", sorted(a.load_visited(KEY)), [])
check("  --resume behaves like the old default", pending(True), ["u3", "u4", "u5", "u6"])
# And a corrupt one is not fatal either: a run interrupted mid-write should cost
# a place in the list, not the run.
sp.write_text("{ not json", encoding="utf-8")
check("  a truncated file reads as empty", (sorted(a.load_state(KEY)), sorted(a.load_visited(KEY))), ([], []))
cleanup()

print("\nclear_state removes both services' files and says which:")
a.save_state(KEY, {"u1"})
a.save_state(KEY, {"u1"}, suffix="_freer")
gone = a.clear_state(KEY)
check("  two files removed", len(gone), 2)
check("  and nothing is left", [p.exists() for p in gone], [False, False])
check("  a second call removes nothing", a.clear_state(KEY), [])

# ── the wiring ─────────────────────────────────────────────────────────────
# ── two runs, one list ─────────────────────────────────────────────────────
# The PC's browser and the phone's can work the same links at once. They are
# separate processes, so who-is-doing-what lives in a claims file beside the
# state file — and a claim is a LEASE, not a lock: if the phone is unplugged
# mid-link nobody is left holding it.
print("\ntwo runs can share one list without repeating each other:")
_K = "__check_share__"
for _f in (a._claims_path(_K), a._lock_path(_K)):
    _f.unlink(missing_ok=True)

check("  the pc takes a link", a.claim_link(_K, "u1", "pc-1"), True)
check("  the phone is turned away from it", a.claim_link(_K, "u1", "phone-2"), False)
check("  but the next one is free", a.claim_link(_K, "u2", "phone-2"), True)
check("  and re-claiming your own is not a conflict", a.claim_link(_K, "u1", "pc-1"), True)
a.release_link(_K, "u1", "pc-1")
check("  releasing hands it over", a.claim_link(_K, "u1", "phone-2"), True)

print("\na run that stops does not keep its links:")
_ttl = a.CLAIM_TTL
a.CLAIM_TTL = 1
try:
    a.claim_link(_K, "u3", "phone-2")
    check("  held while the lease is live", a.claim_link(_K, "u3", "pc-1"), False)
    time.sleep(1.2)
    check("  and taken over once it lapses", a.claim_link(_K, "u3", "pc-1"), True)
finally:
    a.CLAIM_TTL = _ttl

print("\nwho a runner says it is:")
_cdp = a.CDP_URL
try:
    a.CDP_URL = ""
    check("  on this PC", a.runner_name().startswith("pc-"), True)
    a.CDP_URL = "http://127.0.0.1:9222"
    check("  on the phone", a.runner_name().startswith("phone-"), True)
finally:
    a.CDP_URL = _cdp
for _f in (a._claims_path(_K), a._lock_path(_K)):
    _f.unlink(missing_ok=True)

print("\nand the run uses all of it:")
check("  a claimed link is skipped", "if not claim_link(csv_path, url, me):" in src, True)
check("  so is one the other run finished", "if url in load_state(csv_path):" in src, True)
check("  the link is released as soon as it is done",
      "release_link(csv_path, url, me)" in src, True)
# Walking the list once would leave a hole where the other runner stopped.
check("  and the survivor goes back for what was dropped",
      "sweeps_left[0] -= 1" in src, True)
check("  after a pause, since a live claim is work, not a leak",
      "time.sleep(SHARE_SWEEP_WAIT)" in src, True)
check("  --fresh forgets the claims too", "_claims_path(csv_path), _lock_path(csv_path)" in src, True)
check("  and a flag turns it on", '"--share", action="store_true"' in src, True)

print("\nthe switch reaches the runner:")
check("  there is a flag", '"--resume", "-R"' in src, True)
check("  and an env default", 'RESUME              = os.getenv("RESUME", "false")' in src, True)
check("  run_zefoy takes it", "resume: bool = False" in src, True)
check("  it is passed in", "resume=args.resume" in src, True)
check("  a visit is recorded whether or not it finished", "visited.add(url)" in src, True)
# ...but not a link the browser never opened. A dead connection logged 1,416 of
# those in two minutes, and the next --resume would have skipped the whole list.
check("  a link the browser never opened is not a visit",
      'if "has been closed" not in (r.get("note") or ""):' in src, True)
check("  and saved with the rest", "save_state(csv_path, processed, visited=visited)" in src, True)
check("  --fresh clears the file", "gone = clear_state(state_key)" in src, True)
# LOOP=true lives in .env and --loop could only ever turn it ON, so a resumed run
# had no way to say "one pass, then stop".
check("  and a loop can be switched off for one run",
      '"--no-loop", dest="loop", action="store_false"' in src, True)
check("  asking for both at once is refused",
      "--resume and --fresh ask for opposite things" in src, True)
# Without --resume the run says what it is about to redo, so the flag is
# discoverable from the output rather than only from --help.
check("  the default run names the flag", "pass --resume to carry on past them" in src, True)
check("  and the header says which mode is on", '"[*] Resume     : "' in src, True)

# A --loop pass is not an interrupted run: it reached the end of the list and
# came back. It still starts over, --resume or not.
print("\na --loop pass is still a fresh sweep:")
check("  the loop clears the state", "if last_pass_rows:\n                clear_state(state_key)" in src, True)
# ...BUT ONLY IF IT SWEPT ANYTHING. A pass that worked no links did not finish
# the list, and clearing then is pure loss. This is what a dead adb forward cost:
# the browser went at link 40 of 1,526 and the whole record was wiped, once a
# minute, for thirteen passes.
check("  a pass that did nothing keeps it",
      "the last pass worked no links" in src, True)
check("  and the count it decides on is the pass's own rows",
      "last_pass_rows = len(all_results)" in src, True)

# The same failure must also end the run, not feed it back into the loop.
print("\na browser that is gone stops the run instead of looping:")
check("  the failure is recorded", "BROWSER_FATAL.append(str(e))" in src, True)
# Two handlers that END a run, one per runner — and a third, in the Zefoy
# worker, that tries to put the phone back before it comes to that.
check("  both runners record it", src.count("BROWSER_FATAL.append(str(e))"), 2)
check("  and one more tries to recover first", src.count("except BrowserGone as e:"), 3)
check("  the loop checks it", "if BROWSER_FATAL:" in src, True)
check("  and says how to carry on", "with --resume to carry " in src, True)
check("  a connect refusal is not treated as a crash",
      "raise BrowserGone(f\"cannot reach {CDP_URL}" in src, True)

# And it is asked before the link list is fetched, not after.
print("\nthe phone is checked before anything else happens:")
check("  there is a check", "def cdp_alive(" in src, True)
check("  it runs before the pool is pulled",
      src.index("ok, cdp_detail = cdp_alive(args.cdp)") < src.index("all_urls, dash_products = from_dashboard("),
      True)
check("  a refused connection is named plainly",
      "nothing is listening there - the adb forward is gone" in src, True)
check("  with the command that fixes it",
      "adb forward tcp:9222 localabstract:chrome_devtools_remote" in src, True)

# The order the links come in is what makes "where I left off" a place at all.
print("\nand the order a resume continues in is the same order:")
check("  dashboard links keep their cluster order",
      "entries.sort(key=lambda e: (e[\"cluster\"] is None, e[\"cluster\"] or 0))" in src, True)

# ── a phone that drops mid-run ─────────────────────────────────────────────
# The device falls off adb by itself: `adb devices` lists nothing, the forward
# goes with it, and 127.0.0.1:9222 stops answering. Two commands bring it back —
# which a person was typing, once per drop, roughly every fifteen minutes.
print("\na dropped phone is picked back up with the two commands a person would type:")
_real_adb, _real_alive, _real_sleep = a._adb, a.cdp_alive, a.time.sleep
calls = []
DEVICES_OUT = "List of devices attached\nRZ8T21TZJSL\tdevice"
a._adb = lambda *args, **kw: (calls.append(args) or (0, DEVICES_OUT))
a.time.sleep = lambda s: None
try:
    a.CDP_URL = "http://127.0.0.1:9222"
    a.cdp_alive = lambda url, timeout=4.0: (True, "Chrome/154")
    calls.clear()
    check("  it comes back", a.cdp_relink(), True)
    check("  via adb reconnect", ("reconnect", "offline") in calls, True)
    check("  and the forward",
          ("forward", "tcp:9222", "localabstract:chrome_devtools_remote") in calls, True)
    # reconnect, devices (is there anything to dial?), forward.
    check("  nothing more than that", len(calls), 3)

    print("\nthe port comes from --cdp, not from a constant:")
    a.CDP_URL = "http://127.0.0.1:9333"
    calls.clear()
    a.cdp_relink()
    check("  9333", ("forward", "tcp:9333", "localabstract:chrome_devtools_remote") in calls, True)

    print("\na phone that does not come back ends the attempt, bounded:")
    a.CDP_URL = "http://127.0.0.1:9222"
    a.cdp_alive = lambda url, timeout=4.0: (False, "nothing is listening there")
    calls.clear()
    check("  gives up", a.cdp_relink(tries=3, every=0), False)
    # Three rounds of (reconnect, devices, forward), one `adb devices` for the
    # line that says what adb can see, and on the second round the Chrome
    # restart: force-stop, a cold launch, and the forward re-made after it.
    # Plus one `pm list packages`: when the restart does not help, the run asks
    # whether CHROME_PACKAGE was ever installed, because force-stop and monkey
    # both succeed silently against a package that is not there. It only ever
    # prints, and it runs AFTER the repair so it can never stand in front of it.
    check("  after exactly that many tries", len(calls), 14)

    # THE FORWARD CAN BE FINE AND THE SOCKET STILL GONE. Chrome opens
    # chrome_devtools_remote once, at browser start, and never again — so a
    # Chrome that ran through the disconnect has nothing for the forward to point
    # at, and adb repeats itself while 127.0.0.1:9222 answers nothing. Resuming
    # the app does not do it either; it has to be a cold start.
    # ── a phone on Wi-Fi has to be found before it can be dialled ──────────
    # adb ships two mDNS backends. The default one reports itself as
    # "adb discovery 0.0.0" and finds nothing; the Openscreen one finds the phone
    # on the first try. Same adb, same network, same phone — so the environment
    # variable is set for every call rather than left to whoever opened the
    # terminal.
    print("\na phone on Wi-Fi is found by asking the network:")
    check("  the discovery backend is switched on",
          'env.setdefault("ADB_MDNS_OPENSCREEN", "1")' in src, True)

    a._adb = lambda *args, **kw: (calls.append(args) or (0,
        "List of discovered mdns services\n"
        "adb-RZ8T21TZJSL-LZWXEd\t_adb-tls-connect._tcp\t192.168.1.10:45327\n"))
    check("  the address is read out of the advert", a.adb_discover(), "192.168.1.10:45327")
    a._adb = lambda *args, **kw: (0, "List of discovered mdns services\n")
    check("  and nothing advertised is nothing invented", a.adb_discover(), "")
    # The pairing advert is a different service and is not something to dial.
    a._adb = lambda *args, **kw: (0,
        "List of discovered mdns services\n"
        "adb-X\t_adb-tls-pairing._tcp\t192.168.1.10:37000\n")
    check("  a pairing advert is not a connect address", a.adb_discover(), "")
    # Put the recording fake back: the sections below count what adb was asked.
    a._adb = lambda *args, **kw: (calls.append(args) or (0, DEVICES_OUT))

    print("\nand an undialled phone is not the same as an offline one:")
    check("  recovery dials what it discovers",
          "if not adb_attached():" in src and 'rc, out = _adb("connect", found)' in src, True)
    check("  saying where it found it", "Found the phone on the network at" in src, True)

    print("\nwhen adb is fine but Chrome has no socket, Chrome is restarted:")
    a.CDP_URL = "http://127.0.0.1:9222"

    def alive_once_restarted(url, timeout=4.0):
        restarted = any(c[:3] == ("shell", "am", "force-stop") for c in calls)
        return (True, "Chrome/154") if restarted else (False, "nothing is listening")

    a.cdp_alive = alive_once_restarted
    calls.clear()
    check("  it comes back", a.cdp_relink(tries=4, every=0), True)
    check("  via a force-stop",
          any(c[:3] == ("shell", "am", "force-stop") for c in calls), True)
    check("  and a cold launch", any("monkey" in c for c in calls), True)
    check("  with the forward re-made afterwards",
          any(c[:2] == ("forward", "tcp:9222") for c in calls[-2:]), True)
    # Said because it changes what happens next: a cold Chrome has no Zefoy
    # session, so the first thing the run meets is a captcha.
    check("  and the captcha that follows is announced",
          "Chrome was restarted, so " in src, True)

    print("\nbut a plain reconnect still wins without touching Chrome:")
    a.cdp_alive = lambda url, timeout=4.0: (True, "Chrome/154")
    calls.clear()
    check("  back on the first try", a.cdp_relink(tries=4, every=0), True)
    check("  Chrome untouched", any("force-stop" in c for c in calls), False)

    print("\nand without --cdp there is nothing to relink:")
    a.CDP_URL = ""
    calls.clear()
    check("  says so", a.cdp_relink(), False)
    check("  without running adb", calls, [])
finally:
    a._adb, a.cdp_alive, a.time.sleep = _real_adb, _real_alive, _real_sleep
    a.CDP_URL = ""

# ── a dead browser must leave the visit, not be logged as the video's fault ──
# zefoy_process_url catches everything and returns a per-link failure. That is
# right for a video that will not cooperate and wrong for a connection that is
# gone: "Target page, context or browser has been closed" was recorded 1,416
# times in one run, one video at a time, because the queue kept feeding links to
# a browser that no longer existed. Nothing ever raised, so the reconnect never
# ran and the run ended "3/1435 successful" with exit code 0.
print("\na dead connection is told apart from an uncooperative video:")


class _Open:
    def is_closed(self):
        return False


class _Closed:
    def is_closed(self):
        return True


for msg in ("Target page, context or browser has been closed",
            "Locator.wait_for: Target page, context or browser has been closed",
            "websocket connection closed"):
    check(f"  {msg[:40]}", a.browser_gone(_Open(), RuntimeError(msg)), True)
check("  an ordinary timeout is not",
      a.browser_gone(_Open(), RuntimeError("Timeout 10000ms exceeded")), False)
check("  a closed page always is", a.browser_gone(_Closed(), None), True)

print("\nand it leaves the visit so the worker can reconnect:")
# Two runners, and each checks both its timeout and its catch-all handler.
check("  both runners re-raise, on both handlers",
      src.count('raise BrowserGone(f"the browser went away mid-visit'), 4)
check("  on timeouts as well as errors", src.count("if browser_gone(page, e):"), 6)
check("  an already-named one passes straight through",
      src.count("except BrowserGone:"), 2)

print("\nthe worker carries on instead of ending the run:")
check("  one session per attempt", "ONE SESSION PER ATTEMPT" in src, True)
check("  bounded by a budget", "left = CDP_RECOVER" in src, True)
check("  which a flag can set", '"--recover", type=int' in src, True)
check("  an empty queue is not worth reconnecting for",
      "if not CDP_URL or left <= 0 or url_queue.empty():" in src, True)
check("  and the links still queued are kept", "link(s) still queued" in src, True)
check("  adb is found without being configured", "def adb_bin(" in src, True)

cleanup()
print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
