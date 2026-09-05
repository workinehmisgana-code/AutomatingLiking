# Next Bubble — floating link + comments overlay

A native Android app that authenticates as your **3_dashboard** user and shows a
**floating bubble on top of every app**:

- **Google sign-in** on first open (same account as the dashboard).
- The bubble shows the **link being opened** on top.
- **Next ▶** opens the next link *assigned to you* — with all the dashboard rules:
  already-opened links are skipped, retired links are removed, links are in
  priority order, and each open records the click (respecting the hourly limit).
- A **💬 button left of Next** opens your assigned-product **comments** — tap any to copy.

No app screen: tapping the icon just shows the bubble (the only prompts are the
one-time Google sign-in in the browser and the "Display over other apps" permission).

## How sign-in works
The app can't run Google OAuth inside itself (Google blocks embedded WebViews), so:
1. The app opens the dashboard's `/app-login` page in **Chrome**.
2. You sign in with Google (the same account as the dashboard).
3. The dashboard mints a per-user token and hands it back via a
   `nextbubble://auth?token=…` deep link → the app stores it.
4. From then on the bubble calls `/api/app/*` with that token as its identity.

## Setup

### Dashboard (once)
Deploy 3_dashboard with the new endpoints (already added):
`/app-login`, `/api/app/token`, `/api/app/me`, `/api/app/links`, `/api/app/click`,
`/api/app/comments`. Nothing else to configure — it uses your existing Google OAuth.

### App
Edit `app/src/main/java/com/repostearn/bubble/Config.kt`:
- `DASHBOARD` → your deployed URL (default `https://comments-delta-sand.vercel.app`).
- `PLATFORM` → `"tiktok"` to restrict to one platform, or `""` for all.

That's it — there's **no token to paste** anymore; each user signs in themselves.

## Using it
1. Tap the app icon. First run: grant **"Display over other apps"**, reopen, then
   **sign in with Google** in the browser that opens.
2. The bubble appears and loads your assigned links + comments.
3. Open TikTok. Tap **Next ▶** to open each link (the top of the bubble shows which
   link). Tap **💬** to view your comments — **tap any comment to copy it**. Use the
   **platform button** (e.g. "All ▾") to filter to TikTok / YT Shorts / YT Videos /
   Instagram; it reloads your links for that platform. Drag by **⠿**, close with **✕**.
4. Re-tap the app icon anytime to reload your latest links.

## Behaviors carried over from the dashboard
- **Only your available links** — excludes ones you've already opened and any link
  retired after enough distinct users.
- **Priority order** — best search rank first, then most recent.
- **Click recording** — opening a link records it (so it won't come back) via
  `/api/app/click`.
- **Hourly limit** — if you hit the per-platform cap, Next shows "Hourly limit
  reached" and won't open more of that platform until the window frees up.
- **Comments** — the same list as the web `/comments` page for your assigned product.

## Build
Open `4_android_bubble` in **Android Studio** → set `Config.DASHBOARD` → **Run ▶**
(or Build → Build APK). CLI: `gradle wrapper && ./gradlew assembleDebug` (JDK 17 +
Android SDK). No AndroidX / third-party libraries.

## Notes
- Package id `com.repostearn.bubble`, deep-link scheme `nextbubble://auth`, minSdk 26.
- Some phones (Xiaomi/Oppo/…) need "Autostart"/"Floating windows" enabled so the
  bubble survives battery savers.
- The older static `/api/links/export` + `LINKS_EXPORT_TOKEN` are no longer used by
  the app (superseded by per-user auth); you can leave or remove them.
