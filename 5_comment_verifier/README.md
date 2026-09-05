# TikTok comment verifier

Confirms that a user actually commented on the TikTok sample link(s) they
submitted when reporting their work. If the user's own `@username` (from their
TikTok profile link) appears in that video's comments, the dashboard marks them
**valid for the next 7 days** (starting from the check day).

## Why this runs locally (not on the dashboard)

TikTok blocks datacenter IPs (Vercel) and unsigned API calls, and serves a
bot-challenge page to plain HTTP requests. The only reliable way to read a
video's comments is a **real browser on a residential connection**. So this
piece runs on your machine via Playwright; the dashboard just stores the result.

## Setup

```bash
cd 5_comment_verifier
python -m venv .venv && .venv/Scripts/activate     # Windows
pip install playwright requests python-dotenv
python -m playwright install chromium
cp .env.example .env                                # then edit .env
```

In `.env`, set `DASHBOARD_URL` and `VERIFY_SECRET`. **`VERIFY_SECRET` must match
the `VERIFY_SECRET` environment variable set on the dashboard (Vercel → Settings
→ Environment Variables)** — that's what lets the script call the admin APIs
without logging in.

## Run

```bash
python verify_comments.py             # check every user (headed — recommended)
python verify_comments.py --limit 5   # just the first 5 (for a test run)
python verify_comments.py --headless  # no window (more likely to be blocked)
```

A window opens and steps through each user's sample links. If TikTok shows a
captcha, solve it in the window — the script waits and continues. Reusing a
persistent browser profile (`BROWSER_PROFILE_DIR`) keeps you logged in / less
likely to be challenged; you can point it at the scraper's `browser_profile`.

## What it does

1. `GET /api/admin/verify-list` → each user's `@username` + their TikTok sample links (submitted in the last 14 days).
2. Opens each sample video, scrolls the comments, collects commenter usernames.
3. If the user's `@username` is present → `POST /api/admin/verify-result {valid:true}` → valid for 7 days.
4. The admin dashboard shows a **✓ valid to \<date\>** / **✗ expired** / **• unverified** badge on each user.

## Scheduling (weekly)

Run it once a week. On Windows, Task Scheduler → weekly → action:
`…\.venv\Scripts\python.exe …\5_comment_verifier\verify_comments.py`.
(Headed needs an interactive session; for unattended runs try `--headless`, but
expect more captchas.)

## Notes / limits

- TikTok's DOM changes often; the selectors are best-effort with several
  fallbacks. If comment collection returns 0 across the board, TikTok likely
  changed its markup — update `COMMENT_AUTHOR_SELECTORS` in `verify_comments.py`.
- Only TikTok is checked (per spec). Users with no TikTok sample link in the last
  14 days are skipped and stay unverified.
- A "not found" result is left to expire naturally (no negative marking).
