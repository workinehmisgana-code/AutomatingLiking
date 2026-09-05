# Android app for the user dashboard

The dashboard is now an **installable PWA**, and this folder ships everything
needed to package it as a real Android app using a **Trusted Web Activity (TWA)**.

## Why a TWA (and not a WebView/Capacitor wrapper)

Login uses **Google OAuth**. Google **blocks OAuth inside embedded WebViews**
(you'd get `403: disallowed_useragent`), which breaks a Capacitor/plain-WebView
app. A TWA runs your site in **Chrome Custom Tabs** — the real Chrome engine —
so Google sign-in works, cookies/session are shared with Chrome, and you get
**every dashboard feature for free** because the app *is* the deployed site.

Users get the full app: links, Comments, Video task, Repost & earn, Finish, pay
status, messages — all of it, updated instantly whenever you deploy the web app.

---

## Option A — Fastest: install the PWA (no build, no store)

On the phone, open the deployed site in **Chrome** →  ⋮ menu →
**Add to Home screen / Install app**. It launches full-screen like a native app.
Good for testing and for users who don't need a Play Store listing.

## Option B — Build a real APK/AAB (TWA)

### 0. Prerequisites
- Deploy the web app first (Vercel). Confirm these URLs load:
  - `https://comments-delta-sand.vercel.app/manifest.webmanifest`
  - `https://comments-delta-sand.vercel.app/icons/icon-512.png`
- Install **Node 18+** and **JDK 17**. Bubblewrap can fetch the Android SDK for you.

### 1. Install Bubblewrap (Google's TWA CLI)
```bash
npm install -g @bubblewrap/cli
bubblewrap doctor      # installs/points to JDK + Android SDK if needed
```

### 2. Initialize the project from the live manifest
Run this in an **empty folder** (not this repo):
```bash
bubblewrap init --manifest https://comments-delta-sand.vercel.app/manifest.webmanifest
```
- Accept the defaults (they're pre-matched by `twa-manifest.json` in this repo:
  package `com.repostearn.app`, name/colors/icons).
- When prompted, let it **create a signing keystore** and **remember the password**
  (you need the same key for every future update).

> Prefer a reproducible config? Copy this repo's `twa-manifest.json` into that
> folder before `bubblewrap build` instead of answering the prompts.

### 3. Build
```bash
bubblewrap build
```
Outputs:
- `app-release-signed.apk` — sideload / share directly (`adb install app-release-signed.apk`).
- `app-release-bundle.aab` — upload to Google Play Console.

### 4. Verify domain ownership (removes the browser URL bar)
Get your app's signing SHA-256 fingerprint:
```bash
keytool -list -v -keystore android.keystore -alias android
# or Bubblewrap prints an assetlinks snippet after build
```
Put that fingerprint into **`public/.well-known/assetlinks.json`** (replace
`REPLACE_WITH_YOUR_APP_SIGNING_SHA256_FINGERPRINT`), then **redeploy the web app**.
Verify it serves at:
```
https://comments-delta-sand.vercel.app/.well-known/assetlinks.json
```
Once that matches, the TWA opens **without** the address bar (full-screen native feel).

> **Google Play App Signing:** if you publish on Play and use Play App Signing,
> use the **Play-provided** SHA-256 (Play Console → Setup → App integrity) in
> `assetlinks.json`, not (or in addition to) your upload key's fingerprint.

### 5. Google OAuth note
No app-side OAuth work is needed — sign-in happens in Chrome Custom Tabs on the
**same domain** your web OAuth already trusts. Just make sure the Google Cloud
OAuth client still lists the production redirect URI
`https://comments-delta-sand.vercel.app/api/auth/callback/google` and that
`BETTER_AUTH_URL` is the production URL.

---

## Updating the app

- **Content/features:** just deploy the web app — the TWA picks it up instantly.
  No re-build, no store update.
- **App shell** (name, icon, colors, package): edit `twa-manifest.json`, bump
  `appVersionCode`, run `bubblewrap update && bubblewrap build`, ship the new APK/AAB.

## Files in this repo that power the app
- `app/manifest.ts` → served at `/manifest.webmanifest` (PWA manifest / TWA source)
- `public/icons/*` → app + maskable icons (regenerate with `scripts` or your own art)
- `public/sw.js` + `components/PWARegister.tsx` → service worker for installability
  (deliberately network-first; it does **not** cache pages, so no stale/auth issues)
- `public/.well-known/assetlinks.json` → Digital Asset Links (add your fingerprint)
- `twa-manifest.json` → Bubblewrap build config

## Want a fully native app instead?
A native (Kotlin/Compose) or React Native rewrite would re-implement every screen
and re-do Google Sign-In with the native SDK — weeks of work for the same feature
set the TWA already gives you. Recommended only if you need device features the web
can't reach (background services, deep OS integration). Ask and I can scaffold it.
