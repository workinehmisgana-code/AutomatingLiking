#!/usr/bin/env python3
"""Which profile directories a browser already has open.

WHY THIS EXISTS. A second Chromium on a user data directory that is already
open does not fail loudly. It starts, it renders TikTok, and it reports the
account as SIGNED OUT — because the cookie database is held by the first
browser and the second one cannot read it:

    PermissionError: [WinError 32] The process cannot access the file
    because it is being used by another process
        profile-a/Default/Network/Cookies

Everything that asks "is this profile signed in, and as whom" was answering
that question from an empty cookie store whenever a run happened to be going:

    login.py --check      "NOT signed in (error)"     — it is signed in
    sessions.py           writes it onto #not-signed-in
    the dashboard         shows a stale or wrong account name
    like.py               "Not signed in on profile 'a'", and stops

None of those is a session problem, and the fix for each is the same: find out
first, and say "in use" instead of guessing.

HOW. The running browsers are asked what they were started with. Chromium puts
--user-data-dir on its own command line, so the set of directories currently
held is exactly the set of those values. That is a fact about the machine
rather than about this process, so it also catches a run somebody started in
another terminal — which the dashboard's own bookkeeping cannot.

    python busy.py            # what is open right now
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import console

console.fix()

# The answer is good for a moment: a scan asks about twenty profiles in a row
# and the browsers do not come and go between them. Half a second per call for
# a question whose answer cannot have changed is worth avoiding.
_CACHE: tuple[float, set[str]] = (0.0, set())
CACHE_S = 3.0

WINDOWS = sys.platform.startswith("win")

PS = (
    "Get-CimInstance Win32_Process -Filter \"Name like '%chrome%'\" | "
    "Select-Object -ExpandProperty CommandLine | "
    "Select-String -Pattern 'user-data-dir=(\"\"[^\"\"]+\"\"|[^ ]+)' -AllMatches | "
    "ForEach-Object { $_.Matches.Groups[1].Value } | Sort-Object -Unique"
)


def _key(path) -> str:
    """One spelling of a directory, so two spellings of it compare equal."""
    try:
        return os.path.normcase(os.path.normpath(os.path.abspath(str(path))))
    except Exception:  # noqa: BLE001
        return str(path).strip().lower()


def dirs_in_use(force: bool = False) -> set[str]:
    """Every user data directory a running browser currently holds.

    An empty set means "nothing found", which is also what a failure returns —
    deliberately. Not being able to ask must not stop a run; it only loses the
    better error message.
    """
    global _CACHE
    now = time.time()
    if not force and now - _CACHE[0] < CACHE_S:
        return _CACHE[1]
    found: set[str] = set()
    if WINDOWS:
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", PS],
                capture_output=True, text=True, timeout=20,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).stdout
            for line in out.splitlines():
                line = line.strip().strip('"')
                if line:
                    found.add(_key(line))
        except Exception:  # noqa: BLE001
            pass
    _CACHE = (now, found)
    return found


def is_busy(profile_dir, force: bool = False) -> bool:
    """Is this profile directory open in a browser right now?"""
    return _key(profile_dir) in dirs_in_use(force=force)


def note(profile_dir) -> str:
    """The sentence to print instead of a wrong answer."""
    return (
        f"{Path(profile_dir).name} is open in another browser right now.\n"
        "  Chromium holds its cookie database while it has the profile, so a second\n"
        "  browser on it reads no cookies and reports the account as signed out.\n"
        "  Stop that run (or wait for it) and ask again — this says nothing about\n"
        "  whether the account is signed in."
    )


def main() -> int:
    held = sorted(dirs_in_use(force=True))
    if not held:
        print("No browser is holding a profile directory.")
        return 0
    print(f"{len(held)} profile directory(ies) are open right now:")
    for d in held:
        print(f"  {d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
