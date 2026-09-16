#!/usr/bin/env python3
"""
The Next button is never disabled.

There used to be a randomised 12-22 second cooldown after every link: Next was
greyed out and counted down on its own label. It is gone. What must be true now:

  * nothing in the service disables either action button, ever;
  * no part of the cooldown survives — a leftover field or a stray call to a
    function that no longer exists is a compile error, and one that only shows
    up on the machine with a working JDK;
  * the IN-FLIGHT guard is still there. It is a different thing: it lasts one
    request, not one pause, and without it a double tap records two clicks and
    skips a link nobody saw.

Static checks only: there is no JDK on this machine that Gradle 8.2 accepts
(Android Studio ships Java 25, Gradle 8.2 takes up to 20), so this cannot
compile the app. It can tell you the edit is self-consistent.

    python check_next_button.py
"""
import io
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "app/src/main/java/com/repostearn/bubble/BubbleService.kt"

FAILS = 0


def check(name, got, want):
    global FAILS
    ok = got == want
    if not ok:
        FAILS += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


text = io.open(SRC, encoding="utf-8").read()
# Comments explain what was removed and why, so they must not count as uses.
code = "\n".join(
    re.sub(r"//.*$", "", ln) for ln in re.sub(r"/\*.*?\*/", "", text, flags=re.S).split("\n")
)

print("every trace of the cooldown is gone from the code:")
for name in (
    "cooldownTicker",
    "startCooldown",
    "cancelCooldown",
    "cooldownMinMs",
    "cooldownMaxMs",
    "nextLabel",
):
    check(f"  {name}", len(re.findall(rf"\b{name}\b", code)), 0)

print("\nand so are the imports it alone needed:")
for imp in ("android.os.SystemClock", "kotlin.random.Random"):
    used = len(re.findall(rf"\b{imp.split('.')[-1]}\b", code))
    check(f"  {imp} neither imported nor used", used, 0)

print("\nnothing disables an action button:")
disables = re.findall(r"(nextButton|unrelatedButton)\?\.isEnabled\s*=\s*([A-Za-z0-9_!.]+)", code)
check("  every isEnabled assignment is `true`", sorted({v for _, v in disables}), ["true"])
alphas = re.findall(r"(nextButton|unrelatedButton)\?\.alpha\s*=\s*([A-Za-z0-9_.f]+)", code)
check("  and every alpha is full", sorted({v for _, v in alphas}), ["1f"])
check("  both buttons are set", sorted({b for b, _ in disables}), ["nextButton", "unrelatedButton"])
# The countdown wrote the seconds onto the button's own label.
check("  nothing writes a countdown onto Next",
      len(re.findall(r"nextButton\?\.text\s*=", code)), 0)

print("\nthe in-flight guard stays, on both handlers:")
check("  Next is guarded", "if (busy) return" in code.split("private fun onNext()")[1][:400], True)
check("  Unrelated is guarded",
      "if (busy) return" in code.split("private fun onMarkUnrelated()")[1][:400], True)
check("  lock() still sets it", bool(re.search(r"fun lock\(\)\s*\{\s*busy = true", code)), True)
check("  unlock() still clears it", bool(re.search(r"fun unlock\(\)\s*\{\s*busy = false", code)), True)
# The branch that opens a link must release the guard, or Next stays dead for
# the rest of the session — the exact failure this change must not introduce.
opened = code.split("copyCommentThen(commentText)")[1][:400]
check("  opening a link releases it", "unlock()" in opened, True)

print("\nthe file is still balanced:")
stripped = re.sub(r'"(?:[^"\\]|\\.)*"', '""', code)
check("  braces", stripped.count("{") - stripped.count("}"), 0)
check("  parens", stripped.count("(") - stripped.count(")"), 0)

print("\nNOTE: not compiled - no JDK here that Gradle 8.2 accepts.")
print(f"\n{'all correct' if FAILS == 0 else str(FAILS) + ' FAILED'}")
sys.exit(0 if FAILS == 0 else 1)
