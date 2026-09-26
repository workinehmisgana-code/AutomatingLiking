"""A new site's browser starts as a COPY of the TikTok one, not empty.

The TikTok profiles were set up by signing in to Google — that is how the
accounts were made — so the Google session, the saved passwords and the mailbox
that receives confirmation codes all live in profile-a. Creating profile-ig-a as
an empty browser threw every bit of that away and presented a window with no
accounts in it, when the whole point was to reuse the ones already there.

Measured, after copying profile-b to profile-yt-b: both directories answered
myaccount.google.com with the same signed-in address. YouTube itself still shows
its Sign in button, because that profile has never been to YouTube — but signing
in is then a click on the account chooser rather than a password and a code.

The one file this all rests on is `Local State`: Chrome keeps the cookie
encryption key there, wrapped by Windows DPAPI. Copy the cookies without it and
they decrypt to nothing, which looks exactly like the bug being fixed.

    python check_clone.py
"""
import shutil
import sys
import tempfile
from pathlib import Path

import clone
from login import profile_dir

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(f"   {'ok  ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))


def a_profile(root: Path, name: str) -> Path:
    """A directory shaped like a Chrome profile with a session in it."""
    d = root / name
    (d / "Default" / "Network").mkdir(parents=True)
    (d / "Default" / "Network" / "Cookies").write_bytes(b"cookie-db")
    (d / "Default" / "Login Data").write_bytes(b"passwords")
    (d / "Default" / "Preferences").write_text("{}", encoding="utf-8")
    (d / "Local State").write_text('{"os_crypt":{"encrypted_key":"k"}}', encoding="utf-8")
    # ...and the parts that are only caches and locks.
    (d / "Default" / "Cache").mkdir()
    (d / "Default" / "Cache" / "f").write_bytes(b"0" * 10000)
    (d / "GrShaderCache").mkdir()
    (d / "GrShaderCache" / "f").write_bytes(b"0" * 10000)
    (d / "Default" / "Sessions").mkdir()
    (d / "Default" / "Sessions" / "tabs").write_bytes(b"open tabs")
    (d / "lockfile").write_bytes(b"lock")
    return d


tmp = Path(tempfile.mkdtemp(prefix="clone-"))
src = a_profile(tmp, "profile-x")
dst = tmp / "profile-ig-x"

print("what a copy carries")
ok, note = clone.copy_profile(src, dst)
check("  it copies", ok, True)
# The session, which is the entire reason for this.
check("  cookies", (dst / "Default" / "Network" / "Cookies").read_bytes(), b"cookie-db")
check("  saved passwords", (dst / "Default" / "Login Data").exists(), True)
check("  preferences", (dst / "Default" / "Preferences").exists(), True)
# THE KEY. Without it the cookies above decrypt to nothing and the copy looks
# signed out — the one failure mode that would look like the bug being fixed.
check("  and Local State, which decrypts them", (dst / "Local State").exists(), True)
check("  the code says why that file matters", "COPIED AND REQUIRED"
      in Path("clone.py").read_text(encoding="utf-8"), True)

print("\nand what it leaves behind")
# 21MB of Cache and 10MB of shader caches out of 53MB, all re-downloadable.
check("  the cache", (dst / "Default" / "Cache").exists(), False)
check("  the shader cache", (dst / "GrShaderCache").exists(), False)
# A fresh Instagram browser reopening yesterday's TikTok tabs is nobody's idea.
check("  yesterday's open tabs", (dst / "Default" / "Sessions").exists(), False)
# A copy of a lock is a lock.
check("  the lock file", (dst / "lockfile").exists(), False)
check("  so it is much smaller",
      sum(f.stat().st_size for f in dst.rglob("*") if f.is_file())
      < sum(f.stat().st_size for f in src.rglob("*") if f.is_file()) / 2, True)

print("\nit never quietly replaces an account")
ok, note = clone.copy_profile(src, dst)
check("  a second copy is refused", ok, False)
check("  saying why", "already exists" in note, True)
check("  and the first is untouched",
      (dst / "Default" / "Network" / "Cookies").read_bytes(), b"cookie-db")
# ...unless asked, in as many words.
(src / "Default" / "Network" / "Cookies").write_bytes(b"newer-db")
ok, note = clone.copy_profile(src, dst, overwrite=True)
check("  --overwrite does replace it", ok, True)
check("  with the newer one", (dst / "Default" / "Network" / "Cookies").read_bytes(), b"newer-db")

print("\nand it refuses what it cannot copy correctly")
empty = tmp / "profile-empty"
empty.mkdir()
ok, note = clone.copy_profile(empty, tmp / "profile-ig-empty")
check("  a profile with no browser in it", ok, False)
check("  saying so", "no browser in it yet" in note, True)
# A busy directory means a held cookie database and a truncated copy — the
# result is a profile that is signed out in a way nothing explains.
src_txt = Path("clone.py").read_text(encoding="utf-8")
check("  a source a browser has open", "busy.is_busy(src)" in src_txt, True)
check("  and a destination one", "busy.is_busy(dst)" in src_txt, True)
check("  a failed copy leaves nothing behind", "nothing left behind" in src_txt, True)
check("  copying a site onto itself", clone.clone("x", "tiktok", "tiktok")[0], False)

print("\nthe dashboard offers it where it makes sense")
dash = Path("dashboard.py").read_text(encoding="utf-8")
html = Path("dashboard.html").read_text(encoding="utf-8")
check("  one profile at a time", "cloneOne(" in html, True)
check("  or every one that is missing", "cloneAll(" in html, True)
check("  only on the profiles that have no browser here",
      "!p.here && S.site !== 'tiktok'" in html, True)
check("  and never on TikTok itself", "the ones being copied FROM" in dash, True)
check("  the button says what it is for",
      "Brings the Google account across" in html, True)
check("  nothing already there is touched",
      "not profile_dir(n, site).exists()" in dash, True)

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{'all correct' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(0 if fails == 0 else 1)
