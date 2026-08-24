import React, { useState, useMemo, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabaseClient";

// xlsx and pdfjs-dist are both large libraries only needed by the "import a
// spreadsheet/PDF" feature. They're loaded on demand (see xlsxBufferToRows
// and pdfBufferToRows below) instead of at the top of the file, so a visitor
// who never touches file import doesn't pay to download either of them.

// Supabase Edge Functions live at the same project ref, under /functions/v1
const SUPABASE_FUNCTIONS_URL = "https://mcxmtnlhqubaljvnwmzc.supabase.co/functions/v1";

/* ============================== HELPERS ============================== */

const fmt = (n) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(n || 0);

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
  ok: { label: "ON TRACK", color: "#4C7A5C", bg: "rgba(76,122,92,0.12)" },
  watch: { label: "WATCH", color: "#B8862F", bg: "rgba(184,134,47,0.12)" },
  over: { label: "OVER", color: "#C1462B", bg: "rgba(193,70,43,0.12)" },
};

const CATEGORIES = ["Labour", "Materials", "Labour & Materials", "Subcontractors", "Other"];
const CATEGORY_COLOR = { Labour: "#3D6FA6", Materials: "#B8862F", "Labour & Materials": "#4FA8A0", Subcontractors: "#8B5FA3", Other: "#6E6E73" };

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
    budgetScore = Math.max(0, Math.min(100, 100 - avgOverrun * 4)); // 25% over => 0
  }

  const scheduled = items.filter((i) => i.due_date && i.completed_date);
  let scheduleScore = null;
  let avgDaysLate = null;
  if (scheduled.length > 0) {
    const lateness = scheduled.map((i) => daysBetween(i.due_date, i.completed_date) ?? 0);
    avgDaysLate = lateness.reduce((s, v) => s + v, 0) / lateness.length;
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

  return {
    budgetScore, scheduleScore, qualityScore, overall,
    avgDaysLate, avgQuality,
    itemCount: items.length, ratedCount: rated.length, scheduledCount: scheduled.length,
    totalBudget, totalActual, variance: totalActual - totalBudget,
  };
}

function scoreColor(score) {
  if (score == null) return "#6E6E73";
  if (score >= 75) return "#4C7A5C";
  if (score >= 50) return "#B8862F";
  return "#C1462B";
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
  "Labour & Materials": ["supply and install", "supply & install", "supply and fix", "supply & fix", "labour and materials", "labour & materials"],
  Labour: ["labour", "labor", "wages", "preliminaries", "prelim"],
  Materials: ["material", "concrete", "steel", "earthwork", "excavation", "masonry", "roofing", "brickwork", "supply"],
  Subcontractors: ["subcontract", "sub-contract", "nominated", "specialist"],
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
              <span style={{ fontSize: 12.5, color: "#4A4A4F" }}>{item.name}</span>
              <span style={{ fontSize: 11.5, fontFamily: "'IBM Plex Mono', monospace", color: over ? "#C1462B" : "#4C7A5C" }}>
                {fmtShort(item.actual)} / {fmtShort(item.budget)}
              </span>
            </div>
            <div style={{ position: "relative", height: 16 }}>
              <div style={{ position: "absolute", top: 0, left: 0, width: `${bPct}%`, height: 7, background: "#C7C7CE", borderRadius: 3 }} />
              <div style={{ position: "absolute", top: 9, left: 0, width: `${aPct}%`, height: 7, background: over ? "#C1462B" : "#4C7A5C", borderRadius: 3 }} />
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 16, marginTop: 4, flexWrap: "wrap" }}>
        <LegendDot color="#C7C7CE" label="Budget" />
        <LegendDot color="#4C7A5C" label="Actual (within)" />
        <LegendDot color="#C1462B" label="Actual (over)" />
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
        <text x="70" y="82" textAnchor="middle" fill="#1D1D1F" fontSize="14" fontWeight="600" fontFamily="'IBM Plex Mono', monospace">
          {fmtShort(total)}
        </text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 160 }}>
        {rollup.map((c) => (
          <div key={c.category} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: CATEGORY_COLOR[c.category] }} />
            <span style={{ color: "#4A4A4F" }}>{c.category}</span>
            <span style={{ marginLeft: "auto", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#6E6E73" }}>
              {((c.actual / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProgressScatter({ items }) {
  const plotted = items.filter((i) => Number(i.budget) > 0 && i.percent_complete != null);
  if (plotted.length === 0) return <EmptyChart label="Set % complete on line items to plot them." />;

  const W = 320, H = 220, pad = 34;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 420, display: "block" }}>
        <rect x={pad} y={10} width={W - pad - 10} height={H - pad - 10} fill="#F5F5F7" stroke="#E8E8ED" />
        <line x1={pad} y1={H - pad} x2={W - 10} y2={10} stroke="#C7C7CE" strokeWidth="1" strokeDasharray="3,3" />
        <text x={W - 14} y={22} textAnchor="end" fill="#A0A0A6" fontSize="8" fontFamily="'IBM Plex Mono', monospace">on parity</text>
        {plotted.map((item) => {
          const prog = Math.min(Number(item.percent_complete), 100);
          const spent = Math.min((Number(item.actual) / Number(item.budget)) * 100, 130);
          const x = pad + (prog / 100) * (W - pad - 10);
          const y = H - pad - (spent / 130) * (H - pad - 10);
          const gap = spent - prog;
          const color = gap > 15 ? "#C1462B" : gap > 5 ? "#B8862F" : "#4C7A5C";
          return <circle key={item.id} cx={x} cy={Math.max(y, 12)} r="4.5" fill={color} opacity="0.85" />;
        })}
        <text x={pad} y={H - 12} fill="#6E6E73" fontSize="9" fontFamily="'IBM Plex Mono', monospace">0%</text>
        <text x={W - 10} y={H - 12} textAnchor="end" fill="#6E6E73" fontSize="9" fontFamily="'IBM Plex Mono', monospace">100% complete →</text>
      </svg>
      <p style={{ fontSize: 12, color: "#6E6E73", marginTop: 10, maxWidth: 420 }}>
        Anything above the dashed line is spending faster than it's progressing. The further above, the more urgent.
      </p>
    </div>
  );
}

function TrendChart({ snapshots }) {
  const W = 100, H = 30;
  const values = snapshots.map((s) => Number(s.variance));
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const points = snapshots.map((s, i) => {
    const x = (i / Math.max(snapshots.length - 1, 1)) * W;
    const y = H - ((Number(s.variance) - min) / range) * H;
    return `${x},${y}`;
  }).join(" ");
  const zeroY = H - ((0 - min) / range) * H;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 80, display: "block" }} preserveAspectRatio="none">
      <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="#E8E8ED" strokeWidth="0.5" strokeDasharray="1,1" />
      <polyline points={points} fill="none" stroke="#B85C2C" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function LegendDot({ color, label }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#6E6E73" }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      {label}
    </span>
  );
}

function EmptyChart({ label }) {
  return <div style={{ fontSize: 13, color: "#6E6E73", padding: "24px 0" }}>{label}</div>;
}

function ScoreBar({ label, score, detail }) {
  const color = scoreColor(score);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#4A4A4F" }}>{label}</span>
        <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", color }}>
          {score == null ? "—" : Math.round(score)}
        </span>
      </div>
      <div style={{ height: 6, background: "#F2F2F5", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${score ?? 0}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.3s ease" }} />
      </div>
      {detail && <div style={{ fontSize: 10.5, color: "#6E6E73", marginTop: 3 }}>{detail}</div>}
    </div>
  );
}

function SummaryCard({ label, value, accent }) {
  return (
    <div style={styles.summaryCard}>
      <div style={styles.summaryLabel}>{label}</div>
      <div style={{ ...styles.summaryValue, color: accent || "#1D1D1F" }}>{value}</div>
    </div>
  );
}

function AppLogo() {
  return (
    <div style={styles.appLogoRow}>
      <svg className="sm-app-logo-mark" style={styles.appLogoMark} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="8" width="28" height="8" fill="#3C2E1E" />
        <rect x="34" y="8" width="10" height="8" fill="#B85C2C" />
        <rect x="4" y="20" width="40" height="8" fill="#3C2E1E" />
        <rect x="4" y="32" width="40" height="8" fill="#3C2E1E" />
      </svg>
      <div className="sm-app-logo-text" style={styles.appLogoText}>
        site<span style={{ color: "#B85C2C" }}>Margin</span>
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
      input:focus, select:focus, textarea:focus { outline: 2px solid #B85C2C; outline-offset: 1px; }
      button:focus-visible { outline: 2px solid #B85C2C; outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      .print-only-status { display: none; }
      .print-only-footer { display: none; }
      .sm-logo-menu-item:hover { background: #F5F5F7; }
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
  const tabs = [
    ["dashboard", "Projects"],
    ["subcontractors", "Subcontractors"],
    ["templates", "Templates"],
  ];
  const closeAnd = (fn) => () => { setMenuOpen(false); if (fn) fn(); };
  return (
    <div style={styles.dashHeader}>
      <div style={styles.dashNavBar}>
        <AppLogo />
        <div className="no-print" style={styles.dashNavRight}>
          {/* Mirrors the marketing site's always-visible "Go to App" button,
              in the same spot next to the hamburger — pointing the other
              way. Native-only exclusion for the same reason as elsewhere:
              it would hijack the app's own webview with no way back. */}
          {!Capacitor.isNativePlatform() && (
            <a href="https://sitemargin.co.za" style={styles.navHomeLink}>Home</a>
          )}
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
        </div>
      </div>
      {!hideTitle && (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {logoNode !== undefined ? logoNode : (
            logoUrl && (
              // Deliberately not "no-print" — the company logo should appear on
              // printed/exported output (change order sheets, cost reports etc.),
              // not just on screen.
              <img src={logoUrl} alt="Company logo" style={styles.companyLogoMark} />
            )
          )}
          {titleNode !== undefined ? titleNode : <h1 style={styles.dashTitle}>{title}</h1>}
        </div>
      )}

      {menuOpen && (
        <div id="appMenuPanel" className="no-print" style={styles.menuPanel}>
          <div style={styles.menuPanelInner}>
            {onNavigate && tabs.map(([key, label]) => (
              <button
                key={key}
                style={{ ...styles.menuPanelLink, ...(current === key ? styles.menuPanelLinkActive : {}) }}
                onClick={closeAnd(() => onNavigate(key))}
              >
                {label}
              </button>
            ))}
            {/* The marketing site's own menu, one level down, lists its
                other pages (What's inside, Pricing, About, Contact, Terms,
                Privacy) below its app-equivalent links. Mirroring that here
                — same items, same reduced Terms/Privacy treatment — so the
                two menus match in contents, not just in style. Web-only,
                same native-webview-hijack reasoning as the footer. */}
            {!Capacitor.isNativePlatform() && (
              <>
                {[
                  { label: "What's inside", href: "https://sitemargin.co.za/whats-inside.html" },
                  { label: "Pricing", href: "https://sitemargin.co.za/pricing.html" },
                  { label: "About", href: "https://sitemargin.co.za/about.html" },
                  { label: "Contact", href: "https://sitemargin.co.za/contact.html" },
                ].map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.menuPanelLink}
                    onClick={() => setMenuOpen(false)}
                  >
                    {item.label}
                  </a>
                ))}
                <a
                  href="https://sitemargin.co.za/terms.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ ...styles.menuPanelDim, ...styles.menuPanelDimFirst }}
                  onClick={() => setMenuOpen(false)}
                >
                  Terms
                </a>
                <a
                  href="https://sitemargin.co.za/privacy.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.menuPanelDim}
                  onClick={() => setMenuOpen(false)}
                >
                  Privacy
                </a>
              </>
            )}
            <div style={styles.menuPanelActions}>
              <button style={styles.menuPanelGhost} onClick={closeAnd(() => window.print())}>Print</button>
              {onSignOut && <button style={styles.menuPanelSolid} onClick={closeAnd(onSignOut)}>Sign out</button>}
            </div>
            {userEmail && <div style={styles.menuPanelEmail}>{userEmail}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/* Footer, matching sitemargin.co.za's own footer exactly (same text, same
   six links back to the marketing site's pages) — rendered at the bottom of
   every app page for the "all aspects, uniform" header/footer request. */
function AppFooter() {
  return (
    <div className="no-print" style={styles.siteFooter}>
      <span>SiteMargin — built for contractors, not accountants.</span>
      {/* Same reasoning as the hamburger menu's marketing-site link: on the
          native app these would hijack the app's own webview to show an
          external page. They're shown on the web build, where linking out
          to the marketing site's pages is a normal, expected action. */}
      {!Capacitor.isNativePlatform() && (
        <div style={styles.siteFooterLinks}>
          <a href="https://sitemargin.co.za/whats-inside.html" target="_blank" rel="noopener noreferrer" style={styles.siteFooterLink}>What's inside</a>
          <a href="https://sitemargin.co.za/pricing.html" target="_blank" rel="noopener noreferrer" style={styles.siteFooterLink}>Pricing</a>
          <a href="https://sitemargin.co.za/about.html" target="_blank" rel="noopener noreferrer" style={styles.siteFooterLink}>About</a>
          <a href="https://sitemargin.co.za/contact.html" target="_blank" rel="noopener noreferrer" style={styles.siteFooterLink}>Contact</a>
          <a href="https://sitemargin.co.za/terms.html" target="_blank" rel="noopener noreferrer" style={styles.siteFooterLink}>Terms</a>
          <a href="https://sitemargin.co.za/privacy.html" target="_blank" rel="noopener noreferrer" style={styles.siteFooterLink}>Privacy</a>
        </div>
      )}
    </div>
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
  const [selectedTier, setSelectedTier] = useState(() => {
    try { return localStorage.getItem("sm_selected_tier") || null; } catch { return null; }
  });
  const [gateMenuOpen, setGateMenuOpen] = useState(false);
  const emailInputRef = useRef(null);

  function chooseTier(tier) {
    setSelectedTier(tier);
    try { localStorage.setItem("sm_selected_tier", tier); } catch {}
    if (tier === "free") return;
    // Paid tiers need a signed-in session before checkout can start —
    // scroll them to the email form instead of a dead click.
    emailInputRef.current?.focus();
    emailInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function checkAccess(currentSession) {
    if (!currentSession) {
      setStatus("signedout");
      return;
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

    if (signup?.access_granted || hasActiveSub) {
      setStatus("approved");
    } else {
      setStatus("pending");
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => checkAccess(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      checkAccess(newSession);
    });
    return () => listener.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendMagicLink(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setSendState("sending");
    setErrorMsg("");
    // Always send the magic link back to production, unless we're actually
    // running the local dev server right now. This stops sign-in links from
    // silently pointing at localhost (or a stray preview URL) just because
    // that's what tab happened to be open when the link was requested.
    const PROD_ORIGIN = "https://app.sitemargin.co.za";
    const redirectOrigin = window.location.hostname === "localhost" ? window.location.origin : PROD_ORIGIN;
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectOrigin },
    });
    if (error) {
      setSendState("error");
      setErrorMsg(error.message);
    } else {
      setSendState("sent");
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setStatus("signedout");
    setSession(null);
  }

  async function startCheckout(tier) {
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
        body: JSON.stringify({ email: session.user.email, tier }),
      });
      const json = await res.json();
      if (json.redirectUrl) {
        try { localStorage.removeItem("sm_selected_tier"); } catch {}
        window.location.href = json.redirectUrl;
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

  if (status === "checking") {
    return (
      <div style={styles.page}>
        <GlobalStyles />
        <div style={{ ...styles.footer, textAlign: "center", padding: 80 }}>Loading…</div>
      </div>
    );
  }

  if (status === "approved") {
    return <AppShell userEmail={session?.user?.email} onSignOut={signOut} />;
  }

  // signed out, pending, or denied — all get the gate screen, with different messaging
  return (
    <div style={styles.page}>
      <GlobalStyles />
      <div style={styles.gateNavOuter}>
        <div style={styles.gateNavWrap}>
          <div style={styles.gateNav}>
            <AppLogo />
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
          </div>
        </div>
      </div>
      {gateMenuOpen && (
        <div id="gateMenuPanel" style={{ ...styles.menuPanel, paddingTop: 140 }}>
          <div style={styles.menuPanelInner}>
            {[
              { label: "Home", href: "https://sitemargin.co.za/index.html" },
              { label: "What's inside", href: "https://sitemargin.co.za/whats-inside.html" },
              { label: "Pricing", href: "https://sitemargin.co.za/pricing.html" },
              { label: "About", href: "https://sitemargin.co.za/about.html" },
              { label: "Contact", href: "https://sitemargin.co.za/contact.html" },
            ].map((item) => (
              <button
                key={item.label}
                style={styles.menuPanelLink}
                onClick={() => { setGateMenuOpen(false); window.location.href = item.href; }}
              >
                {item.label}
              </button>
            ))}
            {[
              { label: "Terms", href: "https://sitemargin.co.za/terms.html" },
              { label: "Privacy", href: "https://sitemargin.co.za/privacy.html" },
            ].map((item, i) => (
              <button
                key={item.label}
                style={{ ...styles.menuPanelDim, ...(i === 0 ? styles.menuPanelDimFirst : null) }}
                onClick={() => { setGateMenuOpen(false); window.location.href = item.href; }}
              >
                {item.label}
              </button>
            ))}
            <div style={{ ...styles.menuPanelActions, flexDirection: "column" }}>
              <button
                style={styles.menuPanelGhost}
                onClick={() => { setGateMenuOpen(false); window.location.href = "https://app.sitemargin.co.za"; }}
              >
                Open the app
              </button>
              <button
                style={styles.menuPanelSolid}
                onClick={() => { setGateMenuOpen(false); window.location.href = "https://app.sitemargin.co.za"; }}
              >
                Sign up free
              </button>
            </div>
          </div>
        </div>
      )}
      <div style={styles.gateWrap}>
        {status === "signedout" && sendState !== "sent" && (
          <div style={styles.heroWrap}>
            <div style={styles.eyebrow}>COST VARIANCE INTELLIGENCE · FOR SOUTH AFRICAN CONTRACTORS</div>
            <h1 style={{ ...styles.dashTitle, margin: "10px 0 14px" }}>
              Know you're <em style={styles.heroEm}>over budget</em> before your client does.
            </h1>
            <p style={styles.heroSub}>
              Stop finding out about cost overruns at month-end. SiteMargin flags budget risk the moment it
              happens — built for contractors who don't have time for enterprise QS software.
            </p>

            <div style={styles.mockSheet}>
              <div style={styles.mockHead}>
                <span>Line item</span>
                <span>Tolerance</span>
              </div>
              {[
                { name: "Concrete & foundations", nums: "R448,000 / R420,000", pct: "+6.7%", fill: 76, color: "#C1462B", bg: "rgba(193,70,43,0.1)", tag: "OVER" },
                { name: "Plumbing rough-in", nums: "R126,000 / R118,000", pct: "+6.8%", fill: 76, color: "#B8862F", bg: "rgba(184,134,47,0.1)", tag: "WATCH" },
                { name: "Structural steel", nums: "R298,000 / R310,000", pct: "-3.9%", fill: 68, color: "#4C7A5C", bg: "rgba(76,122,92,0.1)", tag: "ON TRACK" },
              ].map((row) => (
                <div key={row.name} style={styles.mockRow}>
                  <span style={styles.mockName}>{row.name}</span>
                  <span style={styles.mockNums}>{row.nums}</span>
                  <span style={styles.mockGauge}>
                    <div style={styles.gaugeTrack}>
                      <div style={{ ...styles.gaugeFill, width: `${row.fill}%`, background: row.color }} />
                    </div>
                    <span style={{ ...styles.gaugeLabel, color: row.color }}>{row.pct}</span>
                  </span>
                  <span style={{ ...styles.pill, color: row.color, background: row.bg }}>{row.tag}</span>
                </div>
              ))}
            </div>

            <div style={styles.problemBlock}>
              <div style={styles.pricingHead}>The problem</div>
              <p style={{ ...styles.gateText, marginBottom: 0 }}>
                Most overruns are visible weeks before anyone notices them. The number that gives it away isn't
                the budget — it's the gap between money spent and work actually done. SiteMargin watches that gap
                on every line item and tells you the moment it opens up.
              </p>
            </div>
          </div>
        )}

        <h1 style={{ ...styles.dashTitle, marginBottom: 10 }}>
          {status === "pending" ? "Almost there" : status === "denied" ? "Something went wrong" : "Try it for free"}
        </h1>

        {status === "signedout" && (
          <>
            {sendState === "sent" ? (
              <div style={styles.gateNotice}>
                Check your inbox at <b>{email}</b> for the sign-in link. You can close this tab.
              </div>
            ) : (
              <>
                <p style={styles.gateText}>
                  Enter your email and we'll send you a one-click sign-in link — no password needed.
                </p>
                {selectedTier && (
                  <div style={styles.tierNote}>
                    {selectedTier === "free" ? "Starting on the Free plan." : `Continuing with ${selectedTier === "contractor" ? "Contractor" : "Company"} — you'll choose it again once you're signed in.`}
                  </div>
                )}
                <form onSubmit={sendMagicLink} style={styles.gateForm}>
                  <input
                    ref={emailInputRef}
                    type="email"
                    required
                    placeholder="you@yourcompany.co.za"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={styles.addInput}
                  />
                  <button type="submit" style={styles.addBtn} disabled={sendState === "sending"}>
                    {sendState === "sending" ? "Sending…" : "Send sign-in link"}
                  </button>
                </form>
              </>
            )}
            {sendState === "error" && <div style={styles.gateError}>{errorMsg}</div>}
            <div style={styles.pricingHead}>Pricing</div>
            <div style={styles.checkoutGrid}>
              <div style={{ ...styles.checkoutCard, ...(selectedTier === "free" ? styles.checkoutCardSelected : {}) }}>
                <div style={styles.checkoutTier}>Free</div>
                <div style={styles.checkoutPrice}>R0</div>
                <div style={styles.checkoutDesc}>For trying it out on a single job. 1 active project, unlimited line items.</div>
                <button type="button" style={styles.tierCta} onClick={() => chooseTier("free")}>Get started</button>
              </div>
              <div style={{ ...styles.checkoutCard, ...(selectedTier === "contractor" ? styles.checkoutCardSelected : {}) }}>
                <div style={styles.checkoutTier}>Contractor</div>
                <div style={styles.checkoutPrice}>
                  R199<span style={styles.checkoutPriceUnit}>/month</span>
                </div>
                <div style={styles.checkoutDesc}>Unlimited projects, change orders, payments &amp; retention, PDF export.</div>
                <button type="button" style={styles.tierCta} onClick={() => chooseTier("contractor")}>Get started</button>
              </div>
              <div style={{ ...styles.checkoutCard, ...(selectedTier === "firm" ? styles.checkoutCardSelected : {}) }}>
                <div style={styles.checkoutTier}>Company</div>
                <div style={styles.checkoutPrice}>
                  R599<span style={styles.checkoutPriceUnit}>/month</span>
                </div>
                <div style={styles.checkoutDesc}>Everything in Contractor, plus unlimited attachments and priority support.</div>
                <button type="button" style={styles.tierCta} onClick={() => chooseTier("firm")}>Get started</button>
              </div>
            </div>
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
      });
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
                  <button type="button" className="sm-logo-menu-item" style={{ ...styles.logoMenuItem, color: "#C1462B" }} onClick={() => { setLogoMenuOpen(false); removeLogo(); }}>
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
            <SummaryCard label="Revised allocation" value={fmt(portfolio.revisedBudget)} accent="#B8862F" />
          )}
          <SummaryCard label="Actual spend" value={fmt(portfolio.actual)} />
          <SummaryCard
            label="Net variance"
            value={`${portfolio.variance >= 0 ? "+" : ""}${fmt(portfolio.variance)}`}
            accent={portfolio.variance > 0 ? "#C1462B" : "#4C7A5C"}
          />
          <SummaryCard label="Retention held" value={fmt(portfolio.retentionHeld)} />
          <SummaryCard
            label="Projects flagged"
            value={`${portfolio.overCount} over · ${portfolio.watchCount} watch`}
            accent={portfolio.overCount ? "#C1462B" : portfolio.watchCount ? "#B8862F" : "#4C7A5C"}
          />
          <SummaryCard label="Total line items" value={String(portfolio.lineCount)} />
        </div>
      )}

      {atFreeLimit ? (
        <div className="no-print" style={styles.freeLimitBanner}>
          <span>You've used your Free plan's {FREE_PROJECT_LIMIT} project. Upgrade to Contractor or Company for unlimited projects.</span>
          <a href="https://sitemargin.co.za/pricing.html" target="_blank" rel="noopener noreferrer" style={styles.freeLimitLink}>
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
            const color = p.variance > 0 ? "#C1462B" : "#4C7A5C";
            const spentPct = p.budget ? Math.min((p.actual / p.budget) * 100, 100) : 0;
            return (
              <div key={p.id} style={styles.projectCard} onClick={() => onOpen(p.id)}>
                <div style={styles.projectCardTop}>
                  <div style={styles.projectName}>{p.name}</div>
                  <button style={styles.deleteProjectBtn} className="no-print" onClick={(e) => { e.stopPropagation(); deleteProject(p.id, p.name); }}>✕</button>
                </div>
                <div style={{ height: 5, background: "#F2F2F5", borderRadius: 3, marginBottom: 10 }}>
                  <div style={{ width: `${spentPct}%`, height: "100%", background: color, borderRadius: 3 }} />
                </div>
                <div style={styles.projectNums}>
                  <span>{fmt(p.budget)} budget</span>
                  <span style={{ color, fontWeight: 600 }}>
                    {p.variance >= 0 ? "+" : ""}{fmt(p.variance)} ({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)
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

  async function loadAll() {
    setLoading(true);
    const { data: subsData } = await supabase.from("subcontractors").select("*").order("name");
    const { data: items } = await supabase.from("line_items").select("*").not("subcontractor_id", "is", null);
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

  const ranked = useMemo(() => {
    return subs
      .map((s) => ({ sub: s, score: scoreSubcontractor(itemsBySub[s.id] || []) }))
      .sort((a, b) => (b.score.overall ?? -1) - (a.score.overall ?? -1));
  }, [subs, itemsBySub]);

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <PageHeader title="Subcontractor scorecards" current="subcontractors" onNavigate={onNavigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={logoUrl} />

      <div style={styles.explainer}>
        Scores build up automatically from the line items you assign to each sub. <b>Budget</b> comes from how close
        actuals land to budget, <b>schedule</b> from due date vs completed date, and <b>quality</b> from the 1–5 rating
        you set per line item. Dimensions with no data yet show a dash rather than a misleading zero.
      </div>

      <div className="no-print" style={styles.addRowStandalone}>
        <input style={{ ...styles.addInput, flex: 1.6 }} placeholder="Subcontractor name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input style={{ ...styles.addInput, flex: 1.2 }} placeholder="Trade (e.g. Electrical)" value={newTrade} onChange={(e) => setNewTrade(e.target.value)} />
        <input style={{ ...styles.addInput, flex: 1.2 }} placeholder="Contact (optional)" value={newContact} onChange={(e) => setNewContact(e.target.value)} />
        <button style={styles.addBtn} onClick={addSub}>+ Add subcontractor</button>
      </div>

      {loading ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>Loading…</div>
      ) : ranked.length === 0 ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>
          No subcontractors yet. Add one above, then assign line items to them inside a project.
        </div>
      ) : (
        <div style={styles.projectGrid}>
          {ranked.map(({ sub, score }) => {
            const isOpen = expanded === sub.id;
            return (
              <div key={sub.id} style={styles.scoreCard}>
                <div style={styles.projectCardTop}>
                  <div>
                    <div style={styles.projectName}>{sub.name}</div>
                    {sub.trade && <div style={{ fontSize: 11.5, color: "#6E6E73", marginTop: 2 }}>{sub.trade}</div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: "#6E6E73", letterSpacing: "0.08em" }}>OVERALL</div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: scoreColor(score.overall) }}>
                        {score.overall == null ? "—" : Math.round(score.overall)}
                      </div>
                    </div>
                    <button style={styles.deleteProjectBtn} className="no-print" onClick={() => removeSub(sub.id, sub.name)}>✕</button>
                  </div>
                </div>

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

                <button style={styles.miniLinkBlock} className="no-print" onClick={() => setExpanded(isOpen ? null : sub.id)}>
                  {isOpen ? "Hide line items" : `View ${score.itemCount} line item${score.itemCount === 1 ? "" : "s"}`}
                </button>

                {isOpen && (
                  <div style={{ marginTop: 10, borderTop: "1px solid #F2F2F5", paddingTop: 10 }}>
                    {(itemsBySub[sub.id] || []).length === 0 ? (
                      <div style={{ fontSize: 12, color: "#6E6E73" }}>No line items assigned to this sub yet.</div>
                    ) : (
                      (itemsBySub[sub.id] || []).map((i) => {
                        const late = daysBetween(i.due_date, i.completed_date);
                        return (
                          <div key={i.id} style={styles.subItemRow}>
                            <span style={{ fontSize: 12.5, flex: 2 }}>{i.name}</span>
                            <span style={{ fontSize: 11.5, fontFamily: "'IBM Plex Mono', monospace", color: Number(i.actual) > Number(i.budget) ? "#C1462B" : "#4C7A5C", flex: 1, textAlign: "right" }}>
                              {fmtShort(i.actual)} / {fmtShort(i.budget)}
                            </span>
                            <span style={{ fontSize: 11, color: "#6E6E73", flex: 0.8, textAlign: "right" }}>
                              {late == null ? "—" : late > 0 ? `${late}d late` : `${Math.abs(late)}d early`}
                            </span>
                            <span style={{ fontSize: 11, color: "#B8862F", flex: 0.5, textAlign: "right" }}>
                              {i.quality_rating ? `${i.quality_rating}/5` : "—"}
                            </span>
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
  const [addingTo, setAddingTo] = useState(null);
  const [itemName, setItemName] = useState("");
  const [itemCategory, setItemCategory] = useState(CATEGORIES[0]);
  const [itemBudget, setItemBudget] = useState("");

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

  async function createTemplate() {
    if (!newName.trim()) return;
    const { data, error } = await supabase
      .from("templates").insert({ name: newName.trim(), description: newDesc.trim(), owner_email: userEmail }).select().single();
    if (!error && data) {
      setTemplates((prev) => [data, ...prev]);
      setNewName(""); setNewDesc("");
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
    setItemsByTemplate((prev) => ({ ...prev, [templateId]: (prev[templateId] || []).filter((i) => i.id !== itemId) }));
    await supabase.from("template_items").delete().eq("id", itemId);
  }

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <PageHeader title="Templates" current="templates" onNavigate={onNavigate} userEmail={userEmail} onSignOut={onSignOut} logoUrl={logoUrl} />

      <div style={styles.explainer}>
        Build a standard line-item set once — a typical residential build, a shopfit, whatever you repeat — then apply it
        to any new project in one click instead of retyping it. You can also save an existing project's line items
        straight back out as a new template from inside that project.
        <div style={{ marginTop: 10 }}>
          Need a starting point? <a href="https://jbcc.co.za/free-forms/" target="_blank" rel="noopener noreferrer" style={styles.explainerLink}>JBCC's free standard forms ↗</a>
          {" · "}<a href="https://www.cidb.org.za/about-us/our-construction-mandate/" target="_blank" rel="noopener noreferrer" style={styles.explainerLink}>CIDB registration ↗</a>
          {" · "}<a href="https://www.sans10400.co.za/nhbrc-2/" target="_blank" rel="noopener noreferrer" style={styles.explainerLink}>NHBRC ↗</a>
          {" · "}<a href="https://www.sans10400.co.za/" target="_blank" rel="noopener noreferrer" style={styles.explainerLink}>SANS 10400 ↗</a>
        </div>
      </div>

      <div className="no-print" style={styles.addRowStandalone}>
        <input style={{ ...styles.addInput, flex: 1.4 }} placeholder="Template name (e.g. Standard residential build)" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input style={{ ...styles.addInput, flex: 1.6 }} placeholder="Description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
        <button style={styles.addBtn} onClick={createTemplate}>+ New template</button>
      </div>

      {loading ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>Loading…</div>
      ) : templates.length === 0 ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>
          No templates yet. Create one above, or save one from an existing project.
        </div>
      ) : (
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          {templates.map((t) => {
            const tItems = itemsByTemplate[t.id] || [];
            const total = tItems.reduce((s, i) => s + Number(i.budget || 0), 0);
            const isOpen = expanded === t.id;
            return (
              <div key={t.id} style={styles.templateCard}>
                <div style={styles.projectCardTop}>
                  <div>
                    <div style={styles.projectName}>{t.name}</div>
                    {t.description && <div style={{ fontSize: 12, color: "#6E6E73", marginTop: 3 }}>{t.description}</div>}
                    <div style={{ fontSize: 11.5, color: "#6E6E73", marginTop: 6, fontFamily: "'IBM Plex Mono', monospace" }}>
                      {tItems.length} line item{tItems.length === 1 ? "" : "s"} · {fmt(total)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }} className="no-print">
                    <button style={styles.miniLink} onClick={() => setExpanded(isOpen ? null : t.id)}>
                      {isOpen ? "Collapse" : "Edit items"}
                    </button>
                    <button style={styles.deleteProjectBtn} onClick={() => deleteTemplate(t.id, t.name)}>✕</button>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 12, borderTop: "1px solid #F2F2F5", paddingTop: 12 }}>
                    {tItems.map((i) => (
                      <div key={i.id} style={styles.subItemRow}>
                        <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 2 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: CATEGORY_COLOR[i.category] || "#6E6E73" }} />
                          <span style={{ fontSize: 12.5 }}>{i.name}</span>
                        </span>
                        <span style={{ fontSize: 11.5, color: "#6E6E73", flex: 0.8 }}>{i.category}</span>
                        <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", flex: 0.8, textAlign: "right" }}>{fmt(i.budget)}</span>
                        <button style={{ ...styles.removeBtn, flex: 0.2, textAlign: "right" }} className="no-print" onClick={() => removeTemplateItem(t.id, i.id)}>✕</button>
                      </div>
                    ))}
                    <div className="no-print" style={{ ...styles.addRow, marginTop: 10, borderRadius: 4 }}>
                      <input style={{ ...styles.addInput, flex: 2 }} placeholder="Line item name" value={addingTo === t.id ? itemName : ""} onChange={(e) => { setAddingTo(t.id); setItemName(e.target.value); }} />
                      <select style={{ ...styles.addInput, flex: 1 }} value={addingTo === t.id ? itemCategory : CATEGORIES[0]} onChange={(e) => { setAddingTo(t.id); setItemCategory(e.target.value); }}>
                        {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input style={{ ...styles.addInput, flex: 0.9, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }} placeholder="Budget (optional)" type="number" value={addingTo === t.id ? itemBudget : ""} onChange={(e) => { setAddingTo(t.id); setItemBudget(e.target.value); }} />
                      <button style={styles.addBtn} onClick={() => addTemplateItem(t.id)}>+ Add</button>
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
  const [taskStart, setTaskStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [taskEnd, setTaskEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [documents, setDocuments] = useState([]);
  const [docCategory, setDocCategory] = useState("Drawings");
  const [docLineItemId, setDocLineItemId] = useState("");
  const documentsInputRef = useRef(null);
  const DOC_CATEGORIES = ["Drawings", "Contracts", "Specifications", "Photos", "Correspondence", "Other"];
  const fileInputRef = useRef(null);
  const attachInputRef = useRef(null);
  const attachTargetItem = useRef(null);
  const plansInputRef = useRef(null);
  const saveTimers = useRef({});

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

  const approvedCoTotal = useMemo(
    () => changeOrders.filter((c) => c.status === "approved").reduce((s, c) => s + Number(c.amount || 0), 0),
    [changeOrders]
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

  function scheduleSave(itemId, patch) {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, ...patch } : i)));
    if (saveTimers.current[itemId]) clearTimeout(saveTimers.current[itemId]);
    saveTimers.current[itemId] = setTimeout(async () => {
      await supabase.from("line_items").update(patch).eq("id", itemId);
    }, 500);
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


  function downloadTemplate() {
    const csv = [
      "Name,Category,Budget,Actual,Percent Complete,Claimed,Certified",
      "Excavation & earthworks,Subcontractors,185000,0,0,0,0",
      "Concrete & foundations,Materials,420000,0,0,0,0",
      "Electrical rough-in,Labour,140000,0,0,0,0",
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "sitemargin-budget-template.csv"; a.click();
    URL.revokeObjectURL(url);
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
      if (attachment.url) window.open(attachment.url, "_blank", "noopener");
      return;
    }
    const { data, error } = await supabase.storage.from("attachments").createSignedUrl(attachment.path, 60);
    if (error || !data?.signedUrl) {
      setImportMessage({ type: "error", text: "Couldn't open that file — please try again." });
      setTimeout(() => setImportMessage(null), 6000);
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener");
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
    window.open(data.signedUrl, "_blank", "noopener");
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
    window.open(data.signedUrl, "_blank", "noopener");
  }

  async function setPaymentDate(itemId, date) {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, payment_date: date } : i)));
    await supabase.from("line_items").update({ payment_date: date || null }).eq("id", itemId);
  }

  async function removePlan(path) {
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
    if (!taskName.trim() || !taskStart || !taskEnd) return;
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
    window.open(data.signedUrl, "_blank", "noopener");
  }

  async function removeDocument(doc) {
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

  async function logSnapshot() {
    const { data, error } = await supabase
      .from("snapshots")
      .insert({ project_id: projectId, budget: totals.revisedBudget, actual: totals.actual, variance: totals.variance })
      .select().single();
    if (!error && data) setSnapshots((prev) => [...prev, data]);
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
        <button style={styles.exportBtn} onClick={() => window.print()}>Export PDF</button>
      </div>

      <div style={styles.titleBlock}>
        <div style={styles.titleBlockLeft}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            {/* Deliberately not "no-print" — this is the header of the
                exported/printed cost sheet, so the company logo needs to
                pull through onto the PDF, not just show on screen. */}
            {logoUrl && <img src={logoUrl} alt="Company logo" style={styles.companyLogoMark} />}
            <div style={styles.eyebrowProminent}>COST VARIANCE SHEET</div>
            <span style={styles.titleDivider}>·</span>
            <input
              style={styles.projectInput}
              value={project.name}
              onChange={(e) => {
                const name = e.target.value;
                setProject((p) => ({ ...p, name }));
                if (saveTimers.current.projectName) clearTimeout(saveTimers.current.projectName);
                saveTimers.current.projectName = setTimeout(() => {
                  supabase.from("projects_v2").update({ name }).eq("id", projectId);
                }, 500);
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
                  supabase.from("projects_v2").update({ retention_pct: v }).eq("id", projectId);
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
        <SummaryCard label="Original budget" value={fmt(totals.budget)} />
        {approvedCoTotal !== 0 && <SummaryCard label="Revised budget" value={fmt(totals.revisedBudget)} accent="#B8862F" />}
        <SummaryCard label="Actual spend" value={fmt(totals.actual)} />
        <SummaryCard label="Variance" value={`${totals.variance >= 0 ? "+" : ""}${fmt(totals.variance)}`} accent={totals.variance > 0 ? "#C1462B" : "#4C7A5C"} />
        <SummaryCard label="Retention held" value={fmt(totals.retentionHeld)} />
        <SummaryCard label="Flagged lines" value={`${overCount} over · ${watchCount} watch`} accent={overCount ? "#C1462B" : watchCount ? "#B8862F" : "#4C7A5C"} />
      </div>

      {totals.pct > 0 && (
        <div style={styles.warningBanner}>
          You're trending {totals.pct.toFixed(1)}% over the revised budget on this project. Review flagged lines below before your next client meeting.
        </div>
      )}
      {aheadCount > 0 && (
        <div style={{ ...styles.warningBanner, borderColor: "#B8862F", background: "rgba(184,134,47,0.1)", color: "#7A5A1E" }}>
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
              <span style={{ ...styles.categoryVariance, color: c.variance > 0 ? "#C1462B" : "#4C7A5C" }}>
                {c.variance >= 0 ? "+" : ""}{fmt(c.variance)}
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
        <button style={styles.templateLink} onClick={downloadTemplate}>Download CSV format</button>
        {importMessage && (
          <span style={{ fontSize: 12.5, color: importMessage.type === "error" ? "#C1462B" : "#4C7A5C" }}>{importMessage.text}</span>
        )}
      </div>

      <div className="no-print" style={styles.viewToggle}>
        {[
          ["ledger", "Cost & Progress"],
          ["quote", "Quote"],
          ["charts", "Charts"],
          ["payments", "Payments & Retention"],
          ["changeorders", `Change Orders${changeOrders.length ? ` (${changeOrders.length})` : ""}`],
          ["purchaseorders", `Purchase Orders${purchaseOrders.length ? ` (${purchaseOrders.length})` : ""}`],
          ["tenders", `Tenders${tenders.length ? ` (${tenders.length})` : ""}`],
          ["schedule", `Schedule${scheduleTasks.length ? ` (${scheduleTasks.length})` : ""}`],
          ["documents", `Documents${documents.length ? ` (${documents.length})` : ""}`],
          ["plans", `Plans${(project?.plans || []).length ? ` (${(project.plans || []).length})` : ""}`],
          ["trend", "Trend"],
        ].map(([key, label]) => (
          <button key={key} style={{ ...styles.toggleBtn, ...(view === key ? styles.toggleBtnActive : {}) }} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </div>

      {view === "ledger" && (
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
                        <span style={{ fontSize: 11, color: "#6E6E73" }}>{item.category || "Other"}</span>
                      </span>
                      {subName && <span style={{ fontSize: 11, color: "#8B5FA3" }}>· {subName}</span>}
                      <button className="no-print" style={styles.miniLink} onClick={() => { setExpandedRow(isOpen ? null : item.id); setNoteDraft(item.notes || ""); }}>
                        {isOpen ? "Close" : "Details"}
                      </button>
                    </div>
                  </span>
                  <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(item.budget)}</span>
                  <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                    {editingCell === `${item.id}:actual` ? (
                      <input autoFocus style={styles.inlineInput} value={editValue} type="number"
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
                      <div style={{ ...styles.dualBarFill, width: `${progPct}%`, background: "#4C7A5C", top: 0 }} />
                      <div style={{ ...styles.dualBarFill, width: `${spentPct}%`, background: gapFlag ? "#C1462B" : "#3D6FA6", top: 8 }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                      <span style={{ fontSize: 10, color: "#4C7A5C" }}>{progPct.toFixed(0)}% done</span>
                      <span style={{ fontSize: 10, color: gapFlag ? "#C1462B" : "#3D6FA6" }}>{spentPct.toFixed(0)}% spent</span>
                    </div>
                  </span>
                  <span style={{ ...styles.tdCell, flex: 0.9, textAlign: "center" }}>
                    <span style={{ ...styles.statusPill, color: s.color, background: s.bg }}>{s.label}</span>
                    {gapFlag && (
                      <div className="no-print" style={{ marginTop: 4 }}>
                        <span style={{ ...styles.statusPill, color: "#C1462B", background: "rgba(193,70,43,0.12)", fontSize: 9 }}>SPEND AHEAD</span>
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
                          onChange={(e) => scheduleSave(item.id, { percent_complete: Number(e.target.value) || 0 })} />
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
                        <span style={styles.detailLabel}>Quality (1–5)</span>
                        <select style={styles.addInput} value={item.quality_rating || ""}
                          onChange={(e) => scheduleSave(item.id, { quality_rating: e.target.value ? Number(e.target.value) : null })}>
                          <option value="">— not rated —</option>
                          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </label>
                      <label style={styles.detailField}>
                        <span style={styles.detailLabel}>Claimed / Certified</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input style={{ ...styles.addInput, width: "50%" }} type="number" placeholder="Claimed" value={item.claimed ?? ""}
                            onChange={(e) => scheduleSave(item.id, { claimed: Number(e.target.value) || 0 })} />
                          <input style={{ ...styles.addInput, width: "50%" }} type="number" placeholder="Certified" value={item.certified ?? ""}
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
            <input style={{ ...styles.addInput, flex: 1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}
              placeholder="Budget (optional)" type="number" value={newBudget} onChange={(e) => setNewBudget(e.target.value)} />
            <button style={styles.addBtn} onClick={addItem}>+ Add line</button>
          </div>
        </div>
      )}

      {view === "charts" && (
        <div style={styles.chartGrid}>
          <div style={styles.chartCard}>
            <div style={styles.chartTitle}>Budget vs actual</div>
            <div style={styles.chartSub}>Largest eight line items by budget.</div>
            <BarChartBudgetVsActual items={items} />
          </div>
          <div style={styles.chartCard}>
            <div style={styles.chartTitle}>Where the money went</div>
            <div style={styles.chartSub}>Actual spend split by category.</div>
            <DonutCategorySplit rollup={categoryRollup} />
          </div>
          <div style={styles.chartCard}>
            <div style={styles.chartTitle}>Progress against spend</div>
            <div style={styles.chartSub}>Each dot is a line item.</div>
            <ProgressScatter items={items} />
          </div>
          <div style={styles.chartCard}>
            <div style={styles.chartTitle}>Category variance</div>
            <div style={styles.chartSub}>Positive bars are overruns.</div>
            {categoryRollup.length === 0 ? (
              <EmptyChart label="Add line items to see category variance." />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 6 }}>
                {categoryRollup.map((c) => {
                  const maxAbs = Math.max(...categoryRollup.map((x) => Math.abs(x.variance)), 1);
                  const w = (Math.abs(c.variance) / maxAbs) * 50;
                  const over = c.variance > 0;
                  return (
                    <div key={c.category}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 12.5, color: "#4A4A4F" }}>{c.category}</span>
                        <span style={{ fontSize: 11.5, fontFamily: "'IBM Plex Mono', monospace", color: over ? "#C1462B" : "#4C7A5C" }}>
                          {over ? "+" : ""}{fmtShort(c.variance)}
                        </span>
                      </div>
                      <div style={{ position: "relative", height: 8, background: "#F2F2F5", borderRadius: 3 }}>
                        <div style={{ position: "absolute", left: "50%", top: -2, width: 1, height: 12, background: "#C7C7CE" }} />
                        <div style={{
                          position: "absolute", top: 0, height: "100%", borderRadius: 3,
                          left: over ? "50%" : `${50 - w}%`, width: `${w}%`,
                          background: over ? "#C1462B" : "#4C7A5C",
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {view === "quote" && (
        <div style={styles.quoteSheet}>
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

          {categoryRollup.map((cat) => {
            const catItems = items.filter((i) => (i.category || "Other") === cat.category);
            return (
              <div key={cat.category} style={{ marginBottom: 24 }}>
                <div style={styles.quoteCatHeading}>{cat.category}</div>
                {catItems.map((item) => (
                  <div key={item.id} style={styles.quoteRow}>
                    <span style={{ flex: 3 }}>{item.name}</span>
                    <span style={{ flex: 1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(item.budget)}</span>
                  </div>
                ))}
                <div style={{ ...styles.quoteRow, borderTop: "1px solid #E8E8ED", fontWeight: 600 }}>
                  <span style={{ flex: 3 }}>Subtotal — {cat.category}</span>
                  <span style={{ flex: 1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(cat.budget)}</span>
                </div>
              </div>
            );
          })}

          <div style={styles.quoteTotalRow}>
            <span>Total</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(totals.budget)}</span>
          </div>

          <p style={styles.quoteFootnote}>
            This quotation covers the work described above at the prices listed. It does not include
            variations, delays, or site conditions discovered after work begins — those will be raised
            separately as change orders. Prices exclude VAT unless stated otherwise.
          </p>
        </div>
      )}

      {view === "payments" && (
        <div style={{ ...styles.ledger, overflowX: "auto" }}>
          <input
            ref={paymentDocInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={handlePaymentDocUpload}
          />
          <div style={{ ...styles.ledgerHeaderRow, minWidth: 980 }}>
            <span style={{ ...styles.thCell, flex: 2.4 }}>Line item</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Claimed</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Certified</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Retention held</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Paid to date</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Uncertified</span>
            <span style={{ ...styles.thCell, flex: 1.1, textAlign: "center" }}>Payment date</span>
            <span style={{ ...styles.thCell, flex: 1.3, textAlign: "center" }}>Document</span>
          </div>
          {items.map((item) => {
            const certified = Number(item.certified || 0);
            const claimed = Number(item.claimed || 0);
            const retentionHeld = certified * (totals.retentionPct / 100);
            const uncertified = claimed - certified;
            return (
              <div key={item.id} style={{ ...styles.row, minWidth: 980 }}>
                <span style={{ ...styles.tdCell, flex: 2.4, fontWeight: 500 }}>{item.name}</span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                  {editingCell === `${item.id}:claimed` ? (
                    <input autoFocus style={styles.inlineInput} value={editValue} type="number"
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(item.id, "claimed")}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "claimed")} />
                  ) : (
                    <button style={styles.actualButton} onClick={() => startEdit(item.id, "claimed", item.claimed)}>{fmt(claimed)}</button>
                  )}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                  {editingCell === `${item.id}:certified` ? (
                    <input autoFocus style={styles.inlineInput} value={editValue} type="number"
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(item.id, "certified")}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "certified")} />
                  ) : (
                    <button style={styles.actualButton} onClick={() => startEdit(item.id, "certified", item.certified)}>{fmt(certified)}</button>
                  )}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#B8862F" }}>{fmt(retentionHeld)}</span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#4C7A5C" }}>{fmt(certified - retentionHeld)}</span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: uncertified > 0 ? "#C1462B" : "#6E6E73" }}>{fmt(uncertified)}</span>
                <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "center" }} className="no-print">
                  <input
                    type="date"
                    style={{ ...styles.addInput, padding: "4px 6px", fontSize: 12 }}
                    value={item.payment_date || ""}
                    onChange={(e) => setPaymentDate(item.id, e.target.value)}
                  />
                </span>
                <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "center", fontFamily: "'IBM Plex Mono', monospace" }} className="print-only-status">
                  {item.payment_date ? new Date(item.payment_date + "T00:00:00").toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.3, textAlign: "center" }}>
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
          <div style={{ ...styles.row, background: "#F5F5F7", fontWeight: 600, minWidth: 980 }}>
            <span style={{ ...styles.tdCell, flex: 2.4 }}>Totals</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(totals.claimed)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(totals.certified)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#B8862F" }}>{fmt(totals.retentionHeld)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#4C7A5C" }}>{fmt(totals.paidToDate)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: totals.uncertified > 0 ? "#C1462B" : "#6E6E73" }}>{fmt(totals.uncertified)}</span>
            <span style={{ ...styles.tdCell, flex: 1.1 }}></span>
            <span style={{ ...styles.tdCell, flex: 1.3 }}></span>
          </div>
        </div>
      )}

      {view === "changeorders" && (
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
                  style={{ ...styles.addInput, padding: "4px 8px", fontSize: 12, color: co.priority === "High" ? "#C1462B" : co.priority === "Low" ? "#6E6E73" : "#B8862F" }}>
                  <option value="High">High</option>
                  <option value="Normal">Normal</option>
                  <option value="Low">Low</option>
                </select>
              </span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center" }} className="print-only-status">{co.priority || "Normal"}</span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center", fontFamily: "'IBM Plex Mono', monospace" }} className="no-print">
                <input
                  style={{ ...styles.addInput, padding: "4px 6px", fontSize: 12, textAlign: "center" }}
                  placeholder="—"
                  value={co.po_number || ""}
                  onChange={(e) => setChangeOrders((prev) => prev.map((c) => (c.id === co.id ? { ...c, po_number: e.target.value } : c)))}
                  onBlur={(e) => setCoPoNumberValue(co.id, e.target.value.trim())}
                />
              </span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center", fontFamily: "'IBM Plex Mono', monospace" }} className="print-only-status">{co.po_number || "—"}</span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center", fontFamily: "'IBM Plex Mono', monospace" }}>
                {co.co_date ? new Date(co.co_date + "T00:00:00").toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
              </span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(co.amount)}</span>
              <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "center" }} className="no-print">
                <select value={co.status} onChange={(e) => setCoStatus(co.id, e.target.value)}
                  style={{ ...styles.addInput, padding: "4px 8px", fontSize: 12, color: co.status === "approved" ? "#4C7A5C" : co.status === "rejected" ? "#C1462B" : "#B8862F" }}>
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
            <div style={{ padding: 20, fontSize: 13, color: "#6E6E73" }}>
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
            <input style={{ ...styles.addInput, flex: 1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }} placeholder="Amount" type="number" value={coAmount} onChange={(e) => setCoAmount(e.target.value)} />
            <button style={styles.addBtn} onClick={addChangeOrder}>+ Add change order</button>
          </div>
        </div>
      )}

      {view === "purchaseorders" && (
        <div style={{ ...styles.ledger, overflowX: "auto" }}>
          <div style={{ padding: "12px 16px", fontSize: 13, color: "#6E6E73", borderBottom: "1px solid #E8E8ED" }}>
            Outstanding (not yet received): <strong style={{ color: "#1D1D1F", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(poOutstandingTotal)}</strong>
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
            const poStatusColor = po.status === "received" ? "#4C7A5C" : po.status === "cancelled" ? "#C1462B" : po.status === "confirmed" ? "#1D1D1F" : po.status === "sent" ? "#B8862F" : "#6E6E73";
            return (
              <div key={po.id} style={{ ...styles.row, minWidth: 1180 }}>
                <span style={{ ...styles.tdCell, flex: 1.4 }}>{po.supplier_name}</span>
                <span style={{ ...styles.tdCell, flex: 0.9, fontFamily: "'IBM Plex Mono', monospace" }}>{po.po_number || "—"}</span>
                <span style={{ ...styles.tdCell, flex: 1.8 }}>{po.description || "—"}</span>
                <span style={{ ...styles.tdCell, flex: 1.4, color: "#6E6E73" }}>{linkedItem ? linkedItem.name : "—"}</span>
                <span style={{ ...styles.tdCell, flex: 1, textAlign: "center", fontFamily: "'IBM Plex Mono', monospace" }}>
                  {po.order_date ? new Date(po.order_date + "T00:00:00").toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                </span>
                <span style={{ ...styles.tdCell, flex: 0.9, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(po.amount)}</span>
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
            <div style={{ padding: 20, fontSize: 13, color: "#6E6E73" }}>
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
            <input style={{ ...styles.addInput, flex: 0.9, minWidth: 0, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }} placeholder="Amount" type="number" value={poAmount} onChange={(e) => setPoAmount(e.target.value)} />
            <button style={{ ...styles.addBtn, flex: "1.6 0 auto" }} onClick={addPurchaseOrder}>+ Add purchase order</button>
          </div>
        </div>
      )}

      {view === "tenders" && (
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div className="no-print" style={{ ...styles.addRow, flexWrap: "nowrap", borderRadius: 18, marginBottom: 16 }}>
            <input style={{ ...styles.addInput, flex: 1.2, minWidth: 0 }} placeholder="Trade (e.g. Plumbing)" value={tTrade} onChange={(e) => setTTrade(e.target.value)} />
            <input style={{ ...styles.addInput, flex: 2, minWidth: 0 }} placeholder="Scope of work being tendered" value={tTitle} onChange={(e) => setTTitle(e.target.value)} />
            <select style={{ ...styles.addInput, flex: 1.4, minWidth: 0 }} value={tLineItemId} onChange={(e) => setTLineItemId(e.target.value)}>
              <option value="">No line item</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
            <button style={{ ...styles.addBtn, flex: "1.4 0 auto" }} onClick={addTender}>+ New tender</button>
          </div>

          {tenders.length === 0 && (
            <div style={{ ...styles.ledger, padding: 20, fontSize: 13, color: "#6E6E73" }}>
              No tenders yet. Raise one above to start collecting and comparing subcontractor bids before appointing anyone.
            </div>
          )}

          {tenders.map((tender) => {
            const bids = tenderBids.filter((b) => b.tender_id === tender.id).sort((a, b) => Number(a.amount) - Number(b.amount));
            const linkedItem = items.find((i) => i.id === tender.line_item_id);
            const draft = bidDrafts[tender.id] || { bidderName: "", subcontractorId: "", amount: "", notes: "" };
            const tenderStatusColor = tender.status === "awarded" ? "#4C7A5C" : tender.status === "cancelled" ? "#C1462B" : "#B85C2C";
            return (
              <div key={tender.id} style={{ ...styles.scoreCard, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "#B85C2C", background: "rgba(184,92,44,0.1)", borderRadius: 100, padding: "3px 10px" }}>{tender.trade || "Trade"}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: tenderStatusColor }}>{tender.status}</span>
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#1D1D1F" }}>{tender.title}</div>
                    {linkedItem && <div style={{ fontSize: 12.5, color: "#6E6E73", marginTop: 2 }}>Against: {linkedItem.name}</div>}
                  </div>
                  <button className="no-print" style={styles.removeBtn} onClick={() => removeTender(tender.id)}>✕</button>
                </div>

                <div style={{ borderTop: "1px solid #F2F2F5", marginTop: 10, paddingTop: 10 }}>
                  {bids.length === 0 && <div style={{ fontSize: 13, color: "#6E6E73", padding: "4px 0" }}>No bids logged yet.</div>}
                  {bids.map((bid) => {
                    const bidStatusColor = bid.status === "awarded" ? "#4C7A5C" : bid.status === "declined" ? "#C1462B" : bid.status === "shortlisted" ? "#B8862F" : "#6E6E73";
                    return (
                      <div key={bid.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #F7F7F8" }}>
                        <div style={{ flex: 1.6, fontSize: 13.5, color: "#1D1D1F" }}>{bid.bidder_name}</div>
                        <div style={{ flex: 1, fontSize: 13.5, fontFamily: "'IBM Plex Mono', monospace", textAlign: "right" }}>{fmt(bid.amount)}</div>
                        <div style={{ flex: 1.6, fontSize: 12.5, color: "#6E6E73" }}>{bid.notes}</div>
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
                  <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "nowrap", marginTop: 12 }}>
                    <input style={{ ...styles.addInput, flex: 1.4, minWidth: 0 }} placeholder="Bidder / company name"
                      value={draft.bidderName} onChange={(e) => updateBidDraft(tender.id, { bidderName: e.target.value })} />
                    <select style={{ ...styles.addInput, flex: 1.4, minWidth: 0 }}
                      value={draft.subcontractorId} onChange={(e) => updateBidDraft(tender.id, { subcontractorId: e.target.value })}>
                      <option value="">Not yet in Subcontractors</option>
                      {subs.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    <input style={{ ...styles.addInput, flex: 1, minWidth: 0, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }} placeholder="Amount" type="number"
                      value={draft.amount} onChange={(e) => updateBidDraft(tender.id, { amount: e.target.value })} />
                    <input style={{ ...styles.addInput, flex: 1.6, minWidth: 0 }} placeholder="Notes (optional)"
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
        return (
          <div style={{ maxWidth: 1180, margin: "0 auto" }}>
            <div className="no-print" style={{ ...styles.addRow, flexWrap: "nowrap", borderRadius: 18, marginBottom: 16 }}>
              <input style={{ ...styles.addInput, flex: 1.6, minWidth: 0 }} placeholder="Task name (e.g. Roof trusses)" value={taskName} onChange={(e) => setTaskName(e.target.value)} />
              <select style={{ ...styles.addInput, flex: 1.4, minWidth: 0 }} value={taskLineItemId} onChange={(e) => setTaskLineItemId(e.target.value)}>
                <option value="">No line item</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
              <input style={{ ...styles.addInput, flex: 1, minWidth: 0 }} type="date" value={taskStart} onChange={(e) => setTaskStart(e.target.value)} />
              <input style={{ ...styles.addInput, flex: 1, minWidth: 0 }} type="date" value={taskEnd} onChange={(e) => setTaskEnd(e.target.value)} />
              <button style={{ ...styles.addBtn, flex: "1.2 0 auto" }} onClick={addScheduleTask}>+ Add task</button>
            </div>

            {scheduleTasks.length === 0 ? (
              <div style={{ ...styles.ledger, padding: 20, fontSize: 13, color: "#6E6E73" }}>
                No tasks scheduled yet. Add one above to start building the project timeline.
              </div>
            ) : (
              <div style={styles.ledger}>
                <div style={{ padding: "10px 16px", fontSize: 12, color: "#6E6E73", borderBottom: "1px solid #E8E8ED", display: "flex", justifyContent: "space-between" }}>
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
                  if (pct >= 100) { statusColor = "#4C7A5C"; statusLabel = "Done"; }
                  else if (end < today) { statusColor = "#C1462B"; statusLabel = "Overdue"; }
                  else if (start <= today && today <= end) { statusColor = "#B85C2C"; statusLabel = "In progress"; }
                  return (
                    <div key={task.id} style={{ padding: "12px 16px", borderBottom: "1px solid #F2F2F5" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: "#1D1D1F" }}>{task.name}</span>
                          {linkedItem && <span style={{ fontSize: 12, color: "#6E6E73" }}>· {linkedItem.name}</span>}
                          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: statusColor }}>{statusLabel}</span>
                        </div>
                        <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input type="number" min="0" max="100" value={pct}
                            onChange={(e) => setTaskProgress(task.id, e.target.value)}
                            style={{ ...styles.addInput, width: 56, padding: "4px 6px", fontSize: 12, textAlign: "right" }} />
                          <span style={{ fontSize: 12, color: "#6E6E73" }}>%</span>
                          <button style={styles.removeBtn} onClick={() => removeScheduleTask(task.id)}>✕</button>
                        </div>
                      </div>
                      <div style={{ position: "relative", height: 14, background: "#F2F2F5", borderRadius: 4 }}>
                        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 6, background: "rgba(184,92,44,0.16)", border: `1.5px solid ${statusColor}`, borderRadius: 4, overflow: "hidden" }}>
                          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: statusColor, opacity: 0.6 }} />
                        </div>
                        {today >= rangeStart && today <= rangeEnd && (
                          <div style={{ position: "absolute", top: -2, bottom: -2, left: `${((today - rangeStart) / 86400000 / totalDays) * 100}%`, width: 1, background: "#1D1D1F" }} title="Today" />
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "#6E6E73", marginTop: 4 }}>{dfmt(start)} → {dfmt(end)}</div>
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
          <input
            ref={documentsInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleDocumentUpload}
          />
          <div className="no-print" style={{ ...styles.addRow, flexWrap: "nowrap", borderRadius: 18, marginBottom: 16 }}>
            <select style={{ ...styles.addInput, flex: 1.2, minWidth: 0 }} value={docCategory} onChange={(e) => setDocCategory(e.target.value)}>
              {DOC_CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
            <select style={{ ...styles.addInput, flex: 1.6, minWidth: 0 }} value={docLineItemId} onChange={(e) => setDocLineItemId(e.target.value)}>
              <option value="">No line item</option>
              {items.map((i) => (<option key={i.id} value={i.id}>{i.name}</option>))}
            </select>
            <button style={{ ...styles.addBtn, flex: "1.4 0 auto" }} onClick={() => documentsInputRef.current?.click()}>+ Upload files</button>
          </div>

          {documents.length === 0 ? (
            <div style={{ ...styles.ledger, padding: 20, fontSize: 13, color: "#6E6E73" }}>
              No documents yet. Upload drawings, contracts, specs, or site photos above — pick a category and, optionally, the budget line they belong to.
            </div>
          ) : (
            <div style={styles.ledger}>
              {DOC_CATEGORIES.filter((cat) => documents.some((d) => d.category === cat)).map((cat) => (
                <div key={cat}>
                  <div style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#B85C2C", background: "#FAF7F2", borderBottom: "1px solid #E8E8ED" }}>
                    {cat}
                  </div>
                  {documents.filter((d) => d.category === cat).map((doc) => {
                    const linkedItem = items.find((i) => i.id === doc.line_item_id);
                    return (
                      <div key={doc.id} style={{ padding: "10px 16px", borderBottom: "1px solid #F2F2F5", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
                          <button onClick={() => openDocument(doc)} style={{ background: "none", border: "none", padding: 0, color: "#1D1D1F", fontSize: 14, fontWeight: 600, cursor: "pointer", textAlign: "left" }}>
                            {doc.name}
                          </button>
                          {doc.version > 1 && <span style={{ fontSize: 11, fontWeight: 700, color: "#B85C2C", background: "rgba(184,92,44,0.1)", borderRadius: 100, padding: "2px 8px" }}>v{doc.version}</span>}
                          {linkedItem && <span style={{ fontSize: 12, color: "#6E6E73" }}>· {linkedItem.name}</span>}
                          <span style={{ fontSize: 12, color: "#6E6E73" }}>{fmtFileSize(doc.file_size)}</span>
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
        <div style={styles.ledger}>
          <input
            ref={plansInputRef}
            type="file"
            multiple
            accept=".pdf,.dwg,.dxf,.dwf,.xlsx,.xls,.csv,.doc,.docx"
            style={{ display: "none" }}
            onChange={handlePlanUpload}
          />
          <div style={{ padding: "16px 20px 4px", fontSize: 13, color: "#6E6E73", lineHeight: 1.5 }}>
            Reference documents for this project — drawings, CAD exports, quotes, contracts. Uploaded here so
            they're on hand for quick reference; not tied to any single line item. PDF, CAD (DWG/DXF/DWF), Excel,
            and Word files are supported.
          </div>
          {(project?.plans || []).length === 0 ? (
            <div style={{ padding: "8px 20px 20px", fontSize: 13, color: "#6E6E73" }}>No documents uploaded yet.</div>
          ) : (
            <div style={{ padding: "8px 20px 4px" }}>
              {(project.plans || []).map((p) => (
                <div key={p.path} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #EDE6D4" }}>
                  <button onClick={() => openPlan(p)} style={{ ...styles.attachmentLink, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1, textAlign: "left" }}>
                    📄 {p.name}
                  </button>
                  <span style={{ fontSize: 11.5, color: "#6E6E73", fontFamily: "'IBM Plex Mono', monospace" }}>
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
      )}

      {view === "trend" && (
        <div style={styles.ledger}>
          <div className="no-print" style={{ padding: 20 }}>
            <button style={styles.addBtn} onClick={logSnapshot}>+ Log snapshot now</button>
            <p style={{ fontSize: 12.5, color: "#6E6E73", marginTop: 10 }}>
              Click this weekly (or before each client meeting) to record where budget vs actual stand right now.
              Over time this builds a trend you can point to instead of a single snapshot.
            </p>
          </div>
          {snapshots.length === 0 ? (
            <div style={{ padding: "0 20px 20px", fontSize: 13, color: "#6E6E73" }}>No snapshots logged yet.</div>
          ) : (
            <div style={{ padding: "0 20px 20px" }}>
              <TrendChart snapshots={snapshots} />
              <div style={{ marginTop: 16 }}>
                {[...snapshots].reverse().map((s) => (
                  <div key={s.id} style={styles.trendRow}>
                    <span style={{ fontSize: 12, color: "#6E6E73", fontFamily: "'IBM Plex Mono', monospace" }}>
                      {new Date(s.created_at).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}
                    </span>
                    <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(s.actual)}</span>
                    <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", color: Number(s.variance) > 0 ? "#C1462B" : "#4C7A5C", fontWeight: 600 }}>
                      {Number(s.variance) >= 0 ? "+" : ""}{fmt(s.variance)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="print-only-footer" style={styles.docFooter}>
        <div style={styles.dfRow}>
          <div style={styles.dfBrand}>
            <svg style={styles.dfMark} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
              <rect x="4" y="8" width="28" height="8" fill="#3C2E1E" />
              <rect x="34" y="8" width="10" height="8" fill="#B85C2C" />
              <rect x="4" y="20" width="40" height="8" fill="#3C2E1E" />
              <rect x="4" y="32" width="40" height="8" fill="#3C2E1E" />
            </svg>
            <span style={styles.dfText}>
              site<span style={{ color: "#B85C2C" }}>Margin</span> — Cost variance report for {project.name}
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
                      style={{ ...styles.previewInput, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}
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
    background: "#F5F5F7",
    color: "#1D1D1F",
    fontFamily: "'Inter', sans-serif",
    padding: "20px 16px 48px",
  },
  eyebrow: { fontSize: 12, letterSpacing: "0.1em", color: "#6E6E73", fontWeight: 600, textTransform: "uppercase" },
  eyebrowProminent: { fontSize: 17, letterSpacing: "0.06em", color: "#B85C2C", fontWeight: 800, textTransform: "uppercase" },
  titleDivider: { fontSize: 22, color: "#C9C4B8", fontWeight: 400, lineHeight: 1 },
  appLogoRow: { display: "flex", alignItems: "center", gap: 8 },
  appLogoMark: { height: 64, width: "auto", display: "block" },
  appLogoText: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 22, letterSpacing: "-0.01em", color: "#1D1D1F" },
  eyebrowLink: { fontSize: 12, letterSpacing: "0.1em", color: "#6E6E73", fontWeight: 600, textTransform: "uppercase", textDecoration: "none", display: "inline-block" },

  // zIndex 201 keeps the logo + hamburger button visible ABOVE the full-screen
  // menu overlay (zIndex 200) when the menu is open — otherwise the overlay
  // covers the close (✕) button and there's no way to see it's open or close
  // it, which is what the marketing site avoids via the same nav-above-panel
  // stacking (nav z-index 200 > .menu-panel z-index 150 on sitemargin.co.za).
  dashHeader: { maxWidth: 1180, margin: "0 auto 20px", position: "relative", zIndex: 201 },
  dashNavBar: { display: "flex", alignItems: "center", justifyContent: "space-between", background: "#FFFFFF", borderRadius: 18, padding: "10px 18px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", marginBottom: 22, gap: 16, flexWrap: "wrap" },
  dashNavRight: { display: "flex", alignItems: "center", gap: 14 },
  // Matches sitemargin.co.za's own .nav-app-link exactly (same font, size,
  // color, padding, radius) — the app's mirror-image equivalent, pointing
  // back to the marketing site instead of into the app.
  navHomeLink: { fontSize: 13.5, fontWeight: 600, color: "#FFFFFF", textDecoration: "none", whiteSpace: "nowrap", background: "#B85C2C", padding: "8px 16px", borderRadius: 100, display: "inline-block" },
  dashTitle: { fontSize: "clamp(30px, 4.5vw, 42px)", fontWeight: 700, letterSpacing: "-0.02em" },
  dashTitleInput: { fontSize: "clamp(30px, 4.5vw, 42px)", fontWeight: 700, letterSpacing: "-0.02em", color: "#1D1D1F", background: "none", border: "none", borderBottom: "1px dashed #D9D9DE", padding: 0, width: "100%", minWidth: 0 },
  companyLogoMark: { height: "clamp(28px, 4.5vw, 44px)", width: "auto", maxWidth: 140, objectFit: "contain", borderRadius: 6 },
  logoTextBtn: { background: "none", border: "none", color: "#B85C2C", fontSize: 11.5, fontWeight: 600, textAlign: "left", padding: 0, cursor: "pointer" },
  logoTextBtnMuted: { background: "none", border: "none", color: "#6E6E73", fontSize: 11, textAlign: "left", padding: 0, cursor: "pointer" },
  logoMenuPopover: { position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30, background: "#FFFFFF", borderRadius: 12, boxShadow: "0 8px 28px rgba(0,0,0,0.14)", padding: 6, minWidth: 150, display: "flex", flexDirection: "column", gap: 2 },
  logoMenuItem: { background: "none", border: "none", color: "#1D1D1F", fontSize: 13.5, fontWeight: 500, textAlign: "left", padding: "9px 12px", borderRadius: 8, cursor: "pointer" },

  menuBtn: { width: 40, height: 40, border: "none", borderRadius: "50%", background: "#F5F5F7", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, padding: 0, flexShrink: 0 },
  menuBtnBar: { display: "block", width: 15, height: 1.5, background: "#1D1D1F", borderRadius: 2, transition: "transform 0.25s ease, opacity 0.2s ease" },
  menuBtnBar1Open: { transform: "translateY(5.5px) rotate(45deg)" },
  menuBtnBarMidOpen: { opacity: 0 },
  menuBtnBar3Open: { transform: "translateY(-5.5px) rotate(-45deg)" },

  // Every value below is copied 1:1 from sitemargin.co.za's own
  // .menu-panel / .menu-inner / .menu-link / .menu-actions rules in
  // styles.css — not approximated. menuPanelInner previously used 1180
  // (the app's wider content-page width) instead of the marketing site's
  // actual 980, and menuPanelActions was a side-by-side row instead of
  // marketing's stacked, full-width column — both fixed here.
  menuPanel: { position: "fixed", inset: 0, background: "rgba(255,255,255,0.94)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", zIndex: 200, display: "flex", flexDirection: "column", padding: "120px 20px 40px", overflowY: "auto" },
  menuPanelInner: { maxWidth: 980, margin: "0 auto", width: "100%" },
  menuPanelLink: { display: "block", width: "100%", textAlign: "left", background: "none", fontSize: 29, fontWeight: 700, letterSpacing: "-0.018em", color: "#1D1D1F", border: "none", padding: "9px 0", cursor: "pointer" },
  menuPanelLinkActive: { color: "#B85C2C" },
  menuPanelDim: { display: "block", width: "100%", textAlign: "left", background: "none", border: "none", fontSize: 15, fontWeight: 500, color: "#6E6E73", padding: "5px 0", cursor: "pointer", textDecoration: "none" },
  menuPanelDimFirst: { marginTop: 18, paddingTop: 16, borderTop: "1px solid #E8E8ED" },
  menuPanelActions: { marginTop: 28, display: "flex", flexDirection: "column", gap: 10, maxWidth: 340 },
  menuPanelGhost: { textAlign: "center", padding: 13, borderRadius: 100, fontWeight: 600, fontSize: 14.5, border: "1px solid #1D1D1F", color: "#1D1D1F", background: "none", cursor: "pointer" },
  menuPanelSolid: { textAlign: "center", padding: 13, borderRadius: 100, fontWeight: 600, fontSize: 14.5, border: "none", color: "#FFFFFF", background: "#1D1D1F", cursor: "pointer" },
  menuPanelEmail: { marginTop: 22, fontSize: 12, color: "#6E6E73", fontFamily: "'IBM Plex Mono', monospace" },

  topNav: { maxWidth: 1180, margin: "0 auto 20px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #E8E8ED", paddingBottom: 12 },
  topNavRight: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 },
  topNavEmail: { fontSize: 12, color: "#6E6E73", fontFamily: "'IBM Plex Mono', monospace" },
  topNavSignOut: { background: "none", border: "1px solid #E8E8ED", borderRadius: 100, color: "#6E6E73", fontSize: 12, padding: "6px 12px", cursor: "pointer" },

  gateNavOuter: { position: "relative", zIndex: 201, background: "#F5F5F7" },
  gateNavWrap: { maxWidth: 980, margin: "0 auto", padding: "0 20px" },
  gateNav: { display: "flex", alignItems: "center", justifyContent: "space-between", background: "#FFFFFF", borderRadius: 18, padding: "10px 18px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", margin: "14px 0 0" },
  gateWrap: { maxWidth: 640, margin: "48px auto 0", padding: "0 16px" },
  heroWrap: { marginBottom: 36, paddingBottom: 32, borderBottom: "1px solid #E8E8ED" },
  heroEm: { fontStyle: "normal", color: "#B85C2C" },
  heroSub: { fontSize: 16, color: "#4A4A4F", lineHeight: 1.6, marginBottom: 26 },
  mockSheet: { background: "#FFFFFF", borderRadius: 18, padding: "16px 18px", boxShadow: "0 12px 34px rgba(0,0,0,0.08)", marginBottom: 28 },
  mockHead: { display: "flex", justifyContent: "space-between", fontSize: 11, letterSpacing: "0.08em", color: "#6E6E73", textTransform: "uppercase", fontWeight: 600, paddingBottom: 10, marginBottom: 10, borderBottom: "1px solid #F2F2F5" },
  mockRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: "1px solid #F2F2F5", flexWrap: "wrap" },
  mockName: { fontSize: 13.5, fontWeight: 600, color: "#1D1D1F", flex: "1 1 150px" },
  mockNums: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#6E6E73", flex: "0 0 auto" },
  mockGauge: { display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" },
  gaugeTrack: { position: "relative", width: 60, height: 6, background: "#F2F2F5", borderRadius: 4, overflow: "hidden" },
  gaugeFill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 4 },
  gaugeLabel: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, fontWeight: 600, width: 44 },
  pill: { fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em", padding: "4px 10px", borderRadius: 100, flex: "0 0 auto" },
  problemBlock: { marginTop: 4 },
  pricingHead: { fontSize: 12.5, letterSpacing: "0.1em", color: "#6E6E73", textTransform: "uppercase", fontWeight: 600, margin: "34px 0 12px" },
  checkoutGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginTop: 8 },
  checkoutCard: { background: "#FFFFFF", borderRadius: 18, padding: "22px 20px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  checkoutTier: { fontSize: 12.5, letterSpacing: "0.08em", color: "#6E6E73", textTransform: "uppercase", fontWeight: 600, marginBottom: 10 },
  checkoutPrice: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 26, fontWeight: 600, color: "#1D1D1F", marginBottom: 8 },
  checkoutPriceUnit: { fontSize: 13, color: "#6E6E73", fontWeight: 400 },
  checkoutDesc: { fontSize: 13, color: "#6E6E73", marginBottom: 16, lineHeight: 1.5 },
  checkoutCardSelected: { boxShadow: "0 0 0 1.5px #B85C2C, 0 12px 34px rgba(0,0,0,0.08)" },
  tierCta: { background: "transparent", border: "1px solid #1D1D1F", borderRadius: 100, padding: "9px 16px", fontSize: 12.5, fontWeight: 600, color: "#1D1D1F", cursor: "pointer" },
  tierNote: { fontSize: 12.5, color: "#B85C2C", fontWeight: 600, marginBottom: 10 },
  gateText: { fontSize: 15, color: "#4A4A4F", lineHeight: 1.6, marginBottom: 20 },
  gateForm: { display: "flex", flexDirection: "column", gap: 10 },
  gateNotice: { background: "rgba(184,92,44,0.07)", border: "1px solid #B85C2C", borderRadius: 14, padding: "14px 16px", fontSize: 14, color: "#4A4A4F" },
  gateError: { color: "#C1462B", fontSize: 13, marginTop: 10 },
  gateFootnote: { fontSize: 13, color: "#6E6E73", marginTop: 22 },
  topNavBtn: { background: "none", border: "none", color: "#6E6E73", fontSize: 14, fontWeight: 500, padding: "6px 12px", cursor: "pointer", borderRadius: 3 },
  topNavBtnActive: { background: "#1D1D1F", color: "#FFFFFF", fontWeight: 600 },

  explainer: { maxWidth: 1180, margin: "0 auto 18px", fontSize: 13, color: "#6E6E73", lineHeight: 1.6, background: "#FFFFFF", borderRadius: 12, padding: "12px 16px", boxShadow: "0 1px 6px rgba(0,0,0,0.04)" },
  explainerLink: { color: "#B85C2C", fontWeight: 600 },

  newProjectRow: { maxWidth: 1180, margin: "0 auto 24px", display: "flex", gap: 10 },
  freeLimitBanner: { maxWidth: 1180, margin: "0 auto 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, background: "rgba(184,92,44,0.07)", border: "1px solid #B85C2C", borderRadius: 14, padding: "14px 16px", fontSize: 13.5, color: "#4A4A4F", flexWrap: "wrap" },
  freeLimitLink: { color: "#B85C2C", fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" },
  addRowStandalone: { maxWidth: 1180, margin: "0 auto 22px", display: "flex", gap: 10, flexWrap: "wrap" },
  projectGrid: { maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 },
  projectCard: { background: "#FFFFFF", borderRadius: 18, padding: "20px 22px", cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  scoreCard: { background: "#FFFFFF", borderRadius: 18, padding: "20px 22px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  templateCard: { background: "#FFFFFF", borderRadius: 18, padding: "20px 22px", marginBottom: 12, boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  projectCardTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  projectName: { fontSize: 20, fontWeight: 600 },
  deleteProjectBtn: { background: "none", border: "none", color: "#6E6E73", cursor: "pointer", fontSize: 14 },
  projectNums: { display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", color: "#4A4A4F" },
  projectMeta: { fontSize: 12, color: "#6E6E73", marginTop: 8 },
  subItemRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #F2F2F5" },

  backRow: { maxWidth: 1180, margin: "0 auto 12px", display: "flex", justifyContent: "space-between" },
  backBtn: { background: "none", border: "none", color: "#6E6E73", fontSize: 13, cursor: "pointer" },
  exportBtn: { background: "#FFFFFF", border: "none", borderRadius: 100, color: "#1D1D1F", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: "pointer", boxShadow: "0 1px 6px rgba(0,0,0,0.06)" },

  titleBlock: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 16, borderBottom: "2px solid #E8E8ED", paddingBottom: 14, maxWidth: 1180, margin: "0 auto 20px" },
  titleBlockLeft: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 },
  projectInput: { background: "transparent", border: "none", color: "#1D1D1F", fontSize: 26, fontWeight: 700, padding: 0, flex: "1 1 auto", minWidth: 160, letterSpacing: "-0.02em" },
  titleBlockRight: { display: "flex", gap: 22 },
  tbCell: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  tbLabel: { fontSize: 10, letterSpacing: "0.1em", color: "#6E6E73" },
  tbValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, color: "#1D1D1F", display: "flex", alignItems: "center", gap: 2 },
  retentionInput: { width: 34, background: "#F5F5F7", border: "1px solid transparent", borderRadius: 6, color: "#1D1D1F", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, padding: "1px 4px", textAlign: "right" },

  summaryStrip: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, maxWidth: 1180, margin: "0 auto 16px" },
  summaryCard: { background: "#FFFFFF", borderRadius: 16, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  summaryLabel: { fontSize: 11, letterSpacing: "0.08em", color: "#6E6E73", marginBottom: 6, textTransform: "uppercase" },
  summaryValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 17, fontWeight: 600 },

  warningBanner: { maxWidth: 1180, margin: "0 auto 12px", background: "rgba(193,70,43,0.07)", border: "1px solid #C1462B", borderRadius: 14, padding: "12px 16px", fontSize: 14, color: "#8A3D1E" },

  categoryStrip: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, maxWidth: 1180, margin: "0 auto 16px" },
  categoryCard: { background: "#FFFFFF", borderRadius: 12, padding: "10px 14px", boxShadow: "0 1px 6px rgba(0,0,0,0.04)" },
  categoryHead: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  categoryDot: { width: 8, height: 8, borderRadius: "50%" },
  categoryName: { fontSize: 12, color: "#4A4A4F", fontWeight: 500 },
  categoryNums: { display: "flex", justifyContent: "space-between", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 },
  categoryBudget: { color: "#6E6E73" },
  categoryVariance: { fontWeight: 600 },

  importRow: { maxWidth: 1180, margin: "0 auto 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  importBtn: { background: "#FFFFFF", border: "none", borderRadius: 100, color: "#1D1D1F", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: "pointer", boxShadow: "0 1px 6px rgba(0,0,0,0.06)" },
  templateLink: { background: "none", border: "none", color: "#6E6E73", fontSize: 12.5, textDecoration: "underline", cursor: "pointer", padding: 0 },

  viewToggle: { maxWidth: 1180, margin: "0 auto 12px", display: "flex", gap: 8, flexWrap: "wrap" },
  toggleBtn: { background: "#FFFFFF", border: "none", borderRadius: 100, color: "#6E6E73", fontSize: 13, fontWeight: 500, padding: "8px 16px", cursor: "pointer", boxShadow: "0 1px 6px rgba(0,0,0,0.04)" },
  toggleBtnActive: { background: "#1D1D1F", color: "#FFFFFF", fontWeight: 600 },

  ledger: { maxWidth: 1180, margin: "0 auto", background: "#FFFFFF", borderRadius: 18, overflowX: "auto", overflowY: "hidden", WebkitOverflowScrolling: "touch", boxShadow: "0 4px 20px rgba(0,0,0,0.06)" },
  ledgerHeaderRow: { display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #E8E8ED", background: "#F5F5F7", minWidth: 640 },
  thCell: { fontSize: 11, letterSpacing: "0.08em", color: "#6E6E73", textTransform: "uppercase" },
  row: { display: "flex", alignItems: "center", padding: "12px 14px", borderBottom: "1px solid #F2F2F5", minWidth: 640 },
  tdCell: { fontSize: 14, paddingRight: 8 },
  actualButton: { background: "none", border: "none", color: "#1D1D1F", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, cursor: "pointer", borderBottom: "1px dashed #6E6E73", padding: 0 },
  inlineInput: { width: "100%", background: "#FFFFFF", border: "1px solid #B85C2C", borderRadius: 8, color: "#1D1D1F", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, padding: "2px 6px", textAlign: "right" },
  miniLink: { background: "none", border: "none", color: "#6E6E73", fontSize: 10.5, textDecoration: "underline", cursor: "pointer", padding: 0 },
  miniLinkBlock: { background: "none", border: "none", color: "#3D6FA6", fontSize: 12, textDecoration: "underline", cursor: "pointer", padding: 0, marginTop: 4 },
  gaugeTrack: { position: "relative", height: 6, background: "#F2F2F5", borderRadius: 3, overflow: "visible", marginBottom: 4 },
  gaugeFill: { height: "100%", borderRadius: 3, transition: "width 0.3s ease" },
  gaugeTolMark: { position: "absolute", left: "71.4%", top: -2, width: 1, height: 10, background: "#6E6E73" },
  gaugeLabel: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 },
  dualBarTrack: { position: "relative", height: 16, background: "#F2F2F5", borderRadius: 3 },
  dualBarFill: { position: "absolute", left: 0, height: 6, borderRadius: 3, transition: "width 0.3s ease" },
  statusPill: { display: "inline-block", fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", padding: "4px 10px", borderRadius: 100 },
  removeBtn: { background: "none", border: "none", color: "#6E6E73", cursor: "pointer", fontSize: 13 },
  addRow: { display: "flex", gap: 10, alignItems: "center", padding: "14px", background: "#F5F5F7", flexWrap: "wrap" },
  addInput: { background: "#F5F5F7", border: "1px solid transparent", borderRadius: 10, color: "#1D1D1F", fontSize: 14, padding: "8px 12px" },
  addBtn: { background: "#B85C2C", border: "none", borderRadius: 100, color: "#FFFFFF", fontWeight: 600, fontSize: 13, padding: "9px 16px", cursor: "pointer", whiteSpace: "nowrap" },
  footer: { maxWidth: 1180, margin: "16px auto 0", fontSize: 12, color: "#6E6E73" },
  siteFooter: { maxWidth: 1180, margin: "40px auto 0", padding: "24px 0", borderTop: "1px solid #E8E8ED", fontSize: 13, color: "#6E6E73", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 14 },
  siteFooterLinks: { display: "flex", gap: 20, flexWrap: "wrap" },
  siteFooterLink: { color: "#6E6E73", textDecoration: "none" },
  docFooter: { maxWidth: 1180, margin: "30px auto 0", paddingTop: 14, borderTop: "1px solid #D9D9DE" },
  dfRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  dfBrand: { display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 14, color: "#1D1D1F" },
  dfMark: { height: 20, width: 20, display: "block" },
  dfText: { fontStyle: "normal" },
  dfMeta: { fontSize: 11, color: "#6E6E73", fontFamily: "Arial, sans-serif" },
  dfDisclaimer: { fontSize: 10, color: "#A0A0A6", marginTop: 4, fontFamily: "Arial, sans-serif" },

  detailPanel: { background: "#F5F5F7", padding: "16px 18px", borderBottom: "1px solid #F2F2F5" },
  detailGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 },
  detailField: { display: "flex", flexDirection: "column", gap: 5 },
  detailLabel: { fontSize: 10.5, letterSpacing: "0.08em", color: "#6E6E73", textTransform: "uppercase" },
  notesTextarea: { width: "100%", minHeight: 60, background: "#F5F5F7", border: "1px solid transparent", borderRadius: 10, color: "#1D1D1F", fontSize: 13, padding: "8px 10px", fontFamily: "'Inter', sans-serif", resize: "vertical", marginTop: 5 },
  attachmentLink: { fontSize: 12, color: "#3D6FA6", textDecoration: "none" },

  chartGrid: { maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 },
  chartCard: { background: "#FFFFFF", borderRadius: 18, padding: "22px 24px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" },
  chartTitle: { fontSize: 18, fontWeight: 600, marginBottom: 2 },
  chartSub: { fontSize: 12, color: "#6E6E73", marginBottom: 16 },

  trendRow: { display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #F2F2F5" },

  quoteSheet: { maxWidth: 800, margin: "0 auto", background: "#FFFFFF", borderRadius: 18, padding: "36px 40px", boxShadow: "0 12px 34px rgba(0,0,0,0.08)" },
  quoteHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "2px solid #1D1D1F", paddingBottom: 20, marginBottom: 28 },
  quoteEyebrow: { fontSize: 12, letterSpacing: "0.14em", color: "#B85C2C", fontWeight: 600, marginBottom: 6 },
  quoteProjectName: { fontSize: 24, fontWeight: 700, letterSpacing: "-0.015em", color: "#1D1D1F" },
  quoteMeta: { textAlign: "right", fontSize: 12.5, color: "#6E6E73", lineHeight: 1.7 },
  quoteCatHeading: { fontSize: 13, letterSpacing: "0.06em", color: "#6E6E73", textTransform: "uppercase", marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid #F2F2F5" },
  quoteRow: { display: "flex", padding: "6px 0", fontSize: 14, color: "#1D1D1F" },
  quoteTotalRow: { display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 600, color: "#1D1D1F", borderTop: "2px solid #1D1D1F", paddingTop: 14, marginTop: 10 },
  quoteFootnote: { fontSize: 11.5, color: "#6E6E73", marginTop: 30, lineHeight: 1.6, borderTop: "1px solid #F2F2F5", paddingTop: 16 },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 },
  modalCard: { background: "#FFFFFF", borderRadius: 18, maxWidth: 760, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "20px 24px", borderBottom: "1px solid #E8E8ED" },
  modalTitle: { fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em", color: "#1D1D1F" },
  modalSub: { fontSize: 12.5, color: "#6E6E73", marginTop: 4, maxWidth: 480 },
  modalBody: { padding: "12px 24px", overflowY: "auto", flex: 1 },
  modalFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderTop: "1px solid #E8E8ED" },
  previewHeaderRow: { display: "flex", gap: 10, fontSize: 11, letterSpacing: "0.06em", color: "#6E6E73", textTransform: "uppercase", padding: "8px 0", borderBottom: "1px solid #E8E8ED" },
  previewRow: { display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid #F2F2F5" },
  previewInput: { width: "100%", background: "#F5F5F7", border: "1px solid transparent", borderRadius: 8, color: "#1D1D1F", fontSize: 13, padding: "6px 8px" },
  previewNote: { fontSize: 10.5, color: "#6E6E73", marginTop: 3 },
};
