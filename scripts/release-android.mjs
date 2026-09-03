#!/usr/bin/env node
//
// One command between "code is ready" and "open Android Studio to sign".
//
//   npm run release:android
//
// Codifies the sequence so a release can't skip a step, and fails loudly
// rather than shipping a mismatch. Signing stays manual on purpose — the
// keystore password should never live in a script.
//
// Two things this exists to prevent, both of which have already bitten:
//
//   1. "Version code N has already been used." Play permanently burns a
//      versionCode on upload, even for a release you abandon. Bumping by hand
//      means forgetting, so step 0 does it.
//
//   2. A stale bundle inside the APK. `dist/` and the Android assets drifting
//      apart is invisible until users report a bug you already fixed, so the
//      last step compares content hashes and refuses to pass if they differ.
//
// Deliberately NOT deriving versionCode from `git rev-list --count`: a rebase,
// squash or shallow clone can lower it, and Play rejects a decreasing version
// code permanently for that track. A monotonic counter in the file is safer.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";

const GRADLE = "android/app/build.gradle";
const SW = "public/sw.js"; // the source; Vite copies it into dist/ on build

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

if (!existsSync("capacitor.config.json")) {
  fail("Run this from the project root (capacitor.config.json not found).");
}

// ── 0. bump versionCode ─────────────────────────────────────────────────────
if (!existsSync(GRADLE)) fail(`${GRADLE} not found.`);
let gradle = readFileSync(GRADLE, "utf8");

const codeMatch = gradle.match(/versionCode\s+(\d+)/);
if (!codeMatch) fail(`No versionCode found in ${GRADLE}.`);
const nextCode = Number(codeMatch[1]) + 1;
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${nextCode}`);

const nameMatch = gradle.match(/versionName\s+"([^"]+)"/);
if (!nameMatch) fail(`No versionName found in ${GRADLE}.`);
// Bump the patch segment; edit by hand for a minor or major release.
const parts = nameMatch[1].split(".").map(Number);
while (parts.length < 3) parts.push(0);
parts[2] += 1;
const nextName = parts.join(".");
gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${nextName}"`);

writeFileSync(GRADLE, gradle);
console.log(`0/5 — version ${codeMatch[1]} → ${nextCode}  (${nameMatch[1]} → ${nextName})`);

// ── 1. bump the service worker cache name ───────────────────────────────────
// Must happen in public/ BEFORE the build: Vite copies public/ into dist/, so
// editing dist/sw.js afterwards is silently undone by the next build.
if (!existsSync(SW)) fail(`${SW} not found.`);
const sw = readFileSync(SW, "utf8");
const swBumped = sw.replace(
  /const CACHE_NAME = "sitemargin-shell-v(\d+)"/,
  (_, n) => `const CACHE_NAME = "sitemargin-shell-v${Number(n) + 1}"`,
);
if (swBumped === sw) fail(`CACHE_NAME not found in ${SW} — update the pattern in this script.`);
writeFileSync(SW, swBumped);
const swVersion = swBumped.match(/sitemargin-shell-v(\d+)/)[1];
console.log(`1/5 — service worker cache → sitemargin-shell-v${swVersion}`);

// ── 2. build the web bundle ─────────────────────────────────────────────────
console.log("\n2/5 — building the web bundle");
run("npm run build");

// ── 3. regenerate native icons and splash ───────────────────────────────────
console.log("\n3/5 — regenerating icons and splash from resources/");
run("npx @capacitor/assets generate --android");

// ── 4. sync dist/ into the native shell ─────────────────────────────────────
console.log("\n4/5 — syncing dist/ into android/");
run("npx cap sync android");

// ── 5. prove the two sides actually match ───────────────────────────────────
console.log("\n5/5 — verifying the Android bundle matches dist/");
const bundleHash = (dir) => {
  const hit = readdirSync(dir).find((f) => /^index-[\w-]+\.js$/.test(f));
  if (!hit) fail(`No index-*.js found in ${dir}`);
  return hit.match(/^index-([\w-]+)\.js$/)[1];
};
const distHash = bundleHash("dist/assets");
const androidHash = bundleHash("android/app/src/main/assets/public/assets");
if (distHash !== androidHash) {
  fail(`Sync mismatch — dist is ${distHash}, android is ${androidHash}. Re-run: npx cap sync android`);
}
console.log(`      bundle ${distHash} present on both sides ✓`);

console.log(`
────────────────────────────────────────────────────────────
Ready to sign.  versionCode ${nextCode} · versionName ${nextName}

  1. npm run android:open
  2. Build → Generate Signed Bundle / APK → Android App Bundle
  3. Choose EXISTING keystore (a new one permanently breaks updates)
  4. release variant → produces app-release.aab
  5. Upload to Play Console

Commit the version bump so the next release starts from the right number.
────────────────────────────────────────────────────────────`);
