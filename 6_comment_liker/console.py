#!/usr/bin/env python3
"""Make printing safe whatever this script's output is attached to.

Windows gives a Python process cp1252 stdout when it is attached to a PIPE
rather than a console. Every box-drawing rule, em dash and ellipsis in this
project is outside cp1252, so a script that runs perfectly in a terminal dies
the moment something captures its output:

    print(f"\\n── {name} ── {pdir.name}")
    UnicodeEncodeError: 'charmap' codec can't encode characters in position 2-3

It is not a display problem. The exception is raised by print, so the script
STOPS — a browser never opens, a run never starts — and the traceback blames a
line that is only drawing a heading.

Two defences, because they cover different callers:

  * this, called by each entry point, which fixes the script however it was
    started — piped, redirected to a file, or run by hand;
  * PYTHONIOENCODING=utf-8 in the environment of every child that dashboard.py
    and run_parallel.py start, which fixes scripts they launch even if one of
    them forgets to call this.

errors="replace" rather than "strict": a console that genuinely cannot render a
character should show a question mark, not end the run.
"""
import sys
import time


def fix() -> None:
    """Force UTF-8 on stdout and stderr. Safe to call more than once."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - a stream that cannot be reconfigured
            pass            #               (a pytest capture, a null device) is
            #               left alone; nothing here is worth failing over.


class _Stamped:
    """A stdout that puts the elapsed time in front of every line.

    Written for the question a log cannot otherwise answer: WHEN did this
    happen, and how long was the gap before it? "page did not render" says
    nothing; "page did not render" thirty-one seconds after the line above it
    says the browser spent thirty of those waiting, which is the whole
    diagnosis.

    The prefix goes on at the start of a line only. print() writes the text and
    the newline as separate calls, and a progress line written in pieces must
    not collect a timestamp between each piece.
    """

    def __init__(self, stream, started: float):
        self._s = stream
        self._t0 = started
        self._fresh = True

    def write(self, text: str) -> int:
        if not text:
            return 0
        out = []
        for part in text.splitlines(keepends=True):
            if self._fresh and part.strip():
                out.append(f"{time.time() - self._t0:8.1f}s  ")
            out.append(part)
            self._fresh = part.endswith(("\n", "\r"))
        return self._s.write("".join(out))

    def __getattr__(self, name):
        return getattr(self._s, name)


def stamp(started: float | None = None) -> None:
    """Put elapsed seconds in front of every line from here on.

    Only for a debugging run: a stamp on all 2,000 lines of an ordinary one is
    noise, and the ledger already carries wall-clock times.
    """
    t0 = time.time() if started is None else started
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if not isinstance(stream, _Stamped):
            setattr(sys, name, _Stamped(stream, t0))


def child_env(base: dict | None = None) -> dict:
    """An environment for a child process that will not die on a box character.

    The child's own stdout encoding is decided before any of its code runs, so
    it cannot fix itself before its first print. This is the only thing that
    can be set from outside.
    """
    import os

    env = dict(base if base is not None else os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    return env
