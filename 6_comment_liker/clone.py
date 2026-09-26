#!/usr/bin/env python3
"""Copy a Chrome profile from one site's directory to another's.

WHY. The TikTok profiles were set up by signing in to Google — that is how the
accounts were made, and the Google session, the saved passwords and the mailbox
are all sitting in profile-a. Starting profile-ig-a as an empty browser threw
all of that away: a new window with no accounts in it, where the whole point was
to reuse the ones already there.

So Instagram's and YouTube's browsers start as a COPY of TikTok's. Same Google
account signed in, same saved passwords, same mail for the confirmation code —
and then a different site is signed in to on top of it. They are still separate
directories afterwards: signing in to Instagram in profile-ig-a does not touch
profile-a, and a later TikTok run is unaffected.

WHAT IS COPIED, and what is not:

  * `Local State` is COPIED AND REQUIRED. Chrome encrypts cookies with a key
    stored there, wrapped by Windows DPAPI for this user. Copy the cookies
    without it and they decrypt to nothing — the copy looks signed out, which is
    the one failure that would look exactly like the bug being fixed.
  * Caches are SKIPPED: 21MB of `Cache` and 10MB of shader caches out of 53MB,
    all of it re-downloadable and none of it a session. A profile copies in
    about a second this way.
  * `Sessions` is skipped too. That is the list of open tabs, and a fresh
    Instagram browser reopening yesterday's TikTok tabs is nobody's idea.
  * The singleton lock files are skipped, because a copy of a lock is a lock.

Refused while either directory is open in a browser: the cookie database is
held, the copy gets a truncated file, and the result is a profile that is signed
out in a way nothing explains.

    python clone.py --profile a --to instagram
    python clone.py --all --to youtube          # every tiktok profile
    python clone.py --all --to instagram --overwrite
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import busy
import console
from login import SITE_PREFIX, profile_dir

console.fix()

HERE = Path(__file__).resolve().parent

# Directories and files that are caches, locks or open-tab lists. Everything
# else is copied, so a session cannot be lost by this list being incomplete —
# only time can.
SKIP = {
    "Cache", "Code Cache", "GPUCache", "DawnWebGPUCache", "DawnGraphiteCache",
    "GrShaderCache", "ShaderCache", "GraphiteDawnCache", "component_crx_cache",
    "extensions_crx_cache", "Crashpad", "Crash Reports", "Safe Browsing",
    "Sessions", "Session Storage", "Service Worker",
    "BrowserMetrics", "BrowserMetrics-spare.pma", "segmentation_platform",
    "lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket",
}


def _ignore(directory: str, names: list[str]) -> set[str]:
    return {n for n in names if n in SKIP}


def copy_profile(src: Path, dst: Path, overwrite: bool = False) -> tuple[bool, str]:
    """Copy one profile directory to another. Returns (ok, what happened)."""
    if not (src / "Default").exists():
        return False, f"{src.name} has no browser in it yet — nothing to copy."
    if busy.is_busy(src):
        return False, (f"{src.name} is open in a browser. Its cookie database is held "
                       "open, so a copy would be half a file — stop that run first.")
    if busy.is_busy(dst):
        return False, f"{dst.name} is open in a browser. Stop that run first."
    if dst.exists():
        if not overwrite:
            return False, (f"{dst.name} already exists. Deleting it first is a decision "
                           "with an account in it, so it is not made here.")
        try:
            shutil.rmtree(dst)
        except Exception as e:  # noqa: BLE001
            return False, f"could not replace {dst.name}: {e}"
    try:
        shutil.copytree(src, dst, ignore=_ignore, dirs_exist_ok=False)
    except Exception as e:  # noqa: BLE001
        # A half-copied profile is worse than none: it opens, looks signed in,
        # and fails in ways nothing explains.
        shutil.rmtree(dst, ignore_errors=True)
        return False, f"copy failed, nothing left behind: {e}"
    # The one file the whole thing depends on.
    if not (dst / "Local State").exists() and (src / "Local State").exists():
        shutil.copy2(src / "Local State", dst / "Local State")
    size = sum(f.stat().st_size for f in dst.rglob("*") if f.is_file())
    return True, f"{src.name} → {dst.name} ({size / 1e6:.0f} MB, caches left behind)"


def clone(name: str, to_site: str, from_site: str = "tiktok",
          overwrite: bool = False) -> tuple[bool, str]:
    """Copy one profile from one site's directory to another's."""
    if to_site == from_site:
        return False, "That is the same directory."
    return copy_profile(profile_dir(name, from_site), profile_dir(name, to_site), overwrite)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Copy Chrome profiles from one site's directories to another's.")
    ap.add_argument("--profile", default="", help="one profile name")
    ap.add_argument("--all", action="store_true", help="every profile of --from")
    ap.add_argument("--from", dest="src", default="tiktok", choices=list(SITE_PREFIX),
                    help="which site's profiles to copy (default: tiktok)")
    ap.add_argument("--to", required=True, choices=list(SITE_PREFIX),
                    help="which site to create them for")
    ap.add_argument("--overwrite", action="store_true",
                    help="replace a directory that already exists — it has an account "
                         "in it, so this is never the default")
    args = ap.parse_args()

    import sessions

    if args.all:
        names = sessions.discover(args.src)
    elif args.profile:
        names = [args.profile]
    else:
        print("Give --profile NAME or --all.")
        return 2
    if not names:
        print(f"No {args.src} profiles on disk.")
        return 1

    print(f"Copying {len(names)} {args.src} profile(s) to {args.to}:")
    done = failed = 0
    for n in names:
        ok, note = clone(n, args.to, args.src, args.overwrite)
        print(f"  {'ok  ' if ok else 'SKIP'} {n:10} {note}")
        done += ok
        failed += not ok
    print(f"\n{done} copied, {failed} skipped.")
    if done:
        print(f"Each one is signed in exactly as its {args.src} profile was. Sign in to")
        print(f"{args.to} in them now — the dashboard's Sign in button does it one at a time.")
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
