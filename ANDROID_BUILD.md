# SiteMargin — Android (Play Store) build guide

This wraps the existing SiteMargin web app in a native Android shell using
Capacitor, so it can be published on the Google Play Store. It reuses your
React app almost entirely — Capacitor just packages the built `dist/`
output into a native app and gives it access to a Play Store listing.

Everything below runs on your own machine (Windows/Mac/Linux) — none of
this needs a Mac.

---

## 0. One-time accounts you'll need

- **Google Play Console account** — https://play.google.com/console — $25
  one-time fee, your own Google account, ID verification required.
- That's it for Android. (Apple Developer account is only needed later, if
  you decide to also do iOS.)

## 1. Prerequisites on your machine

Install these once:

- **Node.js** (you already have this, since you run the Vite app)
- **Android Studio** — https://developer.android.com/studio — this also
  installs the Android SDK you need. During setup, let it install the
  default SDK platform + build tools.
- **A Java JDK** — Android Studio bundles its own, so you usually don't
  need to install one separately.

## 2. Install Capacitor in the project

From the `sitemargin` folder (`cd "G:\My Drive\Other\SiteMargin\sitemargin"`):

```
npm install @capacitor/core @capacitor/android
npm install -D @capacitor/cli @capacitor/assets
```

## 3. Add the Android platform

```
npx cap add android
```

This creates a new `android/` folder in the project — that's the actual
native Android Studio project. It reads `capacitor.config.json` (already
in the repo) for the app name, package ID (`za.co.sitemargin.app`), and
colors.

## 4. Generate app icons and splash screen from the brand assets

The `resources/` folder already has the source images (icon, adaptive
icon layers, splash) built to match your brand. Generate every Android
density/size from them in one command:

```
npx @capacitor/assets generate --android
```

## 5. Build the web app and sync it into the native project

Every time you change `App.jsx` (or anything else in the app) and want
that reflected in the Android build, run:

```
npm run android:sync
```

This runs `vite build` and copies the fresh `dist/` output into the
native Android project.

## 6. Open it in Android Studio

```
npm run android:open
```

This launches Android Studio with the native project. First launch will
take a few minutes while Gradle syncs.

You can run it on an emulator or a real phone (USB debugging) straight
from Android Studio's Run button to see it working before you publish
anything.

## 7. Build a signed release (AAB) for the Play Store

Play Store requires an Android App Bundle (`.aab`), signed with your own
release key. In Android Studio:

1. **Build → Generate Signed Bundle / APK**
2. Choose **Android App Bundle**
3. **Create new...** keystore the first time — save this `.jks` file and
   its passwords somewhere safe and backed up. If you ever lose it, you
   cannot publish updates to the same app listing again — Google can't
   recover it for you.
4. Choose **release** build variant, finish the wizard.
5. Android Studio produces `app-release.aab` — this is the file you
   upload to Play Console.

## 8. Set up the Play Console listing

In Play Console → **Create app**:

- App name: `SiteMargin`
- Default language, app or game: App, Free or paid: your choice
- Package name will match `za.co.sitemargin.app` automatically once you
  upload the first `.aab`

You'll need to fill in, before you can publish:

- **Store listing** — short description, full description, app icon
  (512×512, Play Console will crop from your `resources/icon.png`),
  a **feature graphic** (1024×500 — I can generate this on brand if you
  want), and at least 2 phone screenshots (I can generate these from
  the live app if you'd like, once you tell me which screens to show)
- **Privacy policy URL** — you already have one live:
  `https://sitemargin.co.za/privacy.html`
- **Data safety form** — Google requires you to disclose what data the
  app collects. Based on what's actually in the app: email address
  (auth), and payment info is handled entirely by PayFast (you never
  store card details yourself) — worth confirming this section together
  before submitting, since getting it wrong can get an app rejected or
  flagged.
- **Content rating questionnaire** — a standard set of questions Google
  asks about the app's content.
- **App category and contact details**

## 9. Submit for review

Upload the `.aab` to a release track (start with **Internal testing** to
try it privately first, then promote to **Production** when ready).
Google's review typically takes a few hours to a few days for a first
submission.

---

## Notes

- The **PWA** version (already live) works today with zero app store
  review — this Play Store build is additive, not a replacement.
- If you want an iOS version later, the same `resources/` assets and
  `capacitor.config.json` carry over — you'd just run `npx cap add ios`
  on a Mac (or via a cloud Mac build service) instead.
- Come back here any time you change `App.jsx` and want a fresh Android
  build — the loop is: edit → `npm run android:sync` → rebuild in
  Android Studio → upload a new `.aab` version to Play Console.
