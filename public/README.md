# New siteMargin logo — deploy package

I can't push to the `leonmayo84/sitemargin` repo directly, so drop these in by hand:

| File here | Goes to |
|---|---|
| `favicon.svg` | `public/favicon.svg` |
| `icon-192.png` | `public/icon-192.png` |
| `icon-512.png` | `public/icon-512.png` |
| `icon-192-maskable.png` | `public/icon-192-maskable.png` |
| `icon-512-maskable.png` | `public/icon-512-maskable.png` |
| `apple-touch-icon.png` | `public/apple-touch-icon.png` |
| `icon.png` | `resources/icon.png` |
| `icon-foreground.png` | `resources/icon-foreground.png` |
| `icon-background.png` | `resources/icon-background.png` |
| `AppLogo-replacement.jsx` | replaces the `AppLogo()` function in `src/App.jsx` (~line 520) |

After swapping `resources/*`, re-run your Capacitor icon generation step (per `ANDROID_BUILD.md`) so the Android app icon picks up the new mark. Colors used: ink `#3C2E1E`, accent `#B85C2C` / `#D08050`.
