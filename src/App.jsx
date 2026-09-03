import React, { useState, useMemo, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabaseClient";
import { useRememberMeRestore, enableRememberMe, disableRememberMe } from "./useRememberMe";
import { biometricAvailable, enableBiometricUnlock, unlockWithBiometrics, disableBiometricUnlock } from "./nativeBiometric";
import { ThemeToggle } from "./ThemeToggle";

// xlsx and pdfjs-dist are both large libraries only needed by the "import a
// spreadsheet/PDF" feature. They're loaded on demand (see xlsxBufferToRows
// and pdfBufferToRows below) instead of at the top of the file, so a visitor
// who never touches file import doesn't pay to download either of them.

// Supabase Edge Functions live at the same project ref, under /functions/v1
const SUPABASE_FUNCTIONS_URL = "https://mcxmtnlhqubaljvnwmzc.supabase.co/functions/v1";

/* ============================== HELPERS ============================== */

// Opens an https:// URL without ever handing the visit off to a separate
// browser app. On the web build a plain new tab is fine and expected. On
// the native Android/iOS build, a plain target="_blank" anchor (or
// window.open) gets handed to the OS, which launches Chrome/Safari as a
// completely separate app — exactly the "kicked out of the app" bug this
// fixes. @capacitor/browser's Browser.open() instead shows the page in a
// Custom Tab / SFSafariViewController that overlays the app itself, so the
// user never leaves SiteMargin. Falls back to window.open if the plugin
// isn't installed yet (e.g. before `npm install` + `npx cap sync` has been
// run), so this never hard-crashes the native build.
async function openExternalLink(url) {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url });
      return;
    } catch {
      // Plugin not installed/synced yet — fall through to window.open below
      // rather than silently doing nothing.
    }
  }
  window.open(url, "_blank", "noopener");
}

// For a payment/OAuth hand-off, as opposed to opening a link the user clicked.
// On the web this must stay a same-tab redirect: the page is meant to be
// replaced, and window.open() called after an await has lost the user-gesture
// context so popup blockers eat it. On native the WebView refuses to navigate
// off the app's own origin, so assigning location.href there did nothing at
// all — which is why checkout looked broken only in the mobile build.
async function openExternalRedirect(url) {
  if (Capacitor.isNativePlatform()) {
    await openExternalLink(url);
    return;
  }
  window.location.href = url;
}

const fmt = (n) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(n || 0);

// Same output as fmt(), but as two tightly-spaced spans ("R" + amount)
// instead of one string — the space Intl inserts between symbol and amount
// reads as an oversized gap once it lands in a monospace font at small sizes.
function Money({ value, style }) {
  const amount = new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 0 }).format(value || 0);
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", justifyContent: "flex-end", gap: 3, ...style }}>
      <span>R</span><span>{amount}</span>
    </span>
  );
}

// A plain-looking reference link (JBCC, CIDB, SANS, etc.) that routes
// through openExternalLink on native so it opens in an in-app browser tab
// instead of kicking the user out to a separate browser app.
function ExplainerRefLink({ href, children }) {
  return (
    <a
      href={href}
      {...(!Capacitor.isNativePlatform() && { target: "_blank", rel: "noopener noreferrer" })}
      style={styles.explainerLink}
      onClick={(e) => {
        if (Capacitor.isNativePlatform()) {
          e.preventDefault();
          openExternalLink(href);
        }
      }}
    >
      {children}
    </a>
  );
}

// #8: "Your projects" -> "[name]'s projects". There's no separate display-name
// field anywhere yet, only the sign-in email, so this derives a reasonable
// first name from the email's local part (strips trailing digits, splits on
// non-letter separators, capitalizes). Falls back to "Your" if email is empty.
function friendlyFirstName(email) {
  if (!email) return "Your";
  const local = String(email).split("@")[0];
  const cleaned = local.replace(/[^a-zA-Z]+$/, "").replace(/[^a-zA-Z]+/g, " ").trim();
  const first = cleaned.split(" ").filter(Boolean)[0];
  if (!first) return "Your";
  return first[0].toUpperCase() + first.slice(1);
}

const fmtShort = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1000000) return `R${(v / 1000000).toFixed(1)}M`;
  if (Math.abs(v) >= 1000) return `R${Math.round(v / 1000)}k`;
  return `R${Math.round(v)}`;
};

const STATUS = {
  ok: { label: "ON TRACK", color: "var(--success)", bg: "rgba(76,122,92,0.12)" },
  watch: { label: "WATCH", color: "var(--warning)", bg: "rgba(184,134,47,0.12)" },
  over: { label: "OVER", color: "var(--danger)", bg: "rgba(193,70,43,0.12)" },
};

const CATEGORIES = [
  "Preliminaries", "Demolition", "Groundworks & Earthworks", "Concrete & Structural", "Steelwork",
  "Bricklaying & Masonry", "Roofing & Waterproofing", "Windows & Doors", "Plumbing", "Electrical",
  "HVAC & Mechanical", "Fire Protection", "Plastering & Rendering", "Dry-walling & Ceilings",
  "Joinery & Carpentry", "Shopfitting & Cabinetry", "Tiling & Finishes", "Flooring", "Glazing",
  "Security & Access Control", "Solar & Renewable Energy", "Paving & Driveways", "Fencing & Gates",
  "Landscaping & Irrigation", "Pool & Water Features", "Scaffolding", "External Works",
  "Provisional Sums", "Other",
];
const CATEGORY_COLOR = {
  Preliminaries: "#6B7A8F",
  Demolition: "#7A4B4B",
  "Groundworks & Earthworks": "#9C7A4A",
  "Concrete & Structural": "#8C8C94",
  Steelwork: "#5C6B73",
  "Bricklaying & Masonry": "#A0522D",
  "Roofing & Waterproofing": "#B5651D",
  "Windows & Doors": "#4F7A8C",
  Plumbing: "#3D6FA6",
  Electrical: "var(--warning)",
  "HVAC & Mechanical": "#4C8C87",
  "Fire Protection": "#B3453D",
  "Plastering & Rendering": "#BFA98C",
  "Dry-walling & Ceilings": "#9B9BA3",
  "Joinery & Carpentry": "#8B6F4E",
  "Shopfitting & Cabinetry": "#6F5B7A",
  "Tiling & Finishes": "#4FA8A0",
  Flooring: "#7C6A55",
  Glazing: "#5A8FA3",
  "Security & Access Control": "#4A5B7A",
  "Solar & Renewable Energy": "#C9A227",
  "Paving & Driveways": "#6B6459",
  "Fencing & Gates": "#77775B",
  "Landscaping & Irrigation": "#5B8C5A",
  "Pool & Water Features": "#3F8FA0",
  Scaffolding: "#A6A6A6",
  "External Works": "#7A8C5B",
  "Provisional Sums": "#8B5FA3",
  Other: "#6E6E73",
};

// Same six hues as the tool tiles on sitemargin.co.za's homepage ("Six tools,
// six colours — so you always know which one you're in"), applied here to
// the matching view-toggle tab so the app and marketing site read as one
// system. Only the six tabs with a real marketing-site equivalent get a
// colour — Purchase Orders, Tenders, Quote, Charts and Trend are sub-views
// without their own tile there, so they stay on the neutral grey/black
// toggle treatment rather than inventing colours the rest of the product
// doesn't use.
const MODULE_COLOR = {
  // "banner" is the pastel background used by ModuleBanner below (a flat
  // tint, not the tab's translucent rgba() — reads more solid at the larger
  // size a full-width banner is shown at than the same alpha does on a
  // small pill button).
  ledger: { solid: "#C2571F", tint: "rgba(194,87,31,0.09)", banner: "#FCEFE8" },       // budget
  schedule: { solid: "#3B6FA6", tint: "rgba(59,111,166,0.09)", banner: "#EAF1F8" },     // schedule
  documents: { solid: "#7A5FBF", tint: "rgba(122,95,191,0.09)", banner: "#F1EDF9" },    // docs
  payments: { solid: "#3F8A5D", tint: "rgba(63,138,93,0.09)", banner: "#EAF3EE" },      // payments
  plans: { solid: "#2E8C82", tint: "rgba(46,140,130,0.09)", banner: "#E7F3F2" },        // plans
  changeorders: { solid: "#C6902E", tint: "rgba(198,144,46,0.09)", banner: "#FBF3E5" }, // change orders
  clientreports: { solid: "#20344A", tint: "rgba(32,52,74,0.09)", banner: "#EAEEF2" }, // client reports
};

// Per-module copy + decorative artwork for ModuleBanner — the icon and
// mini-chart mirror the matching tool tile on sitemargin.co.za's homepage
// ("Six tools, six colours") at a scaled-down size, so a module reads as
// visually continuous between the marketing site and the app itself.
const MODULE_INFO = {
  ledger: {
    label: "Cost & Progress",
    sub: "Variance against budget, updated as line items move.",
    icon: <path d="M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />,
    chart: (c) => (
      <>
        <path d="M4 46 L38 40 L72 44 L106 26 L140 30 L174 12 L216 6" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 46 L38 40 L72 44 L106 26 L140 30 L174 12 L216 6 L216 60 L4 60 Z" fill={c} opacity="0.12" />
      </>
    ),
  },
  schedule: {
    label: "Schedule",
    sub: "Every milestone against the date it's actually due.",
    icon: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 3v3M16 3v3" /></>,
    chart: (c) => (
      <>
        <rect x="4" y="10" width="212" height="8" rx="4" fill={c} opacity="0.85" />
        <rect x="4" y="26" width="212" height="8" rx="4" fill={c} opacity="0.2" /><rect x="4" y="26" width="138" height="8" rx="4" fill={c} opacity="0.85" />
        <rect x="4" y="42" width="212" height="8" rx="4" fill={c} opacity="0.2" /><rect x="4" y="42" width="62" height="8" rx="4" fill={c} opacity="0.85" />
        <line x1="150" y1="0" x2="150" y2="60" stroke={c} strokeWidth="1.5" strokeDasharray="3 3" opacity="0.5" />
      </>
    ),
  },
  documents: {
    label: "Documents",
    sub: "Every drawing, contract, and RFI in one register.",
    icon: <><path d="M6 3h9l4 4v14a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" /><path d="M9 12h6M9 16h6" /></>,
    chart: (c) => (
      <>
        <rect x="20" y="18" width="26" height="38" rx="5" fill={c} opacity="0.85" />
        <rect x="94" y="30" width="26" height="26" rx="5" fill={c} opacity="0.85" />
        <rect x="168" y="6" width="26" height="50" rx="5" fill={c} opacity="0.85" />
      </>
    ),
  },
  payments: {
    label: "Payments & Retention",
    sub: "Retention held, and released.",
    icon: <><circle cx="12" cy="12" r="9" /><path d="M9 12h6M12 9v6" /></>,
    chart: (c, pct) => {
      const frac = Math.max(0, Math.min(100, pct ?? 0)) / 100;
      const circumference = 2 * Math.PI * 22;
      return (
        <g transform="translate(36,30)">
          <circle r="22" fill="none" stroke={c} strokeWidth="7" opacity="0.2" />
          <circle r="22" fill="none" stroke={c} strokeWidth="7" strokeLinecap="round"
            strokeDasharray={`${circumference * frac} ${circumference}`} transform="rotate(-90)" />
        </g>
      );
    },
  },
  plans: {
    label: "Plans",
    sub: "Every reference document on the project.",
    icon: <path d="M4 20V4l8 4 8-4v16l-8-4z" />,
    chart: (c) => (
      <>
        <path d="M4 50 L46 50 L46 38 L92 38 L92 26 L146 26 L146 12 L216 12" stroke={c} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="46" cy="38" r="3.5" fill={c} /><circle cx="92" cy="26" r="3.5" fill={c} /><circle cx="146" cy="12" r="3.5" fill={c} />
      </>
    ),
  },
  changeorders: {
    label: "Change Orders",
    sub: "Scope changes, priced and logged.",
    icon: <path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" />,
    chart: (c) => (
      <>
        <rect x="12" y="40" width="30" height="16" rx="4" fill={c} opacity="0.6" />
        <rect x="66" y="30" width="30" height="26" rx="4" fill={c} opacity="0.72" />
        <rect x="120" y="18" width="30" height="38" rx="4" fill={c} opacity="0.85" />
        <rect x="174" y="6" width="30" height="50" rx="4" fill={c} opacity="1" />
      </>
    ),
  },
};

// Small colour-coded header shown at the top of each of the six modules
// (Cost & Progress, Schedule, Documents, Payments & Retention, Plans,
// Change Orders) — mirrors the matching tool tile from the marketing
// site's homepage, scaled down, with a real live stat instead of a
// marketing placeholder. `stat`/`statLabel` are computed by the caller
// from actual project data; `chartArg` is an optional extra passed through
// to that module's chart renderer (only "payments" uses it, for the donut's
// fill fraction).
function ModuleBanner({ moduleKey, stat, statLabel, chartArg }) {
  const mc = MODULE_COLOR[moduleKey];
  const info = MODULE_INFO[moduleKey];
  if (!mc || !info) return null;
  return (
    <div
      className="no-print"
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderRadius: 14, padding: "16px 22px", position: "relative", overflow: "hidden",
        boxShadow: "0 1px 6px rgba(0,0,0,0.04)", maxWidth: 1180, margin: "0 auto 16px",
        background: mc.banner,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, zIndex: 1 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: mc.solid }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8">{info.icon}</svg>
        </div>
        <div>
          <p style={{ fontSize: 15, fontWeight: 700, margin: "0 0 2px" }}>{info.label}</p>
          <p style={{ fontSize: 12.5, margin: 0, color: "var(--text-secondary)" }}>{info.sub}</p>
        </div>
      </div>
      <svg style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 220, opacity: 0.5 }} viewBox="0 0 220 60" preserveAspectRatio="none">
        {info.chart(mc.solid, chartArg)}
      </svg>
      <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 20, fontWeight: 700, zIndex: 1, textAlign: "right", color: mc.solid }}>
        {stat}
        <span style={{ display: "block", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-secondary)", marginTop: 2 }}>{statLabel}</span>
      </div>
    </div>
  );
}

// Display labels for the pricing-tier keys used across the gate screen —
// matches sitemargin.co.za's own pricing page (Free/Contractor/Company/Home
// Owner), which this gate is meant to mirror one-to-one.
const TIER_LABEL = {
  free: "Free",
  contractor: "Contractor",
  firm: "Company",
  homeowner: "Home Owner",
};

// The small subscription-tier badge shown in every PageHeader (approved
// direction "B" from the tier-badge mockup: a tinted pill with a colored
// label, reusing the exact tint/solid pairing MODULE_COLOR already uses
// for module banners elsewhere in the app — so this reads as another
// piece of the app's own UI language rather than a new one). Free-tier
// accounts read "Trial" here specifically (not "Free" as TIER_LABEL says
// elsewhere) per the ask: distinguishable per tier, but quiet — the grey
// trial tint is deliberately the least saturated of the four.
const HEADER_TIER_BADGE = {
  free: { label: "Trial", tint: "rgba(160,160,166,0.14)", color: "#83838A" },
  contractor: { label: "Contractor", tint: "rgba(29,92,138,0.09)", color: "var(--accent)" },
  firm: { label: "Company", tint: "rgba(184,134,47,0.11)", color: "var(--warning)" },
  homeowner: { label: "Home Owner", tint: "rgba(76,122,92,0.10)", color: "var(--success)" },
};

function statusFor(budget, actual) {
  if (budget <= 0) return "ok";
  const ratio = actual / budget;
  if (ratio > 1) return "over";
  if (ratio > 0.85) return "watch";
  return "ok";
}

function progressGapFor(budget, actual, percentComplete) {
  if (!budget || percentComplete == null || percentComplete === "") return null;
  return (actual / budget) * 100 - Number(percentComplete);
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/* Scorecard maths. Each dimension resolves to 0-100 so they sit side by side.
   Any dimension without data returns null rather than a misleading zero. */
function scoreSubcontractor(items) {
  const withBudget = items.filter((i) => Number(i.budget) > 0);

  let budgetScore = null;
  if (withBudget.length > 0) {
    const overruns = withBudget.map((i) =>
      Math.max(((Number(i.actual) - Number(i.budget)) / Number(i.budget)) * 100, 0)
    );
    const avgOverrun = overruns.reduce((s, v) => s + v, 0) / overruns.length;
    // 50% over => 0. The previous curve (x4) bottomed out at 25%, which put a
    // sub 27% over budget and one 300% over on the same score of zero — the
    // dimension stopped discriminating exactly where real jobs live.
    budgetScore = Math.max(0, Math.min(100, 100 - avgOverrun * 2));
  }

  const scheduled = items.filter((i) => i.due_date && i.completed_date);
  let scheduleScore = null;
  let avgDaysLate = null;
  let worstDaysLate = null;
  let onTimeRate = null;
  let lateness = [];
  if (scheduled.length > 0) {
    lateness = scheduled.map((i) => daysBetween(i.due_date, i.completed_date) ?? 0);
    avgDaysLate = lateness.reduce((s, v) => s + v, 0) / lateness.length;
    worstDaysLate = Math.max(...lateness);
    onTimeRate = (lateness.filter((v) => v <= 0).length / lateness.length) * 100;
    scheduleScore = Math.max(0, Math.min(100, 100 - Math.max(avgDaysLate, 0) * 5)); // 20 days late => 0
  }

  const rated = items.filter((i) => i.quality_rating != null && Number(i.quality_rating) > 0);
  let qualityScore = null;
  let avgQuality = null;
  if (rated.length > 0) {
    avgQuality = rated.reduce((s, i) => s + Number(i.quality_rating), 0) / rated.length;
    qualityScore = (avgQuality / 5) * 100;
  }

  const present = [budgetScore, scheduleScore, qualityScore].filter((v) => v != null);
  const overall = present.length > 0 ? present.reduce((s, v) => s + v, 0) / present.length : null;

  const totalBudget = items.reduce((s, i) => s + Number(i.budget || 0), 0);
  const totalActual = items.reduce((s, i) => s + Number(i.actual || 0), 0);

  // Rand, not score. "Has cost you R11 000 above budget" is a sentence someone
  // can act on; "budget accuracy 0" is a grade they have to translate first.
  const overrunRand = items.reduce(
    (s, i) => s + Math.max(Number(i.actual || 0) - Number(i.budget || 0), 0), 0
  );

  // What is late right now, as opposed to what was late historically. This is
  // the only figure on the card that should change what you do today.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const overdueItems = items.filter(
    (i) => i.due_date && !i.completed_date && new Date(i.due_date) < today
  );
  const overdueValue = overdueItems.reduce((s, i) => s + Number(i.budget || 0), 0);

  const projectCount = new Set(items.map((i) => i.project_id).filter(Boolean)).size;

  // Direction of travel on budget: mean overrun of the older completed half
  // against the newer half. Positive means improving.
  let trend = null;
  const datedBudget = withBudget
    .filter((i) => i.completed_date)
    .sort((a, b) => new Date(a.completed_date) - new Date(b.completed_date));
  if (datedBudget.length >= 4) {
    const meanOverrun = (arr) =>
      arr.reduce((s, i) => s + Math.max(((Number(i.actual) - Number(i.budget)) / Number(i.budget)) * 100, 0), 0) / arr.length;
    const half = Math.floor(datedBudget.length / 2);
    trend = meanOverrun(datedBudget.slice(0, half)) - meanOverrun(datedBudget.slice(half));
  }

  // How much weight the overall number can bear. A 30 earned across one item
  // and a 30 earned across fifty are not the same claim, and until now the
  // card presented them identically.
  const dimensions = present.length;
  const confidence =
    items.length >= 8 && dimensions >= 2 ? "high"
    : items.length >= 3 && dimensions >= 1 ? "medium"
    : "low";

  return {
    budgetScore, scheduleScore, qualityScore, overall,
    avgDaysLate, worstDaysLate, onTimeRate, avgQuality,
    itemCount: items.length, ratedCount: rated.length, scheduledCount: scheduled.length,
    totalBudget, totalActual, variance: totalActual - totalBudget,
    overrunRand, overdueCount: overdueItems.length, overdueValue,
    projectCount, trend, confidence, dimensions,
  };
}

function scoreColor(score) {
  if (score == null) return "#6E6E73";
  if (score >= 75) return "var(--success)";
  if (score >= 50) return "var(--warning)";
  return "var(--danger)";
}

function parseCsvToItems(text) {
  const rows = csvTextToRows(text);
  return rowsToItems(rows);
}

// Splits raw CSV text into an array of row-arrays, respecting quoted commas.
function csvTextToRows(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  const splitRow = (row) => {
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === "," && !inQuotes) { cells.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };
  return lines.map(splitRow);
}

// Reads an .xlsx file's first sheet into the same row-array shape as CSV parsing.
// Loads the xlsx library on demand (see the file-level comment above).
async function xlsxBufferToRows(arrayBuffer) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  return rows
    .map((row) => row.map((cell) => String(cell ?? "").trim()))
    .filter((row) => row.some((cell) => cell !== ""));
}

// Reads a PDF's text into row/column form by clustering text fragments by
// vertical position (rows) then horizontal gaps (columns). Works reasonably
// on digitally-created PDFs (exported from Excel, Word, a QS tool) with
// visible spacing between columns. It cannot read scanned or photographed
// pages — those have no extractable text at all, only an image.
async function pdfBufferToRows(arrayBuffer) {
  const [pdfjsLib, { default: pdfjsWorker }] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const allRows = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const fragments = textContent.items
      .filter((it) => it.str && it.str.trim() !== "")
      .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5], width: it.width || 0 }));

    if (fragments.length === 0) continue;

    // Group fragments into lines by rounded Y position (small tolerance for jitter).
    const lineMap = new Map();
    fragments.forEach((f) => {
      const key = Math.round(f.y / 3) * 3;
      if (!lineMap.has(key)) lineMap.set(key, []);
      lineMap.get(key).push(f);
    });

    // PDF Y increases upward, so sort descending to read top-to-bottom.
    const orderedKeys = Array.from(lineMap.keys()).sort((a, b) => b - a);

    orderedKeys.forEach((key) => {
      const lineFragments = lineMap.get(key).sort((a, b) => a.x - b.x);
      const cells = [];
      let currentCell = "";
      let lastEndX = null;
      lineFragments.forEach((f) => {
        const gap = lastEndX == null ? 0 : f.x - lastEndX;
        if (lastEndX != null && gap > 8) {
          cells.push(currentCell.trim());
          currentCell = f.text;
        } else {
          currentCell += f.text;
        }
        lastEndX = f.x + f.width;
      });
      if (currentCell.trim()) cells.push(currentCell.trim());
      if (cells.length > 0) allRows.push(cells);
    });
  }
  return allRows;
}

// PDFs often have a title, company letterhead, or notes before the actual
// table starts. Scan for the row most likely to be real column headers
// rather than assuming row 0 is it, the way a clean CSV export would be.
function findHeaderRowIndex(rows) {
  const keywords = ["description", "amount", "budget", "quantity", "qty", "rate", "item", "particulars", "total"];
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const rowText = rows[i].join(" ").toLowerCase();
    const matches = keywords.filter((k) => rowText.includes(k)).length;
    if (matches >= 2) return i;
  }
  return 0;
}

function pdfRowsToItems(rows) {
  const headerIdx = findHeaderRowIndex(rows);
  const trimmed = rows.slice(headerIdx);
  return rowsToItems(trimmed);
}


const CATEGORY_KEYWORDS = {
  Preliminaries: ["preliminaries", "prelim", "site establishment", "site setup"],
  Demolition: ["demolition", "demolish", "strip out", "strip-out"],
  "Groundworks & Earthworks": ["earthwork", "excavation", "groundwork", "site clearance", "bulk earthworks"],
  "Concrete & Structural": ["concrete", "foundation", "footing", "slab", "structural concrete"],
  Steelwork: ["structural steel", "steelwork", "reinforcing", "rebar"],
  "Bricklaying & Masonry": ["brickwork", "masonry", "blockwork", "bricklaying"],
  "Roofing & Waterproofing": ["roofing", "roof ", "waterproofing", "gutter", "fascia"],
  "Windows & Doors": ["windows", "aluminium windows", "door frames", " doors"],
  Plumbing: ["plumbing", "plumber", "drainage", "sanitary ware", "sewer", "water supply"],
  Electrical: ["electrical", "electrician", "wiring", "lighting", "led ", "distribution board", "db board"],
  "HVAC & Mechanical": ["hvac", "air conditioning", "aircon", "ventilation", "mechanical"],
  "Fire Protection": ["fire protection", "sprinkler", "fire detection", "fire hose"],
  "Plastering & Rendering": ["plaster", "rendering", "skim coat"],
  "Dry-walling & Ceilings": ["drywall", "dry-wall", "ceiling", "gypsum", "rhino board"],
  "Joinery & Carpentry": ["joinery", "carpentry", "timber"],
  "Shopfitting & Cabinetry": ["shopfitting", "shop fitting", "cabinetry", "cabinet", "cupboard"],
  "Tiling & Finishes": ["tiling", "tile", "paint", "painting", "grout"],
  Flooring: ["flooring", "vinyl floor", "laminate floor", "carpet"],
  Glazing: ["glazing", "glass", "shopfront glazing"],
  "Security & Access Control": ["security", "access control", "cctv", "alarm system"],
  "Solar & Renewable Energy": ["solar", "pv panel", "inverter", "renewable energy"],
  "Paving & Driveways": ["paving", "driveway", "cobble"],
  "Fencing & Gates": ["fencing", "fence", "gate", "palisade"],
  "Landscaping & Irrigation": ["landscaping", "irrigation", "garden"],
  "Pool & Water Features": ["swimming pool", "pool", "water feature"],
  Scaffolding: ["scaffolding", "scaffold"],
  "External Works": ["external works", "site works"],
  "Provisional Sums": ["provisional sum", "prov sum", "pc sum", "contingency", "nominated", "specialist"],
};

function inferCategoryFromText(text) {
  const lower = (text || "").toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return cat;
  }
  return null;
}

// Shared logic for both plain budget CSVs and full BOQ exports (CSV or Excel).
// Recognizes either a simple Budget column, or BOQ-style Quantity/Rate/Amount
// columns, and treats description-only rows with no numbers as section headers
// used to infer category for the items that follow.
function rowsToItems(rows) {
  if (rows.length < 2) return { items: [], error: "That file doesn't look like it has any data rows." };

  const header = rows[0].map((h) => h.toLowerCase().replace(/[^a-z0-9%]/g, ""));
  const findCol = (...aliases) => {
    for (const a of aliases) {
      const idx = header.indexOf(a);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const col = {
    name: findCol("name", "lineitem", "description", "itemdescription", "particulars", "item"),
    category: findCol("category", "type"),
    budget: findCol("budget", "budgetamount", "budgeted"),
    amount: findCol("amount", "total", "amountr", "totalr"),
    quantity: findCol("quantity", "qty"),
    rate: findCol("rate", "unitrate", "rater"),
    unit: findCol("unit", "uom", "unitofmeasure"),
    actual: findCol("actual", "actualspend", "spent"),
    percentComplete: findCol("percentcomplete", "complete", "progress"),
    claimed: findCol("claimed"),
    certified: findCol("certified"),
  };

  const hasBudgetSource = col.budget !== -1 || col.amount !== -1 || (col.quantity !== -1 && col.rate !== -1);
  if (col.name === -1 || !hasBudgetSource) {
    return {
      items: [],
      error: "Couldn't find a Description column plus a Budget, Amount, or Quantity+Rate column. Check the template or your BOQ's column headers.",
    };
  }

  const toNum = (v) => {
    if (v == null || v === "") return null;
    const n = Number(String(v).replace(/[R$,\s]/g, ""));
    return isNaN(n) ? null : n;
  };

  const items = [];
  let currentSection = null;

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const name = cells[col.name]?.trim();
    if (!name) continue;

    const budgetVal = col.budget !== -1 ? toNum(cells[col.budget]) : null;
    const amountVal = col.amount !== -1 ? toNum(cells[col.amount]) : null;
    const qtyVal = col.quantity !== -1 ? toNum(cells[col.quantity]) : null;
    const rateVal = col.rate !== -1 ? toNum(cells[col.rate]) : null;
    const unitVal = col.unit !== -1 ? cells[col.unit]?.trim() : "";

    const computedFromQtyRate = qtyVal != null && rateVal != null ? qtyVal * rateVal : null;
    const resolvedBudget = budgetVal ?? amountVal ?? computedFromQtyRate;

    // A row with a description but no budget/amount/quantity/rate anywhere is
    // treated as a BOQ section header (e.g. "2.0 EARTHWORKS"), not a line item.
    if (resolvedBudget == null) {
      currentSection = name;
      continue;
    }

    const rawCategory = col.category !== -1 ? cells[col.category]?.trim() : "";
    const category =
      CATEGORIES.find((c) => c.toLowerCase() === rawCategory?.toLowerCase()) ||
      inferCategoryFromText(currentSection) ||
      inferCategoryFromText(name) ||
      "Other";

    let notes = "";
    if (qtyVal != null || rateVal != null || unitVal) {
      const parts = [];
      if (qtyVal != null) parts.push(`Qty: ${qtyVal}${unitVal ? ` ${unitVal}` : ""}`);
      if (rateVal != null) parts.push(`Rate: ${fmt(rateVal)}`);
      notes = parts.join(" · ");
      if (currentSection) notes += ` (BOQ section: ${currentSection})`;
    } else if (currentSection) {
      notes = `BOQ section: ${currentSection}`;
    }

    items.push({
      name,
      category,
      budget: resolvedBudget,
      actual: col.actual !== -1 ? toNum(cells[col.actual]) ?? 0 : 0,
      percent_complete: col.percentComplete !== -1 ? toNum(cells[col.percentComplete]) ?? 0 : 0,
      claimed: col.claimed !== -1 ? toNum(cells[col.claimed]) ?? 0 : 0,
      certified: col.certified !== -1 ? toNum(cells[col.certified]) ?? 0 : 0,
      notes,
    });
  }

  if (items.length === 0) return { items: [], error: "No valid line items found — make sure each row has a description and a budget, amount, or quantity+rate." };
  return { items, error: null };
}

/* ============================== CHARTS ============================== */
/* Hand-rolled SVG/CSS so there's no charting dependency to install or break. */

function BarChartBudgetVsActual({ items }) {
  const top = [...items].sort((a, b) => Number(b.budget) - Number(a.budget)).slice(0, 8);
  if (top.length === 0) return <EmptyChart label="Add line items to see the comparison." />;
  const max = Math.max(...top.map((i) => Math.max(Number(i.budget), Number(i.actual))), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {top.map((item) => {
        const bPct = (Number(item.budget) / max) * 100;
        const aPct = (Number(item.actual) / max) * 100;
        const over = Number(item.actual) > Number(item.budget);
        return (
          <div key={item.id}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>{item.name}</span>
              <span style={{ fontSize: 11.5, fontFamily: "'Space Grotesk', sans-serif", color: over ? "var(--danger)" : "var(--success)" }}>
                {fmtShort(item.actual)} / {fmtShort(item.budget)}
              </span>
            </div>
            <div style={{ position: "relative", height: 16 }}>
              <div style={{ position: "absolute", top: 0, left: 0, width: `${bPct}%`, height: 7, background: "var(--border-color)", borderRadius: 3 }} />
              <div style={{ position: "absolute", top: 9, left: 0, width: `${aPct}%`, height: 7, background: over ? "var(--danger)" : "var(--success)", borderRadius: 3 }} />
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 16, marginTop: 4, flexWrap: "wrap" }}>
        <LegendDot color="#C7C7CE" label="Budget" />
        <LegendDot color="var(--success)" label="Actual (within)" />
        <LegendDot color="var(--danger)" label="Actual (over)" />
      </div>
    </div>
  );
}

function DonutCategorySplit({ rollup }) {
  const total = rollup.reduce((s, c) => s + c.actual, 0);
  if (total <= 0) return <EmptyChart label="Log some spend to see the split." />;

  const radius = 52;
  const stroke = 18;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 26, flexWrap: "wrap" }}>
      <svg width="140" height="140" viewBox="0 0 140 140" style={{ flexShrink: 0 }}>
        <g transform="rotate(-90 70 70)">
          {rollup.map((c) => {
            const dash = (c.actual / total) * circumference;
            const el = (
              <circle key={c.category} cx="70" cy="70" r={radius} fill="none"
                stroke={CATEGORY_COLOR[c.category]} strokeWidth={stroke}
                strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset} />
            );
            offset += dash;
            return el;
          })}
        </g>
        <text x="70" y="66" textAnchor="middle" fill="#6E6E73" fontSize="10" fontFamily="'IBM Plex Mono', monospace">SPENT</text>
        <text x="70" y="82" textAnchor="middle" fill="var(--text-primary)" fontSize="14" fontWeight="600" fontFamily="'IBM Plex Mono', monospace">
          {fmtShort(total)}
        </text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 160 }}>
        {rollup.map((c) => (
          <div key={c.category} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: CATEGORY_COLOR[c.category] }} />
            <span style={{ color: "var(--text-secondary)" }}>{c.category}</span>
            <span style={{ marginLeft: "auto", fontFamily: "'Space Grotesk', sans-serif", fontSize: 12, color: "var(--text-secondary)" }}>
              {((c.actual / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProgressBars({ items }) {
  const plotted = items
    .filter((i) => Number(i.budget) > 0 && i.percent_complete != null)
    .map((i) => {
      const prog = Math.min(Number(i.percent_complete), 100);
      const spent = Math.min((Number(i.actual) / Number(i.budget)) * 100, 130);
      return { ...i, prog, spent, gap: spent - prog };
    })
    .sort((a, b) => b.gap - a.gap);

  if (plotted.length === 0) return <EmptyChart label="Set % complete on line items to see this." />;

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {plotted.map((item) => {
          const color = item.gap > 15 ? "var(--danger)" : item.gap > 5 ? "var(--warning)" : "var(--success)";
          return (
            <div key={item.id}>
              <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 5 }}>{item.name}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div style={{ height: 7, background: "var(--bg-secondary)", borderRadius: 3 }}>
                  <div style={{ width: `${item.prog}%`, height: "100%", background: "var(--success)", borderRadius: 3 }} />
                </div>
                <div style={{ height: 7, background: "var(--bg-secondary)", borderRadius: 3 }}>
                  <div style={{ width: `${Math.min(item.spent, 100)}%`, height: "100%", background: color, borderRadius: 3 }} />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                <span style={{ fontSize: 10, color: "var(--success)" }}>{item.prog.toFixed(0)}% done</span>
                <span style={{ fontSize: 10, color }}>{item.spent.toFixed(0)}% spent</span>
              </div>
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 14 }}>
        Red means spending is well ahead of progress — the bigger the gap between the two bars, the more urgent.
      </p>
    </div>
  );
}

function TopOverruns({ items }) {
  const overruns = items
    .filter((i) => Number(i.budget) > 0 && Number(i.actual) > Number(i.budget))
    .map((i) => ({
      ...i,
      variance: Number(i.actual) - Number(i.budget),
      pctOver: ((Number(i.actual) - Number(i.budget)) / Number(i.budget)) * 100,
    }))
    .sort((a, b) => b.variance - a.variance)
    .slice(0, 6);

  if (overruns.length === 0) return <EmptyChart label="Nothing is over budget right now." />;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {overruns.map((item, idx) => (
        <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: idx < overruns.length - 1 ? "1px solid #F2F2F5" : "none" }}>
          <div style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(193,70,43,0.10)", color: "var(--danger)", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {idx + 1}
          </div>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{item.name}</div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif", color: "var(--danger)" }}>+{fmtShort(item.variance)}</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>+{item.pctOver.toFixed(0)}%</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ClaimsCertifiedChart({ items }) {
  const relevant = items.filter(
    (i) => Number(i.claimed) > 0 || Number(i.certified) > 0
  );
  if (relevant.length === 0) {
    return <EmptyChart label="Log claimed and certified amounts on line items (via Details) to see this chart." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {relevant.map((item) => {
        const claimed = Number(item.claimed) || 0;
        const certified = Number(item.certified) || 0;
        const paid = Number(item.actual) || 0;
        const stageMax = Math.max(claimed, certified, paid, 1);
        const gap = claimed - certified;
        const stages = [
          { label: "Claimed", value: claimed, color: "var(--warning)" },
          { label: "Certified", value: certified, color: "#3D6FA6" },
          { label: "Paid", value: paid, color: "var(--success)" },
        ];
        return (
          <div key={item.id} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{item.name}</span>
              {gap > 0 && (
                <span style={{ fontSize: 10.5, fontFamily: "'Space Grotesk', sans-serif", color: "var(--warning)" }}>
                  {fmtShort(gap)} awaiting sign-off
                </span>
              )}
            </div>
            {stages.map((stage) => (
              <div key={stage.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ width: 60, fontSize: 10.5, color: "var(--text-secondary)", textAlign: "right", flexShrink: 0 }}>{stage.label}</span>
                <div style={{ flex: 1, height: 14, background: "var(--bg-secondary)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${(stage.value / stageMax) * 100}%`, height: "100%", background: stage.color, borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: 10.5, fontFamily: "'Space Grotesk', sans-serif", color: "var(--text-secondary)", width: 60, flexShrink: 0 }}>{fmtShort(stage.value)}</span>
              </div>
            ))}
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 16, marginTop: 4, flexWrap: "wrap" }}>
        <LegendDot color="var(--warning)" label="Claimed" />
        <LegendDot color="#3D6FA6" label="Certified" />
        <LegendDot color="var(--success)" label="Paid (actual)" />
      </div>
    </div>
  );
}

function TrendChart({ snapshots }) {
  // No preserveAspectRatio="none" here (unlike a bare trend line, which
  // has no shape to distort) — this chart draws circles and text, and
  // stretching x/y independently to fill an arbitrary container width
  // would render the points as ellipses and squash the labels. Leaving
  // the default "meet" behaviour and sizing the wrapper only by width
  // (no fixed height) keeps everything scaling uniformly, the same way
  // ProgressBars's bar widths do elsewhere in this file.
  const W = 1000, H = 220;
  const marginTop = 34, marginBottom = 14;
  const plotTop = marginTop, plotBottom = H - marginBottom;
  const values = snapshots.map((s) => Number(s.variance));
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  // When every snapshot so far has the same variance (most commonly all
  // zero, on a project's first one or two snapshots before anything has
  // moved), max - min collapses to 0. Falling back to a range of 1 in that
  // case still anchors the line/zero-marker using the real min, which for
  // an all-zero run pins everything to the very bottom of the plot area —
  // effectively invisible. Centering instead keeps a flat trend visible
  // as a flat line through the middle rather than a sliver at the edge.
  const flat = max === min;
  const range = flat ? 1 : max - min;
  const coords = snapshots.map((s, i) => ({
    x: (i / Math.max(snapshots.length - 1, 1)) * W,
    y: flat ? (plotTop + plotBottom) / 2 : plotBottom - ((Number(s.variance) - min) / range) * (plotBottom - plotTop),
    variance: Number(s.variance),
  }));
  const points = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const areaPoints = `0,${plotBottom} ${points} ${W},${plotBottom}`;
  const zeroY = flat ? (plotTop + plotBottom) / 2 : plotBottom - ((0 - min) / range) * (plotBottom - plotTop);
  // Colour follows the latest snapshot's own status — over budget is red,
  // on/under budget is green — the same convention used everywhere else
  // in the app (line items, the trend table's Variance column, etc.),
  // rather than whether the trend is improving or worsening, which the
  // callout line above the chart speaks to instead.
  const latest = values[values.length - 1];
  const color = latest > 0 ? "var(--danger)" : "var(--success)";
  const fillId = "trendAreaFill";
  // Labelling every point gets unreadable past a handful of snapshots —
  // only the first and last carry a value once there are more than five.
  const labelAll = coords.length <= 5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="#E8E8ED" strokeWidth="1.5" strokeDasharray="4,4" />
      {/* Skip the label in the flat case — the line and the trend itself
          sit on top of each other there, so "on budget" would collide
          with the last point's own value label right above it. */}
      {!flat && (
        <text x={W} y={zeroY - 8} textAnchor="end" fontSize="12" fill="#9A9AA0" fontFamily="'IBM Plex Mono', monospace">on budget</text>
      )}
      <polygon points={areaPoints} fill={`url(#${fillId})`} />
      <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {coords.map((c, i) => {
        const isFirst = i === 0;
        const isLast = i === coords.length - 1;
        const showLabel = labelAll || isFirst || isLast;
        return (
          <React.Fragment key={i}>
            <circle cx={c.x} cy={c.y} r="5" fill="var(--surface)" stroke={color} strokeWidth="2.5" />
            {showLabel && (
              <text
                x={c.x}
                y={c.y - 14}
                textAnchor={isFirst ? "start" : isLast ? "end" : "middle"}
                fontSize="13"
                fontWeight="700"
                fill="var(--text-primary)"
                fontFamily="'IBM Plex Mono', monospace"
              >
                {c.variance >= 0 ? "+" : ""}{fmtShort(c.variance)}
              </text>
            )}
          </React.Fragment>
        );
      })}
    </svg>
  );
}

function LegendDot({ color, label }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-secondary)" }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      {label}
    </span>
  );
}

function EmptyChart({ label }) {
  return <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "24px 0" }}>{label}</div>;
}

// This app styles everything through the inline `style` prop, and inline
// styles beat stylesheet selectors — so a `:hover` rule in index.css loses to
// every property the style prop already sets. Interactive states therefore
// live in React state, the same way FlaggedLinesCard handles its popover.
// onFocus/onBlur mirror the pointer events: a control that only answers to a
// mouse is half a control.
const REDUCED_MOTION =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function LitButton({ children, style, litStyle, disabled, onClick, ...rest }) {
  const [lit, setLit] = useState(false);
  const on = lit && !disabled;
  const active = on ? { ...litStyle } : {};
  if (on && REDUCED_MOTION) delete active.transform;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setLit(true)}
      onMouseLeave={() => setLit(false)}
      onFocus={() => setLit(true)}
      onBlur={() => setLit(false)}
      style={{
        outline: "none",
        transition: REDUCED_MOTION ? "none" : "border-color .16s ease, background .16s ease, box-shadow .16s ease, transform .16s ease, color .16s ease",
        ...style,
        ...active,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

// One figure with its label and supporting line — used for the exposure strip
// on a subcontractor card, where the numbers are context for the scores below
// rather than scores themselves.
// Storage upgrade tile. The price line brightens along with the border so the
// whole tile reads as one lit object rather than a box with a glowing edge.
function UpgradeOption({ label, price, busy, onClick }) {
  const [lit, setLit] = useState(false);
  const on = lit && !busy;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      onMouseEnter={() => setLit(true)}
      onMouseLeave={() => setLit(false)}
      onFocus={() => setLit(true)}
      onBlur={() => setLit(false)}
      style={{
        ...styles.importBtn,
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        padding: "10px 14px", textAlign: "left", outline: "none",
        borderColor: on ? "var(--accent)" : "var(--border-color)",
        background: on ? "var(--bg-secondary)" : "var(--surface)",
        boxShadow: on
          ? "0 0 0 3px var(--accent-glow), 0 8px 20px -12px var(--accent-glow)"
          : "0 1px 6px rgba(0,0,0,0.06)",
        transform: on && !REDUCED_MOTION ? "translateY(-1px)" : "none",
        opacity: busy ? 0.6 : 1,
        cursor: busy ? "default" : "pointer",
        transition: REDUCED_MOTION ? "none" : "border-color .16s ease, background .16s ease, box-shadow .16s ease, transform .16s ease",
      }}
    >
      <span style={{ fontWeight: 600 }}>{busy ? "Redirecting…" : label}</span>
      <span style={{
        fontSize: 12, fontWeight: 400, marginTop: 1,
        color: on ? "var(--text-primary)" : "var(--text-secondary)",
        transition: REDUCED_MOTION ? "none" : "color .16s ease",
      }}>{price}</span>
    </button>
  );
}

function SubMetric({ label, value, sub, tone }) {
  return (
    <div style={{ minWidth: 96, flex: "1 1 96px" }}>
      <div style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 9, fontWeight: 600, letterSpacing: "0.13em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 5 }}>{label}</div>
      <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 15, fontWeight: 600, letterSpacing: "-0.015em", color: tone || "var(--text-primary)" }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: "var(--text-secondary)", marginTop: 3, lineHeight: 1.35 }}>{sub}</div>}
    </div>
  );
}

// The spend mix of a template, as a share-of-total bar. Lets you tell a
// residential build from a shopfit without opening either one.
function TemplateComposition({ items }) {
  const total = items.reduce((s, i) => s + Number(i.budget || 0), 0);
  if (!total) return null;
  const byCat = {};
  items.forEach((i) => {
    const c = i.category || "Other";
    byCat[c] = (byCat[c] || 0) + Number(i.budget || 0);
  });
  const parts = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const [topCat, topVal] = parts[0];
  return (
    <div style={{ marginTop: 10, maxWidth: 460 }}>
      <div style={{ display: "flex", gap: 2, height: 7, borderRadius: 100, overflow: "hidden", background: "var(--bg-secondary)" }}>
        {parts.map(([cat, v]) => (
          <div
            key={cat}
            title={`${cat} — ${fmt(v)} (${Math.round((v / total) * 100)}%)`}
            style={{ width: `${(v / total) * 100}%`, background: CATEGORY_COLOR[cat] || "#8C8C94" }}
          />
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 6 }}>
        Spans {parts.length} trade{parts.length === 1 ? "" : "s"} · heaviest in {topCat} ({Math.round((topVal / total) * 100)}%)
      </div>
    </div>
  );
}

function ScoreBar({ label, score, detail }) {
  const color = scoreColor(score);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{label}</span>
        <span style={{ fontSize: 12, fontFamily: "'Space Grotesk', sans-serif", color }}>
          {score == null ? "—" : Math.round(score)}
        </span>
      </div>
      <div style={{ height: 6, background: "var(--bg-secondary)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${score ?? 0}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.3s ease" }} />
      </div>
      {detail && <div style={{ fontSize: 10.5, color: "var(--text-secondary)", marginTop: 3 }}>{detail}</div>}
    </div>
  );
}

function SummaryCard({ label, value, accent, slab, sub, popover, popoverLabel, glow }) {
  const [open, setOpen] = useState(false);
  if (slab) {
    return (
      <div style={styles.summaryCardSlab}>
        <div style={styles.summaryLabelSlab}>{label}</div>
        <div style={styles.summaryValueSlab}>{value}</div>
        {sub && <div style={styles.summarySubSlab}>{sub}</div>}
      </div>
    );
  }
  const hasPopover = !!popover;
  return (
    <div
      style={{ ...styles.summaryCard, position: "relative", overflow: hasPopover ? "visible" : "hidden" }}
      onMouseEnter={() => hasPopover && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {glow && (
        <div style={{ ...styles.summaryGlowBar, ...(glow === "neg" ? styles.summaryGlowNeg : styles.summaryGlowPos) }} />
      )}
      <div style={{ ...styles.summaryLabel, ...(hasPopover ? { paddingRight: 24 } : {}) }}>{label}</div>
      <div style={{ ...styles.summaryValue, ...(accent ? { color: accent } : {}) }}>{value}</div>
      {sub && <div style={styles.summarySub}>{sub}</div>}
      {hasPopover && (
        <button
          type="button"
          aria-label={popoverLabel || label}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          style={{ ...styles.summaryInfoBtn, ...(open ? styles.summaryInfoBtnActive : {}) }}
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="12" y1="16" x2="12" y2="11" />
            <circle cx="12" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="9.2" />
          </svg>
        </button>
      )}
      {hasPopover && open && (
        <div style={styles.summaryPopover}>
          <div style={styles.summaryPopoverCaret} />
          {popover}
        </div>
      )}
    </div>
  );
}

function FlaggedLinesCard({ label, value, accent, items, sub }) {
  const hasItems = items && items.length > 0;
  return (
    <SummaryCard
      label={label}
      value={value}
      accent={accent}
      sub={sub}
      popoverLabel="Flagged line items"
      popover={
        hasItems ? (
          <>
            <div style={styles.summaryPopoverTitle}>Flagged line items</div>
            {items.map((f, idx) => (
              <div key={f.id} style={idx === items.length - 1 ? styles.summaryPopoverRowLast : styles.summaryPopoverRow}>
                <span style={{ ...styles.summaryPopoverDot, background: f.status === "over" ? "var(--tm-neg)" : "var(--tm-warn-mark)" }} />
                <span style={styles.summaryPopoverName}>{f.name}</span>
                <span style={{ ...styles.summaryPopoverValue, color: f.status === "over" ? "var(--tm-neg)" : "var(--tm-warn)" }}>
                  {f.pct >= 0 ? "+" : ""}{f.pct.toFixed(1)}%
                </span>
              </div>
            ))}
          </>
        ) : null
      }
    />
  );
}

function AppLogo() {
  return (
    <div style={styles.appLogoRow}>
      <svg className="sm-app-logo-mark" style={styles.appLogoMark} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="8" width="28" height="8" fill="var(--text-primary)" />
        <rect x="34" y="8" width="10" height="8" fill="var(--accent)" />
        <rect x="4" y="20" width="40" height="8" fill="var(--text-primary)" />
        <rect x="4" y="32" width="40" height="8" fill="var(--text-primary)" />
      </svg>
      <div className="sm-app-logo-text" style={styles.appLogoText}>
        site<span style={{ color: "var(--accent)" }}>Margin</span>
      </div>
    </div>
  );
}

function GlobalStyles() {
  // Font loading itself now lives in index.html's <head> (preconnect + a
  // real <link rel="stylesheet">) instead of this @import, so the browser
  // starts fetching fonts in parallel with the JS bundle instead of only
  // discovering them after React mounts and injects this style tag.
  return (
    <style>{`
      * { box-sizing: border-box; }
      input, select, textarea, button { font-family: inherit; }
      input:focus, select:focus, textarea:focus { outline: 2px solid #1D5C8A; outline-offset: 1px; }
      button:focus-visible { outline: 2px solid #1D5C8A; outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      .print-only-status { display: none; }
      .print-only-footer { display: none; }
      .sm-logo-menu-item:hover { background: #F5F5F7; }
      /* Hover highlight for every link/button row inside the hamburger
         drawer — blueprint blue rather than the old accent orange, to stay
         consistent with the rest of the app's colour swap. .sm-menu-item
         covers Projects/Subcontractors/Templates and the "More from
         SiteMargin" links; .sm-menu-item-dim covers the smaller Terms/
         Privacy row, which gets a colour-only hover (no background) since
         it has no horizontal padding to hold one. */
      .sm-menu-item:hover { background: #E9F1F6 !important; color: #1D5C8A !important; }
      .sm-menu-item-dim:hover { color: #1D5C8A !important; }
      /* Full marketing-style footer shown on the public sign-up/log-in
         screen (see PublicSiteFooter below) — hover states mirror the
         marketing site's styles.css .footer-social/.footer-col/.footer-bottom
         rules exactly, since inline styles can't express :hover. */
      .sm-pub-footer-social:hover { background: #ECECEF !important; color: #1D1D1F !important; }
      .sm-pub-footer-col a:hover { color: #1D5C8A !important; }
      .sm-pub-footer-bottom a:hover { color: #1D1D1F !important; }
      /* Always-visible Log in / Sign up pill in the gate screen's header —
         mirrors the marketing site's .nav-app-link pill exactly, so the
         login entry point is immediately visible without opening the
         hamburger menu at all, on every screen size. */
      .sm-gate-nav-btn:hover { background: #154766 !important; }
      /* Lets the hamburger's drawer pop open on hover, but only on devices
         that have a real hover-capable pointer (a mouse/trackpad) — gated
         behind (hover: hover) and (pointer: fine) so touchscreens (the
         Android app included) never get a "stuck open" menu from a phantom
         hover a tap can trigger. Touch and click-only devices still open it
         via the button's own onClick, which sets menuOpen and applies
         styles.menuDrawerOpen directly as an inline style further down —
         this rule only adds hover as an extra way in on desktop, it's never
         the only way in. !important is required to win over the drawer's
         own inline closed-state styles, which inline styles otherwise
         always beat regardless of this rule's specificity. */
      @media (hover: hover) and (pointer: fine) {
        .sm-menu-wrap:hover .sm-menu-drawer {
          transform: translateY(0) scale(1) !important;
          opacity: 1 !important;
          visibility: visible !important;
          pointer-events: auto !important;
        }
      }
      @media print {
        .no-print { display: none !important; }
        body, html { background: #fff !important; }
        .print-only-status { display: inline !important; text-transform: capitalize; }
        .print-only-footer { display: block !important; }
      }
      @media (max-width: 640px) {
        /* TopNav duplicates everything (tabs, Print, email, Sign out) that's
           already in PageHeader's hamburger menu — on a phone-width screen
           it doesn't fit in one row and was overflowing off-screen, so hide
           it rather than trying to cram it in. */
        .sm-top-nav { display: none !important; }
        .sm-app-logo-mark { height: 40px !important; }
        .sm-app-logo-text { font-size: 17px !important; }
      }
    `}</style>
  );
}

function PageHeader({ title, current, onNavigate, userEmail, onSignOut, logoUrl, hideTitle, titleNode, logoNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef(null);

  // Self-fetched rather than threaded down as a prop: `subscription` today
  // only lives inside AuthGate's own state and isn't passed to AppShell or
  // any view, and PageHeader is already the one component every view
  // shares (7 call sites) — so fetching tier here, keyed on the userEmail
  // prop every call site already passes, makes the badge appear
  // everywhere with a change in exactly one place instead of prop-drilling
  // subscription through six separate view components. null while
  // loading/signed-out keeps the badge hidden rather than flashing a
  // wrong tier before the row comes back.
  const [headerTier, setHeaderTier] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userEmail) {
        if (!cancelled) setHeaderTier(null);
        return;
      }
      const { data } = await supabase.from("subscriptions").select("tier").eq("email", userEmail).maybeSingle();
      if (cancelled) return;
      setHeaderTier(data?.tier || "free");
    })();
    return () => { cancelled = true; };
  }, [userEmail]);
  const tierBadge = headerTier && HEADER_TIER_BADGE[headerTier];
  const tabs = [
    ["dashboard", "Projects"],
    ["subcontractors", "Subcontractors"],
    ["templates", "Templates"],
    ["integrations", "Accounting"],
    ["storage", "Plan and Storage"],
  ];
  const closeAnd = (fn) => () => { setMenuOpen(false); if (fn) fn(); };

  // Closes the drawer on an outside click/tap — same pattern used for the
  // logo and download popovers elsewhere in this file. Only needed for the
  // click-opened case; the hover-opened case already closes itself the
  // moment the pointer leaves .sm-menu-wrap.
  useEffect(() => {
    if (!menuOpen) return;
    function handleOutside(e) {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [menuOpen]);

  return (
    <div style={styles.dashHeader}>
      <div style={styles.dashNavBar}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <AppLogo />
          {tierBadge && (
            <span style={{ ...styles.tierBadge, background: tierBadge.tint }}>
              <span style={{ ...styles.tierBadgeLabel, color: tierBadge.color }}>{tierBadge.label}</span>
            </span>
          )}
        </div>
        <div className="no-print" style={styles.dashNavRight}>
          {/* Mirrors the marketing site's always-visible "Go to App" button,
              in the same spot next to the hamburger — pointing the other
              way. Native-only exclusion for the same reason as elsewhere:
              it would hijack the app's own webview with no way back. */}
          {!Capacitor.isNativePlatform() && (
            <a href="https://sitemargin.co.za" style={styles.navHomeLink}>Home</a>
          )}
          <ThemeToggle />
          <div className="sm-menu-wrap" ref={menuWrapRef} style={styles.menuWrap}>
            <button
              style={styles.menuBtn}
              aria-expanded={menuOpen}
              aria-controls="appMenuPanel"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span style={{ ...styles.menuBtnBar, ...(menuOpen ? styles.menuBtnBar1Open : {}) }} />
              <span style={{ ...styles.menuBtnBar, ...(menuOpen ? styles.menuBtnBarMidOpen : {}) }} />
              <span style={{ ...styles.menuBtnBar, ...(menuOpen ? styles.menuBtnBar3Open : {}) }} />
            </button>

            {/* Always mounted (not menuOpen && …) so the CSS hover rule has
                something to reveal — visibility/pointer-events keep it
                non-interactive and untabbable while closed. */}
            <div id="appMenuPanel" className="no-print sm-menu-drawer" style={{ ...styles.menuDrawer, ...(menuOpen ? styles.menuDrawerOpen : {}) }}>
              <div style={styles.menuPanelInner}>
                {onNavigate && tabs.map(([key, label]) => (
                  <button
                    key={key}
                    className="sm-menu-item"
                    style={{ ...styles.menuPanelLink, ...(current === key ? styles.menuPanelLinkActive : {}) }}
                    onClick={closeAnd(() => onNavigate(key))}
                  >
                    {label}
                  </button>
                ))}
                {/* The marketing site's own pages (What's inside, Pricing,
                    About, Contact, Terms, Privacy) sit one tier down —
                    smaller and muted rather than matching Projects/
                    Subcontractors/Templates — so the panel reads as "your
                    app" first and "more from SiteMargin" second, instead of
                    seven identical-weight links with no hierarchy. On native
                    these route through openExternalLink (an in-app Custom
                    Tab overlay) instead of a plain href, which would hijack
                    the app's own webview out to a separate browser app. */}
                <div style={styles.menuSectionLabel}>More from SiteMargin</div>
                {[
                  { label: "What's inside", href: "https://sitemargin.co.za/whats-inside.html" },
                  { label: "Pricing", href: "https://sitemargin.co.za/pricing.html" },
                  { label: "About", href: "https://sitemargin.co.za/about.html" },
                  { label: "Contact", href: "https://sitemargin.co.za/contact.html" },
                  { label: "Construction Library", href: "https://sitemargin.co.za/construction-library.html" },
                ].map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    className="sm-menu-item"
                    style={styles.menuSecondaryLink}
                    onClick={() => setMenuOpen(false)}
                  >
                    {item.label}
                  </a>
                ))}
                <div style={styles.menuPanelDimRow}>
                  <a
                    href="https://sitemargin.co.za/terms.html"
                    className="sm-menu-item-dim"
                    style={styles.menuPanelDim}
                    onClick={() => setMenuOpen(false)}
                  >
                    Terms
                  </a>
                  <a
                    href="https://sitemargin.co.za/privacy.html"
                    className="sm-menu-item-dim"
                    style={styles.menuPanelDim}
                    onClick={() => setMenuOpen(false)}
                  >
                    Privacy
                  </a>
                </div>
                <div style={styles.menuFooter}>
                  <div style={styles.menuFooterBrandRow}>
                    <svg style={styles.menuFooterLogoMark} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
                      <rect x="4" y="8" width="28" height="8" fill="var(--text-primary)" />
                      <rect x="34" y="8" width="10" height="8" fill="var(--accent)" />
                      <rect x="4" y="20" width="40" height="8" fill="var(--text-primary)" />
                      <rect x="4" y="32" width="40" height="8" fill="var(--text-primary)" />
                    </svg>
                    <span style={styles.menuFooterWordmark}>site<span style={{ color: "var(--accent)" }}>Margin</span></span>
                  </div>
                  <div style={styles.menuFooterTagline}>Cost variance tracking built for contractors, not accountants.</div>
                  <div style={styles.menuPanelActions}>
                    <button style={styles.menuPanelGhost} onClick={closeAnd(() => window.print())}>Print</button>
                    {onSignOut && <button style={styles.menuPanelSolid} onClick={closeAnd(onSignOut)}>Sign out</button>}
                  </div>
                  {userEmail && <div style={styles.menuPanelEmail}>{userEmail}</div>}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {!hideTitle && (
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          {logoNode !== undefined ? logoNode : (
            logoUrl && (
              // Deliberately not "no-print" — the company logo should appear on
              // printed/exported output (change order sheets, cost reports etc.),
              // not just on screen.
              <img src={logoUrl} alt="Company logo" style={styles.companyLogoMark} />
            )
          )}
          {titleNode !== undefined ? titleNode : <h1 style={styles.pageHeaderEyebrow}>{title}</h1>}
        </div>
      )}
    </div>
  );
}

// QR code encoding https://www.sitemargin.co.za, generated offline (no
// external QR API call) and verified to decode correctly before being
// committed here. Stored as one binary string per row (not a packed int —
// the 33-column width exceeds JS's 32-bit bitwise-op range) so ReferralQr
// below can render it as plain SVG rects with no image request at all.
const SITEMARGIN_QR_SIZE = 33;
const SITEMARGIN_QR_ROWS = [
  "000000000000000000000000000000000",
  "000000000000000000000000000000000",
  "001111111000000100111110111111100",
  "001000001011100011101100100000100",
  "001011101000111110101100101110100",
  "001011101000001111001000101110100",
  "001011101011101010001100101110100",
  "001000001000011100000110100000100",
  "001111111010101010101010111111100",
  "000000000000110110111100000000000",
  "001010101001100011010110001001000",
  "000011100010000011000010100100100",
  "000110011111101100010000100011100",
  "001101110010100001011010101001000",
  "001111001011111000111011100101100",
  "001101100010001101100011110100100",
  "001010011100100011110010010101100",
  "000110100000000110110000000101000",
  "000101011110101011010001110101100",
  "000001110001101011001010100110100",
  "001001101010101100011001110001100",
  "000111000101100001010101000101000",
  "001101111011101000110011111000000",
  "000000000011101101110110001011100",
  "001111111001100011101110101101100",
  "001000001001011110111010001101000",
  "001011101011110011001011111001000",
  "001011101000101011000000001010000",
  "001011101011110100010100011100100",
  "001000001000011001000110001001000",
  "001111111010001100100111111101100",
  "000000000000000000000000000000000",
  "000000000000000000000000000000000",
];

// Renders the QR matrix above as inline SVG rects — no <img>, no network
// request, so it can never break due to a third-party QR API going down.
function ReferralQr({ size = 112 }) {
  const quiet = 2; // the matrix already bakes in ~2 modules of quiet zone per edge
  const scale = 8;
  const full = (SITEMARGIN_QR_SIZE + quiet * 2) * scale;
  const rects = [];
  for (let r = 0; r < SITEMARGIN_QR_SIZE; r++) {
    const row = SITEMARGIN_QR_ROWS[r];
    for (let c = 0; c < SITEMARGIN_QR_SIZE; c++) {
      if (row[c] === "1") {
        rects.push(<rect key={`${r}-${c}`} x={(c + quiet) * scale} y={(r + quiet) * scale} width={scale} height={scale} />);
      }
    }
  }
  return (
    <svg viewBox={`0 0 ${full} ${full}`} width={size} height={size} shapeRendering="crispEdges" style={{ boxShadow: "0 1px 6px rgba(0,0,0,0.08)" }}>
      <rect width={full} height={full} fill="#ffffff" />
      <g fill="#1D1D1F">{rects}</g>
    </svg>
  );
}

function ReferralRow() {
  const [copied, setCopied] = useState(false);
  const referralText = "Check out SiteMargin — cost variance tracking built for contractors: https://www.sitemargin.co.za";
  async function copyLink() {
    try {
      await navigator.clipboard.writeText("https://www.sitemargin.co.za");
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard permission denied — link is still visible via the other share options */
    }
  }
  // On native, wa.me is an https:// link — inside a WebView that gets handed
  // to a separate browser app rather than to WhatsApp itself. The
  // whatsapp://send scheme instead hands off straight to the WhatsApp app
  // (same as tapping a share button anywhere else), so the user never sees
  // a browser at all. On the web build wa.me is correct as-is.
  function shareWhatsapp(e) {
    if (Capacitor.isNativePlatform()) {
      e.preventDefault();
      window.location.href = `whatsapp://send?text=${encodeURIComponent(referralText)}`;
    }
  }
  return (
    <div className="no-print" style={styles.referralRow}>
      <div style={styles.referralText}>
        <div style={styles.referralEyebrow}>Spread the word</div>
        <div style={styles.referralHeading}>Know a contractor or homeowner who'd love this?</div>
        <div style={styles.referralSub}>Share SiteMargin with friends and family — no referral code needed, just send the link.</div>
        <div style={styles.referralActions}>
          <a
            style={{ ...styles.referralBtn, ...styles.referralBtnWhatsapp }}
            href={`https://wa.me/?text=${encodeURIComponent(referralText)}`}
            {...(!Capacitor.isNativePlatform() && { target: "_blank", rel: "noopener noreferrer" })}
            onClick={shareWhatsapp}
          >
            WhatsApp
          </a>
          <a style={styles.referralBtn} href="mailto:?subject=Take%20a%20look%20at%20SiteMargin&body=Thought%20you%27d%20find%20this%20useful%20%E2%80%94%20https%3A%2F%2Fwww.sitemargin.co.za">Email</a>
          <button type="button" style={styles.referralBtn} onClick={copyLink}>{copied ? "Copied!" : "Copy link"}</button>
        </div>
      </div>
      <div style={styles.referralQrBlock}>
        <ReferralQr />
        <div style={styles.referralQrCaption}>Scan to visit<br /><b style={{ fontFamily: "'Space Grotesk', sans-serif" }}>sitemargin.co.za</b></div>
      </div>
    </div>
  );
}

/* Footer, matching sitemargin.co.za's own footer exactly (same logo, tagline,
   social icons, three link columns, and copyright bar) — rendered at the
   bottom of every app page, the public sign-up/log-in screen included, so
   the footer stays universal across the whole site and not just the
   marketing pages. Previously this was a stripped-down single line; that
   drifted out of sync the same way the hamburger menu once did once the
   marketing site's footer grew into the fuller design below. */
function AppFooter() {
  // Same reasoning as the hamburger menu's marketing-site links: on the
  // native app these would hijack the app's own webview to show an external
  // page, and "Get the app" store badges make no sense from inside the app
  // you already installed. Hidden on native; shown on the web build, where
  // linking out to the marketing site is a normal, expected action.
  const showExternalLinks = !Capacitor.isNativePlatform();
  return (
    <>
      <ReferralRow />
      <footer className="no-print" style={styles.pubFooter}>
        <div style={styles.pubFooterTop}>
          <div style={styles.pubFooterBrand}>
            <div style={styles.pubFooterLogoRow}>
              <svg style={styles.pubFooterLogoMark} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
                <rect x="4" y="8" width="28" height="8" fill="var(--text-primary)" />
                <rect x="34" y="8" width="10" height="8" fill="var(--accent)" />
                <rect x="4" y="20" width="40" height="8" fill="var(--text-primary)" />
                <rect x="4" y="32" width="40" height="8" fill="var(--text-primary)" />
              </svg>
              <div style={styles.pubFooterLogoText}>site<span style={{ color: "var(--accent)" }}>Margin</span></div>
            </div>
            <p style={styles.pubFooterTagline}>Cost variance tracking built for contractors, not accountants.</p>
            {showExternalLinks && (
              <div style={styles.pubFooterSocial}>
                <a className="sm-pub-footer-social" href="#" aria-label="LinkedIn" style={styles.pubFooterSocialLink}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 11-.02 5.001A2.5 2.5 0 014.98 3.5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.6c0-1.34-.02-3.06-1.87-3.06-1.87 0-2.16 1.46-2.16 2.96V21H9z"/></svg>
                </a>
                <a className="sm-pub-footer-social" href="https://www.instagram.com/sitemargin/" target="_blank" rel="noopener noreferrer" aria-label="Instagram" style={styles.pubFooterSocialLink}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.2" cy="6.8" r="1" /></svg>
                </a>
              </div>
            )}
          </div>
          {showExternalLinks && (
            <div style={styles.pubFooterCols}>
              <div className="sm-pub-footer-col" style={styles.pubFooterCol}>
                <h5 style={styles.pubFooterColHead}>Get started</h5>
                <a href="https://sitemargin.co.za/whats-inside.html" style={styles.pubFooterColLink}>What's inside</a>
                <a href="https://sitemargin.co.za/pricing.html" style={styles.pubFooterColLink}>Pricing</a>
                <a href="https://app.sitemargin.co.za" style={styles.pubFooterColLink}>Start free</a>
              </div>
              <div className="sm-pub-footer-col" style={styles.pubFooterCol}>
                <h5 style={styles.pubFooterColHead}>Company</h5>
                <a href="https://sitemargin.co.za/about.html" style={styles.pubFooterColLink}>About</a>
                <a href="https://sitemargin.co.za/contact.html" style={styles.pubFooterColLink}>Contact</a>
                <a href="https://sitemargin.co.za/terms.html" style={styles.pubFooterColLink}>Terms</a>
                <a href="https://sitemargin.co.za/privacy.html" style={styles.pubFooterColLink}>Privacy</a>
              </div>
              <div className="sm-pub-footer-col" style={styles.pubFooterCol}>
                <h5 style={styles.pubFooterColHead}>Get the app</h5>
                <a style={styles.pubFooterStoreLink} href="https://app.sitemargin.co.za">
                  <svg viewBox="0 0 24 24" fill="currentColor" style={styles.pubFooterStoreIcon}><path d="M3 2.6v18.8a1 1 0 001.5.87l16-9.4a1 1 0 000-1.74l-16-9.4A1 1 0 003 2.6z" /></svg>
                  Google Play
                </a>
                <span style={{ ...styles.pubFooterStoreLink, ...styles.pubFooterStoreLinkSoon }}>
                  <svg viewBox="0 0 24 24" fill="currentColor" style={styles.pubFooterStoreIcon}><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.947 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.692 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zm3.415-3.132c.843-1.012 1.4-2.427 1.245-3.831-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.717-.688 3.559-1.701z" /></svg>
                  Apple App Store — coming soon
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="sm-pub-footer-bottom" style={styles.pubFooterBottom}>
          <span>© 2026 SiteMargin</span>
        </div>
      </footer>
    </>
  );
}

/* ============================== APP SHELL (everything behind the gate) ============================== */

function AppShell({ userEmail, onSignOut }) {
  const [route, setRoute] = useState({ page: "dashboard", projectId: null });
  // Company logo, edited inline on the dashboard, shown next to the page
  // title everywhere (and on printed output — see ProjectView's title
  // block). Lives in its own table keyed by owner_email rather than on
  // each project, since it's one logo per account, not per project.
  const [companyLogoUrl, setCompanyLogoUrl] = useState(null);
  // Client-chosen account/company name, edited inline on the dashboard
  // title itself, instead of defaulting to something derived from the
  // sign-in email — clients should be able to name their own account freely.
  const [companyDisplayName, setCompanyDisplayName] = useState(null);

  useEffect(() => {
    if (!userEmail) return;
    supabase
      .from("company_settings")
      .select("logo_data_url, display_name")
      .eq("owner_email", userEmail)
      .maybeSingle()
      .then(({ data }) => {
        setCompanyLogoUrl(data?.logo_data_url || null);
        setCompanyDisplayName(data?.display_name || null);
      });
  }, [userEmail]);

  const navigate = (page) => setRoute({ page, projectId: null });

  if (route.page === "project") {
    return (
      <ProjectView
        projectId={route.projectId}
        onBack={() => setRoute({ page: "dashboard", projectId: null })}
        onNavigate={navigate}
        userEmail={userEmail}
        onSignOut={onSignOut}
        logoUrl={companyLogoUrl}
      />
    );
  }
  if (route.page === "subcontractors") {
    return <SubcontractorsView onNavigate={navigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={companyLogoUrl} />;
  }
  if (route.page === "templates") {
    return <TemplatesView onNavigate={navigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={companyLogoUrl} />;
  }
  if (route.page === "integrations") {
    return <IntegrationsView onNavigate={navigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={companyLogoUrl} />;
  }
  if (route.page === "storage") {
    return <StorageView onNavigate={navigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={companyLogoUrl} />;
  }
  return (
    <Dashboard
      onOpen={(id) => setRoute({ page: "project", projectId: id })}
      onNavigate={navigate}
      userEmail={userEmail}
      onSignOut={onSignOut}
      logoUrl={companyLogoUrl}
      onLogoChange={setCompanyLogoUrl}
      displayName={companyDisplayName}
      onDisplayNameChange={setCompanyDisplayName}
    />
  );
}

/* ============================== AUTH GATE ============================== */
/* Access requires a magic-link email sign-in. Every signed-in email is
   auto-granted the Free tier (1 project) in checkAccess() below — paid
   tiers (Contractor/Company) are unlocked separately via an active
   subscription. */

function AuthGate() {
  const [status, setStatus] = useState("checking"); // checking | signedout | pending | denied | approved
  const [session, setSession] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [email, setEmail] = useState("");
  const [sendState, setSendState] = useState("idle"); // idle | sending | sent | error
  const [errorMsg, setErrorMsg] = useState("");
  const [checkoutTier, setCheckoutTier] = useState(null); // which plan button is loading
  // Marketing-site "Get started" buttons (pricing.html) link here with
  // ?tier=<slug> so a click carries its intent all the way through sign-up
  // AND, for an already-signed-in visitor, straight to checkout — arriving
  // with this param is itself the deliberate signal, tracked separately
  // from a plain leftover in localStorage (see arrivedWithTierIntentRef).
  const arrivedWithTierIntentRef = useRef(false);
  // supabase-js fires the auth listener once immediately with the current
  // session (event "INITIAL_SESSION"), in addition to the manual
  // getSession() call below — so checkAccess runs twice on every load. The
  // second, redundant call was overwriting the first call's "redirecting"
  // status back to "approved" before the checkout redirect ever fired
  // (arrivedWithTierIntentRef had already been consumed by the first call).
  // This guard makes only the first INITIAL_SESSION call count.
  const initialCheckedRef = useRef(false);
  const [selectedTier, setSelectedTier] = useState(() => {
    try {
      const urlTier = new URLSearchParams(window.location.search).get("tier");
      if (urlTier === "contractor" || urlTier === "firm" || urlTier === "homeowner" || urlTier === "free") {
        arrivedWithTierIntentRef.current = true;
        try { localStorage.setItem("sm_selected_tier", urlTier); } catch {}
        return urlTier;
      }
    } catch {}
    try { return localStorage.getItem("sm_selected_tier") || null; } catch { return null; }
  });
  // "Log in" (marketing site + app menu) links here with ?login=1 so
  // returning users land on a plain sign-in screen instead of the full
  // marketing pitch + pricing grid meant for new sign-ups.
  const [isLoginIntent, setIsLoginIntent] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("login") === "1"; } catch { return false; }
  });
  // Password is an alternative to the magic link, not a replacement — most
  // people still get the one-click email link by default, but anyone who'd
  // rather not wait on email each time can switch to a password instead.
  const [authMode, setAuthMode] = useState("password"); // magic | password — password shown by default, magic link is the fallback toggle
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordState, setPasswordState] = useState("idle"); // idle | sending | error
  const [forgotState, setForgotState] = useState("idle"); // idle | sending | sent | error
  // Set when Supabase redirects back here after a "forgot password" email
  // link — supabase-js fires a PASSWORD_RECOVERY auth event with a live
  // (but purpose-limited) session, which we use only to let them set a new
  // password below, rather than dropping them straight into the app.
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [resetState, setResetState] = useState("idle"); // idle | saving | saved | error
  const [gateMenuOpen, setGateMenuOpen] = useState(false);
  const gateMenuWrapRef = useRef(null);
  const emailInputRef = useRef(null);
  const [rememberMe, setRememberMe] = useState(true);
  const [biometricOffer, setBiometricOffer] = useState(null); // null | "show" | "saving"
  const [nativeUnlockChecking, setNativeUnlockChecking] = useState(() => Capacitor.isNativePlatform());
  const nativeUnlockAttemptedRef = useRef(false);
  const rememberMeStatus = useRememberMeRestore(); // checking | restored | none

  // Strip ?tier= from the URL once it's been read into state above, so a
  // page refresh or the back button doesn't re-trigger the same intent.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("tier")) return;
      params.delete("tier");
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    } catch {}
  }, []);

  useEffect(() => {
    if (!gateMenuOpen) return;
    function handleOutside(e) {
      if (gateMenuWrapRef.current && !gateMenuWrapRef.current.contains(e.target)) setGateMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [gateMenuOpen]);

  function chooseTier(tier) {
    setSelectedTier(tier);
    try { localStorage.setItem("sm_selected_tier", tier); } catch {}
    if (tier === "free") return;
    // Paid tiers need a signed-in session before checkout can start —
    // scroll them to the email form instead of a dead click.
    emailInputRef.current?.focus();
    emailInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function checkAccess(currentSession, authEvent) {
    if (!currentSession) {
      setStatus("signedout");
      return;
    }
    if (authEvent === "INITIAL_SESSION") {
      if (initialCheckedRef.current) return;
      initialCheckedRef.current = true;
    }
    setSession(currentSession);
    const userEmailAddr = currentSession.user.email;

    let [{ data: signup, error: signupErr }, { data: sub }] = await Promise.all([
      supabase.from("signups").select("access_granted").eq("email", userEmailAddr).maybeSingle(),
      supabase.from("subscriptions").select("tier, status, current_period_end").eq("email", userEmailAddr).maybeSingle(),
    ]);

    if (signupErr) {
      setStatus("denied");
      return;
    }

    // Every signed-in email gets the Free tier automatically (matches the
    // pricing page — 1 project, no approval needed). Cover both cases:
    // a brand-new email (no signups row yet) and a legacy row left over
    // from before self-serve Free existed (access_granted still false).
    if (!signup) {
      const { data: created, error: createErr } = await supabase
        .from("signups")
        .insert({ email: userEmailAddr, access_granted: true })
        .select("access_granted")
        .single();
      if (!createErr && created) {
        signup = created;
      }
    } else if (!signup.access_granted) {
      const { data: updated, error: updateErr } = await supabase
        .from("signups")
        .update({ access_granted: true })
        .eq("email", userEmailAddr)
        .select("access_granted")
        .single();
      if (!updateErr && updated) {
        signup = updated;
      }
    }

    const hasActiveSub = sub?.status === "active";
    setSubscription(sub || null);

    // A pending paid-tier selection should only ever trigger an automatic
    // checkout redirect when there's a genuine, fresh signal that this is
    // what the person wants right now — either they just signed in/up
    // (authEvent === "SIGNED_IN"), or they landed on this exact page load
    // via a marketing-site "Get started" link carrying ?tier=... (tracked
    // by arrivedWithTierIntentRef, set only during this component's very
    // first render). It must NOT fire on a plain page load or background
    // token refresh of an already-open session — otherwise a stale
    // leftover value (someone who clicked a paid tier once and never
    // finished checkout) keeps re-triggering a broken checkout attempt on
    // every later visit, which is what happened before this fix. Both the
    // localStorage value and the ref are consumed exactly once here,
    // regardless of outcome.
    const pendingTier = selectedTier;
    const hadExplicitIntent = authEvent === "SIGNED_IN" || arrivedWithTierIntentRef.current;
    arrivedWithTierIntentRef.current = false;
    try { localStorage.removeItem("sm_selected_tier"); } catch {}

    if (signup?.access_granted || hasActiveSub) {
      if (hadExplicitIntent && !hasActiveSub && (pendingTier === "contractor" || pendingTier === "firm" || pendingTier === "homeowner")) {
        setStatus("redirecting");
      } else {
        setSelectedTier(null);
        setStatus("approved");
      }
    } else {
      setStatus("pending");
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => checkAccess(data.session, "INITIAL_SESSION"));
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === "PASSWORD_RECOVERY") {
        // A recovery-flow session, not a real sign-in — hold here and show
        // the "set a new password" screen instead of routing into the app.
        setSession(newSession);
        setRecoveryMode(true);
        return;
      }
      checkAccess(newSession, event);
    });
    return () => listener.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native cold-start: if Face ID/Touch ID unlock was previously turned on
  // (see the post-login offer below) and there's no live session yet, try
  // it once before falling back to the login form. A cancelled or failed
  // prompt just falls through to the normal signed-out screen.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) { setNativeUnlockChecking(false); return; }
    if (nativeUnlockAttemptedRef.current) return;
    if (status !== "signedout") return;
    let enabled = false;
    try { enabled = localStorage.getItem("sm_biometric_enabled") === "1"; } catch {}
    if (!enabled) { setNativeUnlockChecking(false); return; }
    nativeUnlockAttemptedRef.current = true;
    unlockWithBiometrics().finally(() => setNativeUnlockChecking(false));
  }, [status]);

  // Offer to turn on Face ID/Touch ID once, right after a native sign-in,
  // instead of burying it in a settings screen no one finds on day one.
  useEffect(() => {
    if (status !== "approved" || !Capacitor.isNativePlatform()) return;
    let dismissed = false, enabled = false;
    try {
      enabled = localStorage.getItem("sm_biometric_enabled") === "1";
      dismissed = localStorage.getItem("sm_biometric_offer_dismissed") === "1";
    } catch {}
    if (enabled || dismissed) return;
    let cancelled = false;
    biometricAvailable().then((avail) => { if (!cancelled && avail) setBiometricOffer("show"); });
    return () => { cancelled = true; };
  }, [status]);

  async function handleEnableBiometric() {
    setBiometricOffer("saving");
    try {
      await enableBiometricUnlock();
      try { localStorage.setItem("sm_biometric_enabled", "1"); } catch {}
    } catch (err) {
      console.warn("Enable Face ID/Touch ID failed", err);
    } finally {
      setBiometricOffer(null);
    }
  }

  function dismissBiometricOffer() {
    try { localStorage.setItem("sm_biometric_offer_dismissed", "1"); } catch {}
    setBiometricOffer(null);
  }

  // Same production-origin guard as sendMagicLink below, shared by every
  // Supabase auth call that needs an emailRedirectTo/redirectTo — sign-in
  // links should never silently point at localhost or a stray preview URL.
  function authRedirectOrigin() {
    const PROD_ORIGIN = "https://app.sitemargin.co.za";
    return window.location.hostname === "localhost" ? window.location.origin : PROD_ORIGIN;
  }

  // supabase-js issues these auth calls with no built-in request timeout.
  // On a mobile connection that stalls mid-request (backgrounded app,
  // cellular handoff, dropped Wi-Fi) the underlying fetch can go quiet
  // without ever resolving OR rejecting, and none of the handlers below
  // had a catch -- so a stalled request left the button stuck reading
  // "Logging in..."/"Sending..." forever, with no way out but reloading.
  // This races the real call against a timeout and normalizes a thrown
  // network error into the same { error } shape the handlers already
  // expect, so every path -- success, real error, or silent hang --
  // resolves the loading state.
  const AUTH_TIMEOUT_MS = 15000;
  function withAuthTimeout(promise) {
    return Promise.race([
      promise,
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ error: { message: "That's taking too long — check your connection and try again." } }),
          AUTH_TIMEOUT_MS
        )
      ),
    ]).catch((err) => ({ error: { message: err?.message || "Something went wrong — please try again." } }));
  }

  async function sendMagicLink(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setSendState("sending");
    setErrorMsg("");
    const { error } = await withAuthTimeout(supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: authRedirectOrigin() },
    }));
    if (error) {
      setSendState("error");
      setErrorMsg(error.message);
    } else {
      setSendState("sent");
    }
  }

  async function handlePasswordAuth(e) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    if (!isLoginIntent && password !== confirmPassword) {
      setPasswordState("error");
      setErrorMsg("Passwords don't match.");
      return;
    }
    setPasswordState("sending");
    setErrorMsg("");
    if (isLoginIntent) {
      const { error } = await withAuthTimeout(supabase.auth.signInWithPassword({ email: email.trim(), password }));
      if (error) {
        setPasswordState("error");
        setErrorMsg(error.message);
      } else if (rememberMe && !Capacitor.isNativePlatform()) {
        // Native devices get "stay signed in" from the biometric-gated
        // refresh token offered after login instead — see the effects above.
        enableRememberMe().catch((err) => console.warn("enableRememberMe failed", err));
      }
      // On success the onAuthStateChange listener above picks up the new
      // session and checkAccess() takes it from here — nothing more to do.
    } else {
      const { data, error } = await withAuthTimeout(supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: authRedirectOrigin() },
      }));
      if (error) {
        setPasswordState("error");
        setErrorMsg(error.message);
      } else if (!data.session) {
        // Email confirmation is required before the account is usable —
        // reuse the same "check your inbox" notice as the magic link.
        setSendState("sent");
      }
      // If data.session came back immediately (confirmation disabled on
      // the Supabase project), onAuthStateChange handles routing in as usual.
    }
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      setForgotState("error");
      setErrorMsg("Enter your email above first, then click Forgot password.");
      return;
    }
    setForgotState("sending");
    setErrorMsg("");
    const { error } = await withAuthTimeout(supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${authRedirectOrigin()}/?login=1`,
    }));
    if (error) {
      setForgotState("error");
      setErrorMsg(error.message);
    } else {
      setForgotState("sent");
    }
  }

  async function handleSetNewPassword(e) {
    e.preventDefault();
    if (newPassword !== newPasswordConfirm) {
      setResetState("error");
      setErrorMsg("Passwords don't match.");
      return;
    }
    setResetState("saving");
    setErrorMsg("");
    const { error } = await withAuthTimeout(supabase.auth.updateUser({ password: newPassword }));
    if (error) {
      setResetState("error");
      setErrorMsg(error.message);
    } else {
      setResetState("saved");
      setRecoveryMode(false);
      checkAccess(session);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    disableRememberMe().catch(() => {});
    if (Capacitor.isNativePlatform()) {
      disableBiometricUnlock().catch(() => {});
      try { localStorage.removeItem("sm_biometric_enabled"); } catch {}
    }
    setStatus("signedout");
    setSession(null);
  }

  async function startCheckout(tier, overrideEmail) {
    setCheckoutTier(tier);
    setErrorMsg("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/create-checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionData.session?.access_token || ""}`,
        },
        body: JSON.stringify({ email: overrideEmail || session?.user?.email, tier }),
      });
      const json = await res.json();
      if (json.redirectUrl) {
        try { localStorage.removeItem("sm_selected_tier"); } catch {}
        await openExternalRedirect(json.redirectUrl);
      } else {
        setErrorMsg(json.error || "Couldn't start checkout — please try again.");
        setCheckoutTier(null);
      }
    } catch (err) {
      console.error("Checkout failed", err);
      setErrorMsg("Couldn't start checkout — please try again.");
      setCheckoutTier(null);
    }
  }

  // Fires once when checkAccess() decides a freshly-signed-in user with a
  // pending paid-tier selection should go straight to checkout rather than
  // quietly landing on the Free tier they were auto-granted.
  useEffect(() => {
    if (status !== "redirecting" || !session) return;
    const tier = selectedTier;
    if (tier !== "contractor" && tier !== "firm" && tier !== "homeowner") { setStatus("approved"); return; }
    startCheckout(tier, session.user.email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, session]);

  if (recoveryMode) {
    return (
      <div style={styles.page}>
        <GlobalStyles />
        <div style={styles.gateWrap}>
          <h1 style={{ ...styles.dashTitle, marginBottom: 10 }}>Set a new password</h1>
          {resetState === "saved" ? (
            <div style={styles.gateNotice}>Password updated — taking you in…</div>
          ) : (
            <>
              <p style={styles.gateText}>Choose a new password for your SiteMargin account.</p>
              <form onSubmit={handleSetNewPassword} style={styles.gateForm}>
                <input
                  type="password"
                  required
                  minLength={8}
                  placeholder="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  style={styles.addInput}
                />
                <input
                  type="password"
                  required
                  minLength={8}
                  placeholder="Confirm new password"
                  value={newPasswordConfirm}
                  onChange={(e) => setNewPasswordConfirm(e.target.value)}
                  style={styles.addInput}
                />
                <button type="submit" style={styles.addBtn} disabled={resetState === "saving"}>
                  {resetState === "saving" ? "Saving…" : "Save new password"}
                </button>
              </form>
              {resetState === "error" && <div style={styles.gateError}>{errorMsg}</div>}
            </>
          )}
        </div>
      </div>
    );
  }

  if (status === "checking" || (status === "signedout" && (rememberMeStatus === "checking" || nativeUnlockChecking))) {
    return (
      <div style={styles.page}>
        <GlobalStyles />
        <div style={{ ...styles.footer, textAlign: "center", padding: 80 }}>Loading…</div>
      </div>
    );
  }

  if (status === "approved") {
    return (
      <>
        <AppShell userEmail={session?.user?.email} onSignOut={signOut} />
        {biometricOffer && (
          <div style={{ position: "fixed", left: 16, right: 16, bottom: 16, zIndex: 9999, maxWidth: 420, margin: "0 auto", background: "#1D1D1F", color: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 12px 32px rgba(0,0,0,.28)", display: "flex", alignItems: "center", gap: 12, fontSize: 13.5 }}>
            <span style={{ flex: 1 }}>Enable Face ID / Touch ID to skip your password next time?</span>
            <button
              type="button"
              onClick={handleEnableBiometric}
              disabled={biometricOffer === "saving"}
              style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, padding: "7px 12px", fontWeight: 600, cursor: "pointer" }}
            >
              {biometricOffer === "saving" ? "Enabling…" : "Enable"}
            </button>
            <button
              type="button"
              onClick={dismissBiometricOffer}
              disabled={biometricOffer === "saving"}
              style={{ background: "transparent", color: "#C7C7CC", border: "none", padding: "7px 4px", cursor: "pointer" }}
            >
              Not now
            </button>
          </div>
        )}
      </>
    );
  }

  if (status === "redirecting") {
    return (
      <div style={styles.page}>
        <GlobalStyles />
        <div style={{ ...styles.footer, textAlign: "center", padding: 80, maxWidth: 420, margin: "0 auto" }}>
          {errorMsg ? (
            <>
              <div style={styles.gateError}>{errorMsg}</div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
                <button style={styles.addBtn} onClick={() => startCheckout(selectedTier, session?.user?.email)}>Try again</button>
                <button style={styles.removeBtn} onClick={() => setStatus("approved")}>Continue with Free instead</button>
              </div>
            </>
          ) : (
            "Taking you to checkout…"
          )}
        </div>
      </div>
    );
  }

  // signed out, pending, or denied — all get the gate screen, with different messaging
  return (
    <div style={styles.page}>
      <GlobalStyles />
      <div style={styles.gateNavOuter}>
        <div style={styles.gateNavWrap}>
          <div style={styles.gateNav}>
            <AppLogo />
            <div style={styles.gateNavActions}>
              <a
                className="sm-gate-nav-btn"
                href={isLoginIntent ? "https://app.sitemargin.co.za" : "https://app.sitemargin.co.za/?login=1"}
                style={styles.gateNavBtn}
                onClick={(e) => {
                  if (Capacitor.isNativePlatform()) {
                    e.preventDefault();
                    setIsLoginIntent((v) => !v);
                  }
                }}
              >
                {isLoginIntent ? "Sign up" : "Log in"}
              </a>
              <div className="sm-menu-wrap" ref={gateMenuWrapRef} style={styles.menuWrap}>
              <button
                type="button"
                style={styles.menuBtn}
                aria-expanded={gateMenuOpen}
                aria-controls="gateMenuPanel"
                aria-label={gateMenuOpen ? "Close menu" : "Open menu"}
                onClick={() => setGateMenuOpen((v) => !v)}
              >
                <span style={{ ...styles.menuBtnBar, ...(gateMenuOpen ? styles.menuBtnBar1Open : {}) }} />
                <span style={{ ...styles.menuBtnBar, ...(gateMenuOpen ? styles.menuBtnBarMidOpen : {}) }} />
                <span style={{ ...styles.menuBtnBar, ...(gateMenuOpen ? styles.menuBtnBar3Open : {}) }} />
              </button>

              <div id="gateMenuPanel" className="sm-menu-drawer" style={{ ...styles.menuDrawer, ...(gateMenuOpen ? styles.menuDrawerOpen : {}) }}>
                <div style={styles.menuPanelInner}>
                  {[
                    { label: "Home", href: "https://sitemargin.co.za/index.html" },
                    { label: "What's inside", href: "https://sitemargin.co.za/whats-inside.html" },
                    { label: "Pricing", href: "https://sitemargin.co.za/pricing.html" },
                    { label: "About", href: "https://sitemargin.co.za/about.html" },
                    { label: "Contact", href: "https://sitemargin.co.za/contact.html" },
                    { label: "Construction Library", href: "https://sitemargin.co.za/construction-library.html" },
                  ].map((item) => (
                    <button
                      key={item.label}
                      className="sm-menu-item"
                      style={styles.menuPanelLink}
                      onClick={() => { setGateMenuOpen(false); window.location.href = item.href; }}
                    >
                      {item.label}
                    </button>
                  ))}
                  <div style={styles.menuPanelDimRow}>
                    <button className="sm-menu-item-dim" style={styles.menuPanelDim} onClick={() => { setGateMenuOpen(false); window.location.href = "https://sitemargin.co.za/terms.html"; }}>Terms</button>
                    <button className="sm-menu-item-dim" style={styles.menuPanelDim} onClick={() => { setGateMenuOpen(false); window.location.href = "https://sitemargin.co.za/privacy.html"; }}>Privacy</button>
                  </div>
                  <div style={styles.menuFooter}>
                    <div style={styles.menuFooterBrandRow}>
                      <svg style={styles.menuFooterLogoMark} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
                        <rect x="4" y="8" width="28" height="8" fill="var(--text-primary)" />
                        <rect x="34" y="8" width="10" height="8" fill="var(--accent)" />
                        <rect x="4" y="20" width="40" height="8" fill="var(--text-primary)" />
                        <rect x="4" y="32" width="40" height="8" fill="var(--text-primary)" />
                      </svg>
                      <span style={styles.menuFooterWordmark}>site<span style={{ color: "var(--accent)" }}>Margin</span></span>
                    </div>
                    <div style={styles.menuFooterTagline}>Cost variance tracking built for contractors, not accountants.</div>
                    <div style={styles.menuPanelActions}>
                      <button
                        style={styles.menuPanelGhost}
                        onClick={() => {
                          setGateMenuOpen(false);
                          if (Capacitor.isNativePlatform()) { setIsLoginIntent(true); return; }
                          window.location.href = "https://app.sitemargin.co.za/?login=1";
                        }}
                      >
                        Log in
                      </button>
                      <button
                        style={styles.menuPanelSolid}
                        onClick={() => {
                          setGateMenuOpen(false);
                          if (Capacitor.isNativePlatform()) { setIsLoginIntent(false); return; }
                          window.location.href = "https://app.sitemargin.co.za";
                        }}
                      >
                        Sign up free
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ ...styles.gateWrap, maxWidth: 1024 }}>
        {status === "signedout" && sendState !== "sent" && !isLoginIntent && (
          <div style={styles.heroWrap}>
            <svg style={styles.heroBacksplash} viewBox="0 0 1600 600" preserveAspectRatio="xMidYMid slice" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <defs>
                <pattern id="heroGrain" x="0" y="0" width="8" height="8" patternUnits="userSpaceOnUse">
                  <circle cx="4" cy="4" r="1.1" fill="#B9BDC6" opacity="0.5" />
                </pattern>
                <pattern id="heroPerforated" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
                  <circle cx="7" cy="7" r="2.8" fill="#8B95A5" opacity="0.6" />
                </pattern>
                <pattern id="heroIsoGrid" width="40" height="40" patternUnits="userSpaceOnUse">
                  <path d="M 40 0 L 0 20 L 40 40 L 80 20 Z" fill="none" stroke="#B9BDC6" strokeWidth="0.9" />
                </pattern>
                <linearGradient id="heroConcreteGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#EDEDF1" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#DFDFE5" stopOpacity="0.65" />
                </linearGradient>
              </defs>
              <rect x="0" y="0" width="1600" height="600" fill="#F5F5F7" />
              <polygon points="0,0 860,150 680,600 0,600" fill="url(#heroConcreteGrad)" />
              <polygon points="0,0 860,150 680,600 0,600" fill="url(#heroGrain)" />
              <g stroke="#8B95A5" strokeWidth="1.7" opacity="0.6" fill="none">
                <path d="M 700 0 Q 960 55 1600 5" />
                <path d="M 730 0 Q 1000 85 1600 40" />
                <path d="M 770 0 Q 1030 115 1600 75" />
                <path d="M 810 0 Q 1060 145 1600 110" />
                <path d="M 860 0 Q 1090 175 1600 145" />
                <path d="M 910 0 Q 1120 205 1600 180" />
                <path d="M 970 0 Q 1155 235 1600 220" />
                <path d="M 1040 0 Q 1195 265 1600 260" />
                <path d="M 1120 0 Q 1240 300 1600 300" />
                <path d="M 1210 0 Q 1290 335 1600 340" />
              </g>
              <polygon points="760,0 1600,0 1600,320" fill="#F5F5F7" opacity="0.55" />
              <polygon points="960,150 1600,280 1600,600 800,600" fill="url(#heroPerforated)" />
              <g opacity="0.8">
                <polygon points="380,600 1050,360 1600,500 1600,600" fill="url(#heroIsoGrid)" />
                <g stroke="var(--accent)" strokeWidth="1.8" fill="none" opacity="0.6">
                  <path d="M 1160 470 L 1220 446 L 1280 470 L 1220 494 Z" />
                  <path d="M 1160 470 L 1160 512 L 1220 536 L 1220 494" />
                  <path d="M 1280 470 L 1280 512 L 1220 536" />
                  <path d="M 1178 429 L 1220 412 L 1262 429 L 1220 446 Z" />
                  <path d="M 1178 429 L 1178 459 L 1220 476 L 1220 446" />
                  <path d="M 1262 429 L 1262 459 L 1220 476" />
                  <path d="M 1178 405 L 1268 358 L 1268 333 L 1178 380 Z" />
                  <path d="M 1220 412 L 1220 388" />
                </g>
              </g>
            </svg>
            <div style={styles.heroContent} className="sm-hero-grid">
            <div>
            <div style={styles.eyebrow}>COST VARIANCE, LIVE</div>
            <h1 style={{ ...styles.dashTitle, margin: "10px 0 14px" }}>
              Every Rand, accounted for <em style={styles.heroEm}>the moment it <span style={styles.heroItal}>moves</span>.</em>
            </h1>
            <p style={styles.heroSub}>
              Budget, payments, and progress in one sheet — updated on site, not reconciled at month-end.
            </p>

            <div style={styles.heroCtas}>
              <button
                type="button"
                className="sm-dcta"
                onClick={() => {
                  emailInputRef.current?.focus();
                  emailInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              >
                Start your first project
                <span className="sm-cap"><i><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A5F3FC" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></i></span>
              </button>
              <button
                type="button"
                style={styles.heroTextlink}
                onClick={() => { window.location.href = "https://sitemargin.co.za/whats-inside.html"; }}
              >
                See it in 90 seconds ›
              </button>
            </div>

            {/* Mirrors the hero-proof line on sitemargin.co.za's own homepage — kept as static
                text here (rather than wired to a live count) since this screen ships inside the
                app bundle and can't fetch a fresh number on load. Update alongside index.html's
                #customerCount data-count when that figure changes. */}
            <p style={styles.heroProof}>
              <span style={styles.heroProofCount}>23</span>
              <span>South African contractors already on site</span>
            </p>

            </div>

            <div style={styles.heroVisualWrap} className="sm-hero-visual">
              <div style={styles.heroDiamondWrapper}>
                <div style={styles.heroDiamondRing}>
                  <div style={styles.heroDiamond}>
                    <div style={styles.heroDiamondInner}>
                      <div style={styles.heroDiamondFigure}>R870,000</div>
                      <div style={styles.heroDiamondLabel}>Under budget</div>
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ ...styles.heroBadge, ...styles.heroBadgeTop }}>
                <span style={styles.heroBadgeDot} />
                Retention released
              </div>
              <div style={{ ...styles.heroBadge, ...styles.heroBadgeBottom }}>
                <span style={styles.heroBadgeDot} />
                PO approved
              </div>
            </div>
            </div>
          </div>
        )}

        <h1
          style={{ ...styles.dashTitle, marginBottom: 10 }}
          className={status === "signedout" ? "sm-auth-head" : undefined}
        >
          {status === "pending"
            ? "Almost there"
            : status === "denied"
            ? "Something went wrong"
            : isLoginIntent
            ? "Log in"
            : "Try it for free"}
        </h1>

        {status === "signedout" && (
          <>
            {sendState === "sent" ? (
              <div style={styles.gateNotice}>
                {authMode === "password"
                  ? <>Check your inbox at <b>{email}</b> to confirm your account, then come back and log in.</>
                  : <>Check your inbox at <b>{email}</b> for the sign-in link. You can close this tab.</>}
              </div>
            ) : forgotState === "sent" ? (
              <div style={styles.gateNotice}>
                Check your inbox at <b>{email}</b> for the password reset link.
              </div>
            ) : (
              <>
                <div className="sm-auth-card">
                <p style={{ ...styles.gateText, textAlign: "center" }}>
                  {authMode === "password"
                    ? isLoginIntent
                      ? "Enter your email and password to log in."
                      : "Pick an email and password for your new account."
                    : isLoginIntent
                    ? "Enter the email you signed up with and we'll send you a one-click link to log in — no password needed."
                    : "Enter your email and we'll send you a one-click sign-in link — no password needed."}
                </p>
                {selectedTier && !isLoginIntent && (
                  <div style={styles.tierNote}>
                    {selectedTier === "free"
                      ? "Starting on the Free plan."
                      : `Continuing with ${TIER_LABEL[selectedTier] || selectedTier} — you'll choose it again once you're signed in.`}
                  </div>
                )}
                {authMode === "magic" ? (
                  <form onSubmit={sendMagicLink} style={styles.gateForm}>
                    <input
                      ref={emailInputRef}
                      type="email"
                      required
                      placeholder="you@yourcompany.co.za"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    <button type="submit" className="sm-dcta sm-dcta-block" disabled={sendState === "sending"}>
                      {sendState === "sending" ? "Sending…" : "Send sign-in link"}
                      <span className="sm-cap"><i><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A5F3FC" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></i></span>
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handlePasswordAuth} style={styles.gateForm}>
                    <input
                      ref={emailInputRef}
                      type="email"
                      required
                      placeholder="you@yourcompany.co.za"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    <input
                      type="password"
                      required
                      minLength={8}
                      placeholder="Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete={isLoginIntent ? "current-password" : "new-password"}
                    />
                    {!isLoginIntent && (
                      <input
                        type="password"
                        required
                        minLength={8}
                        placeholder="Confirm password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                    )}
                    {isLoginIntent && (
                      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)", margin: "2px 2px 4px" }}>
                        <input
                          type="checkbox"
                          checked={rememberMe}
                          onChange={(e) => setRememberMe(e.target.checked)}
                          style={{ width: 15, height: 15 }}
                        />
                        Remember me on this device
                      </label>
                    )}
                    <button type="submit" className="sm-dcta sm-dcta-block" disabled={passwordState === "sending"}>
                      {passwordState === "sending"
                        ? isLoginIntent
                          ? "Logging in…"
                          : "Creating account…"
                        : isLoginIntent
                        ? "Log in"
                        : "Create account"}
                      <span className="sm-cap"><i><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A5F3FC" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></i></span>
                    </button>
                  </form>
                )}
                <p style={styles.gateSwitchText}>
                  <button
                    type="button"
                    style={styles.gateSwitchLinkBtn}
                    onClick={() => { setAuthMode((m) => (m === "magic" ? "password" : "magic")); setErrorMsg(""); }}
                  >
                    {authMode === "magic" ? "Use a password instead" : "Use a one-click email link instead"}
                  </button>
                  {authMode === "password" && isLoginIntent && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        style={styles.gateSwitchLinkBtn}
                        onClick={handleForgotPassword}
                        disabled={forgotState === "sending"}
                      >
                        {forgotState === "sending" ? "Sending reset link…" : "Forgot password?"}
                      </button>
                    </>
                  )}
                </p>
                <p style={styles.gateSwitchText}>
                  {isLoginIntent ? (
                    <>New here? <a href="https://sitemargin.co.za/pricing.html" style={styles.gateSwitchLink}>See pricing &amp; sign up</a></>
                  ) : (
                    <>Already have an account? <a href="?login=1" style={styles.gateSwitchLink}>Log in</a></>
                  )}
                </p>
                </div>
              </>
            )}
            {(sendState === "error" || passwordState === "error" || forgotState === "error") && (
              <div style={styles.gateError}>{errorMsg}</div>
            )}
            {!isLoginIntent && (
              <>
                <div style={styles.pricingHead}>Pricing</div>
                <div className="sm-plans">

                  <div className={"sm-plan sm-plan-free"} style={selectedTier === "free" ? styles.checkoutCardSelected : undefined}>
                    <span className="sm-badge">Start free</span>
                    <div className="sm-free-word">Free</div>
                    <div className="sm-micro">No card needed</div>
                    <div style={styles.checkoutDesc} className="sm-plan-desc">For trying it out on a single job. 1 active project, unlimited line items.</div>
                    <button type="button" className="sm-dcta sm-dcta-block" onClick={() => chooseTier("free")}>
                      Get started
                      <span className="sm-cap"><i><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A5F3FC" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></i></span>
                    </button>
                  </div>

                  <div className="sm-plan sm-plan-feat" style={selectedTier === "contractor" ? styles.checkoutCardSelected : undefined}>
                    <span className="sm-badge">Most popular</span>
                    <div className="sm-plan-head">
                      <div style={{ ...styles.checkoutTier, color: "rgba(255,255,255,0.55)" }}>Contractor</div>
                      <div style={{ ...styles.checkoutPrice, color: "#F2F6F9" }}>
                        R199<span style={{ ...styles.checkoutPriceUnit, color: "rgba(255,255,255,0.6)" }}>/month</span>
                      </div>
                      <div style={{ ...styles.checkoutDesc, color: "rgba(255,255,255,0.68)", marginBottom: 0 }}>Unlimited projects, change orders, payments &amp; retention, PDF export.</div>
                    </div>
                    <div className="sm-plan-body">
                      <button type="button" className="sm-dcta sm-dcta-block" onClick={() => chooseTier("contractor")}>
                        Get started
                        <span className="sm-cap"><i><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A5F3FC" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></i></span>
                      </button>
                    </div>
                  </div>

                  <div className="sm-plan" style={selectedTier === "firm" ? styles.checkoutCardSelected : undefined}>
                    <div style={styles.checkoutTier}>Company</div>
                    <div style={styles.checkoutPrice}>
                      R599<span style={styles.checkoutPriceUnit}>/month</span>
                    </div>
                    <div style={styles.checkoutDesc} className="sm-plan-desc">Everything in Contractor, plus unlimited attachments and priority support.</div>
                    <button type="button" className="sm-dcta sm-dcta-block" onClick={() => chooseTier("firm")}>
                      Get started
                      <span className="sm-cap"><i><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A5F3FC" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></i></span>
                    </button>
                  </div>

                  <div className="sm-plan" style={selectedTier === "homeowner" ? styles.checkoutCardSelected : undefined}>
                    <div style={styles.checkoutTier}>Home Owner</div>
                    <div style={styles.checkoutPrice}>
                      R899<span style={styles.checkoutPriceUnit}>/project</span>
                    </div>
                    <div style={styles.checkoutDesc} className="sm-plan-desc">Once-off, for managing your own build. Payments &amp; retention tracking, document register, PDF export.</div>
                    <button type="button" className="sm-dcta sm-dcta-block" onClick={() => chooseTier("homeowner")}>
                      Get started
                      <span className="sm-cap"><i><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A5F3FC" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></i></span>
                    </button>
                  </div>

                </div>
              </>
            )}
          </>
        )}

        {status === "pending" && (
          <>
            <p style={styles.gateText}>
              You're signed in as <b>{session?.user?.email}</b>. Your account hasn't been approved for free access,
              but you can subscribe directly below — payments go through PayFast, so Apple Pay, Google Pay, cards,
              and EFT are all supported.
            </p>
            {subscription?.status === "cancelled" && (
              <div style={{ ...styles.gateNotice, marginBottom: 16 }}>
                Your previous subscription was cancelled. Choose a plan below to reactivate.
              </div>
            )}
            <div style={styles.checkoutGrid}>
              <div style={{ ...styles.checkoutCard, ...(selectedTier === "contractor" ? styles.checkoutCardSelected : {}) }}>
                <div style={styles.checkoutTier}>Contractor</div>
                <div style={styles.checkoutPrice}>
                  R199<span style={styles.checkoutPriceUnit}>/month</span>
                </div>
                <div style={styles.checkoutDesc}>Unlimited projects, change orders, payments &amp; retention, PDF export.</div>
                <button style={styles.addBtn} onClick={() => startCheckout("contractor")} disabled={checkoutTier !== null}>
                  {checkoutTier === "contractor" ? "Redirecting…" : "Subscribe"}
                </button>
              </div>
              <div style={{ ...styles.checkoutCard, ...(selectedTier === "firm" ? styles.checkoutCardSelected : {}) }}>
                <div style={styles.checkoutTier}>Company</div>
                <div style={styles.checkoutPrice}>
                  R599<span style={styles.checkoutPriceUnit}>/month</span>
                </div>
                <div style={styles.checkoutDesc}>Everything in Contractor, plus unlimited attachments and priority support.</div>
                <button style={styles.addBtn} onClick={() => startCheckout("firm")} disabled={checkoutTier !== null}>
                  {checkoutTier === "firm" ? "Redirecting…" : "Subscribe"}
                </button>
              </div>
              <div style={{ ...styles.checkoutCard, ...(selectedTier === "homeowner" ? styles.checkoutCardSelected : {}) }}>
                <div style={styles.checkoutTier}>Home Owner</div>
                <div style={styles.checkoutPrice}>
                  R899<span style={styles.checkoutPriceUnit}>/project</span>
                </div>
                <div style={styles.checkoutDesc}>Once-off, for managing your own build. Payments &amp; retention tracking, document register, PDF export.</div>
                {/* Once-off charge, not a recurring plan — "Pay once" rather
                    than "Subscribe" so this doesn't read as a monthly cost. */}
                <button style={styles.addBtn} onClick={() => startCheckout("homeowner")} disabled={checkoutTier !== null}>
                  {checkoutTier === "homeowner" ? "Redirecting…" : "Pay once"}
                </button>
              </div>
            </div>
            {errorMsg && <div style={styles.gateError}>{errorMsg}</div>}
            <button style={{ ...styles.importBtn, marginTop: 20 }} onClick={signOut}>Sign out</button>
          </>
        )}

        {status === "denied" && (
          <>
            <p style={styles.gateText}>Couldn't verify your access right now. Please try again in a moment.</p>
            <button style={styles.importBtn} onClick={signOut}>Sign out and retry</button>
          </>
        )}
      </div>
      <AppFooter />
    </div>
  );
}

/* ============================== ERROR BOUNDARY ============================== */
/* Catches unexpected errors anywhere below it so a bug in one part of the app
   shows a recoverable message instead of a blank white screen. */

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("SiteMargin crashed:", error, info);
    try {
      supabase.from("error_logs").insert({
        message: error?.message || String(error),
        stack: error?.stack || info?.componentStack || null,
        page_url: window.location.href,
      }).then(() => {}, () => {}); // must be chained or the insert is never sent
    } catch (e) {
      // best-effort only — never let logging itself break the fallback UI
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={styles.page}>
          <GlobalStyles />
          <div style={styles.gateWrap}>
            <AppLogo />
            <a href="https://sitemargin.co.za" style={styles.eyebrowLink}>← sitemargin.co.za</a>
            <h1 style={{ ...styles.dashTitle, marginTop: 14, marginBottom: 10 }}>Something went wrong</h1>
            <p style={styles.gateText}>
              SiteMargin hit an unexpected error and couldn't continue. Your data hasn't been affected — try
              reloading. If this keeps happening, let us know what you were doing when it happened.
            </p>
            <button style={styles.addBtn} onClick={() => window.location.reload()}>Reload SiteMargin</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function SiteMargin() {
  return (
    <ErrorBoundary>
      <AuthGate />
    </ErrorBoundary>
  );
}

/* ============================== DASHBOARD ============================== */

const FREE_PROJECT_LIMIT = 1;

function Dashboard({ onOpen, onNavigate, userEmail, onSignOut, logoUrl, onLogoChange, displayName, onDisplayNameChange }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [isPaid, setIsPaid] = useState(true); // assume paid until we know otherwise, so the cap never flashes incorrectly

  // Company logo + account name — edited inline right here on the dashboard
  // (formerly a separate "App Tools" page) since this is the one place both
  // are actually shown.
  const [nameDraft, setNameDraft] = useState(displayName || "");
  const nameSaveTimer = useRef(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState(null);
  const [logoMenuOpen, setLogoMenuOpen] = useState(false);
  const logoInputRef = useRef(null);
  const logoMenuRef = useRef(null);

  useEffect(() => {
    if (!logoMenuOpen) return;
    function handleOutside(e) {
      if (logoMenuRef.current && !logoMenuRef.current.contains(e.target)) setLogoMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [logoMenuOpen]);

  useEffect(() => { setNameDraft(displayName || ""); }, [displayName]);

  function handleNameInput(e) {
    const value = e.target.value;
    setNameDraft(value);
    if (nameSaveTimer.current) clearTimeout(nameSaveTimer.current);
    nameSaveTimer.current = setTimeout(async () => {
      const trimmed = value.trim();
      const { error } = await supabase
        .from("company_settings")
        .upsert({ owner_email: userEmail, display_name: trimmed || null, updated_at: new Date().toISOString() });
      if (!error) onDisplayNameChange(trimmed || null);
    }, 600);
  }

  async function handleLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|svg\+xml|webp)$/.test(file.type)) {
      setLogoError("Please choose a PNG, JPG, SVG, or WEBP image.");
      return;
    }
    if (file.size > 1_500_000) {
      setLogoError("That image is a bit large — please use something under 1.5MB.");
      return;
    }
    setLogoError(null);
    setLogoUploading(true);
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const { error: upsertError } = await supabase
      .from("company_settings")
      .upsert({ owner_email: userEmail, logo_data_url: dataUrl, updated_at: new Date().toISOString() });
    setLogoUploading(false);
    if (upsertError) { setLogoError("Couldn't save the logo — please try again."); return; }
    onLogoChange(dataUrl);
  }

  async function removeLogo() {
    if (!window.confirm("Remove the company logo?")) return;
    await supabase.from("company_settings").upsert({ owner_email: userEmail, logo_data_url: null, updated_at: new Date().toISOString() });
    onLogoChange(null);
  }

  useEffect(() => {
    supabase
      .from("subscriptions")
      .select("status")
      .eq("email", userEmail)
      .maybeSingle()
      .then(({ data }) => setIsPaid(data?.status === "active"));
  }, [userEmail]);

  async function loadProjects() {
    setLoading(true);
    const { data: projs } = await supabase.from("projects_v2").select("*").order("created_at", { ascending: false });
    if (!projs) { setProjects([]); setLoading(false); return; }
    const withTotals = await Promise.all(
      projs.map(async (p) => {
        const [{ data: items }, { data: cos }] = await Promise.all([
          supabase.from("line_items").select("budget, actual, certified").eq("project_id", p.id),
          supabase.from("change_orders").select("amount, status").eq("project_id", p.id),
        ]);
        const budget = (items || []).reduce((s, i) => s + Number(i.budget || 0), 0);
        const actual = (items || []).reduce((s, i) => s + Number(i.actual || 0), 0);
        const certified = (items || []).reduce((s, i) => s + Number(i.certified || 0), 0);
        const approvedCoTotal = (cos || []).filter((c) => c.status === "approved").reduce((s, c) => s + Number(c.amount || 0), 0);
        const revisedBudget = budget + approvedCoTotal;
        const retentionHeld = certified * ((p.retention_pct ?? 5) / 100);
        return {
          ...p,
          budget,
          revisedBudget,
          actual,
          retentionHeld,
          variance: actual - revisedBudget,
          lineCount: (items || []).length,
        };
      })
    );
    setProjects(withTotals);
    setLoading(false);
  }

  useEffect(() => { loadProjects(); }, []);

  const atFreeLimit = !isPaid && projects.length >= FREE_PROJECT_LIMIT;

  async function createProject() {
    if (!newName.trim() || creating || atFreeLimit) return;
    setCreating(true);
    const { data, error } = await supabase
      .from("projects_v2")
      .insert({ name: newName.trim(), owner_email: userEmail })
      .select()
      .single();
    setCreating(false);
    if (!error && data) { setNewName(""); onOpen(data.id); }
  }

  async function deleteProject(id, name) {
    if (!window.confirm(`Delete "${name}"? This removes all its line items, change orders, and history permanently.`)) return;
    await supabase.from("projects_v2").delete().eq("id", id);
    loadProjects();
  }

  const portfolio = useMemo(() => {
    const budget = projects.reduce((s, p) => s + p.budget, 0);
    const revisedBudget = projects.reduce((s, p) => s + p.revisedBudget, 0);
    const actual = projects.reduce((s, p) => s + p.actual, 0);
    const retentionHeld = projects.reduce((s, p) => s + p.retentionHeld, 0);
    const lineCount = projects.reduce((s, p) => s + p.lineCount, 0);
    return {
      budget,
      revisedBudget,
      actual,
      retentionHeld,
      lineCount,
      variance: actual - revisedBudget,
      overCount: projects.filter((p) => p.variance > 0).length,
      watchCount: projects.filter((p) => p.variance <= 0 && p.revisedBudget > 0 && p.actual / p.revisedBudget > 0.85).length,
    };
  }, [projects]);

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <PageHeader
        current="dashboard"
        onNavigate={onNavigate}
        userEmail={userEmail}
        onSignOut={onSignOut}
        logoNode={
          <div ref={logoMenuRef} style={{ position: "relative" }}>
            {/* Deliberately not "no-print" — the button wrapping the logo still
                needs to render the logo image itself on printed/exported output;
                only the popover menu below is screen-only. */}
            <button
              type="button"
              onClick={() => setLogoMenuOpen((v) => !v)}
              disabled={logoUploading}
              title={logoUrl ? "Change or remove company logo" : "Add company logo"}
              style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: 4, borderRadius: 10, cursor: logoUploading ? "default" : "pointer" }}
            >
              {logoUrl ? (
                <img src={logoUrl} alt="Company logo" style={styles.companyLogoMark} />
              ) : (
                <span style={{ ...styles.logoTextBtn, fontSize: 13 }}>{logoUploading ? "Uploading…" : "+ Add logo"}</span>
              )}
            </button>
            {logoMenuOpen && (
              <div className="no-print" style={styles.logoMenuPopover}>
                <button type="button" className="sm-logo-menu-item" style={styles.logoMenuItem} onClick={() => { setLogoMenuOpen(false); logoInputRef.current?.click(); }} disabled={logoUploading}>
                  {logoUploading ? "Uploading…" : logoUrl ? "Change logo" : "Add logo"}
                </button>
                {logoUrl && (
                  <button type="button" className="sm-logo-menu-item" style={{ ...styles.logoMenuItem, color: "var(--danger)" }} onClick={() => { setLogoMenuOpen(false); removeLogo(); }}>
                    Remove logo
                  </button>
                )}
              </div>
            )}
            <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" style={{ display: "none" }} onChange={handleLogoFile} />
          </div>
        }
        titleNode={
          <input
            style={styles.dashTitleInput}
            value={nameDraft}
            placeholder={friendlyFirstName(userEmail)}
            onChange={handleNameInput}
            aria-label="Account / company name"
          />
        }
      />
      {logoError && <div className="no-print" style={{ ...styles.gateError, maxWidth: 1180, margin: "-10px auto 16px" }}>{logoError}</div>}

      {projects.length > 0 && (
        <div style={styles.summaryStrip}>
          <SummaryCard label="Original quote allocation" value={fmt(portfolio.budget)} />
          {portfolio.revisedBudget !== portfolio.budget && (
            <SummaryCard label="Revised allocation" value={fmt(portfolio.revisedBudget)} accent="var(--tm-warn)" />
          )}
          <SummaryCard label="Actual spend" value={fmt(portfolio.actual)} />
          <SummaryCard
            label="Net variance"
            value={`${portfolio.variance > 0 ? "+" : ""}${fmt(portfolio.variance)}`}
            accent={portfolio.variance > 0 ? "var(--tm-neg)" : portfolio.variance < 0 ? "var(--tm-pos)" : undefined}
            glow={portfolio.variance > 0 ? "neg" : portfolio.variance < 0 ? "pos" : undefined}
            sub={portfolio.variance > 0 ? `${portfolio.overCount} project${portfolio.overCount === 1 ? "" : "s"} over budget` : undefined}
          />
          <SummaryCard label="Retention held" value={fmt(portfolio.retentionHeld)} />
          <SummaryCard
            label="Projects flagged"
            value={`${portfolio.overCount} over · ${portfolio.watchCount} watch`}
            accent={portfolio.overCount ? "var(--tm-neg)" : portfolio.watchCount ? "var(--tm-warn)" : "var(--tm-pos)"}
          />
          <SummaryCard label="Total line items" value={String(portfolio.lineCount)} />
        </div>
      )}

      {atFreeLimit ? (
        <div className="no-print" style={styles.freeLimitBanner}>
          <span>You've used your Free plan's {FREE_PROJECT_LIMIT} project. Upgrade to Contractor or Company for unlimited projects.</span>
          <a
            href="https://sitemargin.co.za/pricing.html"
            {...(!Capacitor.isNativePlatform() && { target: "_blank", rel: "noopener noreferrer" })}
            style={styles.freeLimitLink}
            onClick={(e) => {
              if (Capacitor.isNativePlatform()) {
                e.preventDefault();
                openExternalLink("https://sitemargin.co.za/pricing.html");
              }
            }}
          >
            See plans ↗
          </a>
        </div>
      ) : (
        <div className="no-print" style={styles.newProjectRow}>
          <input
            style={{ ...styles.addInput, flex: 1 }}
            placeholder="New project name (e.g. Fernwood Residence)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createProject()}
          />
          <button style={styles.addBtn} onClick={createProject} disabled={creating}>
            {creating ? "Creating…" : "+ New project"}
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>Loading projects…</div>
      ) : projects.length === 0 ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>No projects yet — create your first one above.</div>
      ) : (
        <div style={styles.projectGrid}>
          {projects.map((p) => {
            const pct = p.budget ? (p.variance / p.budget) * 100 : 0;
            const color = p.variance > 0 ? "var(--tm-neg)" : p.variance < 0 ? "var(--tm-pos)" : "var(--neutral-mark, var(--text-secondary))";
            const spentPct = p.budget ? Math.min((p.actual / p.budget) * 100, 100) : 0;
            return (
              <div key={p.id} style={styles.projectCard} onClick={() => onOpen(p.id)}>
                <div style={styles.projectCardTop}>
                  <div style={styles.projectName}>{p.name}</div>
                  <button style={styles.deleteProjectBtn} className="no-print" onClick={(e) => { e.stopPropagation(); deleteProject(p.id, p.name); }}>✕</button>
                </div>
                <div style={{ height: 5, background: "var(--bg-secondary)", borderRadius: 3, marginBottom: 10 }}>
                  <div style={{ width: `${spentPct}%`, height: "100%", background: color, borderRadius: 3 }} />
                </div>
                <div style={styles.projectNums}>
                  <span>{fmt(p.budget)} budget</span>
                  <span style={{ color, fontWeight: 600 }}>
                    {p.variance > 0 ? "+" : ""}{fmt(p.variance)} ({p.variance > 0 ? "+" : ""}{pct.toFixed(1)}%)
                  </span>
                </div>
                <div style={styles.projectMeta}>{p.lineCount} line items</div>
              </div>
            );
          })}
        </div>
      )}
      <AppFooter />
    </div>
  );
}

/* ============================== SUBCONTRACTORS ============================== */

function SubcontractorsView({ onNavigate, userEmail, onSignOut, logoUrl }) {
  const [subs, setSubs] = useState([]);
  const [itemsBySub, setItemsBySub] = useState({});
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newTrade, setNewTrade] = useState("");
  const [newContact, setNewContact] = useState("");
  const [expanded, setExpanded] = useState(null);
  // "all" or one exact sub.trade value — also drives the compare table below.
  const [tradeFilter, setTradeFilter] = useState("all");
  const fieldSaveTimers = useRef({});

  async function loadAll() {
    setLoading(true);
    const { data: subsData } = await supabase.from("subcontractors").select("*").order("name");
    // projects_v2(name) is a PostgREST embed over the line_items -> projects_v2
    // foreign key — pulled in here so the per-project breakdown below can
    // group and label each sub's items by project without a second round trip.
    const { data: items } = await supabase
      .from("line_items")
      .select("*, projects_v2(name)")
      .not("subcontractor_id", "is", null);
    const grouped = {};
    (items || []).forEach((i) => {
      if (!grouped[i.subcontractor_id]) grouped[i.subcontractor_id] = [];
      grouped[i.subcontractor_id].push(i);
    });
    setSubs(subsData || []);
    setItemsBySub(grouped);
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  async function addSub() {
    if (!newName.trim()) return;
    const { data, error } = await supabase
      .from("subcontractors")
      .insert({ name: newName.trim(), trade: newTrade.trim(), contact: newContact.trim(), owner_email: userEmail })
      .select().single();
    if (!error && data) {
      setSubs((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName(""); setNewTrade(""); setNewContact("");
    }
  }

  async function removeSub(id, name) {
    if (!window.confirm(`Remove "${name}"? Their line items stay, but lose the link to this scorecard.`)) return;
    await supabase.from("subcontractors").delete().eq("id", id);
    setSubs((prev) => prev.filter((s) => s.id !== id));
  }

  // Flag changes are infrequent and low-risk to fire immediately; notes are
  // typed character-by-character so those get the same debounce pattern
  // ProjectView uses for the project-name input.
  function setFlag(id, flag) {
    setSubs((prev) => prev.map((s) => (s.id === id ? { ...s, flag } : s)));
    supabase.from("subcontractors").update({ flag }).eq("id", id).then(({ error }) => { if (error) console.error("Save failed", error); });
  }

  function setNotes(id, notes) {
    setSubs((prev) => prev.map((s) => (s.id === id ? { ...s, notes } : s)));
    if (fieldSaveTimers.current[id]) clearTimeout(fieldSaveTimers.current[id]);
    fieldSaveTimers.current[id] = setTimeout(() => {
      supabase.from("subcontractors").update({ notes }).eq("id", id).then(({ error }) => { if (error) console.error("Save failed", error); });
    }, 600);
  }

  const trades = useMemo(
    () => Array.from(new Set(subs.map((s) => s.trade).filter((t) => t && t.trim()))).sort(),
    [subs]
  );

  const ranked = useMemo(() => {
    const filtered = tradeFilter === "all" ? subs : subs.filter((s) => s.trade === tradeFilter);
    return filtered
      .map((s) => ({ sub: s, score: scoreSubcontractor(itemsBySub[s.id] || []) }))
      .sort((a, b) => (b.score.overall ?? -1) - (a.score.overall ?? -1));
  }, [subs, itemsBySub, tradeFilter]);

  // Splits one sub's flat line-item list into per-project buckets (each
  // re-scored on its own subset) so you can tell a sub that's great on small
  // jobs but struggles on big ones apart from their blended overall number.
  function projectGroups(items) {
    const groups = {};
    items.forEach((i) => {
      const pid = i.project_id || "unknown";
      if (!groups[pid]) groups[pid] = { projectId: pid, projectName: i.projects_v2?.name || "Unknown project", items: [] };
      groups[pid].items.push(i);
    });
    return Object.values(groups).sort((a, b) => a.projectName.localeCompare(b.projectName));
  }

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <PageHeader title="Subcontractor scorecards" current="subcontractors" onNavigate={onNavigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={logoUrl} />

      <div style={styles.explainer}>
        There's no rating button here — scores build up automatically from the line items you assign to each sub
        inside a project. Open a project, click a line item, then under <b>Details</b> pick the subcontractor from
        the dropdown. That same panel has <b>Due date</b> and <b>Completed date</b> fields (these drive the
        <b> schedule</b> score) and a <b>Quality (1–5)</b> rating (drives the <b>quality</b> score) — set them there
        and they'll roll up to the sub's card here. <b>Budget</b> comes from how close actuals land to budget on
        their assigned items, no extra step needed. Dimensions with no data yet show a dash rather than a
        misleading zero. The flag and notes below are yours to set manually — they never affect the computed
        scores, they're just a place to keep the context the numbers don't capture (or can't yet).
      </div>

      <div className="no-print" style={styles.addRowStandalone}>
        <input style={{ ...styles.addInput, flex: 1.6 }} placeholder="Subcontractor name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input style={{ ...styles.addInput, flex: 1.2 }} placeholder="Trade (e.g. Electrical)" value={newTrade} onChange={(e) => setNewTrade(e.target.value)} />
        <input style={{ ...styles.addInput, flex: 1.2 }} placeholder="Contact (optional)" value={newContact} onChange={(e) => setNewContact(e.target.value)} />
        <button style={styles.addBtn} onClick={addSub}>+ Add subcontractor</button>
      </div>

      {trades.length > 0 && (
        <div className="no-print" style={{ maxWidth: 1180, margin: "0 auto 16px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", marginRight: 2 }}>Trade</span>
          <button style={{ ...styles.toggleBtn, ...(tradeFilter === "all" ? styles.toggleBtnActive : {}) }} onClick={() => setTradeFilter("all")}>
            All ({subs.length})
          </button>
          {trades.map((t) => (
            <button
              key={t}
              style={{ ...styles.toggleBtn, ...(tradeFilter === t ? styles.toggleBtnActive : {}) }}
              onClick={() => setTradeFilter(t)}
            >
              {t} ({subs.filter((s) => s.trade === t).length})
            </button>
          ))}
        </div>
      )}

      {tradeFilter !== "all" && ranked.length > 1 && (
        <div className="no-print" style={{ ...styles.integrationsCard, maxWidth: 1180, margin: "0 auto 16px", overflowX: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 10 }}>
            Comparing {tradeFilter} ({ranked.length})
          </div>
          <div style={{ minWidth: 480 }}>
            <div style={{ display: "flex", padding: "6px 0", borderBottom: "1px solid var(--border-color)", fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase" }}>
              <span style={{ flex: 2 }}>Name</span>
              <span style={{ flex: 1, textAlign: "right" }}>Overall</span>
              <span style={{ flex: 1, textAlign: "right" }}>Budget</span>
              <span style={{ flex: 1, textAlign: "right" }}>Schedule</span>
              <span style={{ flex: 1, textAlign: "right" }}>Quality</span>
            </div>
            {ranked.map(({ sub, score }) => (
              <div key={sub.id} style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border-color)", fontSize: 13 }}>
                <span style={{ flex: 2, display: "flex", alignItems: "center", gap: 6 }}>
                  {sub.flag && sub.flag !== "none" && (
                    <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: sub.flag === "red" ? "var(--danger)" : "var(--warning)" }} />
                  )}
                  {sub.name}
                </span>
                <span style={{ flex: 1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: scoreColor(score.overall) }}>{score.overall == null ? "—" : Math.round(score.overall)}</span>
                <span style={{ flex: 1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: scoreColor(score.budgetScore) }}>{score.budgetScore == null ? "—" : Math.round(score.budgetScore)}</span>
                <span style={{ flex: 1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: scoreColor(score.scheduleScore) }}>{score.scheduleScore == null ? "—" : Math.round(score.scheduleScore)}</span>
                <span style={{ flex: 1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: scoreColor(score.qualityScore) }}>{score.qualityScore == null ? "—" : Math.round(score.qualityScore)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>Loading…</div>
      ) : ranked.length === 0 ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>
          {tradeFilter === "all"
            ? "No subcontractors yet. Add one above, then assign line items to them inside a project."
            : `No subcontractors tagged "${tradeFilter}".`}
        </div>
      ) : (
        <div style={styles.projectGrid}>
          {ranked.map(({ sub, score }) => {
            const isOpen = expanded === sub.id;
            const groups = isOpen ? projectGroups(itemsBySub[sub.id] || []) : [];
            return (
              <div key={sub.id} style={styles.scoreCard}>
                <div style={styles.projectCardTop}>
                  <div>
                    <div style={styles.projectName}>{sub.name}</div>
                    {sub.trade && <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>{sub.trade}</div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: "var(--text-secondary)", letterSpacing: "0.08em" }}>OVERALL</div>
                      <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 22, fontWeight: 600, color: scoreColor(score.overall) }}>
                        {score.overall == null ? "—" : Math.round(score.overall)}
                      </div>
                      {score.overall != null && (
                        <div style={{ fontSize: 9.5, color: "var(--text-secondary)", marginTop: 1 }}>
                          {score.confidence === "high" ? "well evidenced"
                            : score.confidence === "medium" ? "limited evidence"
                            : "thin evidence"}
                        </div>
                      )}
                    </div>
                    <button style={styles.deleteProjectBtn} className="no-print" onClick={() => removeSub(sub.id, sub.name)}>✕</button>
                  </div>
                </div>

                <div className="no-print" style={{ margin: "2px 0 12px" }}>
                  <select
                    value={sub.flag || "none"}
                    onChange={(e) => setFlag(sub.id, e.target.value)}
                    style={{
                      fontSize: 12, fontWeight: 600, border: "1px solid transparent", borderRadius: 100, padding: "4px 10px", cursor: "pointer",
                      color: sub.flag === "red" ? "var(--danger)" : sub.flag === "amber" ? "var(--warning)" : "#6E6E73",
                      background: sub.flag === "red" ? "rgba(193,70,43,0.09)" : sub.flag === "amber" ? "rgba(184,134,47,0.09)" : "#F5F5F7",
                    }}
                  >
                    <option value="none">No flag</option>
                    <option value="amber">⚠ Amber — watch</option>
                    <option value="red">⛔ Red — don't rehire</option>
                  </select>
                </div>
                {sub.flag && sub.flag !== "none" && (
                  <div className="print-only-status" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 8, color: sub.flag === "red" ? "var(--danger)" : "var(--warning)" }}>
                    {sub.flag === "red" ? "⛔ Red flag — don't rehire" : "⚠ Amber flag — watch"}
                  </div>
                )}

                {score.itemCount > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "11px 13px", marginBottom: 14, background: "var(--tm-glass)", border: "1px solid var(--tm-brd)", borderRadius: 10 }}>
                    <SubMetric
                      label="Exposure"
                      value={fmt(score.totalBudget)}
                      sub={`${score.itemCount} item${score.itemCount === 1 ? "" : "s"} · ${score.projectCount} project${score.projectCount === 1 ? "" : "s"}`}
                    />
                    <SubMetric
                      label="Over budget"
                      value={score.overrunRand > 0 ? `+${fmt(score.overrunRand)}` : "None"}
                      tone={score.overrunRand > 0 ? "var(--tm-neg)" : "var(--tm-pos)"}
                      sub={score.overrunRand > 0 ? "across assigned items" : "actuals within budget"}
                    />
                    <SubMetric
                      label="Overdue now"
                      value={score.overdueCount > 0 ? String(score.overdueCount) : "None"}
                      tone={score.overdueCount > 0 ? "var(--tm-neg)" : "var(--tm-pos)"}
                      sub={score.overdueCount > 0 ? `${fmt(score.overdueValue)} held up` : "nothing past due"}
                    />
                    {score.trend != null && (
                      <SubMetric
                        label="Trend"
                        value={`${score.trend >= 0 ? "▲" : "▼"} ${Math.abs(score.trend).toFixed(1)}pt`}
                        tone={score.trend >= 0 ? "var(--tm-pos)" : "var(--tm-neg)"}
                        sub={score.trend >= 0 ? "improving on budget" : "worsening on budget"}
                      />
                    )}
                  </div>
                )}

                <ScoreBar
                  label="Budget accuracy"
                  score={score.budgetScore}
                  detail={score.itemCount ? `${fmt(score.totalActual)} spent against ${fmt(score.totalBudget)}` : "No line items assigned yet"}
                />
                <ScoreBar
                  label="Schedule"
                  score={score.scheduleScore}
                  detail={
                    score.scheduledCount
                      ? score.avgDaysLate > 0
                        ? `${score.avgDaysLate.toFixed(1)} days late on average (${score.scheduledCount} completed)`
                        : `${Math.abs(score.avgDaysLate).toFixed(1)} days early on average (${score.scheduledCount} completed)`
                      : "Set due and completed dates to score this"
                  }
                />
                <ScoreBar
                  label="Quality"
                  score={score.qualityScore}
                  detail={score.ratedCount ? `${score.avgQuality.toFixed(1)} / 5 across ${score.ratedCount} rated item${score.ratedCount > 1 ? "s" : ""}` : "Rate line items 1–5 to score this"}
                />

                <div className="no-print" style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Notes</div>
                  <textarea
                    value={sub.notes || ""}
                    onChange={(e) => setNotes(sub.id, e.target.value)}
                    placeholder="e.g. reliable on small jobs, slow to respond to calls…"
                    style={{ width: "100%", minHeight: 48, fontSize: 12.5, fontFamily: "inherit", border: "1px solid var(--border-color)", borderRadius: 8, padding: 8, resize: "vertical" }}
                  />
                </div>
                {sub.notes && sub.notes.trim() && (
                  <p className="print-only-status" style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>Notes: {sub.notes}</p>
                )}

                <button style={styles.miniLinkBlock} className="no-print" onClick={() => setExpanded(isOpen ? null : sub.id)}>
                  {isOpen ? "Hide project breakdown" : `View ${score.itemCount} line item${score.itemCount === 1 ? "" : "s"}`}
                </button>

                {isOpen && (
                  <div style={{ marginTop: 10, borderTop: "1px solid var(--border-color)", paddingTop: 10 }}>
                    {groups.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        No line items assigned to this sub yet. Open a project, click a line item, then under
                        Details pick "{sub.name}" as the subcontractor to start scoring them.
                      </div>
                    ) : (
                      groups.map((g) => {
                        const gScore = scoreSubcontractor(g.items);
                        return (
                          <div key={g.projectId} style={{ marginBottom: 14 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{g.projectName}</span>
                              <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 12, color: scoreColor(gScore.overall) }}>
                                {gScore.overall == null ? "—" : Math.round(gScore.overall)}
                              </span>
                            </div>
                            {g.items.map((i) => {
                              const late = daysBetween(i.due_date, i.completed_date);
                              return (
                                <div key={i.id} style={styles.subItemRow}>
                                  <span style={{ fontSize: 12.5, flex: 2 }}>{i.name}</span>
                                  <span style={{ fontSize: 11.5, fontFamily: "'Space Grotesk', sans-serif", color: Number(i.actual) > Number(i.budget) ? "var(--danger)" : "var(--success)", flex: 1, textAlign: "right" }}>
                                    {fmtShort(i.actual)} / {fmtShort(i.budget)}
                                  </span>
                                  <span style={{ fontSize: 11, color: "var(--text-secondary)", flex: 0.8, textAlign: "right" }}>
                                    {late == null ? "—" : late > 0 ? `${late}d late` : `${Math.abs(late)}d early`}
                                  </span>
                                  <span style={{ fontSize: 11, color: "var(--warning)", flex: 0.5, textAlign: "right" }}>
                                    {i.quality_rating ? `${i.quality_rating}/5` : "—"}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <AppFooter />
    </div>
  );
}

/* ============================== TEMPLATES ============================== */

function TemplatesView({ onNavigate, userEmail, onSignOut, logoUrl }) {
  const [templates, setTemplates] = useState([]);
  const [itemsByTemplate, setItemsByTemplate] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newTags, setNewTags] = useState("");
  const [addingTo, setAddingTo] = useState(null);
  const [itemName, setItemName] = useState("");
  const [itemCategory, setItemCategory] = useState(CATEGORIES[0]);
  const [itemBudget, setItemBudget] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  // The two instruction blocks are worth keeping but not worth the fold —
  // they were pushing the actual templates below the first screen.
  const [helpOpen, setHelpOpen] = useState(false);
  const [tagDrafts, setTagDrafts] = useState({}); // { [templateId]: string being typed }
  const [importMessage, setImportMessage] = useState(null);
  const importFileRef = useRef(null);
  const importTargetRef = useRef(null);

  async function loadAll() {
    setLoading(true);
    const { data: temps } = await supabase.from("templates").select("*").order("created_at", { ascending: false });
    const { data: tItems } = await supabase.from("template_items").select("*").order("sort_order");
    const grouped = {};
    (tItems || []).forEach((i) => {
      if (!grouped[i.template_id]) grouped[i.template_id] = [];
      grouped[i.template_id].push(i);
    });
    setTemplates(temps || []);
    setItemsByTemplate(grouped);
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  function flashMessage(type, text) {
    setImportMessage({ type, text });
    setTimeout(() => setImportMessage(null), 6000);
  }

  async function createTemplate() {
    if (!newName.trim()) return;
    const tags = newTags.split(",").map((t) => t.trim()).filter(Boolean);
    const { data, error } = await supabase
      .from("templates").insert({ name: newName.trim(), description: newDesc.trim(), owner_email: userEmail, tags }).select().single();
    if (!error && data) {
      setTemplates((prev) => [data, ...prev]);
      setNewName(""); setNewDesc(""); setNewTags("");
      setExpanded(data.id);
    }
  }

  async function deleteTemplate(id, name) {
    if (!window.confirm(`Delete template "${name}"? Projects already created from it are unaffected.`)) return;
    await supabase.from("templates").delete().eq("id", id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }

  async function addTemplateItem(templateId) {
    if (!itemName.trim()) return;
    const existing = itemsByTemplate[templateId] || [];
    const { data, error } = await supabase
      .from("template_items")
      .insert({
        template_id: templateId,
        name: itemName.trim(),
        category: itemCategory,
        budget: itemBudget ? Number(itemBudget) : 0,
        sort_order: existing.length,
      })
      .select().single();
    if (!error && data) {
      setItemsByTemplate((prev) => ({ ...prev, [templateId]: [...(prev[templateId] || []), data] }));
      setItemName(""); setItemBudget("");
    }
  }

  async function removeTemplateItem(templateId, itemId) {
    if (!window.confirm("Remove this item from the template?")) return;
    setItemsByTemplate((prev) => ({ ...prev, [templateId]: (prev[templateId] || []).filter((i) => i.id !== itemId) }));
    await supabase.from("template_items").delete().eq("id", itemId);
  }

  // Swaps this item's sort_order with its neighbour above/below — simple
  // up/down reordering rather than drag-and-drop, since it needs no new
  // dependency and works identically on touch.
  async function moveTemplateItem(templateId, itemId, direction) {
    const items = [...(itemsByTemplate[templateId] || [])].sort((a, b) => a.sort_order - b.sort_order);
    const idx = items.findIndex((i) => i.id === itemId);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || swapIdx < 0 || swapIdx >= items.length) return;
    const a = items[idx], b = items[swapIdx];
    const aOrder = a.sort_order, bOrder = b.sort_order;
    const reordered = [...items];
    reordered[idx] = { ...a, sort_order: bOrder };
    reordered[swapIdx] = { ...b, sort_order: aOrder };
    setItemsByTemplate((prev) => ({ ...prev, [templateId]: reordered }));
    await Promise.all([
      supabase.from("template_items").update({ sort_order: bOrder }).eq("id", a.id),
      supabase.from("template_items").update({ sort_order: aOrder }).eq("id", b.id),
    ]);
  }

  function addTag(templateId, rawTag) {
    const tag = rawTag.trim();
    if (!tag) return;
    setTemplates((prev) => prev.map((t) => {
      if (t.id !== templateId) return t;
      if ((t.tags || []).includes(tag)) return t;
      const tags = [...(t.tags || []), tag];
      supabase.from("templates").update({ tags }).eq("id", templateId).then(({ error }) => { if (error) console.error("Save failed", error); });
      return { ...t, tags };
    }));
    setTagDrafts((prev) => ({ ...prev, [templateId]: "" }));
  }

  function removeTag(templateId, tag) {
    setTemplates((prev) => prev.map((t) => {
      if (t.id !== templateId) return t;
      const tags = (t.tags || []).filter((x) => x !== tag);
      supabase.from("templates").update({ tags }).eq("id", templateId).then(({ error }) => { if (error) console.error("Save failed", error); });
      return { ...t, tags };
    }));
  }

  function triggerImport(templateId) {
    importTargetRef.current = templateId;
    importFileRef.current?.click();
  }

  function handleImportFile(e) {
    const file = e.target.files?.[0];
    const templateId = importTargetRef.current;
    e.target.value = "";
    if (!file || !templateId) return;
    const isExcel = /\.xlsx$/i.test(file.name);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const { items: parsed, error } = isExcel
          ? rowsToItems(await xlsxBufferToRows(evt.target.result))
          : parseCsvToItems(evt.target.result);
        if (error) { flashMessage("error", error); return; }
        if (!window.confirm(`Import ${parsed.length} item${parsed.length === 1 ? "" : "s"} into this template?`)) return;

        const existing = itemsByTemplate[templateId] || [];
        const rows = parsed.map((p, idx) => ({
          template_id: templateId,
          name: p.name,
          category: p.category,
          budget: p.budget || 0,
          sort_order: existing.length + idx,
        }));
        const { data, error: insErr } = await supabase.from("template_items").insert(rows).select();
        if (insErr || !data) {
          flashMessage("error", "Import failed — please try again.");
        } else {
          setItemsByTemplate((prev) => ({ ...prev, [templateId]: [...(prev[templateId] || []), ...data] }));
          flashMessage("success", `Imported ${data.length} item${data.length > 1 ? "s" : ""}.`);
        }
      } catch (err) {
        console.error("Template import failed", err);
        flashMessage("error", "Couldn't read that file — make sure it's a valid CSV or .xlsx.");
      }
    };
    if (isExcel) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  }

  const allTags = useMemo(
    () => Array.from(new Set(templates.flatMap((t) => t.tags || []))).sort(),
    [templates]
  );
  const visibleTemplates = tagFilter === "all" ? templates : templates.filter((t) => (t.tags || []).includes(tagFilter));

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <PageHeader title="Templates" current="templates" onNavigate={onNavigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={logoUrl} />

      <div className="no-print" style={{ maxWidth: 1180, margin: "0 auto 14px" }}>
        <LitButton
          onClick={() => setHelpOpen((v) => !v)}
          style={{ ...styles.importBtn, fontSize: 12.5, padding: "7px 15px" }}
          litStyle={{
            borderColor: "var(--accent)",
            background: "var(--bg-secondary)",
            boxShadow: "0 0 0 3px var(--accent-glow), 0 8px 20px -12px var(--accent-glow)",
            transform: "translateY(-1px)",
          }}
          aria-expanded={helpOpen}
        >
          {helpOpen ? "Hide guidance" : "How templates work"}
        </LitButton>
      </div>

      {helpOpen && (<>
      <div style={styles.explainer}>
        Build a standard line-item set once — a typical residential build, a shopfit, whatever you repeat — then apply it
        to any new project in one click instead of retyping it. You can also save an existing project's line items
        straight back out as a new template from inside that project. Tag templates by project type to filter the list
        below, reorder items with the arrows once a template is open, or import a CSV/.xlsx straight into one instead
        of adding items by hand.
        <div style={{ marginTop: 10 }}>
          Need a starting point? <ExplainerRefLink href="https://jbcc.co.za/free-forms/">JBCC's free standard forms ↗</ExplainerRefLink>
          {" · "}<ExplainerRefLink href="https://www.cidb.org.za/about-us/our-construction-mandate/">CIDB registration ↗</ExplainerRefLink>
          {" · "}<ExplainerRefLink href="https://www.sans10400.co.za/nhbrc-2/">NHBRC ↗</ExplainerRefLink>
          {" · "}<ExplainerRefLink href="https://www.sans10400.co.za/">SANS 10400 ↗</ExplainerRefLink>
        </div>
      </div>

      <div style={styles.integrationsBanner}>
        Used from inside a project: open its <b>Cost & Progress</b> tab → <b>Apply a template…</b> drops these
        items straight into the ledger. Or click <b>Save as template</b> there to turn that project into a new one.
      </div>
      </>)}

      <input ref={importFileRef} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleImportFile} style={{ display: "none" }} />

      {importMessage && (
        <div style={{ ...styles.integrationsBanner, ...(importMessage.type === "error" ? styles.integrationsBannerError : {}) }}>
          {importMessage.text}
        </div>
      )}

      <div className="no-print" style={styles.addRowStandalone}>
        <input style={{ ...styles.addInput, flex: 1.4 }} placeholder="Template name (e.g. Standard residential build)" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input style={{ ...styles.addInput, flex: 1.4 }} placeholder="Description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
        <input style={{ ...styles.addInput, flex: 1 }} placeholder="Tags (comma separated)" value={newTags} onChange={(e) => setNewTags(e.target.value)} />
        <button style={styles.addBtn} onClick={createTemplate}>+ New template</button>
      </div>

      {allTags.length > 0 && (
        <div className="no-print" style={{ maxWidth: 1180, margin: "0 auto 16px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", marginRight: 2 }}>Tag</span>
          <button style={{ ...styles.toggleBtn, ...(tagFilter === "all" ? styles.toggleBtnActive : {}) }} onClick={() => setTagFilter("all")}>
            All ({templates.length})
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              style={{ ...styles.toggleBtn, ...(tagFilter === tag ? styles.toggleBtnActive : {}) }}
              onClick={() => setTagFilter(tag)}
            >
              {tag} ({templates.filter((t) => (t.tags || []).includes(tag)).length})
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>Loading…</div>
      ) : visibleTemplates.length === 0 ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>
          {templates.length === 0
            ? "No templates yet. Create one above, or save one from an existing project."
            : `No templates tagged "${tagFilter}".`}
        </div>
      ) : (
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          {visibleTemplates.map((t) => {
            const tItems = [...(itemsByTemplate[t.id] || [])].sort((a, b) => a.sort_order - b.sort_order);
            const total = tItems.reduce((s, i) => s + Number(i.budget || 0), 0);
            const isOpen = expanded === t.id;
            return (
              <div key={t.id} style={styles.templateCard}>
                <div style={styles.projectCardTop}>
                  <div>
                    <div style={styles.projectName}>{t.name}</div>
                    {t.description && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3 }}>{t.description}</div>}
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 6, fontFamily: "'Space Grotesk', sans-serif" }}>
                      {tItems.length} line item{tItems.length === 1 ? "" : "s"} · {fmt(total)}
                    </div>
                    <TemplateComposition items={tItems} />
                    {(t.tags || []).length > 0 && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                        {t.tags.map((tag) => (
                          <span key={tag} style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", background: "rgba(29,92,138,0.08)", borderRadius: 100, padding: "2px 9px" }}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }} className="no-print">
                    <button style={styles.miniLink} onClick={() => setExpanded(isOpen ? null : t.id)}>
                      {isOpen ? "Collapse" : "Edit items"}
                    </button>
                    <button style={styles.deleteProjectBtn} onClick={() => deleteTemplate(t.id, t.name)}>✕</button>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 12, borderTop: "1px solid var(--border-color)", paddingTop: 12 }}>
                    <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
                      {(t.tags || []).map((tag) => (
                        <span key={tag} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "var(--accent)", background: "rgba(29,92,138,0.08)", borderRadius: 100, padding: "2px 6px 2px 9px" }}>
                          {tag}
                          <button style={{ ...styles.removeBtn, fontSize: 11, padding: 0, color: "var(--accent)" }} onClick={() => removeTag(t.id, tag)}>✕</button>
                        </span>
                      ))}
                      <input
                        style={{ ...styles.addInput, width: 140, padding: "4px 10px", fontSize: 12 }}
                        placeholder="+ tag"
                        value={tagDrafts[t.id] || ""}
                        onChange={(e) => setTagDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === "Enter") addTag(t.id, tagDrafts[t.id] || ""); }}
                        onBlur={() => { if (tagDrafts[t.id]) addTag(t.id, tagDrafts[t.id]); }}
                      />
                    </div>

                    {tItems.map((i, idx) => (
                      <div key={i.id} style={styles.subItemRow}>
                        <span className="no-print" style={{ display: "flex", flexDirection: "column", flex: "0 0 auto", marginRight: 4 }}>
                          <button style={{ ...styles.removeBtn, fontSize: 10, lineHeight: 1, padding: 0, opacity: idx === 0 ? 0.3 : 1 }} disabled={idx === 0} onClick={() => moveTemplateItem(t.id, i.id, "up")}>▲</button>
                          <button style={{ ...styles.removeBtn, fontSize: 10, lineHeight: 1, padding: 0, opacity: idx === tItems.length - 1 ? 0.3 : 1 }} disabled={idx === tItems.length - 1} onClick={() => moveTemplateItem(t.id, i.id, "down")}>▼</button>
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 2 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: CATEGORY_COLOR[i.category] || "#6E6E73" }} />
                          <span style={{ fontSize: 12.5 }}>{i.name}</span>
                        </span>
                        <span style={{ fontSize: 11.5, color: "var(--text-secondary)", flex: 0.8 }}>{i.category}</span>
                        <span style={{ fontSize: 12, fontFamily: "'Space Grotesk', sans-serif", flex: 0.8, textAlign: "right" }}>{fmt(i.budget)}</span>
                        <button style={{ ...styles.removeBtn, flex: 0.2, textAlign: "right" }} className="no-print" onClick={() => removeTemplateItem(t.id, i.id)}>✕</button>
                      </div>
                    ))}
                    <div className="no-print" style={{ ...styles.addRow, marginTop: 10, borderRadius: 4, flexWrap: "wrap" }}>
                      <input style={{ ...styles.addInput, flex: 2 }} placeholder="Line item name" value={addingTo === t.id ? itemName : ""} onChange={(e) => { setAddingTo(t.id); setItemName(e.target.value); }} />
                      <select style={{ ...styles.addInput, flex: 1 }} value={addingTo === t.id ? itemCategory : CATEGORIES[0]} onChange={(e) => { setAddingTo(t.id); setItemCategory(e.target.value); }}>
                        {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input style={{ ...styles.addInput, flex: 0.9, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }} placeholder="Budget (optional)" type="number" value={addingTo === t.id ? itemBudget : ""} onChange={(e) => { setAddingTo(t.id); setItemBudget(e.target.value); }} />
                      <button style={styles.addBtn} onClick={() => addTemplateItem(t.id)}>+ Add</button>
                      <button style={{ ...styles.addBtn, background: "#6E6E73" }} onClick={() => triggerImport(t.id)}>Import CSV / .xlsx</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <AppFooter />
    </div>
  );
}

/* ============================== ACCOUNTING SYNC (Xero / Sage) ============================== */

const ACCOUNTING_PROVIDERS = [
  { key: "xero", label: "Xero", color: "#13B5EA" },
  { key: "sage", label: "Sage", color: "#00DC00" },
];

function IntegrationsView({ onNavigate, userEmail, onSignOut, logoUrl }) {
  const [connections, setConnections] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [lineItemOptions, setLineItemOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(null);
  const [syncing, setSyncing] = useState(null);
  const [banner, setBanner] = useState(null);
  // Sage (South Africa) has no OAuth redirect — the user types their own
  // Sage username/password into a form right here, which calls
  // accounting-sage-za-connect. A Sage login with more than one company
  // returns a list to choose from instead of connecting immediately.
  const [sageForm, setSageForm] = useState({ username: "", password: "" });
  const [sageCompanies, setSageCompanies] = useState(null);
  const [sageConnecting, setSageConnecting] = useState(false);
  const [sageError, setSageError] = useState(null);

  async function loadAll() {
    setLoading(true);
    const [{ data: conns }, { data: txns }, { data: projects }] = await Promise.all([
      supabase.from("accounting_connections").select("*").order("provider"),
      supabase.from("accounting_transactions").select("*").eq("status", "unmatched").order("txn_date", { ascending: false }),
      supabase.from("projects_v2").select("id, name, line_items(id, name)"),
    ]);
    setConnections(conns || []);
    setTransactions(txns || []);
    const opts = [];
    (projects || []).forEach((p) => (p.line_items || []).forEach((li) => opts.push({ id: li.id, projectId: p.id, label: `${p.name} — ${li.name}` })));
    setLineItemOptions(opts);
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  // The OAuth callback (accounting-oauth-callback) has no app session to
  // work with — it's the accounting platform's own redirect — so it reports
  // success/failure the only way it can: query params on the bounce back
  // into the app. Read them once, then strip them so a refresh doesn't
  // re-show the banner.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("accounting");
    if (!status) return;
    const provider = params.get("provider");
    const providerLabel = provider === "xero" ? "Xero" : provider === "sage" ? "Sage" : "your accounting account";
    if (status === "connected") {
      setBanner({ type: "connected", text: `${providerLabel} connected — you can sync now.` });
    } else if (status === "error") {
      setBanner({ type: "error", text: `Couldn't connect ${providerLabel} — ${params.get("message") || "please try again"}.` });
    }
    params.delete("accounting"); params.delete("provider"); params.delete("message");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, []);

  async function connect(provider) {
    setConnecting(provider);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/accounting-oauth-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionData.session?.access_token || ""}` },
        body: JSON.stringify({ email: userEmail, provider }),
      });
      const json = await res.json();
      if (json.url) await openExternalRedirect(json.url);
      else { setBanner({ type: "error", text: json.error || "Couldn't start the connection." }); setConnecting(null); }
    } catch (err) {
      console.error("accounting connect failed", err);
      setBanner({ type: "error", text: "Couldn't start the connection." });
      setConnecting(null);
    }
  }

  async function sageConnect(companyId) {
    setSageConnecting(true);
    setSageError(null);
    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/accounting-sage-za-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: userEmail,
          username: sageForm.username,
          password: sageForm.password,
          ...(companyId ? { companyId } : {}),
        }),
      });
      const json = await res.json();
      if (json.companies) {
        // More than one company on this login — show the picker instead of
        // guessing which one the user meant.
        setSageCompanies(json.companies);
      } else if (json.connected) {
        setSageCompanies(null);
        setSageForm({ username: "", password: "" });
        setBanner({ type: "connected", text: `Sage connected — ${json.company?.name || "your company"} is ready to sync.` });
        loadAll();
      } else {
        setSageError(json.error || "Couldn't connect to Sage.");
      }
    } catch (err) {
      console.error("sage connect failed", err);
      setSageError("Couldn't reach Sage — please try again.");
    } finally {
      setSageConnecting(false);
    }
  }

  async function disconnect(conn) {
    const label = conn.provider === "xero" ? "Xero" : "Sage";
    if (!window.confirm(`Disconnect ${label}? Actuals already synced stay on your line items — future syncs stop until you reconnect.`)) return;
    await supabase.from("accounting_connections").update({ status: "disconnected" }).eq("id", conn.id);
    loadAll();
  }

  async function syncNow(provider) {
    setSyncing(provider);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/accounting-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionData.session?.access_token || ""}` },
        body: JSON.stringify({ email: userEmail, provider }),
      });
      const json = await res.json();
      const result = json.results?.[provider];
      if (result?.error) setBanner({ type: "error", text: `Sync failed: ${result.error}` });
      else setBanner({ type: "connected", text: `Synced — pulled ${result?.pulled ?? 0}, matched ${result?.matched ?? 0}.` });
      loadAll();
    } catch (err) {
      console.error("accounting sync failed", err);
      setBanner({ type: "error", text: "Sync failed — please try again." });
    } finally {
      setSyncing(null);
    }
  }

  async function assignTransaction(txn, lineItemId) {
    if (!lineItemId) return;
    const opt = lineItemOptions.find((o) => o.id === lineItemId);
    await supabase.from("accounting_transactions")
      .update({ status: "matched", matched_line_item_id: lineItemId, matched_project_id: opt?.projectId || null })
      .eq("id", txn.id);
    const { data: sumRows } = await supabase.from("accounting_transactions")
      .select("amount").eq("matched_line_item_id", lineItemId).eq("status", "matched");
    const total = (sumRows || []).reduce((s, r) => s + Number(r.amount || 0), 0);
    await supabase.from("line_items")
      .update({ actual: total, actual_source: txn.provider, synced_at: new Date().toISOString() })
      .eq("id", lineItemId);
    setTransactions((prev) => prev.filter((t) => t.id !== txn.id));
  }

  async function ignoreTransaction(txn) {
    await supabase.from("accounting_transactions").update({ status: "ignored" }).eq("id", txn.id);
    setTransactions((prev) => prev.filter((t) => t.id !== txn.id));
  }

  const byProvider = Object.fromEntries(connections.filter((c) => c.status === "connected").map((c) => [c.provider, c]));

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <PageHeader title="Accounting sync" current="integrations" onNavigate={onNavigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={logoUrl} />

      <div style={styles.explainer}>
        Connect Xero or Sage to pull paid bills straight into each project's Cost &amp; Progress ledger as actuals — no
        more retyping what's already in your books. This only reads from your accounting platform; SiteMargin never
        creates or edits anything there. Matches are automatic where an invoice clearly lines up with a line item —
        anything unclear lands below for you to assign by hand rather than being guessed.
      </div>

      {banner && (
        <div style={{ ...styles.integrationsBanner, ...(banner.type === "error" ? styles.integrationsBannerError : {}) }}>
          {banner.text}
        </div>
      )}

      <div style={styles.integrationsGrid}>
        {ACCOUNTING_PROVIDERS.map((p) => {
          const conn = byProvider[p.key];
          return (
            <div key={p.key} style={styles.integrationsCard}>
              <div style={styles.integrationsCardHead}>
                <span style={{ ...styles.integrationsDot, background: p.color }} />
                <span style={styles.integrationsCardName}>{p.label}</span>
                {conn && <span style={styles.integrationsConnectedTag}>Connected</span>}
              </div>
              {conn ? (
                <>
                  <div style={styles.integrationsMeta}>{conn.tenant_name || "Connected account"}</div>
                  <div style={styles.integrationsMeta}>
                    {conn.last_synced_at ? `Last synced ${new Date(conn.last_synced_at).toLocaleString()}` : "Never synced"}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button style={styles.addBtn} disabled={syncing === p.key} onClick={() => syncNow(p.key)}>
                      {syncing === p.key ? "Syncing…" : "Sync now"}
                    </button>
                    <button style={styles.removeBtn} onClick={() => disconnect(conn)}>Disconnect</button>
                  </div>
                </>
              ) : p.key === "sage" ? (
                <div>
                  {sageCompanies ? (
                    <>
                      <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 8 }}>
                        This Sage login has more than one company — pick which one to connect:
                      </div>
                      {sageCompanies.map((c) => (
                        <button
                          key={c.id}
                          style={{ ...styles.importBtn, display: "block", width: "100%", textAlign: "left", marginBottom: 6 }}
                          disabled={sageConnecting}
                          onClick={() => sageConnect(c.id)}
                        >
                          {c.name}
                        </button>
                      ))}
                      <button style={styles.removeBtn} onClick={() => { setSageCompanies(null); setSageError(null); }}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 8 }}>
                        Sign in with your own Sage Business Cloud Accounting (South Africa) username and password.
                      </div>
                      <input
                        style={{ ...styles.addInput, width: "100%", marginBottom: 6 }}
                        placeholder="Sage username"
                        value={sageForm.username}
                        onChange={(e) => setSageForm((f) => ({ ...f, username: e.target.value }))}
                      />
                      <input
                        style={{ ...styles.addInput, width: "100%", marginBottom: 6 }}
                        placeholder="Sage password"
                        type="password"
                        value={sageForm.password}
                        onChange={(e) => setSageForm((f) => ({ ...f, password: e.target.value }))}
                      />
                      {sageError && <div style={{ fontSize: 12.5, color: "var(--danger)", marginBottom: 6 }}>{sageError}</div>}
                      <button
                        style={styles.importBtn}
                        disabled={sageConnecting || !sageForm.username || !sageForm.password}
                        onClick={() => sageConnect(null)}
                      >
                        {sageConnecting ? "Connecting…" : "Connect Sage"}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <button style={styles.importBtn} disabled={connecting === p.key} onClick={() => connect(p.key)}>
                  {connecting === p.key ? "Redirecting…" : `Connect ${p.label}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {!loading && transactions.length > 0 && (
        <div style={styles.integrationsUnmatched}>
          <div style={styles.toggleGroupLabel}>Needs a line item — {transactions.length} unmatched</div>
          {transactions.map((t) => (
            <div key={t.id} style={styles.integrationsTxnRow}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.contact_name || t.description || "Transaction"}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t.description}{t.txn_date ? ` · ${t.txn_date}` : ""}</div>
              </div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, minWidth: 100, textAlign: "right" }}>{fmt(t.amount)}</div>
              <select style={{ ...styles.addInput, maxWidth: 240 }} defaultValue="" onChange={(e) => assignTransaction(t, e.target.value)}>
                <option value="">Assign to line item…</option>
                {lineItemOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <button style={styles.removeBtn} onClick={() => ignoreTransaction(t)}>Ignore</button>
            </div>
          ))}
        </div>
      )}

      <AppFooter />
    </div>
  );
}

/* ============================== STORAGE VIEW ============================== */

const STORAGE_UPGRADES_INDIVIDUAL = [
  { tier: "individual_100mb", label: "100MB", price: "R99 once off" },
  { tier: "individual_250mb", label: "250MB", price: "R199 once off" },
];
const STORAGE_UPGRADES_COMPANY = [
  { tier: "company_1gb", label: "1GB", price: "R299 once off" },
  { tier: "company_10gb", label: "10GB", price: "R469 once off" },
];
const STORAGE_TIER_LABELS = {
  individual_100mb: "100MB",
  individual_250mb: "250MB",
  company_1gb: "1GB",
  company_10gb: "10GB",
};

function formatStorageBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function StorageView({ onNavigate, userEmail, onSignOut, logoUrl }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState(null);
  const [banner, setBanner] = useState(null);
  // Separate from `status` above (which holds storage usage numbers) — this
  // holds the subscription/billing row itself, used to render the "Plan &
  // billing" card and decide whether a Cancel button should show.
  const [plan, setPlan] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  async function loadStatus() {
    setLoading(true);
    // storage_status is a view built FROM subscriptions — an account with
    // no subscriptions row (i.e. everyone still on the free tier, which is
    // most signups, since subscriptions only gets a row on paid checkout)
    // gets no row back at all and the page would render blank. Calling the
    // two underlying functions directly works for every account regardless
    // of subscription status, matching how base_storage_bytes() already
    // defaults an unknown/missing tier to the 25MB free allowance.
    const [{ data: used, error: usedErr }, { data: limit, error: limitErr }, { data: sub }] = await Promise.all([
      supabase.rpc("user_storage_used_bytes", { p_email: userEmail }),
      supabase.rpc("user_storage_limit_bytes", { p_email: userEmail }),
      supabase.from("subscriptions").select("tier, status, current_period_end, payfast_token").eq("email", userEmail).maybeSingle(),
    ]);
    if (usedErr || limitErr) {
      setStatus(null);
    } else {
      const usedBytes = used ?? 0;
      const limitBytes = limit ?? 0;
      setStatus({
        tier: sub?.tier || "free",
        used_bytes: usedBytes,
        limit_bytes: limitBytes,
        pct_used: limitBytes ? (usedBytes / limitBytes) * 100 : 0,
      });
    }
    setPlan(sub || null);
    setLoading(false);
  }

  useEffect(() => { loadStatus(); }, [userEmail]);

  // storage-checkout's return_url/cancel_url bounce back here with
  // ?storage=success|cancelled&purchase_id=... — same pattern as the
  // Accounting tab's ?accounting= banner above. On success, poll briefly
  // since the PayFast ITN that flips the purchase to 'complete' can land a
  // few seconds after the redirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("storage");
    if (!result) return;
    const purchaseId = params.get("purchase_id");
    params.delete("storage"); params.delete("purchase_id");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));

    if (result === "cancelled") {
      setBanner({ type: "error", text: "Upgrade cancelled — no payment was made, your storage limit hasn't changed." });
      return;
    }
    if (result !== "success") return;

    let cancelled = false;
    let attempts = 0;
    async function poll() {
      attempts += 1;
      if (!purchaseId) {
        setBanner({ type: "connected", text: "Payment received — confirming with PayFast, your storage limit will update shortly." });
        return;
      }
      const { data } = await supabase.from("storage_purchases").select("upgrade_tier, status").eq("id", purchaseId).maybeSingle();
      if (cancelled) return;
      if (data?.status === "complete") {
        setBanner({ type: "connected", text: `Storage upgraded — your new limit is ${STORAGE_TIER_LABELS[data.upgrade_tier] || "higher"}.` });
        loadStatus();
      } else if (attempts < 8) {
        setTimeout(poll, 2000);
      } else {
        setBanner({ type: "connected", text: "PayFast is still confirming your payment — check back in a minute if your limit hasn't updated." });
      }
    }
    poll();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upgrade(tier) {
    setUpgrading(tier);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/storage-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionData.session?.access_token || ""}` },
        body: JSON.stringify({ email: userEmail, upgrade_tier: tier }),
      });
      const json = await res.json();
      if (!json.fields || !json.payfast_url) {
        setBanner({ type: "error", text: json.error || "Couldn't start the upgrade — please try again." });
        setUpgrading(null);
        return;
      }
      // PayFast requires an actual form POST, not a GET redirect — build
      // and submit one invisibly, same as the marketing site's checkout.
      const form = document.createElement("form");
      form.method = "POST";
      form.action = json.payfast_url;
      Object.entries(json.fields).forEach(([key, value]) => {
        const input = document.createElement("input");
        input.type = "hidden"; input.name = key; input.value = String(value);
        form.appendChild(input);
      });
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      console.error("storage upgrade failed", err);
      setBanner({ type: "error", text: "Couldn't start the upgrade — please try again." });
      setUpgrading(null);
    }
  }

  async function cancelSubscription() {
    if (!window.confirm(
      "Cancel your subscription? Your recurring billing will stop and your account will drop back to the Free plan immediately — you'll lose access to any paid-tier features and storage above the free allowance."
    )) {
      return;
    }
    setCancelling(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/cancel-subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionData.session?.access_token || ""}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setBanner({ type: "error", text: json.error || "Couldn't cancel — please try again." });
        setCancelling(false);
        return;
      }
      setBanner({ type: json.warning ? "error" : "connected", text: json.warning || "Subscription cancelled — you're back on the Free plan." });
      await loadStatus();
    } catch (err) {
      console.error("cancel subscription failed", err);
      setBanner({ type: "error", text: "Couldn't cancel — please try again." });
    } finally {
      setCancelling(false);
    }
  }

  // Tier key is "firm" internally (displayed to users as "Company" — see
  // TIER_LABEL) — matches base_storage_bytes() in the database.
  const isCompanyTier = status?.tier === "firm";
  const upgradeOptions = isCompanyTier ? STORAGE_UPGRADES_COMPANY : STORAGE_UPGRADES_INDIVIDUAL;
  const pct = status ? Math.min(Number(status.pct_used) || 0, 100) : 0;
  const barColor = pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warning)" : "var(--accent)";

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <PageHeader title="Plan and Storage" current="storage" onNavigate={onNavigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={logoUrl} />

      <div style={styles.explainer}>
        Every plan includes a storage allowance for attachments, photos, and documents across your projects. Once-off
        upgrades raise your limit permanently — they don't expire and don't stack with each other, the highest one you've
        bought is your new ceiling.
      </div>

      {banner && (
        <div style={{ ...styles.integrationsBanner, ...(banner.type === "error" ? styles.integrationsBannerError : {}) }}>
          {banner.text}
        </div>
      )}

      {plan && (plan.tier === "contractor" || plan.tier === "firm") && (
        <div style={{ ...styles.integrationsCard, maxWidth: 1180, margin: "0 auto 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 4 }}>
                Plan &amp; billing
              </div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {TIER_LABEL[plan.tier] || plan.tier}
                {" — "}
                <span style={{ fontWeight: 400, color: plan.status === "active" ? "var(--accent)" : "#6E6E73" }}>
                  {plan.status === "active" ? "Active, billed monthly" : plan.status === "cancelled" ? "Cancelled" : plan.status || "Unknown"}
                </span>
              </div>
            </div>
            {plan.status === "active" && (
              <button
                style={{ ...styles.importBtn, color: "var(--danger)", borderColor: "var(--danger)" }}
                disabled={cancelling}
                onClick={cancelSubscription}
              >
                {cancelling ? "Cancelling…" : "Cancel subscription"}
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ ...styles.integrationsCard, maxWidth: 1180, margin: "0 auto" }}>
        {loading ? (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Loading storage usage…</div>
        ) : !status ? (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Couldn't load your storage usage — please refresh.</div>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Storage used</span>
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                {formatStorageBytes(status.used_bytes)} of {formatStorageBytes(status.limit_bytes)}
              </span>
            </div>
            <div style={{ height: 8, background: "var(--bg-secondary)", borderRadius: 4, overflow: "hidden", marginBottom: 16 }}>
              <div style={{ height: "100%", width: `${pct}%`, background: barColor, borderRadius: 4, transition: "width 0.3s ease" }} />
            </div>
            {pct >= 70 && (
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 14px" }}>
                {pct >= 90 ? "You're almost out of space — upgrade to keep uploading." : "You're close to your limit — consider upgrading."}
              </p>
            )}
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 10 }}>
              {isCompanyTier ? "Company upgrades" : "Upgrade options"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {upgradeOptions.map((opt) => (
                <UpgradeOption
                  key={opt.tier}
                  label={opt.label}
                  price={opt.price}
                  busy={upgrading === opt.tier}
                  onClick={() => upgrade(opt.tier)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <AppFooter />
    </div>
  );
}

/* ============================== PROJECT VIEW ============================== */

function ProjectView({ projectId, onBack, onNavigate, userEmail, onSignOut, logoUrl }) {
  const [project, setProject] = useState(null);
  const [items, setItems] = useState([]);
  const [changeOrders, setChangeOrders] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [subs, setSubs] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("ledger");
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState(CATEGORIES[0]);
  const [newBudget, setNewBudget] = useState("");
  const [editingCell, setEditingCell] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [expandedRow, setExpandedRow] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [importMessage, setImportMessage] = useState(null);
  const [importPreviewItems, setImportPreviewItems] = useState(null); // null = no modal open
  const [coDesc, setCoDesc] = useState("");
  const [coAmount, setCoAmount] = useState("");
  const [coPriority, setCoPriority] = useState("Normal");
  const [coPoNumber, setCoPoNumber] = useState("");
  const [coDate, setCoDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [poSupplier, setPoSupplier] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [poDescription, setPoDescription] = useState("");
  const [poAmount, setPoAmount] = useState("");
  const [poLineItemId, setPoLineItemId] = useState("");
  const [poOrderDate, setPoOrderDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [tenders, setTenders] = useState([]);
  const [tenderBids, setTenderBids] = useState([]);
  const [tTrade, setTTrade] = useState("");
  const [tTitle, setTTitle] = useState("");
  const [tLineItemId, setTLineItemId] = useState("");
  const [bidDrafts, setBidDrafts] = useState({}); // { [tenderId]: { bidderName, subcontractorId, amount, notes } }
  const [scheduleTasks, setScheduleTasks] = useState([]);
  const [taskName, setTaskName] = useState("");
  const [taskLineItemId, setTaskLineItemId] = useState("");
  const [taskStart, setTaskStart] = useState("");
  const [taskEnd, setTaskEnd] = useState("");
  const [documents, setDocuments] = useState([]);
  const [docCategory, setDocCategory] = useState("Drawings");
  const [docLineItemId, setDocLineItemId] = useState("");
  const documentsInputRef = useRef(null);
  const DOC_CATEGORIES = ["Drawings", "Contracts", "Specifications", "Photos", "Correspondence", "Other"];
  // Client Reports: a per-project saved configuration (which sections show,
  // a note, recipients, and an optional recurring schedule) plus the ability
  // to email it now or put it on a schedule. See report_profiles/report_sends
  // — at most one saved profile per project for now (the most recently
  // updated one loads below), rather than letting a project accumulate many.
  const [reportProfile, setReportProfile] = useState(null);
  const [reportSections, setReportSections] = useState({
    cost_summary: true,
    change_orders: true,
    schedule: true,
    trend: true,
    payments: false,
    purchase_orders: false,
    documents: false,
    subcontractors: false,
  });
  const [reportNote, setReportNote] = useState("");
  const [reportRecipients, setReportRecipients] = useState([]);
  const [reportRecipientDraft, setReportRecipientDraft] = useState("");
  const [reportFrequency, setReportFrequency] = useState("none"); // none | weekly | monthly
  const [reportSendDay, setReportSendDay] = useState(1); // weekly: 0(Sun)-6(Sat); monthly: 1-28
  const [reportSaving, setReportSaving] = useState(false);
  const [reportSending, setReportSending] = useState(false);
  const [reportMessage, setReportMessage] = useState(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("report_profiles")
        .select("*")
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || !data) return;
      setReportProfile(data);
      setReportSections((prev) => ({ ...prev, ...(data.sections || {}) }));
      setReportNote(data.note || "");
      setReportRecipients(data.recipients || []);
      setReportFrequency(data.frequency || "none");
      setReportSendDay(data.send_day ?? 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const downloadMenuRef = useRef(null);
  const fileInputRef = useRef(null);
  const attachInputRef = useRef(null);
  const attachTargetItem = useRef(null);
  const plansInputRef = useRef(null);
  const saveTimers = useRef({});
  const pendingSaves = useRef({});
  // supabase-js query builders are lazy: the HTTP request is only issued
  // inside .then(), so a builder that is never awaited (or .then()'d) is
  // silently discarded and the edit is lost. Every write below must be
  // awaited or chained, and its error surfaced rather than swallowed.
  async function flushPending(key) {
    const pending = pendingSaves.current[key];
    if (!pending) return;
    delete pendingSaves.current[key];
    const { error } = await supabase.from(pending.table).update(pending.patch).eq("id", pending.id);
    if (error) console.error("Save failed", pending.table, pending.patch, error);
  }
  // Quote tab: its own Download menu (PDF/Excel/Word) plus a ref around the
  // printable quote content so Word export can grab it. The quote's "client
  // logo" is just the contractor's own company logo (logoUrl, set once from
  // the projects homepage) — no separate per-project upload any more.
  const quoteContentRef = useRef(null);
  const [quoteDownloadMenuOpen, setQuoteDownloadMenuOpen] = useState(false);
  const quoteDownloadMenuRef = useRef(null);

  async function loadAll() {
    const [{ data: proj }, { data: lineItems }, { data: cos }, { data: snaps }, { data: subsData }, { data: temps }, { data: pos }, { data: tends }, { data: tasks }, { data: docs }] =
      await Promise.all([
        supabase.from("projects_v2").select("*").eq("id", projectId).single(),
        supabase.from("line_items").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
        supabase.from("change_orders").select("*").eq("project_id", projectId).order("created_at", { ascending: false }),
        supabase.from("snapshots").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
        supabase.from("subcontractors").select("*").order("name"),
        supabase.from("templates").select("*").order("created_at", { ascending: false }),
        supabase.from("purchase_orders").select("*").eq("project_id", projectId).order("created_at", { ascending: false }),
        supabase.from("tenders").select("*").eq("project_id", projectId).order("created_at", { ascending: false }),
        supabase.from("schedule_tasks").select("*").eq("project_id", projectId).order("start_date", { ascending: true }),
        supabase.from("document_files").select("*").eq("project_id", projectId).order("created_at", { ascending: false }),
      ]);
    setProject(proj);
    setItems(lineItems || []);
    setChangeOrders(cos || []);
    setSnapshots(snaps || []);
    setSubs(subsData || []);
    setTemplates(temps || []);
    setPurchaseOrders(pos || []);
    setTenders(tends || []);
    setScheduleTasks(tasks || []);
    setDocuments(docs || []);
    const tenderIds = (tends || []).map((t) => t.id);
    if (tenderIds.length) {
      const { data: bids } = await supabase.from("tender_bids").select("*").in("tender_id", tenderIds).order("amount", { ascending: true });
      setTenderBids(bids || []);
    } else {
      setTenderBids([]);
    }
    setLoaded(true);
  }

  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  useEffect(() => {
    return () => {
      Object.keys(pendingSaves.current).forEach((key) => flushPending(key));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approvedChangeOrders = useMemo(() => changeOrders.filter((c) => c.status === "approved"), [changeOrders]);
  const approvedCoTotal = useMemo(
    () => approvedChangeOrders.reduce((s, c) => s + Number(c.amount || 0), 0),
    [approvedChangeOrders]
  );

  const totals = useMemo(() => {
    const budget = items.reduce((s, i) => s + Number(i.budget || 0), 0);
    const revisedBudget = budget + approvedCoTotal;
    const actual = items.reduce((s, i) => s + Number(i.actual || 0), 0);
    const claimed = items.reduce((s, i) => s + Number(i.claimed || 0), 0);
    const certified = items.reduce((s, i) => s + Number(i.certified || 0), 0);
    const retentionPct = project?.retention_pct ?? 5;
    const retentionHeld = certified * (retentionPct / 100);
    return {
      budget, revisedBudget, actual,
      variance: actual - revisedBudget,
      pct: revisedBudget ? ((actual - revisedBudget) / revisedBudget) * 100 : 0,
      claimed, certified, retentionHeld,
      paidToDate: certified - retentionHeld,
      uncertified: claimed - certified,
      retentionPct,
    };
  }, [items, approvedCoTotal, project]);

  const overCount = items.filter((i) => statusFor(i.budget, i.actual) === "over").length;
  const watchCount = items.filter((i) => statusFor(i.budget, i.actual) === "watch").length;
  const aheadCount = items.filter((i) => {
    const gap = progressGapFor(i.budget, i.actual, i.percent_complete);
    return gap != null && gap > 15;
  }).length;

  const flaggedItems = useMemo(() => {
    return items
      .map((i) => {
        const status = statusFor(i.budget, i.actual);
        if (status !== "over" && status !== "watch") return null;
        const budget = Number(i.budget || 0);
        const actual = Number(i.actual || 0);
        return {
          id: i.id,
          name: i.name || "Untitled line",
          status,
          variance: actual - budget,
          pct: budget ? ((actual - budget) / budget) * 100 : 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.variance - a.variance);
  }, [items]);

  const categoryRollup = useMemo(() => {
    return CATEGORIES.map((cat) => {
      const catItems = items.filter((i) => (i.category || "Other") === cat);
      return {
        category: cat,
        budget: catItems.reduce((s, i) => s + Number(i.budget || 0), 0),
        actual: catItems.reduce((s, i) => s + Number(i.actual || 0), 0),
        variance: catItems.reduce((s, i) => s + Number(i.actual || 0) - Number(i.budget || 0), 0),
        count: catItems.length,
      };
    }).filter((c) => c.count > 0);
  }, [items]);

  // Popover content for the summary-strip info icons — every figure here
  // reuses categoryRollup/totals/flaggedItems, already computed above for
  // the category strip and the flagged-lines card. No new queries.
  const budgetByCategoryRows = useMemo(
    () => categoryRollup.slice().sort((a, b) => b.budget - a.budget).map((c) => ({
      key: c.category, dot: CATEGORY_COLOR[c.category], name: c.category, value: fmt(c.budget),
    })),
    [categoryRollup]
  );
  const spendByCategoryRows = useMemo(
    () => categoryRollup.slice().sort((a, b) => b.variance - a.variance).map((c) => ({
      key: c.category, dot: CATEGORY_COLOR[c.category], name: c.category,
      value: c.variance > 0 ? `+${fmt(c.variance)}` : "on budget", over: c.variance > 0,
    })),
    [categoryRollup]
  );
  const overCategories = useMemo(
    () => categoryRollup.filter((c) => c.variance > 0).sort((a, b) => b.variance - a.variance),
    [categoryRollup]
  );
  const overCategoryTotal = overCategories.reduce((s, c) => s + c.variance, 0);

  function scheduleSave(itemId, patch) {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, ...patch } : i)));
    const key = `item:${itemId}`;
    pendingSaves.current[key] = { table: "line_items", id: itemId, patch: { ...(pendingSaves.current[key]?.patch || {}), ...patch } };
    if (saveTimers.current[itemId]) clearTimeout(saveTimers.current[itemId]);
    saveTimers.current[itemId] = setTimeout(() => flushPending(key), 500);
  }

  // Quote export — mirrors the Cost & Progress ledger's Download menu
  // (PDF via print, Excel via the same xlsx lib) plus a lightweight Word
  // export (an HTML file with a .doc extension, which Word opens directly —
  // no new dependency needed for that one).
  function quoteExportRows() {
    const header = ["Category", "Item", "Price"];
    const rows = [];
    categoryRollup.forEach((cat) => {
      items.filter((i) => (i.category || "Other") === cat.category).forEach((item) => {
        rows.push([cat.category, item.name || "", Number(item.budget || 0)]);
      });
      rows.push([cat.category, `Subtotal — ${cat.category}`, Number(cat.budget || 0)]);
    });
    rows.push(["", "Total", Number(totals.budget || 0)]);
    return [header, ...rows];
  }

  function quoteExportFileBaseName() {
    const client = (project?.client_name || "").trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
    const name = (project?.name || "quote").trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
    return client ? `quote-${client}` : `quote-${name || "project"}`;
  }

  function exportQuotePdf() {
    setQuoteDownloadMenuOpen(false);
    window.print();
  }

  async function exportQuoteExcel() {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet(quoteExportRows());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Quote");
    XLSX.writeFile(wb, `${quoteExportFileBaseName()}.xlsx`);
    setQuoteDownloadMenuOpen(false);
  }

  function exportQuoteWord() {
    setQuoteDownloadMenuOpen(false);
    const inner = quoteContentRef.current?.innerHTML || "";
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quote</title></head><body>${inner}</body></html>`;
    const blob = new Blob([html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${quoteExportFileBaseName()}.doc`; a.click();
    URL.revokeObjectURL(url);
  }

  async function addItem() {
    if (!newName.trim()) return;
    const { data, error } = await supabase
      .from("line_items")
      .insert({ project_id: projectId, name: newName.trim(), category: newCategory, budget: newBudget ? Number(newBudget) : 0 })
      .select().single();
    if (!error && data) { setItems((prev) => [...prev, data]); setNewName(""); setNewBudget(""); }
  }

  async function removeItem(id) {
    if (!window.confirm("Delete this line item? This can't be undone.")) return;
    setItems((prev) => prev.filter((i) => i.id !== id));
    await supabase.from("line_items").delete().eq("id", id);
  }

  function startEdit(id, field, currentValue) {
    setEditingCell(`${id}:${field}`);
    setEditValue(String(currentValue ?? ""));
  }

  function saveEdit(id, field, isText) {
    scheduleSave(id, { [field]: isText ? editValue || null : Number(editValue) || 0 });
    setEditingCell(null);
  }

  function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const isExcel = /\.xlsx$/i.test(file.name);
    const isPdf = /\.pdf$/i.test(file.name);

    function openPreview(parsed, error) {
      if (error) {
        setImportMessage({ type: "error", text: error });
        setTimeout(() => setImportMessage(null), 6000);
      } else {
        setImportPreviewItems(parsed.map((p) => ({ ...p, _include: true })));
      }
    }

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        if (isExcel) {
          const rows = await xlsxBufferToRows(evt.target.result);
          const { items: parsed, error } = rowsToItems(rows);
          openPreview(parsed, error);
        } else if (isPdf) {
          const rows = await pdfBufferToRows(evt.target.result);
          const { items: parsed, error } = pdfRowsToItems(rows);
          openPreview(
            parsed,
            error ||
              (rows.length === 0
                ? "No readable text found in that PDF. If it's a scanned or photographed document, this won't work — only digitally created PDFs can be read this way."
                : null)
          );
        } else {
          const { items: parsed, error } = parseCsvToItems(evt.target.result);
          openPreview(parsed, error);
        }
      } catch (err) {
        console.error("Import failed", err);
        setImportMessage({ type: "error", text: "Couldn't read that file — make sure it's a valid CSV, .xlsx, or PDF." });
        setTimeout(() => setImportMessage(null), 6000);
      }
    };
    if (isExcel || isPdf) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
    e.target.value = "";
  }

  async function confirmImportPreview() {
    const toImport = importPreviewItems.filter((i) => i._include && i.name?.trim());
    if (toImport.length === 0) {
      setImportPreviewItems(null);
      return;
    }
    const rows = toImport.map(({ _include, ...rest }) => ({ ...rest, project_id: projectId }));
    const { data, error } = await supabase.from("line_items").insert(rows).select();
    setImportPreviewItems(null);
    if (error) {
      setImportMessage({ type: "error", text: "Import failed — please try again." });
    } else {
      setItems((prev) => [...prev, ...data]);
      setImportMessage({ type: "success", text: `Imported ${data.length} line item${data.length > 1 ? "s" : ""}.` });
    }
    setTimeout(() => setImportMessage(null), 6000);
  }

  function updatePreviewItem(index, patch) {
    setImportPreviewItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }


  async function applyTemplate(templateId) {
    if (!templateId) return;
    const { data: tItems } = await supabase.from("template_items").select("*").eq("template_id", templateId).order("sort_order");
    if (!tItems || tItems.length === 0) {
      setImportMessage({ type: "error", text: "That template has no line items yet." });
      setTimeout(() => setImportMessage(null), 6000);
      return;
    }
    const rows = tItems.map((t) => ({
      project_id: projectId, name: t.name, category: t.category, budget: Number(t.budget),
    }));
    const { data, error } = await supabase.from("line_items").insert(rows).select();
    if (!error && data) {
      setItems((prev) => [...prev, ...data]);
      setImportMessage({ type: "success", text: `Applied template — ${data.length} line items added.` });
    } else {
      setImportMessage({ type: "error", text: "Couldn't apply that template." });
    }
    setTimeout(() => setImportMessage(null), 6000);
  }

  async function saveAsTemplate() {
    if (items.length === 0) {
      setImportMessage({ type: "error", text: "Add some line items before saving a template." });
      setTimeout(() => setImportMessage(null), 6000);
      return;
    }
    const name = window.prompt("Template name:", `${project.name} template`);
    if (!name || !name.trim()) return;
    const { data: tmpl, error } = await supabase
      .from("templates").insert({ name: name.trim(), description: `Saved from ${project.name}` }).select().single();
    if (error || !tmpl) {
      setImportMessage({ type: "error", text: "Couldn't create that template." });
      setTimeout(() => setImportMessage(null), 6000);
      return;
    }
    const rows = items.map((i, idx) => ({
      template_id: tmpl.id, name: i.name, category: i.category || "Other", budget: Number(i.budget || 0), sort_order: idx,
    }));
    await supabase.from("template_items").insert(rows);
    setTemplates((prev) => [tmpl, ...prev]);
    setImportMessage({ type: "success", text: `Saved "${name.trim()}" with ${rows.length} line items.` });
    setTimeout(() => setImportMessage(null), 6000);
  }

  function triggerAttach(item) {
    attachTargetItem.current = item;
    attachInputRef.current?.click();
  }

  // Files are private now, so a fresh, short-lived signed URL is requested
  // at the moment someone actually clicks — nothing permanent is exposed.
  async function openAttachment(attachment) {
    if (!attachment.path) {
      // Backward compatibility for attachments uploaded before the bucket
      // was locked down, which stored a direct URL instead of a path.
      if (attachment.url) openExternalLink(attachment.url);
      return;
    }
    const { data, error } = await supabase.storage.from("attachments").createSignedUrl(attachment.path, 60);
    if (error || !data?.signedUrl) {
      setImportMessage({ type: "error", text: "Couldn't open that file — please try again." });
      setTimeout(() => setImportMessage(null), 6000);
      return;
    }
    openExternalLink(data.signedUrl);
  }

  async function handleAttachFile(e) {
    const file = e.target.files?.[0];
    const item = attachTargetItem.current;
    if (!file || !item) return;
    const path = `${projectId}/${item.id}/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from("attachments").upload(path, file);
    if (!error) {
      // Store the storage path, not a permanent public URL — the bucket is
      // private now, so a fresh time-limited signed URL is generated on
      // each click instead (see openAttachment below).
      const newAttachments = [...(item.attachments || []), { name: file.name, path }];
      await supabase.from("line_items").update({ attachments: newAttachments }).eq("id", item.id);
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, attachments: newAttachments } : i)));
    }
    e.target.value = "";
  }

  // "Plans" — reference documents (drawings, quotes, CAD exports, contracts)
  // attached to the project as a whole, for quick reference, not tied to any
  // single line item. Uses the same private "attachments" storage bucket as
  // line-item files, under a projectId/plans/ path so the existing RLS
  // policy (which keys off the first path segment being the project id)
  // covers this without any policy changes.
  async function openPlan(plan) {
    const { data, error } = await supabase.storage.from("attachments").createSignedUrl(plan.path, 60);
    if (error || !data?.signedUrl) {
      setImportMessage({ type: "error", text: "Couldn't open that file — please try again." });
      setTimeout(() => setImportMessage(null), 6000);
      return;
    }
    openExternalLink(data.signedUrl);
  }

  async function handlePlanUpload(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const uploaded = [];
    for (const file of files) {
      const path = `${projectId}/plans/${Date.now()}-${file.name}`;
      const { error } = await supabase.storage.from("attachments").upload(path, file);
      if (!error) uploaded.push({ name: file.name, path, size: file.size, uploaded_at: new Date().toISOString() });
    }
    if (uploaded.length) {
      const newPlans = [...(project?.plans || []), ...uploaded];
      await supabase.from("projects_v2").update({ plans: newPlans }).eq("id", projectId);
      setProject((prev) => ({ ...prev, plans: newPlans }));
    }
    e.target.value = "";
  }

  // #6: Payments & Retention — a payment date plus a supporting document
  // (payment certificate / proof of payment) per line item. The document is
  // also appended to the item's general attachments array so it's linked
  // into the same trail visible on the Cost & Progress tab.
  const paymentDocInputRef = useRef(null);
  const paymentDocTargetItem = useRef(null);

  function triggerPaymentDocUpload(item) {
    paymentDocTargetItem.current = item;
    paymentDocInputRef.current?.click();
  }

  async function handlePaymentDocUpload(e) {
    const file = e.target.files?.[0];
    const item = paymentDocTargetItem.current;
    if (!file || !item) return;
    const path = `${projectId}/${item.id}/payment-${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from("attachments").upload(path, file);
    if (!error) {
      const linkedAttachments = [...(item.attachments || []), { name: file.name, path }];
      await supabase.from("line_items").update({
        payment_doc_name: file.name,
        payment_doc_path: path,
        attachments: linkedAttachments,
      }).eq("id", item.id);
      setItems((prev) => prev.map((i) => (i.id === item.id
        ? { ...i, payment_doc_name: file.name, payment_doc_path: path, attachments: linkedAttachments }
        : i)));
    }
    e.target.value = "";
  }

  async function openPaymentDoc(item) {
    if (!item.payment_doc_path) return;
    const { data, error } = await supabase.storage.from("attachments").createSignedUrl(item.payment_doc_path, 60);
    if (error || !data?.signedUrl) return;
    openExternalLink(data.signedUrl);
  }

  async function setPaymentDate(itemId, date) {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, payment_date: date } : i)));
    await supabase.from("line_items").update({ payment_date: date || null }).eq("id", itemId);
  }

  async function removePlan(path) {
    if (!window.confirm("Delete this plan? This can't be undone.")) return;
    const newPlans = (project?.plans || []).filter((p) => p.path !== path);
    await supabase.from("projects_v2").update({ plans: newPlans }).eq("id", projectId);
    setProject((prev) => ({ ...prev, plans: newPlans }));
    await supabase.storage.from("attachments").remove([path]);
  }

  async function addChangeOrder() {
    if (!coDesc.trim() || !coAmount) return;
    const { data, error } = await supabase
      .from("change_orders")
      .insert({
        project_id: projectId,
        description: coDesc.trim(),
        amount: Number(coAmount),
        status: "pending",
        priority: coPriority,
        po_number: coPoNumber.trim() || null,
        co_date: coDate || new Date().toISOString().slice(0, 10),
      })
      .select().single();
    if (!error && data) {
      setChangeOrders((prev) => [data, ...prev]);
      setCoDesc(""); setCoAmount(""); setCoPriority("Normal"); setCoPoNumber("");
      setCoDate(new Date().toISOString().slice(0, 10));
    }
  }

  async function setCoStatus(id, status) {
    setChangeOrders((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
    await supabase.from("change_orders").update({ status }).eq("id", id);
  }

  async function setCoPriorityValue(id, priority) {
    setChangeOrders((prev) => prev.map((c) => (c.id === id ? { ...c, priority } : c)));
    await supabase.from("change_orders").update({ priority }).eq("id", id);
  }

  async function setCoPoNumberValue(id, po_number) {
    setChangeOrders((prev) => prev.map((c) => (c.id === id ? { ...c, po_number } : c)));
    await supabase.from("change_orders").update({ po_number: po_number || null }).eq("id", id);
  }

  async function removeChangeOrder(id) {
    if (!window.confirm("Delete this change order? This can't be undone.")) return;
    setChangeOrders((prev) => prev.filter((c) => c.id !== id));
    await supabase.from("change_orders").delete().eq("id", id);
  }

  async function addPurchaseOrder() {
    if (!poSupplier.trim() || !poAmount) return;
    const { data, error } = await supabase
      .from("purchase_orders")
      .insert({
        project_id: projectId,
        supplier_name: poSupplier.trim(),
        po_number: poNumber.trim() || null,
        description: poDescription.trim(),
        amount: Number(poAmount),
        line_item_id: poLineItemId || null,
        status: "draft",
        order_date: poOrderDate || new Date().toISOString().slice(0, 10),
      })
      .select().single();
    if (!error && data) {
      setPurchaseOrders((prev) => [data, ...prev]);
      setPoSupplier(""); setPoNumber(""); setPoDescription(""); setPoAmount(""); setPoLineItemId("");
      setPoOrderDate(new Date().toISOString().slice(0, 10));
    }
  }

  async function setPoStatus(id, status) {
    const patch = { status };
    if (status === "received") patch.received_date = new Date().toISOString().slice(0, 10);
    setPurchaseOrders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    await supabase.from("purchase_orders").update(patch).eq("id", id);
  }

  async function removePurchaseOrder(id) {
    if (!window.confirm("Delete this purchase order? This can't be undone.")) return;
    setPurchaseOrders((prev) => prev.filter((p) => p.id !== id));
    await supabase.from("purchase_orders").delete().eq("id", id);
  }

  const poOutstandingTotal = useMemo(
    () => purchaseOrders.filter((p) => p.status !== "received" && p.status !== "cancelled").reduce((s, p) => s + Number(p.amount || 0), 0),
    [purchaseOrders]
  );

  async function addTender() {
    if (!tTrade.trim() || !tTitle.trim()) return;
    const { data, error } = await supabase
      .from("tenders")
      .insert({
        project_id: projectId,
        trade: tTrade.trim(),
        title: tTitle.trim(),
        line_item_id: tLineItemId || null,
        status: "open",
      })
      .select().single();
    if (!error && data) {
      setTenders((prev) => [data, ...prev]);
      setTTrade(""); setTTitle(""); setTLineItemId("");
    }
  }

  async function removeTender(id) {
    if (!window.confirm("Delete this tender and all its bids? This can't be undone.")) return;
    setTenders((prev) => prev.filter((t) => t.id !== id));
    setTenderBids((prev) => prev.filter((b) => b.tender_id !== id));
    await supabase.from("tenders").delete().eq("id", id);
  }

  function updateBidDraft(tenderId, patch) {
    setBidDrafts((prev) => ({ ...prev, [tenderId]: { ...(prev[tenderId] || {}), ...patch } }));
  }

  async function addBid(tenderId) {
    const draft = bidDrafts[tenderId] || {};
    if (!draft.bidderName?.trim() || !draft.amount) return;
    const { data, error } = await supabase
      .from("tender_bids")
      .insert({
        tender_id: tenderId,
        bidder_name: draft.bidderName.trim(),
        subcontractor_id: draft.subcontractorId || null,
        amount: Number(draft.amount),
        notes: (draft.notes || "").trim(),
        status: "pending",
      })
      .select().single();
    if (!error && data) {
      setTenderBids((prev) => [...prev, data].sort((a, b) => Number(a.amount) - Number(b.amount)));
      setBidDrafts((prev) => ({ ...prev, [tenderId]: { bidderName: "", subcontractorId: "", amount: "", notes: "" } }));
    }
  }

  async function removeBid(id) {
    if (!window.confirm("Delete this bid? This can't be undone.")) return;
    setTenderBids((prev) => prev.filter((b) => b.id !== id));
    await supabase.from("tender_bids").delete().eq("id", id);
  }

  async function awardBid(tender, bid) {
    if (!window.confirm(`Award this tender to ${bid.bidder_name}?`)) return;
    setTenderBids((prev) => prev.map((b) => {
      if (b.tender_id !== tender.id) return b;
      return { ...b, status: b.id === bid.id ? "awarded" : "declined" };
    }));
    setTenders((prev) => prev.map((t) => (t.id === tender.id ? { ...t, status: "awarded" } : t)));
    await Promise.all([
      supabase.from("tender_bids").update({ status: "awarded" }).eq("id", bid.id),
      supabase.from("tender_bids").update({ status: "declined" }).eq("tender_id", tender.id).neq("id", bid.id),
      supabase.from("tenders").update({ status: "awarded" }).eq("id", tender.id),
    ]);
    // Closes the loop with the Subcontractors feature: if this tender was
    // raised against a specific budget line and the winning bidder is
    // already a known subcontractor, appoint them to that line item.
    if (tender.line_item_id && bid.subcontractor_id) {
      setItems((prev) => prev.map((i) => (i.id === tender.line_item_id ? { ...i, subcontractor_id: bid.subcontractor_id } : i)));
      await supabase.from("line_items").update({ subcontractor_id: bid.subcontractor_id }).eq("id", tender.line_item_id);
    }
  }

  async function addScheduleTask() {
    if (!taskName.trim()) return;
    if (!taskStart || !taskEnd) { alert("Please set both a start and due date."); return; }
    if (new Date(taskEnd) < new Date(taskStart)) { alert("End date can't be before the start date."); return; }
    const { data, error } = await supabase
      .from("schedule_tasks")
      .insert({
        project_id: projectId,
        name: taskName.trim(),
        line_item_id: taskLineItemId || null,
        start_date: taskStart,
        end_date: taskEnd,
        percent_complete: 0,
        sort_order: scheduleTasks.length,
      })
      .select().single();
    if (!error && data) {
      setScheduleTasks((prev) => [...prev, data].sort((a, b) => new Date(a.start_date) - new Date(b.start_date)));
      setTaskName(""); setTaskLineItemId("");
    }
  }

  async function setTaskProgress(id, pct) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    setScheduleTasks((prev) => prev.map((t) => (t.id === id ? { ...t, percent_complete: clamped } : t)));
    await supabase.from("schedule_tasks").update({ percent_complete: clamped }).eq("id", id);
  }

  async function removeScheduleTask(id) {
    if (!window.confirm("Delete this task? This can't be undone.")) return;
    setScheduleTasks((prev) => prev.filter((t) => t.id !== id));
    await supabase.from("schedule_tasks").delete().eq("id", id);
  }

  // Document & Drawings register — categorized, versioned files stored in the
  // private "documents" bucket under projectId/... so the storage RLS policy
  // (first path segment = project id, owner match) covers it. Distinct from
  // the lightweight "Plans" quick-reference list: this is the full register
  // with category, version, and optional line-item linkage.
  async function handleDocumentUpload(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    for (const file of files) {
      const path = `${projectId}/documents/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage.from("documents").upload(path, file);
      if (upErr) continue;
      const existingVersions = documents.filter((d) => d.name === file.name);
      const version = existingVersions.length
        ? Math.max(...existingVersions.map((d) => d.version || 1)) + 1
        : 1;
      const { data, error } = await supabase
        .from("document_files")
        .insert({
          project_id: projectId,
          line_item_id: docLineItemId || null,
          name: file.name,
          category: docCategory,
          file_path: path,
          file_size: file.size,
          version,
        })
        .select().single();
      if (!error && data) {
        setDocuments((prev) => [data, ...prev]);
      }
    }
    e.target.value = "";
  }

  async function openDocument(doc) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.file_path, 60);
    if (error || !data?.signedUrl) {
      setImportMessage({ type: "error", text: "Couldn't open that file — please try again." });
      setTimeout(() => setImportMessage(null), 6000);
      return;
    }
    openExternalLink(data.signedUrl);
  }

  async function removeDocument(doc) {
    if (!window.confirm("Delete this document? This can't be undone.")) return;
    setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    await supabase.from("document_files").delete().eq("id", doc.id);
    await supabase.storage.from("documents").remove([doc.file_path]);
  }

  function fmtFileSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  useEffect(() => {
    if (!downloadMenuOpen) return;
    function handleOutside(e) {
      if (downloadMenuRef.current && !downloadMenuRef.current.contains(e.target)) setDownloadMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [downloadMenuOpen]);

  useEffect(() => {
    if (!quoteDownloadMenuOpen) return;
    function handleOutside(e) {
      if (quoteDownloadMenuRef.current && !quoteDownloadMenuRef.current.contains(e.target)) setQuoteDownloadMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [quoteDownloadMenuOpen]);

  // Download menu — the three formats a client or bank might ask for. PDF
  // reuses the existing print stylesheet (@media print already hides all
  // no-print controls), CSV/Excel export the live ledger rows directly
  // rather than the blank import template downloadTemplate() produces.
  function ledgerExportRows() {
    const header = ["Name", "Category", "Budget", "Actual", "Variance", "% Complete", "Subcontractor", "Claimed", "Certified"];
    const rows = items.map((i) => {
      const subName = subs.find((s) => s.id === i.subcontractor_id)?.name || "";
      const variance = Number(i.actual || 0) - Number(i.budget || 0);
      return [
        i.name || "",
        i.category || "",
        Number(i.budget || 0),
        Number(i.actual || 0),
        variance,
        Number(i.percent_complete || 0),
        subName,
        Number(i.claimed || 0),
        Number(i.certified || 0),
      ];
    });
    return [header, ...rows];
  }

  function exportFileBaseName() {
    const name = (project?.name || "project").trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
    return `${name || "project"}-cost-variance`;
  }

  function exportLedgerCsv() {
    const csv = ledgerExportRows()
      .map((row) => row.map((cell) => {
        const s = String(cell ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${exportFileBaseName()}.csv`; a.click();
    URL.revokeObjectURL(url);
    setDownloadMenuOpen(false);
  }

  async function exportLedgerExcel() {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet(ledgerExportRows());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Cost Variance");
    XLSX.writeFile(wb, `${exportFileBaseName()}.xlsx`);
    setDownloadMenuOpen(false);
  }

  function exportLedgerPdf() {
    setDownloadMenuOpen(false);
    window.print();
  }

  async function logSnapshot() {
    const { data, error } = await supabase
      .from("snapshots")
      .insert({ project_id: projectId, budget: totals.revisedBudget, actual: totals.actual, variance: totals.variance })
      .select().single();
    if (!error && data) {
      setSnapshots((prev) => [...prev, data]);
      setImportMessage({ type: "success", text: `Snapshot logged — ${fmt(totals.actual)} actual, ${totals.variance >= 0 ? "+" : ""}${fmt(totals.variance)} variance.` });
    } else {
      setImportMessage({ type: "error", text: "Couldn't log that snapshot — please try again." });
    }
    setTimeout(() => setImportMessage(null), 6000);
  }

  async function removeSnapshot(id) {
    if (!window.confirm("Delete this snapshot? This can't be undone.")) return;
    setSnapshots((prev) => prev.filter((s) => s.id !== id));
    await supabase.from("snapshots").delete().eq("id", id);
  }

  function reportRecipientList() {
    const list = [...reportRecipients];
    const draft = reportRecipientDraft.trim();
    if (draft && !list.includes(draft)) list.push(draft);
    return list;
  }

  function addReportRecipient() {
    const email = reportRecipientDraft.trim().replace(/,$/, "");
    if (email && !reportRecipients.includes(email)) setReportRecipients((r) => [...r, email]);
    setReportRecipientDraft("");
  }

  // Deliberately simple: weekly always lands on the next occurrence of
  // send_day (never today, even if today matches, to avoid an ambiguous
  // "did today's send already go out" edge case); monthly clamps the day to
  // 1-28 so every month has that date, sidestepping Feb/30-day-month
  // handling entirely rather than getting it subtly wrong. The schedule
  // runner (see the send-client-report / run-due-reports edge functions)
  // recomputes next_send_at the same way after every actual send, so this
  // approximation never drifts — it just re-derives from "now" each time.
  function computeNextSendAt(frequency, sendDay) {
    if (frequency === "none") return null;
    const next = new Date();
    next.setHours(8, 0, 0, 0);
    if (frequency === "weekly") {
      const targetDow = Number(sendDay) || 0;
      const daysUntil = (targetDow - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + (daysUntil === 0 ? 7 : daysUntil));
    } else {
      const targetDom = Math.min(Math.max(Number(sendDay) || 1, 1), 28);
      next.setDate(1);
      next.setMonth(next.getMonth() + 1);
      next.setDate(targetDom);
    }
    return next.toISOString();
  }

  async function saveReportProfile() {
    setReportSaving(true);
    const recipients = reportRecipientList();
    const payload = {
      project_id: projectId,
      name: "Client Report",
      sections: reportSections,
      note: reportNote,
      recipients,
      frequency: reportFrequency,
      send_day: reportFrequency === "none" ? null : reportSendDay,
      next_send_at: computeNextSendAt(reportFrequency, reportSendDay),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = reportProfile
      ? await supabase.from("report_profiles").update(payload).eq("id", reportProfile.id).select().single()
      : await supabase.from("report_profiles").insert(payload).select().single();
    setReportSaving(false);
    if (error || !data) {
      setReportMessage({ type: "error", text: "Couldn't save that — please try again." });
    } else {
      setReportProfile(data);
      setReportRecipients(recipients);
      setReportRecipientDraft("");
      setReportMessage({ type: "success", text: "Report profile saved." });
    }
    setTimeout(() => setReportMessage(null), 6000);
  }

  async function sendReportNow() {
    const recipients = reportRecipientList();
    if (!recipients.length) {
      setReportMessage({ type: "error", text: "Add at least one recipient email first." });
      setTimeout(() => setReportMessage(null), 6000);
      return;
    }
    setReportSending(true);
    const { error } = await supabase.functions.invoke("send-client-report", {
      body: {
        project_id: projectId,
        recipients,
        sections: reportSections,
        note: reportNote,
        report_profile_id: reportProfile?.id ?? null,
      },
    });
    setReportSending(false);
    if (error) {
      setReportMessage({ type: "error", text: "Couldn't send that report — please try again." });
    } else {
      setReportRecipients(recipients);
      setReportRecipientDraft("");
      setReportMessage({ type: "success", text: `Report sent to ${recipients.join(", ")}.` });
    }
    setTimeout(() => setReportMessage(null), 6000);
  }

  if (!loaded || !project) {
    return (
      <div style={styles.page}>
        <GlobalStyles />
        <PageHeader current={null} onNavigate={onNavigate} userEmail={userEmail} onSignOut={onSignOut} hideTitle />
        <div style={{ ...styles.footer, textAlign: "center", padding: 60 }}>Loading project…</div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <input ref={fileInputRef} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,application/pdf" onChange={handleImportFile} style={{ display: "none" }} />
      <input ref={attachInputRef} type="file" onChange={handleAttachFile} style={{ display: "none" }} />

      {/* Shared app nav (logo, hamburger, full-screen menu overlay), same
          component every other page uses — this page previously had none of
          its own, which was the main inconsistency. Its own title block
          (eyebrow, editable project name, logo) still renders below, so the
          shared header's title row is hidden here. */}
      <PageHeader current={null} onNavigate={onNavigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={logoUrl} hideTitle />

      <div className="no-print" style={styles.backRow}>
        <button style={styles.backBtn} onClick={onBack}>← All projects</button>
      </div>

      <div style={styles.titleBlock}>
        <div style={styles.titleBlockLeft}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            {/* Deliberately not "no-print" — this is the header of the
                exported/printed cost sheet, so the company logo needs to
                pull through onto the PDF, not just show on screen. */}
            {logoUrl && <img src={logoUrl} alt="Company logo" style={styles.companyLogoMark} />}
            <div style={{ ...styles.eyebrowProminent, marginLeft: 12 }}>COST VARIANCE SHEET</div>
            <span style={styles.titleDivider}>·</span>
            <input
              style={styles.projectInput}
              value={project.name}
              onChange={(e) => {
                const name = e.target.value;
                setProject((p) => ({ ...p, name }));
                pendingSaves.current["project:name"] = { table: "projects_v2", id: projectId, patch: { name } };
                if (saveTimers.current.projectName) clearTimeout(saveTimers.current.projectName);
                saveTimers.current.projectName = setTimeout(() => flushPending("project:name"), 500);
              }}
            />
          </div>
        </div>
        <div style={styles.titleBlockRight} className="no-print">
          <div style={styles.tbCell}>
            <span style={styles.tbLabel}>DATE</span>
            <span style={styles.tbValue}>{new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}</span>
          </div>
          <div style={styles.tbCell}>
            <span style={styles.tbLabel}>RETENTION</span>
            <span style={styles.tbValue}>
              <input type="number" value={totals.retentionPct}
                onChange={(e) => {
                  const v = Number(e.target.value) || 0;
                  setProject((p) => ({ ...p, retention_pct: v }));
                  supabase.from("projects_v2").update({ retention_pct: v }).eq("id", projectId).then(({ error }) => { if (error) console.error("Save failed", error); });
                }}
                style={styles.retentionInput} />%
            </span>
          </div>
          <div style={styles.tbCell}>
            <span style={styles.tbLabel}>LINES</span>
            <span style={styles.tbValue}>{items.length}</span>
          </div>
        </div>
      </div>

      <div style={styles.summaryStrip}>
        <SummaryCard
          label="Original budget"
          value={fmt(totals.budget)}
          sub={`${items.length} line item${items.length === 1 ? "" : "s"}`}
          popoverLabel="Budget by category"
          popover={
            budgetByCategoryRows.length ? (
              <>
                <div style={styles.summaryPopoverTitle}>Budget by category</div>
                {budgetByCategoryRows.map((r, idx) => (
                  <div key={r.key} style={idx === budgetByCategoryRows.length - 1 ? styles.summaryPopoverRowLast : styles.summaryPopoverRow}>
                    <span style={{ ...styles.summaryPopoverDot, background: r.dot }} />
                    <span style={styles.summaryPopoverName}>{r.name}</span>
                    <span style={styles.summaryPopoverValue}>{r.value}</span>
                  </div>
                ))}
              </>
            ) : null
          }
        />
        {approvedCoTotal !== 0 && (
          <SummaryCard
            label="Revised budget"
            value={fmt(totals.revisedBudget)}
            accent="var(--tm-warn)"
            sub={`${approvedChangeOrders.length} approved change order${approvedChangeOrders.length === 1 ? "" : "s"}`}
            popoverLabel="Approved change orders"
            popover={
              approvedChangeOrders.length ? (
                <>
                  <div style={styles.summaryPopoverTitle}>Approved change orders</div>
                  {approvedChangeOrders.map((co, idx) => (
                    <div key={co.id} style={idx === approvedChangeOrders.length - 1 ? styles.summaryPopoverRowLast : styles.summaryPopoverRow}>
                      <span style={styles.summaryPopoverName}>{co.description || "Untitled"}</span>
                      <span style={styles.summaryPopoverValue}>+{fmt(Number(co.amount || 0))}</span>
                    </div>
                  ))}
                  <div style={styles.summaryPopoverFoot}>Adds {fmt(approvedCoTotal)} to the original budget.</div>
                </>
              ) : null
            }
          />
        )}
        <SummaryCard
          label="Actual spend"
          value={fmt(totals.actual)}
          sub={totals.budget ? `${((totals.actual / totals.budget) * 100).toFixed(1)}% of original budget` : undefined}
          popoverLabel="Spend by category"
          popover={
            spendByCategoryRows.length ? (
              <>
                <div style={styles.summaryPopoverTitle}>Spend vs budget</div>
                {spendByCategoryRows.map((r, idx) => (
                  <div key={r.key} style={idx === spendByCategoryRows.length - 1 ? styles.summaryPopoverRowLast : styles.summaryPopoverRow}>
                    <span style={{ ...styles.summaryPopoverDot, background: r.dot }} />
                    <span style={styles.summaryPopoverName}>{r.name}</span>
                    <span style={{ ...styles.summaryPopoverValue, ...(r.over ? { color: "var(--tm-neg)" } : {}) }}>{r.value}</span>
                  </div>
                ))}
              </>
            ) : null
          }
        />
        <SummaryCard
          label="Variance"
          value={`${totals.variance > 0 ? "+" : ""}${fmt(totals.variance)}`}
          accent={totals.variance > 0 ? "var(--tm-neg)" : totals.variance < 0 ? "var(--tm-pos)" : undefined}
          sub={`${totals.pct > 0 ? "+" : ""}${totals.pct.toFixed(1)}% · ${overCount} line${overCount === 1 ? "" : "s"} over`}
          popoverLabel="What is driving the variance"
          popover={
            overCategories.length ? (
              <>
                <div style={styles.summaryPopoverTitle}>Driving the overrun</div>
                {overCategories.map((c, idx) => (
                  <div key={c.category} style={idx === overCategories.length - 1 ? styles.summaryPopoverRowLast : styles.summaryPopoverRow}>
                    <span style={styles.summaryPopoverName}>{c.category}</span>
                    <span style={{ ...styles.summaryPopoverValue, color: "var(--tm-neg)" }}>+{fmt(c.variance)}</span>
                  </div>
                ))}
                <div style={styles.summaryPopoverFoot}>
                  Together, {totals.variance > 0 ? Math.round((overCategoryTotal / totals.variance) * 100) : 100}% of the overrun.
                </div>
              </>
            ) : (
              <p style={styles.summaryPopoverNote}>No categories are currently over budget.</p>
            )
          }
        />
        <SummaryCard
          label="Retention held"
          value={fmt(totals.retentionHeld)}
          sub={`${totals.retentionPct}% of certified claims`}
          popoverLabel="About retention"
          popover={
            <p style={styles.summaryPopoverNote}>
              Held back from certified claims at {totals.retentionPct}%, released on the practical completion certificate — not a cost, a timing difference.
            </p>
          }
        />
        <FlaggedLinesCard
          label="Flagged lines"
          value={`${overCount} over · ${watchCount} watch`}
          accent={overCount ? "var(--tm-neg)" : watchCount ? "var(--tm-warn)" : "var(--tm-pos)"}
          items={flaggedItems}
          sub={`of ${items.length} line item${items.length === 1 ? "" : "s"}`}
        />
      </div>

      {totals.pct > 0 && (
        <div style={styles.warningBanner}>
          You're trending {totals.pct.toFixed(1)}% over the revised budget on this project. Review flagged lines below before your next client meeting.
        </div>
      )}
      {aheadCount > 0 && (
        <div style={{ ...styles.warningBanner, borderLeftColor: "var(--tm-warn-mark)", background: "var(--tm-warn-fill)", color: "var(--text-primary)" }}>
          {aheadCount} line{aheadCount > 1 ? "s are" : " is"} spending ahead of physical progress. Check the Progress column below.
        </div>
      )}

      <div className="no-print" style={styles.categoryStrip}>
        {categoryRollup.map((c) => (
          <div key={c.category} style={styles.categoryCard}>
            <div style={styles.categoryHead}>
              <span style={{ ...styles.categoryDot, background: CATEGORY_COLOR[c.category] }} />
              <span style={styles.categoryName}>{c.category}</span>
            </div>
            <div style={styles.categoryNums}>
              <span style={styles.categoryBudget}>{fmt(c.budget)}</span>
              <span style={{ ...styles.categoryVariance, color: c.variance > 0 ? "var(--tm-neg)" : c.variance < 0 ? "var(--tm-pos)" : "var(--text-secondary)" }}>
                {c.variance > 0 ? "+" : ""}{fmt(c.variance)}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="no-print" style={styles.importRow}>
        <button style={styles.importBtn} onClick={() => fileInputRef.current?.click()}>Import BOQ, CSV, or PDF</button>
        <select style={{ ...styles.addInput, maxWidth: 220 }} defaultValue="" onChange={(e) => { applyTemplate(e.target.value); e.target.value = ""; }}>
          <option value="">Apply a template…</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button style={styles.importBtn} onClick={saveAsTemplate}>Save as template</button>
        {importMessage && (
          <span style={{ fontSize: 12.5, color: importMessage.type === "error" ? "var(--danger)" : "var(--success)" }}>{importMessage.text}</span>
        )}
        <div ref={downloadMenuRef} style={{ position: "relative", marginLeft: "auto" }}>
          <button style={styles.exportBtn} onClick={() => setDownloadMenuOpen((v) => !v)}>Download</button>
          {downloadMenuOpen && (
            <div style={styles.downloadMenuPopover}>
              <button style={styles.logoMenuItem} onClick={exportLedgerPdf}>PDF</button>
              <button style={styles.logoMenuItem} onClick={exportLedgerExcel}>Excel</button>
              <button style={styles.logoMenuItem} onClick={exportLedgerCsv}>CSV</button>
            </div>
          )}
        </div>
      </div>

      <div className="no-print" style={styles.toggleGroupWrap}>
        <div style={styles.toggleGroupLabel}>Site & Delivery</div>
        <div style={styles.viewToggle}>
          {[
            ["purchaseorders", `Purchase Orders${purchaseOrders.length ? ` (${purchaseOrders.length})` : ""}`],
            ["tenders", `Tenders${tenders.length ? ` (${tenders.length})` : ""}`],
            ["schedule", `Schedule${scheduleTasks.length ? ` (${scheduleTasks.length})` : ""}`],
            ["documents", `Documents${documents.length ? ` (${documents.length})` : ""}`],
            ["plans", `Plans${(project?.plans || []).length ? ` (${(project.plans || []).length})` : ""}`],
            ["changeorders", `Change Orders${changeOrders.length ? ` (${changeOrders.length})` : ""}`],
          ].map(([key, label]) => {
            const mc = MODULE_COLOR[key];
            const active = view === key;
            return (
              <button
                key={key}
                style={{
                  ...styles.toggleBtn,
                  ...(mc ? { color: mc.solid, background: mc.tint } : {}),
                  ...(active ? (mc ? { background: mc.solid, color: "#FFFFFF", fontWeight: 600 } : styles.toggleBtnActive) : {}),
                }}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="no-print" style={styles.toggleGroupWrap}>
        <div style={styles.toggleGroupLabel}>Budget & Reporting</div>
        <div style={styles.viewToggle}>
          {[
            ["ledger", "Cost & Progress"],
            ["quote", "Quote"],
            ["payments", "Payments & Retention"],
            ["charts", "Charts"],
            ["trend", "Trend"],
            ["clientreports", "Client Reports"],
          ].map(([key, label]) => {
            const mc = MODULE_COLOR[key];
            const active = view === key;
            return (
              <button
                key={key}
                style={{
                  ...styles.toggleBtn,
                  ...(mc ? { color: mc.solid, background: mc.tint } : {}),
                  ...(active ? (mc ? { background: mc.solid, color: "#FFFFFF", fontWeight: 600 } : styles.toggleBtnActive) : {}),
                }}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {view === "ledger" && (
        <>
          <ModuleBanner
            moduleKey="ledger"
            stat={`${totals.variance >= 0 ? "+" : "-"}${fmt(Math.abs(totals.variance))}`}
            statLabel={totals.variance > 0 ? "over budget" : "under budget"}
          />
        <div style={styles.ledger}>
          <div style={styles.ledgerHeaderRow}>
            <span style={{ ...styles.thCell, flex: 2.4 }}>Line item</span>
            <span style={{ ...styles.thCell, flex: 1.1, textAlign: "right" }}>Budget</span>
            <span style={{ ...styles.thCell, flex: 1.1, textAlign: "right" }}>Actual</span>
            <span style={{ ...styles.thCell, flex: 1.5 }} className="no-print">Tolerance</span>
            <span style={{ ...styles.thCell, flex: 1.4 }} className="no-print">Progress vs spend</span>
            <span style={{ ...styles.thCell, flex: 0.9, textAlign: "center" }}>Status</span>
            <span style={{ ...styles.thCell, flex: 0.6 }} className="no-print"></span>
          </div>

          {items.map((item) => {
            const status = statusFor(item.budget, item.actual);
            const s = STATUS[status];
            const ratio = item.budget ? Math.min(item.actual / item.budget, 1.4) : 0;
            const pctLabel = item.budget ? (((item.actual - item.budget) / item.budget) * 100).toFixed(1) : "0.0";
            const gap = progressGapFor(item.budget, item.actual, item.percent_complete);
            const spentPct = item.budget ? Math.min((item.actual / item.budget) * 100, 100) : 0;
            const progPct = item.percent_complete != null ? Math.min(Number(item.percent_complete), 100) : 0;
            const gapFlag = gap != null && gap > 15;
            const isOpen = expandedRow === item.id;
            const subName = subs.find((sb) => sb.id === item.subcontractor_id)?.name;

            return (
              <React.Fragment key={item.id}>
                <div style={styles.row}>
                  <span style={{ ...styles.tdCell, flex: 2.4 }}>
                    <div style={{ fontWeight: 500 }}>{item.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: CATEGORY_COLOR[item.category] || "#6E6E73" }} />
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{item.category || "Other"}</span>
                      </span>
                      {subName && <span style={{ fontSize: 11, color: "#8B5FA3" }}>· {subName}</span>}
                      <button className="no-print" style={styles.miniLink} onClick={() => { setExpandedRow(isOpen ? null : item.id); setNoteDraft(item.notes || ""); }}>
                        {isOpen ? "Close" : "Details"}
                      </button>
                    </div>
                  </span>
                  <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(item.budget)}</span>
                  <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>
                    {editingCell === `${item.id}:actual` ? (
                      <input autoFocus style={styles.inlineInput} value={editValue} type="number"
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => saveEdit(item.id, "actual")}
                        onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "actual")} />
                    ) : (
                      <button style={styles.actualButton} onClick={() => startEdit(item.id, "actual", item.actual)}>{fmt(item.actual)}</button>
                    )}
                  </span>
                  <span style={{ ...styles.tdCell, flex: 1.5 }} className="no-print">
                    <div style={styles.gaugeTrack}>
                      <div style={styles.gaugeTolMark} />
                      <div style={{ ...styles.gaugeFill, width: `${Math.min(ratio * 71.4, 100)}%`, background: s.color }} />
                    </div>
                    <span style={{ ...styles.gaugeLabel, color: s.color }}>{pctLabel > 0 ? "+" : ""}{pctLabel}%</span>
                  </span>
                  <span style={{ ...styles.tdCell, flex: 1.4 }} className="no-print">
                    <div style={styles.dualBarTrack}>
                      <div style={{ ...styles.dualBarFill, width: `${progPct}%`, background: "var(--success)", top: 0 }} />
                      <div style={{ ...styles.dualBarFill, width: `${spentPct}%`, background: gapFlag ? "var(--danger)" : "#3D6FA6", top: 8 }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                      <span style={{ fontSize: 10, color: "var(--success)" }}>{progPct.toFixed(0)}% done</span>
                      <span style={{ fontSize: 10, color: gapFlag ? "var(--danger)" : "#3D6FA6" }}>{spentPct.toFixed(0)}% spent</span>
                    </div>
                  </span>
                  <span style={{ ...styles.tdCell, flex: 0.9, textAlign: "center" }}>
                    <span style={{ ...styles.statusPill, color: s.color, background: s.bg }}>{s.label}</span>
                    {gapFlag && (
                      <div className="no-print" style={{ marginTop: 4 }}>
                        <span style={{ ...styles.statusPill, color: "var(--danger)", background: "rgba(193,70,43,0.12)", fontSize: 9 }}>SPEND AHEAD</span>
                      </div>
                    )}
                  </span>
                  <span style={{ ...styles.tdCell, flex: 0.6, textAlign: "right" }} className="no-print">
                    <button style={styles.removeBtn} onClick={() => removeItem(item.id)}>✕</button>
                  </span>
                </div>

                {isOpen && (
                  <div className="no-print" style={styles.detailPanel}>
                    <div style={styles.detailGrid}>
                      <label style={styles.detailField}>
                        <span style={styles.detailLabel}>Subcontractor</span>
                        <select style={styles.addInput} value={item.subcontractor_id || ""}
                          onChange={(e) => scheduleSave(item.id, { subcontractor_id: e.target.value || null })}>
                          <option value="">— none —</option>
                          {subs.map((sb) => <option key={sb.id} value={sb.id}>{sb.name}</option>)}
                        </select>
                      </label>
                      <label style={styles.detailField}>
                        <span style={styles.detailLabel}>% complete</span>
                        <input style={styles.addInput} type="number" value={item.percent_complete ?? ""}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => scheduleSave(item.id, { percent_complete: Number(e.target.value) || 0 })} />
                      </label>
                      <label style={styles.detailField}>
                        <span style={styles.detailLabel}>Quality</span>
                        <select style={styles.addInput} value={item.quality_rating || ""}
                          onChange={(e) => scheduleSave(item.id, { quality_rating: e.target.value ? Number(e.target.value) : null })}>
                          <option value="">—</option>
                          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </label>
                      <label style={styles.detailField}>
                        <span style={styles.detailLabel}>Due date</span>
                        <input style={styles.addInput} type="date" value={item.due_date || ""}
                          onChange={(e) => scheduleSave(item.id, { due_date: e.target.value || null })} />
                      </label>
                      <label style={styles.detailField}>
                        <span style={styles.detailLabel}>Completed date</span>
                        <input style={styles.addInput} type="date" value={item.completed_date || ""}
                          onChange={(e) => scheduleSave(item.id, { completed_date: e.target.value || null })} />
                      </label>
                      <label style={styles.detailField}>
                        <span style={styles.detailLabel}>Claimed</span>
                        <div style={styles.currencyInputWrap}>
                          <span style={styles.currencyPrefix}>R</span>
                          <input style={{ ...styles.addInput, border: "none", padding: 0, flex: 1 }} type="number" value={item.claimed ?? ""}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => scheduleSave(item.id, { claimed: Number(e.target.value) || 0 })} />
                        </div>
                      </label>
                      <label style={styles.detailField}>
                        <span style={styles.detailLabel}>Certified</span>
                        <div style={styles.currencyInputWrap}>
                          <span style={styles.currencyPrefix}>R</span>
                          <input style={{ ...styles.addInput, border: "none", padding: 0, flex: 1 }} type="number" value={item.certified ?? ""}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => scheduleSave(item.id, { certified: Number(e.target.value) || 0 })} />
                        </div>
                      </label>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <span style={styles.detailLabel}>Site note</span>
                      <textarea style={styles.notesTextarea} value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        placeholder="Why is this over/under? e.g. supplier price increase in March, or scope reduced on site." />
                      <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                        <button style={styles.addBtn} onClick={() => { scheduleSave(item.id, { notes: noteDraft }); setExpandedRow(null); }}>Save note</button>
                        <button style={styles.importBtn} onClick={() => triggerAttach(item)}>Attach file</button>
                        {item.attachments?.map((a, idx) => (
                          <button key={idx} onClick={() => openAttachment(a)} style={{ ...styles.attachmentLink, background: "none", border: "none", cursor: "pointer", padding: 0 }}>📎 {a.name}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}

          <div className="no-print" style={styles.addRow}>
            <input style={{ ...styles.addInput, flex: 2 }} placeholder="New line item" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <select style={{ ...styles.addInput, flex: 1.2 }} value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input style={{ ...styles.addInput, flex: 1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}
              placeholder="Budget (optional)" type="number" value={newBudget} onChange={(e) => setNewBudget(e.target.value)} />
            <button style={styles.addBtn} onClick={addItem}>+ Add line</button>
          </div>
        </div>
        </>
      )}

      {view === "charts" && (
        <div style={styles.chartGrid}>
          <div style={styles.chartCardGreen}>
            <div style={styles.chartTitle}><span style={{ ...styles.chartDot, background: "var(--success)" }} />Budget vs actual</div>
            <div style={styles.chartSub}>Largest eight line items by budget.</div>
            <BarChartBudgetVsActual items={items} />
          </div>
          <div style={styles.chartCardBlue}>
            <div style={styles.chartTitle}><span style={{ ...styles.chartDot, background: "#3D6FA6" }} />Where the money went</div>
            <div style={styles.chartSub}>Actual spend split by category.</div>
            <DonutCategorySplit rollup={categoryRollup} />
          </div>
          <div style={styles.chartCardRed}>
            <div style={styles.chartTitle}><span style={{ ...styles.chartDot, background: "var(--danger)" }} />Progress against spend</div>
            <div style={styles.chartSub}>Progress bar vs spend bar, per line item.</div>
            <ProgressBars items={items} />
          </div>
          <div style={styles.chartCardGold}>
            <div style={styles.chartTitle}><span style={{ ...styles.chartDot, background: "var(--warning)" }} />Category variance</div>
            <div style={styles.chartSub}>Positive bars are overruns.</div>
            {categoryRollup.length === 0 ? (
              <EmptyChart label="Add line items to see category variance." />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 6 }}>
                {categoryRollup.map((c) => {
                  const maxAbs = Math.max(...categoryRollup.map((x) => Math.abs(x.variance)), 1);
                  const over = c.variance > 0;
                  const offset = c.variance === 0 ? 0 : (Math.abs(c.variance) / maxAbs) * 42;
                  const dotPos = 50 + (over ? offset : -offset);
                  const dotColor = c.variance === 0 ? "#8E8E93" : over ? "var(--danger)" : "var(--success)";
                  return (
                    <div key={c.category}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>{c.category}</span>
                        <span style={{ fontSize: 11.5, fontFamily: "'Space Grotesk', sans-serif", color: dotColor }}>
                          {over ? "+" : ""}{fmtShort(c.variance)}
                        </span>
                      </div>
                      <div style={{ position: "relative", height: 22, background: "var(--bg-secondary)", borderRadius: 4 }}>
                        <div style={{ position: "absolute", left: "50%", top: -4, width: 1, height: 30, background: "var(--border-color)" }} />
                        {c.variance !== 0 && (
                          <div style={{
                            position: "absolute", top: "50%", height: 2, transform: "translateY(-1px)",
                            left: over ? "50%" : `${dotPos}%`, width: `${offset}%`,
                            background: dotColor,
                          }} />
                        )}
                        <div style={{
                          position: "absolute", top: "50%", width: 12, height: 12, borderRadius: "50%",
                          transform: "translate(-50%,-50%)", border: "2px solid #FFF", boxShadow: "0 0 0 1px rgba(0,0,0,0.08)",
                          left: `${dotPos}%`, background: dotColor,
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div style={styles.chartCardRed}>
            <div style={styles.chartTitle}><span style={{ ...styles.chartDot, background: "var(--danger)" }} />Top overruns</div>
            <div style={styles.chartSub}>Line items furthest over budget.</div>
            <TopOverruns items={items} />
          </div>
          <div style={styles.chartCardGreen}>
            <div style={styles.chartTitle}><span style={{ ...styles.chartDot, background: "var(--success)" }} />Claims vs certified vs paid</div>
            <div style={styles.chartSub}>Spot claims still waiting on sign-off.</div>
            <ClaimsCertifiedChart items={items} />
          </div>
        </div>
      )}

      {view === "quote" && (
        <div style={styles.quoteSheet}>
          <div className="no-print" style={styles.quoteClientEditRow}>
            <span style={styles.quoteClientEditLabel}>Quoting to</span>
            <input
              style={{ ...styles.addInput, flex: "1 1 220px", maxWidth: 280 }}
              placeholder="Client / company name"
              value={project.client_name || ""}
              onChange={(e) => {
                const client_name = e.target.value;
                setProject((p) => ({ ...p, client_name }));
                pendingSaves.current["project:clientName"] = { table: "projects_v2", id: projectId, patch: { client_name } };
                if (saveTimers.current.clientName) clearTimeout(saveTimers.current.clientName);
                saveTimers.current.clientName = setTimeout(() => flushPending("project:clientName"), 500);
              }}
            />
            <div ref={quoteDownloadMenuRef} style={{ position: "relative", marginLeft: "auto" }}>
              <button style={styles.exportBtn} onClick={() => setQuoteDownloadMenuOpen((v) => !v)}>Download</button>
              {quoteDownloadMenuOpen && (
                <div style={styles.downloadMenuPopover}>
                  <button style={styles.logoMenuItem} onClick={exportQuotePdf}>PDF</button>
                  <button style={styles.logoMenuItem} onClick={exportQuoteExcel}>Excel</button>
                  <button style={styles.logoMenuItem} onClick={exportQuoteWord}>Word</button>
                </div>
              )}
            </div>
          </div>

          <div ref={quoteContentRef}>
            <div style={styles.quoteHead}>
              <div>
                <div style={styles.quoteEyebrow}>QUOTATION</div>
                <div style={styles.quoteProjectName}>{project.name}</div>
              </div>
              <div style={styles.quoteMeta}>
                <div>Date: {new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}</div>
                <div>Valid for 30 days from date of issue</div>
              </div>
            </div>

            {(logoUrl || project.client_name) && (
              <div style={styles.quoteClientBlock}>
                <div style={styles.quoteEyebrow}>PREPARED FOR</div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {logoUrl && (
                    <img src={logoUrl} alt="Company logo" style={styles.quoteClientLogo} />
                  )}
                  {project.client_name && <div style={styles.quoteClientName}>{project.client_name}</div>}
                </div>
              </div>
            )}

            {categoryRollup.map((cat) => {
              const catItems = items.filter((i) => (i.category || "Other") === cat.category);
              return (
                <div key={cat.category} style={{ marginBottom: 24 }}>
                  <div style={styles.quoteCatHeading}>{cat.category}</div>
                  {catItems.map((item) => (
                    <div key={item.id} style={styles.quoteRow}>
                      <span style={{ flex: 3 }}>{item.name}</span>
                      <span style={{ flex: 1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(item.budget)}</span>
                    </div>
                  ))}
                  <div style={{ ...styles.quoteRow, borderTop: "1px solid var(--border-color)", fontWeight: 600 }}>
                    <span style={{ flex: 3 }}>Subtotal — {cat.category}</span>
                    <span style={{ flex: 1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(cat.budget)}</span>
                  </div>
                </div>
              );
            })}

            <div style={styles.quoteTotalRow}>
              <span>Total</span>
              <span style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(totals.budget)}</span>
            </div>

            <p style={styles.quoteFootnote}>
              This quotation covers the work described above at the prices listed. It does not include
              variations, delays, or site conditions discovered after work begins — those will be raised
              separately as change orders. Prices exclude VAT unless stated otherwise.
            </p>
          </div>
        </div>
      )}

      {view === "payments" && (
        <>
          <ModuleBanner
            moduleKey="payments"
            stat={`${totals.certified ? Math.round((totals.paidToDate / totals.certified) * 100) : 0}%`}
            statLabel="released"
            chartArg={totals.certified ? (totals.paidToDate / totals.certified) * 100 : 0}
          />
        <div style={{ ...styles.ledger, overflowX: "auto" }}>
          <input
            ref={paymentDocInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={handlePaymentDocUpload}
          />
          <div style={{ ...styles.ledgerHeaderRow, minWidth: 1140 }}>
            <span style={{ ...styles.thCell, flex: 2.2 }}>Line item</span>
            <span style={{ ...styles.thCell, flex: 1.5, textAlign: "right" }}>Claimed</span>
            <span style={{ ...styles.thCell, flex: 1.5, textAlign: "right" }}>Certified</span>
            <span style={{ ...styles.thCell, flex: 1.5, textAlign: "right" }}>Retention held</span>
            <span style={{ ...styles.thCell, flex: 1.5, textAlign: "right" }}>Paid to date</span>
            <span style={{ ...styles.thCell, flex: 1.5, textAlign: "right" }}>Uncertified</span>
            <span style={{ ...styles.thCell, flex: 1.1, textAlign: "center" }}>Payment date</span>
            <span style={{ ...styles.thCell, flex: 1.1, textAlign: "center" }}>Document</span>
          </div>
          {items.map((item) => {
            const certified = Number(item.certified || 0);
            const claimed = Number(item.claimed || 0);
            const retentionHeld = certified * (totals.retentionPct / 100);
            const uncertified = claimed - certified;
            return (
              <div key={item.id} style={{ ...styles.row, minWidth: 1140 }}>
                <span style={{ ...styles.tdCell, flex: 2.2, fontWeight: 500 }}>{item.name}</span>
                <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>
                  {editingCell === `${item.id}:claimed` ? (
                    <input autoFocus style={styles.inlineInput} value={editValue} type="number"
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(item.id, "claimed")}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "claimed")} />
                  ) : (
                    <button style={styles.actualButton} onClick={() => startEdit(item.id, "claimed", item.claimed)}><Money value={claimed} /></button>
                  )}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>
                  {editingCell === `${item.id}:certified` ? (
                    <input autoFocus style={styles.inlineInput} value={editValue} type="number"
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(item.id, "certified")}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "certified")} />
                  ) : (
                    <button style={styles.actualButton} onClick={() => startEdit(item.id, "certified", item.certified)}><Money value={certified} /></button>
                  )}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: "var(--warning)" }}><Money value={retentionHeld} /></span>
                <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: "var(--success)" }}><Money value={certified - retentionHeld} /></span>
                <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: uncertified > 0 ? "var(--danger)" : "#6E6E73" }}><Money value={uncertified} /></span>
                <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "center" }} className="no-print">
                  <input
                    type="date"
                    style={{ ...styles.addInput, padding: "4px 6px", fontSize: 12 }}
                    value={item.payment_date || ""}
                    onChange={(e) => setPaymentDate(item.id, e.target.value)}
                  />
                </span>
                <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "center", fontFamily: "'Space Grotesk', sans-serif" }} className="print-only-status">
                  {item.payment_date ? new Date(item.payment_date + "T00:00:00").toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "center" }}>
                  {item.payment_doc_path ? (
                    <button onClick={() => openPaymentDoc(item)} style={{ ...styles.attachmentLink, background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 12 }}>
                      📎 {item.payment_doc_name}
                    </button>
                  ) : (
                    <button className="no-print" style={{ ...styles.addBtn, padding: "4px 10px", fontSize: 11.5 }} onClick={() => triggerPaymentDocUpload(item)}>
                      + Attach
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          <div style={{ ...styles.row, background: "var(--bg-secondary)", fontWeight: 600, minWidth: 1140 }}>
            <span style={{ ...styles.tdCell, flex: 2.2 }}>Totals</span>
            <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}><Money value={totals.claimed} /></span>
            <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}><Money value={totals.certified} /></span>
            <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: "var(--warning)" }}><Money value={totals.retentionHeld} /></span>
            <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: "var(--success)" }}><Money value={totals.paidToDate} /></span>
            <span style={{ ...styles.tdCell, flex: 1.5, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif", color: totals.uncertified > 0 ? "var(--danger)" : "#6E6E73" }}><Money value={totals.uncertified} /></span>
            <span style={{ ...styles.tdCell, flex: 1.1 }}></span>
            <span style={{ ...styles.tdCell, flex: 1.1 }}></span>
          </div>
        </div>
        </>
      )}

      {view === "changeorders" && (
        <>
          <ModuleBanner
            moduleKey="changeorders"
            stat={`${approvedCoTotal >= 0 ? "+" : "-"}${fmt(Math.abs(approvedCoTotal))}`}
            statLabel="net approved variations"
          />
        <div style={{ ...styles.ledger, overflowX: "auto" }}>
          <div style={{ ...styles.ledgerHeaderRow, minWidth: 860 }}>
            <span style={{ ...styles.thCell, flex: 2.2 }}>Description</span>
            <span style={{ ...styles.thCell, flex: 1, textAlign: "center" }}>Priority</span>
            <span style={{ ...styles.thCell, flex: 1, textAlign: "center" }}>PO #</span>
            <span style={{ ...styles.thCell, flex: 1, textAlign: "center" }}>Date</span>
            <span style={{ ...styles.thCell, flex: 1, textAlign: "right" }}>Amount</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "center" }}>Status</span>
            <span style={{ ...styles.thCell, flex: 0.6 }}></span>
          </div>
          {changeOrders.map((co) => (
            <div key={co.id} style={{ ...styles.row, minWidth: 860 }}>
              <span style={{ ...styles.tdCell, flex: 2.2 }}>{co.description}</span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center" }} className="no-print">
                <select value={co.priority || "Normal"} onChange={(e) => setCoPriorityValue(co.id, e.target.value)}
                  style={{ ...styles.addInput, padding: "4px 8px", fontSize: 12, color: co.priority === "High" ? "var(--danger)" : co.priority === "Low" ? "#6E6E73" : "var(--warning)" }}>
                  <option value="High">High</option>
                  <option value="Normal">Normal</option>
                  <option value="Low">Low</option>
                </select>
              </span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center" }} className="print-only-status">{co.priority || "Normal"}</span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center", fontFamily: "'Space Grotesk', sans-serif" }} className="no-print">
                <input
                  style={{ ...styles.addInput, padding: "4px 6px", fontSize: 12, textAlign: "center" }}
                  placeholder="—"
                  value={co.po_number || ""}
                  onChange={(e) => setChangeOrders((prev) => prev.map((c) => (c.id === co.id ? { ...c, po_number: e.target.value } : c)))}
                  onBlur={(e) => setCoPoNumberValue(co.id, e.target.value.trim())}
                />
              </span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center", fontFamily: "'Space Grotesk', sans-serif" }} className="print-only-status">{co.po_number || "—"}</span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center", fontFamily: "'Space Grotesk', sans-serif" }}>
                {co.co_date ? new Date(co.co_date + "T00:00:00").toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
              </span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(co.amount)}</span>
              <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "center" }} className="no-print">
                <select value={co.status} onChange={(e) => setCoStatus(co.id, e.target.value)}
                  style={{ ...styles.addInput, padding: "4px 8px", fontSize: 12, color: co.status === "approved" ? "var(--success)" : co.status === "rejected" ? "var(--danger)" : "var(--warning)" }}>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </span>
              <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "center" }} className="print-only-status">{co.status}</span>
              <span style={{ ...styles.tdCell, flex: 0.6, textAlign: "right" }} className="no-print">
                <button style={styles.removeBtn} onClick={() => removeChangeOrder(co.id)}>✕</button>
              </span>
            </div>
          ))}
          {changeOrders.length === 0 && (
            <div style={{ padding: 20, fontSize: 13, color: "var(--text-secondary)" }}>
              No change orders yet. Add one below when a client approves a variation to the original budget.
            </div>
          )}
          <div className="no-print" style={{ ...styles.addRow, minWidth: 860 }}>
            <input style={{ ...styles.addInput, flex: 2.2 }} placeholder="e.g. Additional retaining wall per client request" value={coDesc} onChange={(e) => setCoDesc(e.target.value)} />
            <select style={{ ...styles.addInput, flex: 1 }} value={coPriority} onChange={(e) => setCoPriority(e.target.value)}>
              <option value="High">High</option>
              <option value="Normal">Normal</option>
              <option value="Low">Low</option>
            </select>
            <input style={{ ...styles.addInput, flex: 1 }} placeholder="PO # (optional)" value={coPoNumber} onChange={(e) => setCoPoNumber(e.target.value)} />
            <input style={{ ...styles.addInput, flex: 1 }} type="date" value={coDate} onChange={(e) => setCoDate(e.target.value)} />
            <input style={{ ...styles.addInput, flex: 1, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }} placeholder="Amount" type="number" value={coAmount} onChange={(e) => setCoAmount(e.target.value)} />
            <button style={styles.addBtn} onClick={addChangeOrder}>+ Add change order</button>
          </div>
        </div>
        </>
      )}

      {view === "purchaseorders" && (
        <div style={{ ...styles.ledger, overflowX: "auto" }}>
          <div style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)" }}>
            Outstanding (not yet received): <strong style={{ color: "var(--text-primary)", fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(poOutstandingTotal)}</strong>
          </div>
          <div style={{ ...styles.ledgerHeaderRow, minWidth: 1180 }}>
            <span style={{ ...styles.thCell, flex: 1.4 }}>Supplier</span>
            <span style={{ ...styles.thCell, flex: 0.9 }}>PO #</span>
            <span style={{ ...styles.thCell, flex: 1.8 }}>Description</span>
            <span style={{ ...styles.thCell, flex: 1.4 }}>Against line item</span>
            <span style={{ ...styles.thCell, flex: 1, textAlign: "center" }}>Order date</span>
            <span style={{ ...styles.thCell, flex: 0.9, textAlign: "right" }}>Amount</span>
            <span style={{ ...styles.thCell, flex: 1.1, textAlign: "center" }}>Status</span>
            <span style={{ ...styles.thCell, flex: 0.5 }} className="no-print"></span>
          </div>
          {purchaseOrders.map((po) => {
            const linkedItem = items.find((i) => i.id === po.line_item_id);
            const poStatusColor = po.status === "received" ? "var(--success)" : po.status === "cancelled" ? "var(--danger)" : po.status === "confirmed" ? "var(--text-primary)" : po.status === "sent" ? "var(--warning)" : "var(--text-secondary)";
            return (
              <div key={po.id} style={{ ...styles.row, minWidth: 1180 }}>
                <span style={{ ...styles.tdCell, flex: 1.4 }}>{po.supplier_name}</span>
                <span style={{ ...styles.tdCell, flex: 0.9, fontFamily: "'Space Grotesk', sans-serif" }}>{po.po_number || "—"}</span>
                <span style={{ ...styles.tdCell, flex: 1.8 }}>{po.description || "—"}</span>
                <span style={{ ...styles.tdCell, flex: 1.4, color: "var(--text-secondary)" }}>{linkedItem ? linkedItem.name : "—"}</span>
                <span style={{ ...styles.tdCell, flex: 1, textAlign: "center", fontFamily: "'Space Grotesk', sans-serif" }}>
                  {po.order_date ? new Date(po.order_date + "T00:00:00").toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                </span>
                <span style={{ ...styles.tdCell, flex: 0.9, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(po.amount)}</span>
                <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "center" }} className="no-print">
                  <select value={po.status} onChange={(e) => setPoStatus(po.id, e.target.value)}
                    style={{ ...styles.addInput, padding: "4px 8px", fontSize: 12, color: poStatusColor, width: "100%" }}>
                    <option value="draft">Draft</option>
                    <option value="sent">Sent</option>
                    <option value="confirmed">Confirmed</option>
                    <option value="received">Received</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </span>
                <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "center", color: poStatusColor }} className="print-only-status">{po.status}</span>
                <span style={{ ...styles.tdCell, flex: 0.5, textAlign: "right" }} className="no-print">
                  <button style={styles.removeBtn} onClick={() => removePurchaseOrder(po.id)}>✕</button>
                </span>
              </div>
            );
          })}
          {purchaseOrders.length === 0 && (
            <div style={{ padding: 20, fontSize: 13, color: "var(--text-secondary)" }}>
              No purchase orders yet. Log a supplier order below to track it against this project's budget.
            </div>
          )}
          <div className="no-print" style={{ ...styles.addRow, minWidth: 1180, flexWrap: "nowrap" }}>
            <input style={{ ...styles.addInput, flex: 1.4, minWidth: 0 }} placeholder="Supplier name" value={poSupplier} onChange={(e) => setPoSupplier(e.target.value)} />
            <input style={{ ...styles.addInput, flex: 0.9, minWidth: 0 }} placeholder="PO # (optional)" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
            <input style={{ ...styles.addInput, flex: 1.8, minWidth: 0 }} placeholder="Description / materials" value={poDescription} onChange={(e) => setPoDescription(e.target.value)} />
            <select style={{ ...styles.addInput, flex: 1.4, minWidth: 0 }} value={poLineItemId} onChange={(e) => setPoLineItemId(e.target.value)}>
              <option value="">No line item</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
            <input style={{ ...styles.addInput, flex: 1, minWidth: 0 }} type="date" value={poOrderDate} onChange={(e) => setPoOrderDate(e.target.value)} />
            <input style={{ ...styles.addInput, flex: 0.9, minWidth: 0, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }} placeholder="Amount" type="number" value={poAmount} onChange={(e) => setPoAmount(e.target.value)} />
            <button style={{ ...styles.addBtn, flex: "1.6 0 auto" }} onClick={addPurchaseOrder}>+ Add purchase order</button>
          </div>
        </div>
      )}

      {view === "tenders" && (
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div className="no-print" style={{ ...styles.addRow, borderRadius: 18, marginBottom: 16 }}>
            <input style={{ ...styles.addInput, flex: "1.2 1 160px" }} placeholder="Trade (e.g. Plumbing)" value={tTrade} onChange={(e) => setTTrade(e.target.value)} />
            <input style={{ ...styles.addInput, flex: "2 1 200px" }} placeholder="Scope of work being tendered" value={tTitle} onChange={(e) => setTTitle(e.target.value)} />
            <select style={{ ...styles.addInput, flex: "1.4 1 160px" }} value={tLineItemId} onChange={(e) => setTLineItemId(e.target.value)}>
              <option value="">No line item</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
            <button style={{ ...styles.addBtn, flex: "1.4 0 auto" }} onClick={addTender}>+ New tender</button>
          </div>

          {tenders.length === 0 && (
            <div style={{ ...styles.ledger, padding: 20, fontSize: 13, color: "var(--text-secondary)" }}>
              No tenders yet. Raise one above to start collecting and comparing subcontractor bids before appointing anyone.
            </div>
          )}

          {tenders.map((tender) => {
            const bids = tenderBids.filter((b) => b.tender_id === tender.id).sort((a, b) => Number(a.amount) - Number(b.amount));
            const linkedItem = items.find((i) => i.id === tender.line_item_id);
            const draft = bidDrafts[tender.id] || { bidderName: "", subcontractorId: "", amount: "", notes: "" };
            const tenderStatusColor = tender.status === "awarded" ? "var(--success)" : tender.status === "cancelled" ? "var(--danger)" : "var(--accent)";
            return (
              <div key={tender.id} style={{ ...styles.scoreCard, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--accent)", background: "rgba(29,92,138,0.1)", borderRadius: 100, padding: "3px 10px" }}>{tender.trade || "Trade"}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: tenderStatusColor }}>{tender.status}</span>
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>{tender.title}</div>
                    {linkedItem && <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 2 }}>Against: {linkedItem.name}</div>}
                  </div>
                  <button className="no-print" style={styles.removeBtn} onClick={() => removeTender(tender.id)}>✕</button>
                </div>

                <div style={{ borderTop: "1px solid var(--border-color)", marginTop: 10, paddingTop: 10 }}>
                  {bids.length === 0 && <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "4px 0" }}>No bids logged yet.</div>}
                  {bids.map((bid) => {
                    const bidStatusColor = bid.status === "awarded" ? "var(--success)" : bid.status === "declined" ? "var(--danger)" : bid.status === "shortlisted" ? "var(--warning)" : "#6E6E73";
                    return (
                      <div key={bid.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border-color)" }}>
                        <div style={{ flex: 1.6, fontSize: 13.5, color: "var(--text-primary)" }}>{bid.bidder_name}</div>
                        <div style={{ flex: 1, fontSize: 13.5, fontFamily: "'Space Grotesk', sans-serif", textAlign: "right" }}>{fmt(bid.amount)}</div>
                        <div style={{ flex: 1.6, fontSize: 12.5, color: "var(--text-secondary)" }}>{bid.notes}</div>
                        <div style={{ flex: 0.9, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: bidStatusColor, textAlign: "center" }}>{bid.status}</div>
                        <div className="no-print" style={{ flex: 1.2, textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          {tender.status === "open" && bid.status !== "awarded" && bid.status !== "declined" && (
                            <button style={{ ...styles.addBtn, padding: "5px 10px", fontSize: 11.5 }} onClick={() => awardBid(tender, bid)}>Award</button>
                          )}
                          <button style={styles.removeBtn} onClick={() => removeBid(bid.id)}>✕</button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {tender.status === "open" && (
                  <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                    <input style={{ ...styles.addInput, flex: "1.4 1 150px" }} placeholder="Bidder / company name"
                      value={draft.bidderName} onChange={(e) => updateBidDraft(tender.id, { bidderName: e.target.value })} />
                    <select style={{ ...styles.addInput, flex: "1.4 1 150px" }}
                      value={draft.subcontractorId} onChange={(e) => updateBidDraft(tender.id, { subcontractorId: e.target.value })}>
                      <option value="">Not yet in Subcontractors</option>
                      {subs.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    <input style={{ ...styles.addInput, flex: "1 1 110px", textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }} placeholder="Amount" type="number"
                      value={draft.amount} onChange={(e) => updateBidDraft(tender.id, { amount: e.target.value })} />
                    <input style={{ ...styles.addInput, flex: "1.6 1 150px" }} placeholder="Notes (optional)"
                      value={draft.notes} onChange={(e) => updateBidDraft(tender.id, { notes: e.target.value })} />
                    <button style={{ ...styles.addBtn, flex: "1.1 0 auto" }} onClick={() => addBid(tender.id)}>+ Add bid</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {view === "schedule" && (() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dates = scheduleTasks.flatMap((t) => [new Date(t.start_date + "T00:00:00"), new Date(t.end_date + "T00:00:00")]);
        const rangeStart = dates.length ? new Date(Math.min(...dates)) : today;
        const rangeEnd = dates.length ? new Date(Math.max(...dates)) : today;
        const totalDays = Math.max(1, Math.round((rangeEnd - rangeStart) / 86400000) + 1);
        const dfmt = (d) => d.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
        const openTaskCount = scheduleTasks.filter((t) => Number(t.percent_complete || 0) < 100).length;
        return (
          <div style={{ maxWidth: 1180, margin: "0 auto" }}>
            <ModuleBanner moduleKey="schedule" stat={String(openTaskCount)} statLabel={openTaskCount === 1 ? "task open" : "tasks open"} />
            <div className="no-print" style={{ ...styles.addRow, borderRadius: 18, marginBottom: 16 }}>
              <input style={{ ...styles.addInput, flex: "1.6 1 170px" }} placeholder="Task name (e.g. Roof trusses)" value={taskName} onChange={(e) => setTaskName(e.target.value)} />
              <select style={{ ...styles.addInput, flex: "1.4 1 150px" }} value={taskLineItemId} onChange={(e) => setTaskLineItemId(e.target.value)}>
                <option value="">No line item</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
              <input style={{ ...styles.addInput, flex: "1 1 130px" }} type="date" value={taskStart} onChange={(e) => setTaskStart(e.target.value)} />
              <input style={{ ...styles.addInput, flex: "1 1 130px" }} type="date" value={taskEnd} onChange={(e) => setTaskEnd(e.target.value)} />
              <button style={{ ...styles.addBtn, flex: "1.2 0 auto" }} onClick={addScheduleTask}>+ Add task</button>
            </div>

            {scheduleTasks.length === 0 ? (
              <div style={{ ...styles.ledger, padding: 20, fontSize: 13, color: "var(--text-secondary)" }}>
                No tasks scheduled yet. Add one above to start building the project timeline.
              </div>
            ) : (
              <div style={styles.ledger}>
                <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between" }}>
                  <span>{dfmt(rangeStart)}</span>
                  <span>{dfmt(rangeEnd)}</span>
                </div>
                {scheduleTasks.map((task) => {
                  const start = new Date(task.start_date + "T00:00:00");
                  const end = new Date(task.end_date + "T00:00:00");
                  const leftPct = ((start - rangeStart) / 86400000 / totalDays) * 100;
                  const widthPct = Math.max((((end - start) / 86400000) + 1) / totalDays * 100, 100 / totalDays);
                  const linkedItem = items.find((i) => i.id === task.line_item_id);
                  const pct = Number(task.percent_complete || 0);
                  let statusColor = "#6E6E73"; // not started
                  let statusLabel = "Not started";
                  if (pct >= 100) { statusColor = "var(--success)"; statusLabel = "Done"; }
                  else if (end < today) { statusColor = "var(--danger)"; statusLabel = "Overdue"; }
                  else if (start <= today && today <= end) { statusColor = "var(--accent)"; statusLabel = "In progress"; }
                  return (
                    <div key={task.id} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{task.name}</span>
                          {linkedItem && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· {linkedItem.name}</span>}
                          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: statusColor }}>{statusLabel}</span>
                        </div>
                        <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input type="number" min="0" max="100" value={pct}
                            onChange={(e) => setTaskProgress(task.id, e.target.value)}
                            style={{ ...styles.addInput, width: 56, padding: "4px 6px", fontSize: 12, textAlign: "right" }} />
                          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>%</span>
                          <button style={styles.removeBtn} onClick={() => removeScheduleTask(task.id)}>✕</button>
                        </div>
                      </div>
                      <div style={{ position: "relative", height: 14, background: "var(--bg-secondary)", borderRadius: 4 }}>
                        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 6, background: "rgba(29,92,138,0.16)", border: `1.5px solid ${statusColor}`, borderRadius: 4, overflow: "hidden" }}>
                          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: statusColor, opacity: 0.6 }} />
                        </div>
                        {today >= rangeStart && today <= rangeEnd && (
                          <div style={{ position: "absolute", top: -2, bottom: -2, left: `${((today - rangeStart) / 86400000 / totalDays) * 100}%`, width: 1, background: "var(--text-primary)" }} title="Today" />
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>{dfmt(start)} → {dfmt(end)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {view === "documents" && (
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <ModuleBanner moduleKey="documents" stat={String(documents.length)} statLabel={documents.length === 1 ? "file" : "files"} />
          <input
            ref={documentsInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleDocumentUpload}
          />
          <div className="no-print" style={{ ...styles.addRow, borderRadius: 18, marginBottom: 16 }}>
            <select style={{ ...styles.addInput, flex: "1.2 1 150px" }} value={docCategory} onChange={(e) => setDocCategory(e.target.value)}>
              {DOC_CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
            <select style={{ ...styles.addInput, flex: "1.6 1 170px" }} value={docLineItemId} onChange={(e) => setDocLineItemId(e.target.value)}>
              <option value="">No line item</option>
              {items.map((i) => (<option key={i.id} value={i.id}>{i.name}</option>))}
            </select>
            <button style={{ ...styles.addBtn, flex: "1.4 0 auto" }} onClick={() => documentsInputRef.current?.click()}>+ Upload files</button>
          </div>

          {documents.length === 0 ? (
            <div style={{ ...styles.ledger, padding: 20, fontSize: 13, color: "var(--text-secondary)" }}>
              No documents yet. Upload drawings, contracts, specs, or site photos above — pick a category and, optionally, the budget line they belong to.
            </div>
          ) : (
            <div style={styles.ledger}>
              {DOC_CATEGORIES.filter((cat) => documents.some((d) => d.category === cat)).map((cat) => (
                <div key={cat}>
                  <div style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent)", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" }}>
                    {cat}
                  </div>
                  {documents.filter((d) => d.category === cat).map((doc) => {
                    const linkedItem = items.find((i) => i.id === doc.line_item_id);
                    return (
                      <div key={doc.id} style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
                          <button onClick={() => openDocument(doc)} style={{ background: "none", border: "none", padding: 0, color: "var(--text-primary)", fontSize: 14, fontWeight: 600, cursor: "pointer", textAlign: "left" }}>
                            {doc.name}
                          </button>
                          {doc.version > 1 && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", background: "rgba(29,92,138,0.1)", borderRadius: 100, padding: "2px 8px" }}>v{doc.version}</span>}
                          {linkedItem && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>· {linkedItem.name}</span>}
                          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{fmtFileSize(doc.file_size)}</span>
                        </div>
                        <button className="no-print" style={styles.removeBtn} onClick={() => removeDocument(doc)}>✕</button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "plans" && (
        <>
          <ModuleBanner
            moduleKey="plans"
            stat={String((project?.plans || []).length)}
            statLabel={(project?.plans || []).length === 1 ? "file" : "files"}
          />
        <div style={styles.ledger}>
          <input
            ref={plansInputRef}
            type="file"
            multiple
            accept=".pdf,.dwg,.dxf,.dwf,.xlsx,.xls,.csv,.doc,.docx"
            style={{ display: "none" }}
            onChange={handlePlanUpload}
          />
          <div style={{ padding: "16px 20px 4px", fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Reference documents for this project — drawings, CAD exports, quotes, contracts. Uploaded here so
            they're on hand for quick reference; not tied to any single line item. PDF, CAD (DWG/DXF/DWF), Excel,
            and Word files are supported.
          </div>
          {(project?.plans || []).length === 0 ? (
            <div style={{ padding: "8px 20px 20px", fontSize: 13, color: "var(--text-secondary)" }}>No documents uploaded yet.</div>
          ) : (
            <div style={{ padding: "8px 20px 4px" }}>
              {(project.plans || []).map((p) => (
                <div key={p.path} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border-color)" }}>
                  <button onClick={() => openPlan(p)} style={{ ...styles.attachmentLink, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1, textAlign: "left" }}>
                    📄 {p.name}
                  </button>
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", fontFamily: "'Space Grotesk', sans-serif" }}>
                    {p.size ? `${(p.size / 1024).toFixed(0)} KB` : ""}
                  </span>
                  <button className="no-print" style={styles.removeBtn} onClick={() => removePlan(p.path)}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div className="no-print" style={{ padding: "12px 20px 20px" }}>
            <button style={styles.addBtn} onClick={() => plansInputRef.current?.click()}>+ Upload documents</button>
          </div>
        </div>
        </>
      )}

      {view === "trend" && (
        <div style={styles.ledger}>
          <div className="no-print" style={{ padding: 20 }}>
            <button style={styles.addBtn} onClick={logSnapshot}>+ Log snapshot now</button>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 10 }}>
              Click this weekly (or before each client meeting) to record where budget vs actual stand right now.
              Over time this builds a trend you can point to instead of a single snapshot.
            </p>
          </div>
          {snapshots.length === 0 ? (
            <div style={{ padding: "0 20px 20px", fontSize: 13, color: "var(--text-secondary)" }}>No snapshots logged yet.</div>
          ) : (
            <div style={{ padding: "0 20px 20px" }}>
              <TrendChart snapshots={snapshots} />

              {snapshots.length > 1 && (() => {
                const first = snapshots[0];
                const latest = snapshots[snapshots.length - 1];
                const swing = Number(latest.variance) - Number(first.variance);
                const swingAbs = fmt(Math.abs(swing));
                const calloutText =
                  swing > 0
                    ? `Spend has been catching up to budget over your ${snapshots.length} check-ins — ${swingAbs} less headroom than when you started.`
                    : swing < 0
                    ? `You've pulled back ${swingAbs} versus where you started — trending in the right direction.`
                    : `No change since your first check-in.`;
                return (
                  <>
                    <div className="no-print" style={{ fontSize: 13, color: swing > 0 ? "#8A3D1E" : "#2E5C3E", background: swing > 0 ? "rgba(193,70,43,0.08)" : "rgba(76,122,92,0.1)", borderRadius: 10, padding: "10px 14px", marginTop: 14 }}>
                      {swing > 0 ? "⚠ " : swing < 0 ? "✓ " : ""}{calloutText}
                    </div>
                    <div style={{ ...styles.summaryStrip, margin: "14px 0 0" }}>
                      <SummaryCard
                        label={`Starting point — ${new Date(first.created_at).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}`}
                        value={`${Number(first.variance) >= 0 ? "+" : ""}${fmt(first.variance)}`}
                      />
                      <SummaryCard
                        label={`Where you stand — ${new Date(latest.created_at).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}`}
                        value={`${Number(latest.variance) >= 0 ? "+" : ""}${fmt(latest.variance)}`}
                        accent={Number(latest.variance) > 0 ? "var(--danger)" : "var(--success)"}
                      />
                      <SummaryCard
                        label="Movement since you started"
                        value={`${swing >= 0 ? "+" : ""}${fmt(swing)}`}
                        accent={swing > 0 ? "var(--danger)" : swing < 0 ? "var(--success)" : undefined}
                      />
                      <SummaryCard label="Times you've checked in" value={String(snapshots.length)} />
                    </div>
                  </>
                );
              })()}

              <div style={{ marginTop: 16 }}>
                <div style={{ ...styles.trendRow, borderBottom: "1px solid var(--border-color)" }}>
                  <span style={{ ...styles.trendHeadCell, flex: 1.3 }}>Date</span>
                  <span style={{ ...styles.trendHeadCell, flex: 1, textAlign: "right" }}>Budget</span>
                  <span style={{ ...styles.trendHeadCell, flex: 1, textAlign: "right" }}>Actual</span>
                  <span style={{ ...styles.trendHeadCell, flex: 1.1, textAlign: "right" }}>Variance</span>
                  <span style={{ ...styles.trendHeadCell, flex: 1, textAlign: "right" }}>% of budget</span>
                  <span style={{ ...styles.trendHeadCell, flex: 1.1, textAlign: "right" }}>Since last</span>
                  <span style={{ ...styles.trendHeadCell, flex: 0.4 }} className="no-print"></span>
                </div>
                {[...snapshots].reverse().map((s, idx, arr) => {
                  const prev = arr[idx + 1]; // arr is newest-first, so idx+1 is the snapshot logged just before this one
                  const delta = prev ? Number(s.variance) - Number(prev.variance) : null;
                  const pctOfBudget = Number(s.budget) ? (Number(s.actual) / Number(s.budget)) * 100 : null;
                  return (
                    <div key={s.id} style={styles.trendRow}>
                      <span style={{ ...styles.trendCell, flex: 1.3, color: "var(--text-secondary)" }}>
                        {new Date(s.created_at).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}
                      </span>
                      <span style={{ ...styles.trendCell, flex: 1, textAlign: "right" }}>{fmt(s.budget)}</span>
                      <span style={{ ...styles.trendCell, flex: 1, textAlign: "right" }}>{fmt(s.actual)}</span>
                      <span style={{ ...styles.trendCell, flex: 1.1, textAlign: "right", color: Number(s.variance) > 0 ? "var(--danger)" : "var(--success)", fontWeight: 600 }}>
                        {Number(s.variance) >= 0 ? "+" : ""}{fmt(s.variance)}
                      </span>
                      <span style={{ ...styles.trendCell, flex: 1, textAlign: "right", color: "var(--text-secondary)" }}>
                        {pctOfBudget == null ? "—" : `${pctOfBudget.toFixed(1)}%`}
                      </span>
                      <span style={{ ...styles.trendCell, flex: 1.1, textAlign: "right", color: delta == null ? "#6E6E73" : delta > 0 ? "var(--danger)" : delta < 0 ? "var(--success)" : "#6E6E73" }}>
                        {delta == null ? "— first" : `${delta >= 0 ? "+" : ""}${fmt(delta)}`}
                      </span>
                      <span style={{ ...styles.trendCell, flex: 0.4, textAlign: "right" }} className="no-print">
                        <button style={styles.removeBtn} onClick={() => removeSnapshot(s.id)}>✕</button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {view === "clientreports" && (() => {
        const categoryTotals = {};
        items.forEach((i) => {
          const cat = i.category || "Other";
          if (!categoryTotals[cat]) categoryTotals[cat] = { budget: 0, actual: 0 };
          categoryTotals[cat].budget += Number(i.budget || 0);
          categoryTotals[cat].actual += Number(i.actual || 0);
        });
        const categoryRows = Object.entries(categoryTotals).sort((a, b) => b[1].budget - a[1].budget);
        const coRows = changeOrders.filter((co) => co.status !== "rejected");
        const scheduleOverallPct = scheduleTasks.length
          ? scheduleTasks.reduce((s, t) => s + Number(t.percent_complete || 0), 0) / scheduleTasks.length
          : 0;
        const currentPhase = [...scheduleTasks]
          .filter((t) => Number(t.percent_complete || 0) < 100)
          .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))[0];
        const reportDate = new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });

        return (
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", maxWidth: 1180, margin: "0 auto" }}>

          {/* Preview — what the client will actually see */}
          <div className="card" style={{ flex: 1.6, background: "var(--surface)", borderRadius: 18, boxShadow: "0 4px 20px rgba(0,0,0,0.06)", overflow: "hidden" }}>
            <div style={{ background: "#20344A", padding: "36px 36px 30px", color: "#fff" }}>
              <svg width="26" height="26" viewBox="0 0 48 48" style={{ marginBottom: 18 }}>
                <rect x="4" y="8" width="28" height="8" fill="#fff" opacity="0.9" />
                <rect x="34" y="8" width="10" height="8" fill="#fff" opacity="0.5" />
                <rect x="4" y="20" width="40" height="8" fill="#fff" opacity="0.9" />
                <rect x="4" y="32" width="40" height="8" fill="#fff" opacity="0.9" />
              </svg>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 28, fontWeight: 700, lineHeight: 1.15 }}>{project.name}</div>
              <div style={{ fontSize: 13.5, opacity: 0.75, marginTop: 8 }}>
                {project.client_name ? `Client Report — prepared for ${project.client_name} · ${reportDate}` : `Client Report · ${reportDate}`}
              </div>
            </div>

            <div style={{ display: "flex", padding: "30px 36px", borderBottom: "1px solid var(--border-color)" }}>
              <div style={{ flex: 1, paddingRight: 20 }}>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Budget</div>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 22, fontWeight: 600, marginTop: 4 }}>{fmt(totals.revisedBudget)}</div>
              </div>
              <div style={{ width: 1, background: "var(--border-color)" }} />
              <div style={{ flex: 1, padding: "0 20px" }}>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Actual to date</div>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 22, fontWeight: 600, marginTop: 4 }}>{fmt(totals.actual)}</div>
              </div>
              <div style={{ width: 1, background: "var(--border-color)" }} />
              <div style={{ flex: 1, paddingLeft: 20 }}>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Variance</div>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 22, fontWeight: 600, marginTop: 4, color: totals.variance > 0 ? "var(--danger)" : "var(--success)" }}>
                  {totals.variance >= 0 ? "+" : ""}{fmt(totals.variance)}
                </div>
              </div>
            </div>

            <div style={{ padding: "8px 36px 30px" }}>
              {reportSections.cost_summary && (
                <>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, margin: "20px 0 12px", paddingBottom: 8, borderBottom: "1px solid var(--border-color)" }}>Cost Summary by Category</div>
                  {categoryRows.length === 0 ? (
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "6px 0" }}>No line items yet.</div>
                  ) : (
                    <>
                      <div style={{ textAlign: "right", fontSize: 10.5, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", padding: "4px 0 2px" }}>Actual / Budget</div>
                      {categoryRows.map(([cat, t]) => (
                        <div key={cat} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", fontSize: 13.5 }}>
                          <span>{cat}</span>
                          <span style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(t.actual)} / {fmt(t.budget)}</span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}

              {reportSections.change_orders && (
                <>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, margin: "24px 0 12px", paddingBottom: 8, borderBottom: "1px solid var(--border-color)" }}>Change Orders</div>
                  {coRows.length === 0 ? (
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "6px 0" }}>No change orders logged.</div>
                  ) : (
                    coRows.map((co) => (
                      <div key={co.id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", fontSize: 13.5 }}>
                        <span>{co.description} — {co.status}</span>
                        <span style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{Number(co.amount) >= 0 ? "+" : ""}{fmt(co.amount)}</span>
                      </div>
                    ))
                  )}
                </>
              )}

              {reportSections.schedule && (
                <>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, margin: "24px 0 12px", paddingBottom: 8, borderBottom: "1px solid var(--border-color)" }}>Schedule Progress</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13.5, marginBottom: 8 }}>
                    <span style={{ width: 130 }}>Overall</span>
                    <div style={{ flex: 1, height: 3, background: "var(--bg-secondary)" }}><div style={{ width: `${Math.min(100, scheduleOverallPct)}%`, height: "100%", background: "#20344A" }} /></div>
                    <span style={{ fontFamily: "'Space Grotesk', sans-serif", width: 36, textAlign: "right" }}>{Math.round(scheduleOverallPct)}%</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13.5, color: "var(--text-secondary)" }}>
                    <span style={{ width: 130 }}>Current phase</span>
                    <span>{currentPhase ? currentPhase.name : "All tasks complete"}</span>
                  </div>
                </>
              )}

              {reportSections.trend && (
                <>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, margin: "24px 0 12px", paddingBottom: 8, borderBottom: "1px solid var(--border-color)" }}>Cost Trend</div>
                  {snapshots.length === 0 ? (
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "6px 0" }}>No snapshots logged yet — log one from the Trend tab.</div>
                  ) : (
                    <TrendChart snapshots={snapshots} />
                  )}
                </>
              )}

              {reportSections.payments && (
                <>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, margin: "24px 0 12px", paddingBottom: 8, borderBottom: "1px solid var(--border-color)" }}>Payments &amp; Retention</div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", fontSize: 13.5 }}><span>Claimed to date</span><span style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(totals.claimed)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", fontSize: 13.5 }}><span>Certified to date</span><span style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(totals.certified)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", fontSize: 13.5 }}><span>Retention held ({totals.retentionPct}%)</span><span style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(totals.retentionHeld)}</span></div>
                </>
              )}

              {reportSections.purchase_orders && (
                <>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, margin: "24px 0 12px", paddingBottom: 8, borderBottom: "1px solid var(--border-color)" }}>Purchase Orders</div>
                  {purchaseOrders.length === 0 ? (
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "6px 0" }}>No purchase orders yet.</div>
                  ) : (
                    purchaseOrders.map((po) => (
                      <div key={po.id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", fontSize: 13.5 }}>
                        <span>{po.supplier_name} — {po.status}</span>
                        <span style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{fmt(po.amount)}</span>
                      </div>
                    ))
                  )}
                </>
              )}

              {reportSections.documents && (
                <>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, margin: "24px 0 12px", paddingBottom: 8, borderBottom: "1px solid var(--border-color)" }}>Documents Shared</div>
                  {documents.length === 0 ? (
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "6px 0" }}>No documents uploaded yet.</div>
                  ) : (
                    documents.map((d) => (
                      <div key={d.id} style={{ padding: "7px 0", fontSize: 13.5 }}>{d.name}</div>
                    ))
                  )}
                </>
              )}

              {reportSections.subcontractors && (
                <>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, margin: "24px 0 12px", paddingBottom: 8, borderBottom: "1px solid var(--border-color)" }}>Subcontractors</div>
                  {subs.length === 0 ? (
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "6px 0" }}>None added yet.</div>
                  ) : (
                    subs.map((s) => (
                      <div key={s.id} style={{ padding: "7px 0", fontSize: 13.5 }}>{s.name}{s.trade ? ` — ${s.trade}` : ""}</div>
                    ))
                  )}
                </>
              )}

              {reportNote.trim() && (
                <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--border-color)", fontSize: 13.5, lineHeight: 1.65, fontStyle: "italic", color: "var(--text-secondary)" }}>
                  "{reportNote}"
                </div>
              )}
            </div>

            <div style={{ padding: "16px 36px", borderTop: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-secondary)" }}>
              <span>site<span style={{ color: "var(--accent)" }}>Margin</span> — Client report for {project.name}</span>
              <span>Generated {reportDate}</span>
            </div>
          </div>

          {/* Panel — sections, note, save/send/schedule */}
          <div className="no-print" style={{ width: 340, flexShrink: 0, background: "var(--surface)", borderRadius: 18, boxShadow: "0 4px 20px rgba(0,0,0,0.06)", padding: 22, position: "sticky", top: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Report sections</div>
              <button
                onClick={() => window.print()}
                style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "1px solid var(--border-color)", borderRadius: 100, padding: "5px 11px", fontSize: 12, fontWeight: 600, color: "var(--text-primary)", cursor: "pointer" }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 6 2 18 2 18 9" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <rect x="6" y="14" width="12" height="8" />
                </svg>
                Print
              </button>
            </div>

            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Always included</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0" }}>
              <input type="checkbox" checked disabled style={{ width: 18, height: 18 }} />
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Project &amp; cost headline</span>
            </div>

            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "14px 0 8px" }}>Recommended</div>
            {[
              ["cost_summary", "Cost summary by category"],
              ["change_orders", "Change orders"],
              ["schedule", "Schedule progress"],
              ["trend", "Cost trend"],
            ].map(([key, label]) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!!reportSections[key]}
                  onChange={() => setReportSections((s) => ({ ...s, [key]: !s[key] }))}
                  style={{ width: 18, height: 18, accentColor: "#20344A" }}
                />
                <span style={{ fontSize: 13 }}>{label}</span>
              </label>
            ))}

            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "14px 0 8px" }}>Optional</div>
            {[
              ["payments", "Payments & retention detail"],
              ["purchase_orders", "Purchase orders"],
              ["documents", "Documents shared"],
              ["subcontractors", "Subcontractors (name & trade)"],
            ].map(([key, label]) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!!reportSections[key]}
                  onChange={() => setReportSections((s) => ({ ...s, [key]: !s[key] }))}
                  style={{ width: 18, height: 18, accentColor: "#20344A" }}
                />
                <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{label}</span>
              </label>
            ))}

            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Note to client</div>
            <textarea
              value={reportNote}
              onChange={(e) => setReportNote(e.target.value)}
              placeholder="Add a line or two of context before this goes out…"
              style={{ width: "100%", minHeight: 64, border: "1px solid var(--border-color)", borderRadius: 10, padding: "10px 12px", fontSize: 12.5, fontFamily: "inherit", resize: "vertical" }}
            />

            <div style={{ height: 1, background: "var(--border-color)", margin: "18px 0" }} />

            <button style={{ ...styles.importBtn, width: "100%", marginBottom: 10 }} disabled={reportSaving} onClick={saveReportProfile}>
              {reportSaving ? "Saving…" : "Save profile"}
            </button>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {reportRecipients.map((email) => (
                <span key={email} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface)", border: "1px solid var(--border-color)", borderRadius: 100, padding: "5px 6px 5px 10px", fontSize: 12 }}>
                  {email}
                  <button onClick={() => setReportRecipients((r) => r.filter((e) => e !== email))} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11, padding: 0 }}>✕</button>
                </span>
              ))}
              <input
                value={reportRecipientDraft}
                onChange={(e) => setReportRecipientDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addReportRecipient();
                  }
                }}
                onBlur={addReportRecipient}
                placeholder="client@email.com"
                style={{ border: "1px solid var(--border-color)", borderRadius: 100, padding: "5px 12px", fontSize: 12, minWidth: 140 }}
              />
            </div>
            <button style={{ ...styles.addBtn, width: "100%", background: "#20344A", marginBottom: 14 }} disabled={reportSending} onClick={sendReportNow}>
              {reportSending ? "Sending…" : "Email now"}
            </button>

            {reportMessage && (
              <div style={{ fontSize: 12.5, color: reportMessage.type === "error" ? "var(--danger)" : "var(--success)", marginBottom: 14 }}>{reportMessage.text}</div>
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Repeat this report</span>
              <label style={{ position: "relative", display: "inline-block", width: 36, height: 20 }}>
                <input
                  type="checkbox"
                  checked={reportFrequency !== "none"}
                  onChange={(e) => setReportFrequency(e.target.checked ? "monthly" : "none")}
                  style={{ position: "absolute", opacity: 0, width: "100%", height: "100%", margin: 0, cursor: "pointer" }}
                />
                <span style={{ position: "absolute", inset: 0, borderRadius: 100, background: reportFrequency !== "none" ? "#20344A" : "#DCDCE1", pointerEvents: "none", transition: "background 0.15s" }} />
                <span style={{ position: "absolute", top: 2, left: reportFrequency !== "none" ? 18 : 2, width: 16, height: 16, borderRadius: 100, background: "var(--surface)", pointerEvents: "none", transition: "left 0.15s" }} />
              </label>
            </div>

            {reportFrequency !== "none" && (
              <div style={{ background: "var(--bg-secondary)", borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Frequency</div>
                <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                  {["weekly", "monthly"].map((f) => (
                    <button
                      key={f}
                      onClick={() => setReportFrequency(f)}
                      style={{
                        flex: 1, padding: "7px 0", borderRadius: 100, border: "none", cursor: "pointer",
                        fontSize: 13, fontWeight: 600, textTransform: "capitalize",
                        background: reportFrequency === f ? "#20344A" : "var(--surface)",
                        color: reportFrequency === f ? "#FFFFFF" : "var(--text-secondary)",
                        boxShadow: reportFrequency === f ? "none" : "0 1px 6px rgba(0,0,0,0.06)",
                      }}
                    >
                      {f}
                    </button>
                  ))}
                </div>

                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Send on</div>
                {reportFrequency === "weekly" ? (
                  <select
                    value={reportSendDay}
                    onChange={(e) => setReportSendDay(Number(e.target.value))}
                    style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border-color)", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 14 }}
                  >
                    {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => (
                      <option key={i} value={i}>{d}</option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={reportSendDay}
                    onChange={(e) => setReportSendDay(Number(e.target.value))}
                    style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border-color)", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 14 }}
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>{d === 1 ? "1st" : d === 2 ? "2nd" : d === 3 ? "3rd" : `${d}th`} of the month</option>
                    ))}
                  </select>
                )}

                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Next send: {new Date(computeNextSendAt(reportFrequency, reportSendDay)).toLocaleDateString("en-ZA", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}
                  {" — save the profile to lock this in."}
                </div>
              </div>
            )}
          </div>

        </div>
        );
      })()}

      <div className="print-only-footer" style={styles.docFooter}>
        <div style={styles.dfRow}>
          <div style={styles.dfBrand}>
            <svg style={styles.dfMark} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
              <rect x="4" y="8" width="28" height="8" fill="var(--text-primary)" />
              <rect x="34" y="8" width="10" height="8" fill="var(--accent)" />
              <rect x="4" y="20" width="40" height="8" fill="var(--text-primary)" />
              <rect x="4" y="32" width="40" height="8" fill="var(--text-primary)" />
            </svg>
            <span style={styles.dfText}>
              site<span style={{ color: "var(--accent)" }}>Margin</span> — Cost variance report for {project.name}
            </span>
          </div>
          <div style={styles.dfMeta}>
            Generated {new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}
          </div>
        </div>
        <div style={styles.dfDisclaimer}>Figures as at date of generation, subject to final reconciliation. sitemargin.co.za</div>
      </div>

      <div className="no-print" style={styles.footer}>
        Click Actual to log spend, or "Details" on any line to set the subcontractor, dates, quality rating, notes and files.
      </div>

      <AppFooter />

      {importPreviewItems && (
        <div className="no-print" style={styles.modalOverlay} onClick={() => setImportPreviewItems(null)}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div>
                <div style={styles.modalTitle}>Review before importing</div>
                <div style={styles.modalSub}>
                  {importPreviewItems.length} row{importPreviewItems.length === 1 ? "" : "s"} found. Check the numbers,
                  uncheck anything wrong, edit inline if needed, then import.
                </div>
              </div>
              <button style={styles.removeBtn} onClick={() => setImportPreviewItems(null)}>✕</button>
            </div>

            <div style={styles.modalBody}>
              <div style={styles.previewHeaderRow}>
                <span style={{ flex: 0.4 }}></span>
                <span style={{ flex: 2.4 }}>Description</span>
                <span style={{ flex: 1.2 }}>Category</span>
                <span style={{ flex: 1.2, textAlign: "right" }}>Budget</span>
              </div>
              {importPreviewItems.map((item, idx) => (
                <div key={idx} style={{ ...styles.previewRow, opacity: item._include ? 1 : 0.4 }}>
                  <span style={{ flex: 0.4 }}>
                    <input
                      type="checkbox"
                      checked={item._include}
                      onChange={(e) => updatePreviewItem(idx, { _include: e.target.checked })}
                    />
                  </span>
                  <span style={{ flex: 2.4 }}>
                    <input
                      style={styles.previewInput}
                      value={item.name}
                      onChange={(e) => updatePreviewItem(idx, { name: e.target.value })}
                    />
                    {item.notes && <div style={styles.previewNote}>{item.notes}</div>}
                  </span>
                  <span style={{ flex: 1.2 }}>
                    <select
                      style={styles.previewInput}
                      value={item.category}
                      onChange={(e) => updatePreviewItem(idx, { category: e.target.value })}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </span>
                  <span style={{ flex: 1.2 }}>
                    <input
                      style={{ ...styles.previewInput, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}
                      type="number"
                      value={item.budget}
                      onChange={(e) => updatePreviewItem(idx, { budget: Number(e.target.value) || 0 })}
                    />
                  </span>
                </div>
              ))}
            </div>

            <div style={styles.modalFooter}>
              <button style={styles.templateLink} onClick={() => setImportPreviewItems(null)}>Cancel</button>
              <button style={styles.addBtn} onClick={confirmImportPreview}>
                Import {importPreviewItems.filter((i) => i._include).length} item{importPreviewItems.filter((i) => i._include).length === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================== STYLES ============================== */

const styles = {
  page: {
    minHeight: "100vh",
    background: "var(--bg-primary)",
    color: "var(--text-primary)",
    fontFamily: "'Inter', sans-serif",
    padding: "20px 16px 48px",
  },
  eyebrow: { fontSize: 12, letterSpacing: "0.1em", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase" },
  eyebrowProminent: { fontSize: 17, letterSpacing: "0.06em", color: "var(--accent)", fontWeight: 800, textTransform: "uppercase" },
  titleDivider: { fontSize: 22, color: "var(--border-color)", fontWeight: 400, lineHeight: 1 },
  appLogoRow: { display: "flex", alignItems: "center", gap: 8 },
  appLogoMark: { height: 64, width: "auto", display: "block" },
  appLogoText: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 22, letterSpacing: "-0.01em", color: "var(--text-primary)" },
  eyebrowLink: { fontSize: 12, letterSpacing: "0.1em", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase", textDecoration: "none", display: "inline-block" },

  // zIndex 201 keeps the logo + hamburger button visible ABOVE the full-screen
  // menu overlay (zIndex 200) when the menu is open — otherwise the overlay
  // covers the close (✕) button and there's no way to see it's open or close
  // it, which is what the marketing site avoids via the same nav-above-panel
  // stacking (nav z-index 200 > .menu-panel z-index 150 on sitemargin.co.za).
  // Sticky, with a background matching .page exactly (#F5F5F7) so the band
  // reads as seamless with the page behind it even though it's only as wide
  // as the maxWidth content column — everything below is capped at the same
  // 1180px too, so there's no visible seam on wider viewports. Matches
  // sitemargin.co.za's own nav (position:sticky; top:0) — this header used
  // to just scroll away with the page instead of staying put.
  dashHeader: { maxWidth: 1180, margin: "0 auto 20px", position: "sticky", top: 0, paddingTop: 56, background: "var(--bg-primary)", zIndex: 201 },
  dashNavBar: { display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--surface)", border: "1px solid var(--border-color)", borderRadius: 18, padding: "10px 18px", boxShadow: "var(--shadow-card)", marginBottom: 22, gap: 16, flexWrap: "wrap" },
  dashNavRight: { display: "flex", alignItems: "center", gap: 14 },
  // Matches sitemargin.co.za's own .nav-app-link exactly (same font, size,
  // color, padding, radius) — the app's mirror-image equivalent, pointing
  // back to the marketing site instead of into the app.
  navHomeLink: { fontSize: 13.5, fontWeight: 600, color: "var(--on-accent)", textDecoration: "none", whiteSpace: "nowrap", background: "var(--accent)", padding: "8px 16px", borderRadius: 100, display: "inline-block" },
  dashTitle: { fontSize: "clamp(30px, 4.5vw, 42px)", fontWeight: 700, letterSpacing: "-0.02em" },
  pageHeaderEyebrow: { fontSize: 17, letterSpacing: "0.06em", color: "var(--accent)", fontWeight: 800, textTransform: "uppercase", margin: 0 },
  dashTitleInput: { fontSize: "clamp(20px, 2.6vw, 26px)", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--accent)", background: "none", border: "none", borderBottom: "1px dashed var(--border-color)", padding: 0, width: "100%", minWidth: 0 },
  companyLogoMark: { height: "clamp(28px, 4.5vw, 44px)", width: "auto", maxWidth: 140, objectFit: "contain", borderRadius: 6 },
  // Subscription-tier badge next to the wordmark (direction "B" from the
  // tier-badge mockup) — background is set per-tier via HEADER_TIER_BADGE's
  // `tint`, label color via its `color`; everything else here is constant
  // across tiers so only two values ever vary at the call site.
  tierBadge: { display: "inline-flex", alignItems: "center", borderRadius: 100, padding: "4px 11px" },
  tierBadgeLabel: { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap" },
  logoTextBtn: { background: "none", border: "none", color: "var(--accent)", fontSize: 11.5, fontWeight: 600, textAlign: "left", padding: 0, cursor: "pointer" },
  logoTextBtnMuted: { background: "none", border: "none", color: "var(--text-secondary)", fontSize: 11, textAlign: "left", padding: 0, cursor: "pointer" },
  logoMenuPopover: { position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30, background: "var(--surface)", borderRadius: 12, boxShadow: "0 8px 28px rgba(0,0,0,0.14)", padding: 6, minWidth: 150, display: "flex", flexDirection: "column", gap: 2 },
  downloadMenuPopover: { position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 30, background: "var(--surface)", borderRadius: 12, boxShadow: "0 8px 28px rgba(0,0,0,0.14)", padding: 6, minWidth: 130, display: "flex", flexDirection: "column", gap: 2 },
  logoMenuItem: { background: "none", border: "none", color: "var(--text-primary)", fontSize: 13.5, fontWeight: 500, textAlign: "left", padding: "9px 12px", borderRadius: 8, cursor: "pointer" },

  // menuWrap surrounds the button AND the drawer so the CSS hover rule in
  // GlobalStyles (".sm-menu-wrap:hover .sm-menu-drawer") can bridge the two —
  // hovering the button, the gap, or the drawer itself all count as "still
  // hovering the menu," so moving the mouse from button to drawer doesn't
  // flicker it shut.
  menuWrap: { position: "relative" },
  menuBtn: { width: 40, height: 40, border: "none", borderRadius: "50%", background: "var(--bg-secondary)", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, padding: 0, flexShrink: 0 },
  menuBtnBar: { display: "block", width: 15, height: 1.5, background: "var(--text-primary)", borderRadius: 2, transition: "transform 0.25s ease, opacity 0.2s ease" },
  menuBtnBar1Open: { transform: "translateY(5.5px) rotate(45deg)" },
  menuBtnBarMidOpen: { opacity: 0 },
  menuBtnBar3Open: { transform: "translateY(-5.5px) rotate(-45deg)" },

  // The hamburger button always stays on screen (it just morphs into a ✕
  // rather than being covered or replaced). Its options now live in a
  // rounded card that pops out from directly under the button — same
  // radius/shadow language as the rest of the app's cards (dashNavBar,
  // summaryCard etc.) instead of a flat edge-to-edge slab — anchored via
  // position:absolute on .sm-menu-wrap (position:relative), the same
  // popover pattern already used for the logo/download menus below.
  // Closed by default (scaled down + invisible so it can't be tabbed into),
  // opened either by the onClick toggle (menuOpen state — works on touch,
  // where hover doesn't exist) or, on devices with a real hover-capable
  // pointer, by hovering .sm-menu-wrap (see GlobalStyles).
  //
  // top is flush at "100%" (zero gap) rather than offset a few px below the
  // button — a gap there is dead space that belongs to neither the button
  // nor the drawer, so the pointer loses :hover crossing it and the drawer
  // snaps shut before it can be reached. No maxHeight/overflow either: the
  // drawer just sizes to its content so it never scrolls internally.
  // FIX (2026-08-28): this drawer combined borderRadius + boxShadow + a
  // transform (translateY + scale) on the open/close toggle — the exact
  // same combination that corrupted sitemargin-site's own .menu-panel on
  // software-rendered WebViews (GPU layer promoted for the transform,
  // rasterised wrong against the radius+shadow). That fix dropped the
  // transform there; this drawer never got the same treatment since it's a
  // separate implementation (native app menu vs. the marketing site's own
  // CSS) — bringing it in line here. Opacity/visibility-only fade, no
  // transform, so no GPU layer promotion.
  menuDrawer: {
    position: "absolute", top: "100%", right: 0,
    width: "min(320px, 86vw)",
    background: "var(--surface)", borderRadius: 20,
    boxShadow: "0 20px 50px rgba(0,0,0,0.16), 0 4px 16px rgba(0,0,0,0.07)",
    zIndex: 200,
    display: "flex", flexDirection: "column",
    padding: "20px 20px 18px",
    opacity: 0, visibility: "hidden", pointerEvents: "none",
    transition: "opacity 0.16s ease",
  },
  menuDrawerOpen: { opacity: 1, visibility: "visible", pointerEvents: "auto" },
  menuPanelInner: { width: "100%" },
  menuPanelLink: { display: "block", width: "calc(100% + 20px)", textAlign: "left", background: "none", fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--text-primary)", border: "none", borderRadius: 10, padding: "7px 10px", margin: "0 -10px", cursor: "pointer", textDecoration: "none" },
  menuPanelLinkActive: { color: "var(--accent)" },
  menuSectionLabel: { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--text-secondary)", margin: "16px 0 6px" },
  menuSecondaryLink: { display: "block", width: "calc(100% + 20px)", textAlign: "left", background: "none", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 500, color: "var(--text-secondary)", padding: "5px 10px", margin: "0 -10px", cursor: "pointer", textDecoration: "none" },
  menuDivider: { height: 1, background: "var(--border-color)", margin: "14px 0 0" },
  menuPanelDimRow: { display: "flex", gap: 16, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-color)" },
  menuPanelDim: { background: "none", border: "none", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", padding: 0, cursor: "pointer", textDecoration: "none" },
  menuFooter: { marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-color)" },
  menuFooterBrandRow: { display: "flex", alignItems: "center", gap: 7, marginBottom: 6 },
  menuFooterLogoMark: { height: 20, width: "auto", display: "block" },
  menuFooterWordmark: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 14.5, color: "var(--text-primary)" },
  menuFooterTagline: { fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 14 },
  menuPanelActions: { display: "flex", flexDirection: "column", gap: 8 },
  menuPanelGhost: { textAlign: "center", padding: 11, borderRadius: 100, fontWeight: 600, fontSize: 14, border: "1px solid var(--text-primary)", color: "var(--text-primary)", background: "none", cursor: "pointer" },
  menuPanelSolid: { textAlign: "center", padding: 11, borderRadius: 100, fontWeight: 600, fontSize: 14, border: "none", color: "var(--on-accent)", background: "var(--accent)", cursor: "pointer" },
  menuPanelEmail: { marginTop: 14, fontSize: 11.5, color: "var(--text-secondary)", fontFamily: "'Space Grotesk', sans-serif" },

  topNav: { maxWidth: 1180, margin: "0 auto 20px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border-color)", paddingBottom: 12 },
  topNavRight: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 },
  topNavEmail: { fontSize: 12, color: "var(--text-secondary)", fontFamily: "'Space Grotesk', sans-serif" },
  topNavSignOut: { background: "none", border: "1px solid var(--border-color)", borderRadius: 100, color: "var(--text-secondary)", fontSize: 12, padding: "6px 12px", cursor: "pointer" },

  // Sticky, same reasoning as dashHeader above — this already had the right
  // background band, it was just missing position:sticky, so it scrolled
  // out of view instead of staying put like sitemargin.co.za's own nav.
  gateNavOuter: { position: "sticky", top: 0, paddingTop: 56, zIndex: 201, background: "var(--bg-secondary)" },
  gateNavWrap: { maxWidth: 980, margin: "0 auto", padding: "0 20px" },
  gateNav: { display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--surface)", borderRadius: 18, padding: "10px 18px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", margin: "14px 0 0" },
  // Always-visible pill next to the hamburger — same idea as the marketing
  // site's .nav-app-link, so "Log in" is right there in the header on the
  // signed-out gate screen without needing to open any menu.
  gateNavActions: { display: "flex", alignItems: "center", gap: 10 },
  gateNavBtn: { fontSize: 13.5, fontWeight: 600, color: "var(--on-accent)", textDecoration: "none", whiteSpace: "nowrap", background: "var(--accent)", padding: "8px 16px", borderRadius: 100, display: "inline-block" },
  gateWrap: { maxWidth: 640, margin: "48px auto 0", padding: "0 16px" },
  heroWrap: { position: "relative", isolation: "isolate", overflow: "hidden", borderRadius: 24, background: "var(--bg-secondary)", padding: "30px 20px 34px", marginBottom: 36 },
  heroBacksplash: { position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 0, pointerEvents: "none" },
  heroContent: { position: "relative", zIndex: 1 },
  heroEm: { fontStyle: "normal", color: "var(--accent)" },
  heroItal: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: "italic", fontWeight: 600 },
  heroSub: { fontSize: 16, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 26 },
  heroCtas: { display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", margin: "6px 0 20px" },
  heroBtnPrimary: { background: "var(--accent)", color: "var(--on-accent)", fontWeight: 600, fontSize: 15, padding: "12px 24px", borderRadius: 100, border: "none", cursor: "pointer" },
  heroTextlink: { fontSize: 15, fontWeight: 500, color: "var(--accent)", background: "none", border: "none", padding: 0, cursor: "pointer" },
  heroProof: { display: "flex", alignItems: "baseline", gap: 7, fontSize: 13.5, color: "var(--text-secondary)", marginBottom: 30 },
  heroProofCount: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15.5, color: "var(--text-primary)" },
  heroVisualWrap: { position: "relative", height: 260, display: "flex", alignItems: "center", justifyContent: "center", margin: "4px 0 8px" },
  heroDiamondWrapper: { position: "relative", zIndex: 1, display: "inline-flex", padding: 15, borderRadius: 50, background: "linear-gradient(150deg, #23272E 0%, #14171C 52%, #090B0E 100%)", transform: "rotate(45deg)", boxShadow: "17px 17px 30px -10px rgba(2,6,23,0.5), 10px 10px 18px -8px rgba(2,6,23,0.3), inset 0 1px 1px rgba(255,255,255,0.14)" },
  heroDiamondRing: { display: "flex", padding: 5, borderRadius: 36, background: "linear-gradient(135deg, #CFFAFE 0%, #22D3EE 20%, #06B6D4 42%, #10B981 66%, #22C55E 84%, #86EFAC 100%)", boxShadow: "0 0 5px rgba(207,250,254,0.45)" },
  heroDiamond: { width: 160, height: 160, background: "linear-gradient(150deg, #333740 0%, #272B32 45%, #1B1E24 100%)", borderRadius: 32, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "inset 0 1px 1px rgba(255,255,255,0.08), inset 0 -16px 34px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.5)" },
  heroDiamondInner: { transform: "rotate(-45deg)", textAlign: "center" },
  heroDiamondFigure: { fontWeight: 700, fontSize: 25, letterSpacing: "-0.7px", color: "#F2F6F9", whiteSpace: "nowrap", textShadow: "0 2px 18px rgba(34,211,238,0.28)" },
  heroDiamondLabel: { fontSize: 10, fontWeight: 500, letterSpacing: "0.13em", color: "var(--text-secondary)", marginTop: 6, textTransform: "uppercase" },
  heroBadge: { position: "absolute", zIndex: 1, display: "flex", alignItems: "center", gap: 7, background: "var(--surface)", borderRadius: 100, padding: "9px 14px 9px 12px", fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)", boxShadow: "0 12px 28px rgba(0,0,0,0.12)" },
  heroBadgeDot: { width: 7, height: 7, borderRadius: "50%", background: "var(--success)", flexShrink: 0 },
  heroBadgeTop: { top: 4, left: "8%" },
  heroBadgeBottom: { bottom: 20, right: "4%" },
  mockSheet: { background: "var(--surface)", borderRadius: 18, padding: "16px 18px", boxShadow: "0 12px 34px rgba(0,0,0,0.08)", marginBottom: 28 },
  mockHead: { display: "flex", justifyContent: "space-between", fontSize: 11, letterSpacing: "0.08em", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600, paddingBottom: 10, marginBottom: 10, borderBottom: "1px solid var(--border-color)" },
  mockRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--border-color)", flexWrap: "wrap" },
  mockName: { fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)", flex: "1 1 150px" },
  mockNums: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 12, color: "var(--text-secondary)", flex: "0 0 auto" },
  mockGauge: { display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" },
  gaugeTrack: { position: "relative", width: 60, height: 6, background: "var(--bg-secondary)", borderRadius: 4, overflow: "hidden" },
  gaugeFill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 4 },
  gaugeLabel: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 11.5, fontWeight: 600, width: 44 },
  pill: { fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em", padding: "4px 10px", borderRadius: 100, flex: "0 0 auto" },
  problemBlock: { marginTop: 4 },
  pricingHead: { fontSize: 12.5, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600, margin: "44px 0 34px" },
  checkoutGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginTop: 8 },
  checkoutCard: { background: "var(--surface)", borderRadius: 18, padding: "22px 20px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  checkoutTier: { fontSize: 12.5, letterSpacing: "0.08em", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600, marginBottom: 10 },
  checkoutPrice: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 26, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 },
  checkoutPriceUnit: { fontSize: 13, color: "var(--text-secondary)", fontWeight: 400 },
  checkoutDesc: { fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.5 },
  checkoutCardSelected: { boxShadow: "0 0 0 1.5px #1D5C8A, 0 12px 34px rgba(0,0,0,0.08)" },
  tierCta: { background: "transparent", border: "1px solid var(--text-primary)", borderRadius: 100, padding: "9px 16px", fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)", cursor: "pointer" },
  tierNote: { fontSize: 12.5, color: "var(--accent)", fontWeight: 600, marginBottom: 10 },
  gateText: { fontSize: 15, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 20 },
  gateForm: { display: "flex", flexDirection: "column", gap: 10 },
  gateNotice: { background: "rgba(29,92,138,0.07)", border: "1px solid #1D5C8A", borderRadius: 14, padding: "14px 16px", fontSize: 14, color: "var(--text-secondary)" },
  gateError: { color: "var(--danger)", fontSize: 13, marginTop: 10 },
  gateFootnote: { fontSize: 13, color: "var(--text-secondary)", marginTop: 22 },
  gateSwitchText: { fontSize: 13.5, color: "var(--text-secondary)", marginTop: 14 },
  gateSwitchLink: { color: "var(--accent)", fontWeight: 600, textDecoration: "none" },
  gateSwitchLinkBtn: { color: "var(--accent)", fontWeight: 600, background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer" },
  topNavBtn: { background: "none", border: "none", color: "var(--text-secondary)", fontSize: 14, fontWeight: 500, padding: "6px 12px", cursor: "pointer", borderRadius: 3 },
  topNavBtnActive: { background: "var(--text-primary)", color: "var(--bg-primary)", fontWeight: 600 },

  explainer: { maxWidth: 1180, margin: "0 auto 18px", fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, background: "var(--surface)", borderRadius: 12, padding: "12px 16px", boxShadow: "0 1px 6px rgba(0,0,0,0.04)" },

  // ---- Accounting sync (Xero / Sage) ----
  integrationsBanner: { maxWidth: 1180, margin: "0 auto 18px", fontSize: 13.5, fontWeight: 500, color: "var(--text-primary)", background: "rgba(29,92,138,0.10)", borderRadius: 12, padding: "12px 16px" },
  integrationsBannerError: { color: "var(--text-primary)", background: "rgba(193,70,43,0.09)" },
  integrationsGrid: { maxWidth: 1180, margin: "0 auto 24px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 },
  integrationsCard: { background: "var(--surface)", borderRadius: 14, padding: "18px 20px", boxShadow: "0 1px 6px rgba(0,0,0,0.05)" },
  integrationsCardHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  integrationsDot: { width: 10, height: 10, borderRadius: "50%" },
  integrationsCardName: { fontSize: 15, fontWeight: 700 },
  integrationsConnectedTag: { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--success)", background: "rgba(76,122,92,0.12)", padding: "3px 9px", borderRadius: 100, marginLeft: "auto" },
  integrationsMeta: { fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 3 },
  integrationsUnmatched: { maxWidth: 1180, margin: "0 auto 24px", background: "var(--surface)", borderRadius: 14, padding: "16px 20px", boxShadow: "0 1px 6px rgba(0,0,0,0.04)" },
  integrationsTxnRow: { display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--border-color)", flexWrap: "wrap" },
  explainerLink: { color: "var(--accent)", fontWeight: 600 },

  newProjectRow: { maxWidth: 1180, margin: "0 auto 24px", display: "flex", gap: 10 },
  freeLimitBanner: { maxWidth: 1180, margin: "0 auto 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, background: "rgba(29,92,138,0.07)", border: "1px solid #1D5C8A", borderRadius: 14, padding: "14px 16px", fontSize: 13.5, color: "var(--text-secondary)", flexWrap: "wrap" },
  freeLimitLink: { color: "var(--accent)", fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" },
  addRowStandalone: { maxWidth: 1180, margin: "0 auto 22px", display: "flex", gap: 10, flexWrap: "wrap" },
  projectGrid: { maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 },
  projectCard: { background: "var(--surface)", borderRadius: 18, padding: "20px 22px", cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  scoreCard: { background: "var(--surface)", borderRadius: 18, padding: "20px 22px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  templateCard: { background: "var(--surface)", borderRadius: 18, padding: "20px 22px", marginBottom: 12, boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  projectCardTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  projectName: { fontSize: 20, fontWeight: 600 },
  deleteProjectBtn: { background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14 },
  projectNums: { display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "'Space Grotesk', sans-serif", color: "var(--text-secondary)" },
  projectMeta: { fontSize: 12, color: "var(--text-secondary)", marginTop: 8 },
  subItemRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border-color)" },

  backRow: { maxWidth: 1180, margin: "0 auto 12px", display: "flex", justifyContent: "space-between" },
  backBtn: { background: "none", border: "none", color: "var(--text-secondary)", fontSize: 13, cursor: "pointer" },
  exportBtn: { background: "var(--surface)", border: "none", borderRadius: 100, color: "var(--text-primary)", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: "pointer", boxShadow: "0 1px 6px rgba(0,0,0,0.06)" },

  titleBlock: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 16, borderBottom: "2px solid var(--border-color)", paddingBottom: 14, maxWidth: 1180, margin: "0 auto 20px" },
  titleBlockLeft: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 },
  projectInput: { background: "transparent", border: "none", color: "var(--text-primary)", fontSize: 17, fontWeight: 800, padding: 0, flex: "1 1 auto", minWidth: 160, letterSpacing: "0.02em", fontFamily: "'Inter', sans-serif", textTransform: "uppercase" },
  titleBlockRight: { display: "flex", gap: 22 },
  tbCell: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  tbLabel: { fontSize: 10, letterSpacing: "0.1em", color: "var(--text-secondary)" },
  tbValue: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 2 },
  retentionInput: { width: 34, background: "var(--bg-secondary)", border: "1px solid transparent", borderRadius: 6, color: "var(--text-primary)", fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, padding: "1px 4px", textAlign: "right" },

  summaryStrip: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, maxWidth: 1180, margin: "0 auto 16px" },
  summaryCard: { background: "linear-gradient(0deg, var(--tm-glass), var(--tm-glass)), var(--surface)", border: "1px solid var(--tm-brd)", borderRadius: 13, padding: "15px 16px", boxShadow: "var(--tm-lift)" },
  summaryCardSlab: { background: "linear-gradient(150deg,#23272E 0%,#14171C 60%,#090B0E 100%)", border: "none", borderRadius: 14, padding: "14px 15px", boxShadow: "0 12px 26px -14px rgba(2,6,23,.55)" },
  // lineHeight + minHeight reserve room for two lines of label text (e.g.
  // "ORIGINAL QUOTE ALLOCATION" wraps, "ACTUAL SPEND" doesn't) so every
  // card's value sits on the same baseline regardless of how its label wraps.
  summaryLabel: { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 9.5, lineHeight: 1.35, minHeight: 26, letterSpacing: "0.13em", color: "var(--text-secondary)", marginBottom: 10, textTransform: "uppercase", fontWeight: 600 },
  summaryLabelSlab: { fontSize: 11, lineHeight: 1.3, minHeight: 29, letterSpacing: "0.07em", color: "rgba(255,255,255,.55)", marginBottom: 7, textTransform: "uppercase", fontWeight: 700 },
  summaryValue: { fontFamily: "'Space Grotesk', sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 23, fontWeight: 600, letterSpacing: "-0.022em", color: "var(--text-primary)" },
  summaryValueSlab: { fontFamily: "'Space Grotesk', sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 19, fontWeight: 600, color: "#F2F6F9" },
  summarySubSlab: { fontSize: 10.5, color: "#FCA891", marginTop: 3, fontWeight: 600 },
  summarySub: { fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12, lineHeight: 1.4, color: "var(--text-secondary)", marginTop: 7, fontWeight: 500 },

  // Variance glow — a lit strip along a card's top edge, replacing the old
  // black "slab" treatment on Dashboard's Net Variance card. Relies on the
  // card switching to overflow:hidden (see SummaryCard) so the flush bar
  // clips to the card's own rounded top corners instead of squaring them off.
  summaryGlowBar: { position: "absolute", left: 0, right: 0, top: 0, height: 3 },
  summaryGlowNeg: { background: "var(--tm-neg)", boxShadow: "0 0 12px 2px var(--tm-neg-fill), 0 0 3px 0 var(--tm-neg)" },
  summaryGlowPos: { background: "var(--tm-pos)", boxShadow: "0 0 12px 2px var(--tm-pos-fill), 0 0 3px 0 var(--tm-pos)" },

  // Info-icon expand, shared by every non-slab SummaryCard: a small circular
  // affordance top-right that reveals a popover on hover/focus of the whole
  // card. Kept as React state (not a CSS :hover rule) to match the codebase's
  // established pattern — inline styles always beat stylesheet selectors, so
  // hover/focus state here has to live in JS, same as LitButton.
  summaryInfoBtn: { position: "absolute", top: 12, right: 12, width: 19, height: 19, borderRadius: "50%", border: "1px solid var(--tm-brd)", background: "transparent", color: "var(--text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, transition: "border-color .14s ease, color .14s ease, background .14s ease" },
  summaryInfoBtnActive: { borderColor: "var(--tm-pos)", color: "var(--tm-pos)", background: "var(--tm-pos-fill)" },
  summaryPopover: { position: "absolute", top: "calc(100% + 8px)", right: 0, width: 230, zIndex: 30, background: "var(--tm-pop-surface)", border: "1px solid var(--tm-pop-brd)", borderRadius: 11, boxShadow: "var(--tm-pop-shadow)", padding: "13px 14px 12px" },
  summaryPopoverCaret: { position: "absolute", top: -6, right: 16, width: 11, height: 11, background: "var(--tm-pop-surface)", borderLeft: "1px solid var(--tm-pop-brd)", borderTop: "1px solid var(--tm-pop-brd)", transform: "rotate(45deg)" },
  summaryPopoverTitle: { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 10 },
  summaryPopoverNote: { fontSize: 12.5, lineHeight: 1.5, color: "var(--text-primary)", margin: 0 },
  summaryPopoverRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 12.5, borderBottom: "1px solid var(--tm-pop-brd)" },
  summaryPopoverRowLast: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 12.5 },
  summaryPopoverDot: { width: 7, height: 7, borderRadius: 2, flexShrink: 0 },
  summaryPopoverName: { flex: 1, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  summaryPopoverValue: { fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", flexShrink: 0 },
  summaryPopoverFoot: { marginTop: 9, paddingTop: 8, borderTop: "1px solid var(--tm-pop-brd)", fontSize: 11.5, fontWeight: 500, color: "var(--text-secondary)" },

  // A severity edge rather than a full saturated outline — a ring of pure
  // danger colour round a whole paragraph shouts louder than the sentence does.
  warningBanner: { maxWidth: 1180, margin: "0 auto 12px", background: "var(--tm-neg-fill)", border: "1px solid var(--tm-brd)", borderLeft: "3px solid var(--tm-neg)", borderRadius: 10, padding: "13px 17px", fontSize: 14, color: "var(--text-primary)" },

  categoryStrip: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, maxWidth: 1180, margin: "0 auto 16px" },
  categoryCard: { background: "linear-gradient(0deg, var(--tm-glass), var(--tm-glass)), var(--surface)", border: "1px solid var(--tm-brd)", borderRadius: 13, padding: "11px 14px", boxShadow: "var(--tm-lift)" },
  categoryHead: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  categoryDot: { width: 8, height: 8, borderRadius: "50%" },
  categoryName: { fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 },
  categoryNums: { display: "flex", justifyContent: "space-between", fontFamily: "'Space Grotesk', sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 13 },
  categoryBudget: { color: "var(--text-secondary)" },
  categoryVariance: { fontWeight: 600 },

  importRow: { maxWidth: 1180, margin: "0 auto 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  importBtn: { background: "var(--surface)", border: "1px solid var(--border-color)", borderRadius: 100, color: "var(--text-primary)", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: "pointer", boxShadow: "0 1px 6px rgba(0,0,0,0.06)" },
  templateLink: { background: "none", border: "none", color: "var(--text-secondary)", fontSize: 12.5, textDecoration: "underline", cursor: "pointer", padding: 0 },

  viewToggle: { maxWidth: 1180, margin: "0 auto 12px", display: "flex", gap: 8, flexWrap: "wrap" },
  toggleGroupWrap: { maxWidth: 1180, margin: "0 auto", marginBottom: 14 },
  toggleGroupLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: "0 0 8px 4px" },
  toggleBtn: { background: "var(--surface)", border: "none", borderRadius: 100, color: "var(--text-secondary)", fontSize: 13, fontWeight: 500, padding: "8px 16px", cursor: "pointer", boxShadow: "0 1px 6px rgba(0,0,0,0.04)" },
  toggleBtnActive: { background: "var(--text-primary)", color: "var(--bg-primary)", fontWeight: 600 },

  ledger: { maxWidth: 1180, margin: "0 auto", background: "var(--surface)", borderRadius: 18, overflowX: "auto", overflowY: "hidden", WebkitOverflowScrolling: "touch", boxShadow: "0 4px 20px rgba(0,0,0,0.06)" },
  ledgerHeaderRow: { display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", borderBottom: "1px solid var(--border-color)", background: "var(--bg-secondary)", minWidth: 640 },
  thCell: { fontSize: 11, letterSpacing: "0.08em", color: "var(--text-secondary)", textTransform: "uppercase" },
  row: { display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", borderBottom: "1px solid var(--border-color)", minWidth: 640 },
  tdCell: { fontSize: 14, paddingRight: 8 },
  actualButton: { display: "inline-block", boxSizing: "border-box", appearance: "none", WebkitAppearance: "none", margin: 0, textAlign: "right", background: "none", border: "none", color: "var(--text-primary)", fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, lineHeight: "inherit", cursor: "pointer", borderBottom: "1px dashed #6E6E73", padding: 0 },
  inlineInput: { width: "100%", background: "var(--surface)", border: "1px solid #1D5C8A", borderRadius: 8, color: "var(--text-primary)", fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, padding: "2px 6px", textAlign: "right" },
  miniLink: { background: "none", border: "none", color: "var(--text-secondary)", fontSize: 10.5, textDecoration: "underline", cursor: "pointer", padding: 0 },
  miniLinkBlock: { background: "none", border: "none", color: "#3D6FA6", fontSize: 12, textDecoration: "underline", cursor: "pointer", padding: 0, marginTop: 4 },
  gaugeTrack: { position: "relative", height: 6, background: "var(--bg-secondary)", borderRadius: 3, overflow: "visible", marginBottom: 4 },
  gaugeFill: { height: "100%", borderRadius: 3, transition: "width 0.3s ease" },
  gaugeTolMark: { position: "absolute", left: "71.4%", top: -2, width: 1, height: 10, background: "#6E6E73" },
  gaugeLabel: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 11 },
  dualBarTrack: { position: "relative", height: 16, background: "var(--bg-secondary)", borderRadius: 3 },
  dualBarFill: { position: "absolute", left: 0, height: 6, borderRadius: 3, transition: "width 0.3s ease" },
  statusPill: { display: "inline-block", fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", padding: "4px 10px", borderRadius: 100 },
  removeBtn: { background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13 },
  addRow: { display: "flex", gap: 10, alignItems: "center", padding: "14px", background: "var(--bg-secondary)", flexWrap: "wrap" },
  addInput: { background: "var(--bg-secondary)", border: "1px solid transparent", borderRadius: 10, color: "var(--text-primary)", fontSize: 14, padding: "8px 12px" },
  addBtn: { background: "var(--accent)", border: "none", borderRadius: 100, color: "#FFFFFF", fontWeight: 600, fontSize: 13, padding: "9px 16px", cursor: "pointer", whiteSpace: "nowrap" },
  footer: { maxWidth: 1180, margin: "16px auto 0", fontSize: 12, color: "var(--text-secondary)" },
  // Full marketing-style footer (AppFooter, above) — mirrors sitemargin.co.za's
  // .site-footer/.footer-* rules in styles.css. One deliberate departure: the
  // social-icon circle background is white here instead of the marketing
  // site's --stage (#F5F5F7) tint, because #F5F5F7 is this app's own page
  // background — using it would make the icons invisible against the page.
  pubFooter: { maxWidth: 1180, margin: "0 auto", padding: "40px 0 0", borderTop: "1px solid var(--border-color)" },
  pubFooterTop: { display: "flex", flexWrap: "wrap", gap: 40, justifyContent: "space-between", paddingBottom: 30 },
  pubFooterBrand: { maxWidth: 280 },
  pubFooterLogoRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 },
  pubFooterLogoMark: { height: 38, width: "auto", display: "block" },
  pubFooterLogoText: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 18, letterSpacing: "-0.01em", color: "var(--text-primary)" },
  pubFooterTagline: { color: "var(--text-secondary)", fontSize: 13.5, lineHeight: 1.6, margin: "0 0 16px" },
  pubFooterSocial: { display: "flex", gap: 10 },
  pubFooterSocialLink: { width: 32, height: 32, borderRadius: "50%", background: "var(--surface)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", textDecoration: "none" },
  pubFooterCols: { display: "flex", gap: 40, flexWrap: "wrap" },
  pubFooterCol: { minWidth: 130 },
  pubFooterColHead: { fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", fontWeight: 600, marginBottom: 14 },
  pubFooterColLink: { display: "block", fontSize: 13.5, color: "var(--text-primary)", textDecoration: "none", marginBottom: 10 },
  pubFooterStoreLink: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-primary)", textDecoration: "none", marginBottom: 10 },
  pubFooterStoreLinkSoon: { color: "var(--text-secondary)" },
  pubFooterStoreIcon: { width: 18, height: 18, flex: "none" },
  pubFooterBottom: { borderTop: "1px solid var(--border-color)", marginTop: 8, padding: "18px 0 24px", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, fontSize: 12, color: "var(--text-secondary)" },
  pubFooterBottomLinks: { display: "flex", gap: 18, flexWrap: "wrap" },
  referralRow: { maxWidth: 1180, margin: "40px auto 0", padding: "32px 0", borderTop: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 32, flexWrap: "wrap" },
  referralText: { flex: 1, minWidth: 240 },
  referralEyebrow: { fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 6 },
  referralHeading: { fontSize: 17, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 },
  referralSub: { fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, maxWidth: 420 },
  referralActions: { display: "flex", gap: 10, flexWrap: "wrap" },
  referralBtn: { display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 100, fontSize: 13, fontWeight: 600, textDecoration: "none", border: "1px solid var(--text-primary)", color: "var(--text-primary)", background: "none", cursor: "pointer" },
  referralBtnWhatsapp: { borderColor: "#25D366", color: "var(--success)" },
  referralQrBlock: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: "0 0 auto" },
  referralQrCaption: { fontSize: 11, color: "var(--text-secondary)", textAlign: "center" },
  docFooter: { maxWidth: 1180, margin: "30px auto 0", paddingTop: 14, borderTop: "1px solid var(--border-color)" },
  dfRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  dfBrand: { display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 14, color: "var(--text-primary)" },
  dfMark: { height: 20, width: 20, display: "block" },
  dfText: { fontStyle: "normal" },
  dfMeta: { fontSize: 11, color: "var(--text-secondary)", fontFamily: "Arial, sans-serif" },
  dfDisclaimer: { fontSize: 10, color: "var(--text-secondary)", marginTop: 4, fontFamily: "Arial, sans-serif" },

  detailPanel: { background: "var(--bg-secondary)", padding: "16px 18px", borderBottom: "1px solid var(--border-color)" },
  detailGrid: { display: "grid", gridTemplateColumns: "minmax(170px,2.2fr) minmax(75px,0.75fr) minmax(70px,0.65fr) minmax(105px,1fr) minmax(105px,1fr) minmax(125px,1fr) minmax(125px,1fr)", gap: 12, overflowX: "auto" },
  detailField: { display: "flex", flexDirection: "column", gap: 5 },
  currencyInputWrap: { display: "flex", alignItems: "center", gap: 4, background: "var(--surface)", border: "1px solid var(--border-color)", borderRadius: 8, padding: "0 8px" },
  currencyPrefix: { fontSize: 12.5, color: "var(--text-secondary)" },
  detailLabel: { fontSize: 10.5, letterSpacing: "0.08em", color: "var(--text-secondary)", textTransform: "uppercase" },
  notesTextarea: { width: "100%", minHeight: 60, background: "var(--bg-secondary)", border: "1px solid transparent", borderRadius: 10, color: "var(--text-primary)", fontSize: 13, padding: "8px 10px", fontFamily: "'Inter', sans-serif", resize: "vertical", marginTop: 5 },
  attachmentLink: { fontSize: 12, color: "#3D6FA6", textDecoration: "none" },

  chartGrid: { maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 },
  chartCard: { background: "var(--surface)", borderRadius: 18, padding: "22px 24px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  chartCardGreen: { background: "radial-gradient(120% 100% at 100% 0%, rgba(76,122,92,0.10), rgba(76,122,92,0) 55%), var(--surface)", borderRadius: 18, padding: "22px 24px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", borderLeft: "4px solid var(--success)" },
  chartCardBlue: { background: "radial-gradient(120% 100% at 100% 0%, rgba(61,111,166,0.10), rgba(61,111,166,0) 55%), var(--surface)", borderRadius: 18, padding: "22px 24px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", borderLeft: "4px solid var(--accent)" },
  chartCardRed: { background: "radial-gradient(120% 100% at 100% 0%, rgba(193,70,43,0.09), rgba(193,70,43,0) 55%), var(--surface)", borderRadius: 18, padding: "22px 24px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", borderLeft: "4px solid var(--danger)" },
  chartCardGold: { background: "radial-gradient(120% 100% at 100% 0%, rgba(184,134,47,0.11), rgba(184,134,47,0) 55%), var(--surface)", borderRadius: 18, padding: "22px 24px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", borderLeft: "4px solid var(--warning)" },
  chartDot: { display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 7, position: "relative", top: -1 },
  chartTitle: { fontSize: 18, fontWeight: 600, marginBottom: 2 },
  chartSub: { fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 },

  trendRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border-color)", minWidth: 560 },
  trendHeadCell: { fontSize: 11, letterSpacing: "0.06em", color: "var(--text-secondary)", textTransform: "uppercase" },
  trendCell: { fontSize: 12, fontFamily: "'Space Grotesk', sans-serif" },

  quoteSheet: { maxWidth: 800, margin: "0 auto", background: "var(--surface)", borderRadius: 18, padding: "36px 40px", boxShadow: "0 12px 34px rgba(0,0,0,0.08)" },
  quoteHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "2px solid var(--text-primary)", paddingBottom: 20, marginBottom: 28 },
  quoteEyebrow: { fontSize: 12, letterSpacing: "0.14em", color: "var(--accent)", fontWeight: 600, marginBottom: 6 },
  quoteProjectName: { fontSize: 24, fontWeight: 700, letterSpacing: "-0.015em", color: "var(--text-primary)" },
  quoteMeta: { textAlign: "right", fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.7 },
  quoteCatHeading: { fontSize: 13, letterSpacing: "0.06em", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid var(--border-color)" },
  quoteRow: { display: "flex", padding: "6px 0", fontSize: 14, color: "var(--text-primary)" },
  quoteTotalRow: { display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 600, color: "var(--text-primary)", borderTop: "2px solid var(--text-primary)", paddingTop: 14, marginTop: 10 },
  quoteFootnote: { fontSize: 11.5, color: "var(--text-secondary)", marginTop: 30, lineHeight: 1.6, borderTop: "1px solid var(--border-color)", paddingTop: 16 },
  quoteClientEditRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" },
  quoteClientEditLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)" },
  quoteClientBlock: { marginBottom: 24, paddingBottom: 20, borderBottom: "1px solid var(--border-color)" },
  quoteClientLogo: { height: 40, width: "auto", maxWidth: 160, objectFit: "contain", borderRadius: 4 },
  quoteClientName: { fontSize: 15, fontWeight: 600, color: "var(--text-primary)" },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 },
  modalCard: { background: "var(--surface)", borderRadius: 18, maxWidth: 760, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "20px 24px", borderBottom: "1px solid var(--border-color)" },
  modalTitle: { fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--text-primary)" },
  modalSub: { fontSize: 12.5, color: "var(--text-secondary)", marginTop: 4, maxWidth: 480 },
  modalBody: { padding: "12px 24px", overflowY: "auto", flex: 1 },
  modalFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderTop: "1px solid var(--border-color)" },
  previewHeaderRow: { display: "flex", gap: 10, fontSize: 11, letterSpacing: "0.06em", color: "var(--text-secondary)", textTransform: "uppercase", padding: "8px 0", borderBottom: "1px solid var(--border-color)" },
  previewRow: { display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border-color)" },
  previewInput: { width: "100%", background: "var(--bg-secondary)", border: "1px solid transparent", borderRadius: 8, color: "var(--text-primary)", fontSize: 13, padding: "6px 8px" },
  previewNote: { fontSize: 10.5, color: "var(--text-secondary)", marginTop: 3 },
};
