# SiteMargin — web app (app.sitemargin.co.za)

**This folder (`C:\Dev\sitemargin`) is the React/Vite app + Capacitor Android
shell. The marketing site is a different folder — see below.**

## How it deploys

- Netlify project: **`sitemargin`**, site ID `0da5316d-2be4-4989-b1f8-8fa98fb27de8`
- **Push to `main` → Netlify auto-builds and publishes.** That is the whole
  web deploy. Nothing to upload by hand.
- Admin: https://app.netlify.com/projects/sitemargin

**A web push does not update the Android app.** That needs its own release:
`npm run android:sync` → signed AAB in Android Studio (reuse the existing
keystore — a new one permanently breaks Play Store updates) → upload to Play
Console. Bump `versionCode` in `android/app/build.gradle` every time.

## Do not confuse this with the marketing site

| | Web app | Marketing site |
|---|---|---|
| Folder | `C:\Dev\sitemargin` | `C:\Dev\sitemargin-site` |
| Domain | app.sitemargin.co.za | sitemargin.co.za |
| Netlify project | `sitemargin` | `sitemargins` |
| Deploy method | **git push to `main`** | **upload, no git** (that folder has no `.git` by design) |

## Backend

Supabase project `mcxmtnlhqubaljvnwmzc` ("Site Margin"). Auth is pure Supabase
Auth (GoTrue) — there is no custom Node backend. Migrations are applied
straight to the remote project; `supabase/migrations/` holds them for
reference. Edge Functions are Deno, deployed per-function.

## Theme tokens

`src/index.css` defines the semantic layer: `--bg-primary`, `--bg-secondary`,
`--surface`, `--border-color`, `--text-primary`, `--text-secondary`,
`--accent`, `--success`, `--danger`, `--warning`, plus shadows. Three states:
`:root` (light), `@media (prefers-color-scheme: dark)` guarded with
`:not([data-theme="light"])`, and `:root[data-theme="dark"]` so the toggle
wins either way. `src/ThemeToggle.jsx` stamps `data-theme` on `<html>`.

**Components must read tokens, never raw hex.** A hardcoded `#FFFFFF`
background or `#1D1D1F` text will look correct in light mode and break in dark
(white card on a dark page, or white text on a white card). The whole styles
object was swept to tokens on 2026-09-02 — keep it that way when adding
styles.

The one deliberate exception: the dark slab on the flagged KPI tile
(`summaryCardSlab`) is a fixed near-black gradient in both themes, by design.

## Brand palette

Ink `#1D1D1F` (replaced the old `#3C2E1E` umber), accent `#1D5C8A` blue.
Semantic: over `#C1462B`, watch `#B8862F`, on-track `#4C7A5C` — all now behind
tokens with lighter dark-mode variants.
