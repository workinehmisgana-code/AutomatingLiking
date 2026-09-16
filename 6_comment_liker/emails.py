#!/usr/bin/env python3
"""
Which account is each profile signed in as?

A profile directory is a whole logged-in browser, and after a few of them nobody
remembers which is which. This asks each one and writes the answer to emails.csv.

TWO SOURCES, because neither is enough alone:

  * TikTok's passport endpoint gives the account's own email, MASKED —
    "k***3@gmail.com". Definitely the right account, but not an address you can
    type.
  * Google's account chooser gives the address in full. The profile still holds
    the Google session even when TikTok's has lapsed, which is the same fact
    relogin.py depends on.

They are cross-checked rather than merged: the chooser can list several
accounts, and picking the wrong one would put a plausible-looking address next
to the wrong profile. An address is only reported as confirmed when it fits the
mask — same first and last character of the local part, same domain.

    python emails.py                  # every profile-* directory
    python emails.py --profile a b    # only those
    python emails.py --write-accounts # also fill in accounts.json for relogin.py
"""
import argparse
import csv
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE / "emails.csv"
ACCOUNTS = HERE / "accounts.json"

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def safe(s: str) -> str:
    """Windows consoles are cp1252; one stray non-Latin character kills a run."""
    return str(s).encode("ascii", "replace").decode("ascii")


def profiles() -> list[str]:
    """Every profile-<name> directory, by suffix. 'profile' itself is 'default'."""
    out = []
    for d in sorted(HERE.glob("profile*")):
        if not d.is_dir():
            continue
        out.append("default" if d.name == "profile" else d.name[len("profile-"):])
    return out


def dir_for(name: str) -> Path:
    return HERE / ("profile" if name == "default" else f"profile-{name}")


def fits_mask(full: str, mask: str) -> bool:
    """
    Does this address match TikTok's masked one?

    The mask keeps the first and last character of the local part and the whole
    domain: kirubelman3@gmail.com -> k***3@gmail.com. That is weak on its own but
    decisive against a handful of candidates, which is all we ever compare.

    The star count says nothing about length — TikTok writes three of them
    whether it is hiding one character or nine. What it does say is that at least
    one character IS hidden, which is enough to reject k3@gmail.com: that address
    has nothing between the k and the 3 to hide.
    """
    if not full or not mask or "@" not in full or "@" not in mask:
        return False
    f_local, f_dom = full.rsplit("@", 1)
    m_local, m_dom = mask.rsplit("@", 1)
    if f_dom.lower() != m_dom.lower():
        return False
    keep = m_local.replace("*", "")
    if len(keep) < 2 or len(f_local) < 2:
        return False
    if "*" in m_local and len(f_local) <= len(keep):
        return False
    return f_local[0].lower() == keep[0].lower() and f_local[-1].lower() == keep[-1].lower()


def read_profile(p, name: str) -> dict:
    """Everything one profile will tell us about itself."""
    row = {
        "profile": name,
        "tiktok_username": "",
        "screen_name": "",
        "user_id": "",
        "tiktok_email_masked": "",
        "google_email": "",
        "confirmed": "",
        "note": "",
    }
    user_dir = dir_for(name)
    if not user_dir.exists():
        row["note"] = "no profile directory"
        return row

    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(user_dir),
        headless=True,
        args=["--disable-blink-features=AutomationControlled"],
    )
    try:
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # ── who TikTok thinks this is ────────────────────────────────────────
        try:
            page.goto("https://www.tiktok.com/", wait_until="domcontentloaded", timeout=45000)
            info = page.evaluate(
                """async () => {
                    const r = await fetch('/passport/web/account/info/?aid=1459', {
                        credentials: 'include',
                    })
                    if (!r.ok) return null
                    const j = await r.json().catch(() => null)
                    return (j && j.data) || null
                }"""
            )
        except Exception as e:  # noqa: BLE001
            info = None
            row["note"] = f"tiktok: {safe(e)[:60]}"
        if info:
            row["tiktok_username"] = str(info.get("username") or "")
            row["screen_name"] = str(info.get("screen_name") or "")
            row["user_id"] = str(info.get("user_id_str") or info.get("user_id") or "")
            row["tiktok_email_masked"] = str(info.get("email") or "")
        elif not row["note"]:
            row["note"] = "tiktok session not answering"

        # ── the address in full, from Google ─────────────────────────────────
        # The chooser, not myaccount: a profile whose Google session is passive
        # still lists its accounts here, and that is the state these profiles are
        # usually in.
        # The chooser redirects itself on the way in, and a redirect landing
        # mid-navigation aborts goto() with ERR_ABORTED — one profile in seven
        # hit it. "commit" returns as soon as the navigation is committed rather
        # than waiting for a load that a redirect will replace, so the retry is
        # the thing that actually works, not just another go.
        try:
            try:
                page.goto(
                    "https://accounts.google.com/AccountChooser?continue=https://myaccount.google.com/",
                    wait_until="domcontentloaded",
                    timeout=45000,
                )
            except Exception:  # noqa: BLE001
                page.goto(
                    "https://accounts.google.com/AccountChooser?continue=https://myaccount.google.com/",
                    wait_until="commit",
                    timeout=45000,
                )
            page.wait_for_timeout(3500)
            found = page.evaluate(
                """() => {
                    const out = new Set()
                    const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g
                    for (const m of (document.body.innerText || '').matchAll(re)) out.add(m[0])
                    for (const el of document.querySelectorAll('[data-email], [aria-label]')) {
                        const v = el.getAttribute('data-email') || el.getAttribute('aria-label') || ''
                        for (const m of v.matchAll(re)) out.add(m[0])
                    }
                    return Array.from(out)
                }"""
            )
        except Exception as e:  # noqa: BLE001
            found = []
            row["note"] = (row["note"] + "; " if row["note"] else "") + f"google: {safe(e)[:60]}"

        # Google's own help links are @google.com addresses, not accounts.
        cands = [e for e in found if not e.lower().endswith("@google.com")]
        mask = row["tiktok_email_masked"]
        exact = [e for e in cands if fits_mask(e, mask)]
        if exact:
            row["google_email"] = exact[0]
            row["confirmed"] = "yes"
        elif len(cands) == 1 and not mask:
            # Nothing to check it against, but only one candidate — reported
            # unconfirmed rather than silently treated as certain.
            row["google_email"] = cands[0]
            row["confirmed"] = "unchecked"
        elif cands:
            row["google_email"] = " | ".join(cands[:4])
            row["confirmed"] = "ambiguous"
    finally:
        ctx.close()
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", nargs="*", help="profile suffixes; default is all")
    ap.add_argument(
        "--write-accounts",
        action="store_true",
        help="also fill accounts.json, which relogin.py reads to pick the right Google account",
    )
    args = ap.parse_args()

    names = args.profile or profiles()
    if not names:
        print("no profile directories found")
        return 1
    print(f"reading {len(names)} profile(s): {', '.join(names)}")

    rows = []
    with sync_playwright() as p:
        for name in names:
            row = read_profile(p, name)
            rows.append(row)
            print(
                f"  {name:<8} @{safe(row['tiktok_username']) or '?':<18} "
                f"{safe(row['tiktok_email_masked']) or '-':<22} "
                f"{safe(row['google_email']) or '-':<32} {row['confirmed'] or row['note']}"
            )

    with OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\nwrote {OUT.name} ({len(rows)} row(s))")

    if args.write_accounts:
        # Only confirmed addresses. relogin.py uses this to click the right
        # account in the chooser, so a wrong entry signs a profile into the
        # wrong account — worse than no entry, which just clicks the first.
        current = {}
        if ACCOUNTS.exists():
            try:
                current = json.loads(ACCOUNTS.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                current = {}
        wrote = 0
        for r in rows:
            if r["confirmed"] == "yes" and r["google_email"]:
                current[r["profile"]] = r["google_email"]
                wrote += 1
        ACCOUNTS.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
        print(f"updated {ACCOUNTS.name}: {wrote} confirmed address(es)")
        skipped = [r["profile"] for r in rows if r["confirmed"] != "yes"]
        if skipped:
            print(f"  left alone (not confirmed): {', '.join(skipped)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
