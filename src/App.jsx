import React, { useState, useMemo, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

/* ============================== HELPERS ============================== */

const fmt = (n) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(n || 0);

const fmtShort = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1000000) return `R${(v / 1000000).toFixed(1)}M`;
  if (Math.abs(v) >= 1000) return `R${Math.round(v / 1000)}k`;
  return `R${Math.round(v)}`;
};

const STATUS = {
  ok: { label: "ON TRACK", color: "#4C8C6B", bg: "rgba(76,140,107,0.12)" },
  watch: { label: "WATCH", color: "#D9A441", bg: "rgba(217,164,65,0.12)" },
  over: { label: "OVER", color: "#E8622C", bg: "rgba(232,98,44,0.14)" },
};

const CATEGORIES = ["Labour", "Materials", "Subcontractors", "Other"];
const CATEGORY_COLOR = { Labour: "#7BA6D9", Materials: "#D9A441", Subcontractors: "#C186D9", Other: "#7C93A6" };

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
  if (score == null) return "#7C93A6";
  if (score >= 75) return "#4C8C6B";
  if (score >= 50) return "#D9A441";
  return "#E8622C";
}

function parseCsvToItems(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { items: [], error: "That file doesn't look like it has any data rows." };

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

  const header = splitRow(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z%]/g, ""));
  const findCol = (...aliases) => {
    for (const a of aliases) { const idx = header.indexOf(a); if (idx !== -1) return idx; }
    return -1;
  };
  const col = {
    name: findCol("name", "lineitem", "description", "item"),
    category: findCol("category", "type"),
    budget: findCol("budget", "budgetamount", "budgeted"),
    actual: findCol("actual", "actualspend", "spent"),
    percentComplete: findCol("percentcomplete", "complete", "progress"),
    claimed: findCol("claimed"),
    certified: findCol("certified"),
  };
  if (col.name === -1 || col.budget === -1) {
    return { items: [], error: "Couldn't find Name and Budget columns. Check the template for the expected format." };
  }
  const toNum = (v) => {
    if (v == null) return 0;
    const n = Number(String(v).replace(/[R$,\s]/g, ""));
    return isNaN(n) ? 0 : n;
  };
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const name = cells[col.name]?.trim();
    if (!name) continue;
    const rawCategory = col.category !== -1 ? cells[col.category]?.trim() : "";
    const category = CATEGORIES.find((c) => c.toLowerCase() === rawCategory?.toLowerCase()) || "Other";
    items.push({
      name, category,
      budget: toNum(cells[col.budget]),
      actual: col.actual !== -1 ? toNum(cells[col.actual]) : 0,
      percent_complete: col.percentComplete !== -1 ? toNum(cells[col.percentComplete]) : 0,
      claimed: col.claimed !== -1 ? toNum(cells[col.claimed]) : 0,
      certified: col.certified !== -1 ? toNum(cells[col.certified]) : 0,
    });
  }
  if (items.length === 0) return { items: [], error: "No valid rows found — make sure each row has a name and a budget amount." };
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
              <span style={{ fontSize: 12.5, color: "#C7D2DC" }}>{item.name}</span>
              <span style={{ fontSize: 11.5, fontFamily: "'IBM Plex Mono', monospace", color: over ? "#E8622C" : "#4C8C6B" }}>
                {fmtShort(item.actual)} / {fmtShort(item.budget)}
              </span>
            </div>
            <div style={{ position: "relative", height: 16 }}>
              <div style={{ position: "absolute", top: 0, left: 0, width: `${bPct}%`, height: 7, background: "#3D5468", borderRadius: 3 }} />
              <div style={{ position: "absolute", top: 9, left: 0, width: `${aPct}%`, height: 7, background: over ? "#E8622C" : "#4C8C6B", borderRadius: 3 }} />
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 16, marginTop: 4, flexWrap: "wrap" }}>
        <LegendDot color="#3D5468" label="Budget" />
        <LegendDot color="#4C8C6B" label="Actual (within)" />
        <LegendDot color="#E8622C" label="Actual (over)" />
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
        <text x="70" y="66" textAnchor="middle" fill="#8FA2B3" fontSize="10" fontFamily="'IBM Plex Mono', monospace">SPENT</text>
        <text x="70" y="82" textAnchor="middle" fill="#F2EDE4" fontSize="14" fontWeight="600" fontFamily="'IBM Plex Mono', monospace">
          {fmtShort(total)}
        </text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 160 }}>
        {rollup.map((c) => (
          <div key={c.category} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: CATEGORY_COLOR[c.category] }} />
            <span style={{ color: "#C7D2DC" }}>{c.category}</span>
            <span style={{ marginLeft: "auto", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#8FA2B3" }}>
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
        <rect x={pad} y={10} width={W - pad - 10} height={H - pad - 10} fill="#101820" stroke="#2A3644" />
        <line x1={pad} y1={H - pad} x2={W - 10} y2={10} stroke="#3D5468" strokeWidth="1" strokeDasharray="3,3" />
        <text x={W - 14} y={22} textAnchor="end" fill="#5C7186" fontSize="8" fontFamily="'IBM Plex Mono', monospace">on parity</text>
        {plotted.map((item) => {
          const prog = Math.min(Number(item.percent_complete), 100);
          const spent = Math.min((Number(item.actual) / Number(item.budget)) * 100, 130);
          const x = pad + (prog / 100) * (W - pad - 10);
          const y = H - pad - (spent / 130) * (H - pad - 10);
          const gap = spent - prog;
          const color = gap > 15 ? "#E8622C" : gap > 5 ? "#D9A441" : "#4C8C6B";
          return <circle key={item.id} cx={x} cy={Math.max(y, 12)} r="4.5" fill={color} opacity="0.85" />;
        })}
        <text x={pad} y={H - 12} fill="#7C93A6" fontSize="9" fontFamily="'IBM Plex Mono', monospace">0%</text>
        <text x={W - 10} y={H - 12} textAnchor="end" fill="#7C93A6" fontSize="9" fontFamily="'IBM Plex Mono', monospace">100% complete →</text>
      </svg>
      <p style={{ fontSize: 12, color: "#7C93A6", marginTop: 10, maxWidth: 420 }}>
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
      <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="#3D5468" strokeWidth="0.5" strokeDasharray="1,1" />
      <polyline points={points} fill="none" stroke="#E8622C" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function LegendDot({ color, label }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#8FA2B3" }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      {label}
    </span>
  );
}

function EmptyChart({ label }) {
  return <div style={{ fontSize: 13, color: "#7C93A6", padding: "24px 0" }}>{label}</div>;
}

function ScoreBar({ label, score, detail }) {
  const color = scoreColor(score);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#C7D2DC" }}>{label}</span>
        <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", color }}>
          {score == null ? "—" : Math.round(score)}
        </span>
      </div>
      <div style={{ height: 6, background: "#101820", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${score ?? 0}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.3s ease" }} />
      </div>
      {detail && <div style={{ fontSize: 10.5, color: "#7C93A6", marginTop: 3 }}>{detail}</div>}
    </div>
  );
}

function SummaryCard({ label, value, accent }) {
  return (
    <div style={styles.summaryCard}>
      <div style={styles.summaryLabel}>{label}</div>
      <div style={{ ...styles.summaryValue, color: accent || "#F2EDE4" }}>{value}</div>
    </div>
  );
}

function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
      * { box-sizing: border-box; }
      input:focus, select:focus, textarea:focus { outline: 2px solid #E8622C; outline-offset: 1px; }
      button:focus-visible { outline: 2px solid #E8622C; outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      @media print {
        .no-print { display: none !important; }
        body, html { background: #fff !important; }
      }
    `}</style>
  );
}

function TopNav({ current, onNavigate }) {
  const tabs = [
    ["dashboard", "Projects"],
    ["subcontractors", "Subcontractors"],
    ["templates", "Templates"],
  ];
  return (
    <div className="no-print" style={styles.topNav}>
      {tabs.map(([key, label]) => (
        <button
          key={key}
          style={{ ...styles.topNavBtn, ...(current === key ? styles.topNavBtnActive : {}) }}
          onClick={() => onNavigate(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ============================== ROOT ============================== */

export default function SiteMargin() {
  const [route, setRoute] = useState({ page: "dashboard", projectId: null });

  const navigate = (page) => setRoute({ page, projectId: null });

  if (route.page === "project") {
    return <ProjectView projectId={route.projectId} onBack={() => setRoute({ page: "dashboard", projectId: null })} />;
  }
  if (route.page === "subcontractors") {
    return <SubcontractorsView onNavigate={navigate} />;
  }
  if (route.page === "templates") {
    return <TemplatesView onNavigate={navigate} />;
  }
  return <Dashboard onOpen={(id) => setRoute({ page: "project", projectId: id })} onNavigate={navigate} />;
}

/* ============================== DASHBOARD ============================== */

function Dashboard({ onOpen, onNavigate }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  async function loadProjects() {
    setLoading(true);
    const { data: projs } = await supabase.from("projects_v2").select("*").order("created_at", { ascending: false });
    if (!projs) { setProjects([]); setLoading(false); return; }
    const withTotals = await Promise.all(
      projs.map(async (p) => {
        const { data: items } = await supabase.from("line_items").select("budget, actual").eq("project_id", p.id);
        const budget = (items || []).reduce((s, i) => s + Number(i.budget || 0), 0);
        const actual = (items || []).reduce((s, i) => s + Number(i.actual || 0), 0);
        return { ...p, budget, actual, variance: actual - budget, lineCount: (items || []).length };
      })
    );
    setProjects(withTotals);
    setLoading(false);
  }

  useEffect(() => { loadProjects(); }, []);

  async function createProject() {
    if (!newName.trim() || creating) return;
    setCreating(true);
    const { data, error } = await supabase.from("projects_v2").insert({ name: newName.trim() }).select().single();
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
    const actual = projects.reduce((s, p) => s + p.actual, 0);
    return { budget, actual, variance: actual - budget, overCount: projects.filter((p) => p.variance > 0).length };
  }, [projects]);

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <div style={styles.dashHeader}>
        <div style={styles.eyebrow}>SITEMARGIN</div>
        <h1 style={styles.dashTitle}>Your projects</h1>
      </div>

      <TopNav current="dashboard" onNavigate={onNavigate} />

      {projects.length > 0 && (
        <div style={styles.summaryStrip}>
          <SummaryCard label="Portfolio budget" value={fmt(portfolio.budget)} />
          <SummaryCard label="Actual spend" value={fmt(portfolio.actual)} />
          <SummaryCard
            label="Net variance"
            value={`${portfolio.variance >= 0 ? "+" : ""}${fmt(portfolio.variance)}`}
            accent={portfolio.variance > 0 ? "#E8622C" : "#4C8C6B"}
          />
          <SummaryCard
            label="Projects over"
            value={`${portfolio.overCount} of ${projects.length}`}
            accent={portfolio.overCount ? "#E8622C" : "#4C8C6B"}
          />
        </div>
      )}

      <div style={styles.newProjectRow}>
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

      {loading ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>Loading projects…</div>
      ) : projects.length === 0 ? (
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>No projects yet — create your first one above.</div>
      ) : (
        <div style={styles.projectGrid}>
          {projects.map((p) => {
            const pct = p.budget ? (p.variance / p.budget) * 100 : 0;
            const color = p.variance > 0 ? "#E8622C" : "#4C8C6B";
            const spentPct = p.budget ? Math.min((p.actual / p.budget) * 100, 100) : 0;
            return (
              <div key={p.id} style={styles.projectCard} onClick={() => onOpen(p.id)}>
                <div style={styles.projectCardTop}>
                  <div style={styles.projectName}>{p.name}</div>
                  <button style={styles.deleteProjectBtn} onClick={(e) => { e.stopPropagation(); deleteProject(p.id, p.name); }}>✕</button>
                </div>
                <div style={{ height: 5, background: "#101820", borderRadius: 3, marginBottom: 10 }}>
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
    </div>
  );
}

/* ============================== SUBCONTRACTORS ============================== */

function SubcontractorsView({ onNavigate }) {
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
      .insert({ name: newName.trim(), trade: newTrade.trim(), contact: newContact.trim() })
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
      <div style={styles.dashHeader}>
        <div style={styles.eyebrow}>SITEMARGIN</div>
        <h1 style={styles.dashTitle}>Subcontractor scorecards</h1>
      </div>

      <TopNav current="subcontractors" onNavigate={onNavigate} />

      <div style={styles.explainer}>
        Scores build up automatically from the line items you assign to each sub. <b>Budget</b> comes from how close
        actuals land to budget, <b>schedule</b> from due date vs completed date, and <b>quality</b> from the 1–5 rating
        you set per line item. Dimensions with no data yet show a dash rather than a misleading zero.
      </div>

      <div style={styles.addRowStandalone}>
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
                    {sub.trade && <div style={{ fontSize: 11.5, color: "#8FA2B3", marginTop: 2 }}>{sub.trade}</div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: "#7C93A6", letterSpacing: "0.08em" }}>OVERALL</div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: scoreColor(score.overall) }}>
                        {score.overall == null ? "—" : Math.round(score.overall)}
                      </div>
                    </div>
                    <button style={styles.deleteProjectBtn} onClick={() => removeSub(sub.id, sub.name)}>✕</button>
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

                <button style={styles.miniLinkBlock} onClick={() => setExpanded(isOpen ? null : sub.id)}>
                  {isOpen ? "Hide line items" : `View ${score.itemCount} line item${score.itemCount === 1 ? "" : "s"}`}
                </button>

                {isOpen && (
                  <div style={{ marginTop: 10, borderTop: "1px solid #2A3644", paddingTop: 10 }}>
                    {(itemsBySub[sub.id] || []).length === 0 ? (
                      <div style={{ fontSize: 12, color: "#7C93A6" }}>No line items assigned to this sub yet.</div>
                    ) : (
                      (itemsBySub[sub.id] || []).map((i) => {
                        const late = daysBetween(i.due_date, i.completed_date);
                        return (
                          <div key={i.id} style={styles.subItemRow}>
                            <span style={{ fontSize: 12.5, flex: 2 }}>{i.name}</span>
                            <span style={{ fontSize: 11.5, fontFamily: "'IBM Plex Mono', monospace", color: Number(i.actual) > Number(i.budget) ? "#E8622C" : "#4C8C6B", flex: 1, textAlign: "right" }}>
                              {fmtShort(i.actual)} / {fmtShort(i.budget)}
                            </span>
                            <span style={{ fontSize: 11, color: "#8FA2B3", flex: 0.8, textAlign: "right" }}>
                              {late == null ? "—" : late > 0 ? `${late}d late` : `${Math.abs(late)}d early`}
                            </span>
                            <span style={{ fontSize: 11, color: "#D9A441", flex: 0.5, textAlign: "right" }}>
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
    </div>
  );
}

/* ============================== TEMPLATES ============================== */

function TemplatesView({ onNavigate }) {
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
      .from("templates").insert({ name: newName.trim(), description: newDesc.trim() }).select().single();
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
    if (!itemName.trim() || !itemBudget) return;
    const existing = itemsByTemplate[templateId] || [];
    const { data, error } = await supabase
      .from("template_items")
      .insert({
        template_id: templateId,
        name: itemName.trim(),
        category: itemCategory,
        budget: Number(itemBudget),
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
      <div style={styles.dashHeader}>
        <div style={styles.eyebrow}>SITEMARGIN</div>
        <h1 style={styles.dashTitle}>Budget templates</h1>
      </div>

      <TopNav current="templates" onNavigate={onNavigate} />

      <div style={styles.explainer}>
        Build a standard line-item set once — a typical residential build, a shopfit, whatever you repeat — then apply it
        to any new project in one click instead of retyping it. You can also save an existing project's line items
        straight back out as a new template from inside that project.
      </div>

      <div style={styles.addRowStandalone}>
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
                    {t.description && <div style={{ fontSize: 12, color: "#8FA2B3", marginTop: 3 }}>{t.description}</div>}
                    <div style={{ fontSize: 11.5, color: "#7C93A6", marginTop: 6, fontFamily: "'IBM Plex Mono', monospace" }}>
                      {tItems.length} line item{tItems.length === 1 ? "" : "s"} · {fmt(total)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <button style={styles.miniLink} onClick={() => setExpanded(isOpen ? null : t.id)}>
                      {isOpen ? "Collapse" : "Edit items"}
                    </button>
                    <button style={styles.deleteProjectBtn} onClick={() => deleteTemplate(t.id, t.name)}>✕</button>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 12, borderTop: "1px solid #2A3644", paddingTop: 12 }}>
                    {tItems.map((i) => (
                      <div key={i.id} style={styles.subItemRow}>
                        <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 2 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: CATEGORY_COLOR[i.category] || "#7C93A6" }} />
                          <span style={{ fontSize: 12.5 }}>{i.name}</span>
                        </span>
                        <span style={{ fontSize: 11.5, color: "#8FA2B3", flex: 0.8 }}>{i.category}</span>
                        <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", flex: 0.8, textAlign: "right" }}>{fmt(i.budget)}</span>
                        <button style={{ ...styles.removeBtn, flex: 0.2, textAlign: "right" }} onClick={() => removeTemplateItem(t.id, i.id)}>✕</button>
                      </div>
                    ))}
                    <div style={{ ...styles.addRow, marginTop: 10, borderRadius: 4 }}>
                      <input style={{ ...styles.addInput, flex: 2 }} placeholder="Line item name" value={addingTo === t.id ? itemName : ""} onChange={(e) => { setAddingTo(t.id); setItemName(e.target.value); }} />
                      <select style={{ ...styles.addInput, flex: 1 }} value={addingTo === t.id ? itemCategory : CATEGORIES[0]} onChange={(e) => { setAddingTo(t.id); setItemCategory(e.target.value); }}>
                        {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input style={{ ...styles.addInput, flex: 0.9, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }} placeholder="Budget" type="number" value={addingTo === t.id ? itemBudget : ""} onChange={(e) => { setAddingTo(t.id); setItemBudget(e.target.value); }} />
                      <button style={styles.addBtn} onClick={() => addTemplateItem(t.id)}>+ Add</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================== PROJECT VIEW ============================== */

function ProjectView({ projectId, onBack }) {
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
  const [coDesc, setCoDesc] = useState("");
  const [coAmount, setCoAmount] = useState("");
  const fileInputRef = useRef(null);
  const attachInputRef = useRef(null);
  const attachTargetItem = useRef(null);
  const saveTimers = useRef({});

  async function loadAll() {
    const [{ data: proj }, { data: lineItems }, { data: cos }, { data: snaps }, { data: subsData }, { data: temps }] =
      await Promise.all([
        supabase.from("projects_v2").select("*").eq("id", projectId).single(),
        supabase.from("line_items").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
        supabase.from("change_orders").select("*").eq("project_id", projectId).order("created_at", { ascending: false }),
        supabase.from("snapshots").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
        supabase.from("subcontractors").select("*").order("name"),
        supabase.from("templates").select("*").order("created_at", { ascending: false }),
      ]);
    setProject(proj);
    setItems(lineItems || []);
    setChangeOrders(cos || []);
    setSnapshots(snaps || []);
    setSubs(subsData || []);
    setTemplates(temps || []);
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
    if (!newName.trim() || !newBudget) return;
    const { data, error } = await supabase
      .from("line_items")
      .insert({ project_id: projectId, name: newName.trim(), category: newCategory, budget: Number(newBudget) })
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
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const { items: parsed, error } = parseCsvToItems(evt.target.result);
      if (error) setImportMessage({ type: "error", text: error });
      else {
        const rows = parsed.map((p) => ({ ...p, project_id: projectId }));
        const { data, error: insertErr } = await supabase.from("line_items").insert(rows).select();
        if (insertErr) setImportMessage({ type: "error", text: "Import failed — please try again." });
        else {
          setItems((prev) => [...prev, ...data]);
          setImportMessage({ type: "success", text: `Imported ${data.length} line item${data.length > 1 ? "s" : ""}.` });
        }
      }
      setTimeout(() => setImportMessage(null), 6000);
    };
    reader.readAsText(file);
    e.target.value = "";
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

  async function handleAttachFile(e) {
    const file = e.target.files?.[0];
    const item = attachTargetItem.current;
    if (!file || !item) return;
    const path = `${projectId}/${item.id}/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from("attachments").upload(path, file);
    if (!error) {
      const { data: pub } = supabase.storage.from("attachments").getPublicUrl(path);
      const newAttachments = [...(item.attachments || []), { name: file.name, url: pub.publicUrl }];
      await supabase.from("line_items").update({ attachments: newAttachments }).eq("id", item.id);
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, attachments: newAttachments } : i)));
    }
    e.target.value = "";
  }

  async function addChangeOrder() {
    if (!coDesc.trim() || !coAmount) return;
    const { data, error } = await supabase
      .from("change_orders")
      .insert({ project_id: projectId, description: coDesc.trim(), amount: Number(coAmount), status: "pending" })
      .select().single();
    if (!error && data) { setChangeOrders((prev) => [data, ...prev]); setCoDesc(""); setCoAmount(""); }
  }

  async function setCoStatus(id, status) {
    setChangeOrders((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
    await supabase.from("change_orders").update({ status }).eq("id", id);
  }

  async function removeChangeOrder(id) {
    setChangeOrders((prev) => prev.filter((c) => c.id !== id));
    await supabase.from("change_orders").delete().eq("id", id);
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
        <div style={{ ...styles.footer, textAlign: "center", padding: 60 }}>Loading project…</div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleImportFile} style={{ display: "none" }} />
      <input ref={attachInputRef} type="file" onChange={handleAttachFile} style={{ display: "none" }} />

      <div className="no-print" style={styles.backRow}>
        <button style={styles.backBtn} onClick={onBack}>← All projects</button>
        <button style={styles.exportBtn} onClick={() => window.print()}>Export PDF</button>
      </div>

      <div style={styles.titleBlock}>
        <div style={styles.titleBlockLeft}>
          <div style={styles.eyebrow}>SITEMARGIN — COST VARIANCE SHEET</div>
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
        {approvedCoTotal !== 0 && <SummaryCard label="Revised budget" value={fmt(totals.revisedBudget)} accent="#D9A441" />}
        <SummaryCard label="Actual spend" value={fmt(totals.actual)} />
        <SummaryCard label="Variance" value={`${totals.variance >= 0 ? "+" : ""}${fmt(totals.variance)}`} accent={totals.variance > 0 ? "#E8622C" : "#4C8C6B"} />
        <SummaryCard label="Retention held" value={fmt(totals.retentionHeld)} />
        <SummaryCard label="Flagged lines" value={`${overCount} over · ${watchCount} watch`} accent={overCount ? "#E8622C" : watchCount ? "#D9A441" : "#4C8C6B"} />
      </div>

      {totals.pct > 0 && (
        <div style={styles.warningBanner}>
          You're trending {totals.pct.toFixed(1)}% over the revised budget on this project. Review flagged lines below before your next client meeting.
        </div>
      )}
      {aheadCount > 0 && (
        <div style={{ ...styles.warningBanner, borderColor: "#D9A441", background: "rgba(217,164,65,0.1)", color: "#F2DDB0" }}>
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
              <span style={{ ...styles.categoryVariance, color: c.variance > 0 ? "#E8622C" : "#4C8C6B" }}>
                {c.variance >= 0 ? "+" : ""}{fmt(c.variance)}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="no-print" style={styles.importRow}>
        <button style={styles.importBtn} onClick={() => fileInputRef.current?.click()}>Import budget CSV</button>
        <select style={{ ...styles.addInput, maxWidth: 220 }} defaultValue="" onChange={(e) => { applyTemplate(e.target.value); e.target.value = ""; }}>
          <option value="">Apply a template…</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button style={styles.importBtn} onClick={saveAsTemplate}>Save as template</button>
        <button style={styles.templateLink} onClick={downloadTemplate}>Download CSV format</button>
        {importMessage && (
          <span style={{ fontSize: 12.5, color: importMessage.type === "error" ? "#E8622C" : "#4C8C6B" }}>{importMessage.text}</span>
        )}
      </div>

      <div className="no-print" style={styles.viewToggle}>
        {[
          ["ledger", "Cost & Progress"],
          ["charts", "Charts"],
          ["payments", "Payments & Retention"],
          ["changeorders", `Change Orders${changeOrders.length ? ` (${changeOrders.length})` : ""}`],
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
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: CATEGORY_COLOR[item.category] || "#7C93A6" }} />
                        <span style={{ fontSize: 11, color: "#8FA2B3" }}>{item.category || "Other"}</span>
                      </span>
                      {subName && <span style={{ fontSize: 11, color: "#C186D9" }}>· {subName}</span>}
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
                      <div style={{ ...styles.dualBarFill, width: `${progPct}%`, background: "#4C8C6B", top: 0 }} />
                      <div style={{ ...styles.dualBarFill, width: `${spentPct}%`, background: gapFlag ? "#E8622C" : "#7BA6D9", top: 8 }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                      <span style={{ fontSize: 10, color: "#4C8C6B" }}>{progPct.toFixed(0)}% done</span>
                      <span style={{ fontSize: 10, color: gapFlag ? "#E8622C" : "#7BA6D9" }}>{spentPct.toFixed(0)}% spent</span>
                    </div>
                  </span>
                  <span style={{ ...styles.tdCell, flex: 0.9, textAlign: "center" }}>
                    <span style={{ ...styles.statusPill, color: s.color, background: s.bg }}>{s.label}</span>
                    {gapFlag && (
                      <div className="no-print" style={{ marginTop: 4 }}>
                        <span style={{ ...styles.statusPill, color: "#E8622C", background: "rgba(232,98,44,0.14)", fontSize: 9 }}>SPEND AHEAD</span>
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
                          <a key={idx} href={a.url} target="_blank" rel="noreferrer" style={styles.attachmentLink}>📎 {a.name}</a>
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
              placeholder="Budget" type="number" value={newBudget} onChange={(e) => setNewBudget(e.target.value)} />
            <button style={styles.addBtn} onClick={addItem}>+ Add line</button>
          </div>
        </div>
      )}

      {view === "charts" && (
        <div className="no-print" style={styles.chartGrid}>
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
                        <span style={{ fontSize: 12.5, color: "#C7D2DC" }}>{c.category}</span>
                        <span style={{ fontSize: 11.5, fontFamily: "'IBM Plex Mono', monospace", color: over ? "#E8622C" : "#4C8C6B" }}>
                          {over ? "+" : ""}{fmtShort(c.variance)}
                        </span>
                      </div>
                      <div style={{ position: "relative", height: 8, background: "#101820", borderRadius: 3 }}>
                        <div style={{ position: "absolute", left: "50%", top: -2, width: 1, height: 12, background: "#3D5468" }} />
                        <div style={{
                          position: "absolute", top: 0, height: "100%", borderRadius: 3,
                          left: over ? "50%" : `${50 - w}%`, width: `${w}%`,
                          background: over ? "#E8622C" : "#4C8C6B",
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

      {view === "payments" && (
        <div style={styles.ledger}>
          <div style={styles.ledgerHeaderRow}>
            <span style={{ ...styles.thCell, flex: 2.4 }}>Line item</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Claimed</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Certified</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Retention held</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Paid to date</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "right" }}>Uncertified</span>
          </div>
          {items.map((item) => {
            const certified = Number(item.certified || 0);
            const claimed = Number(item.claimed || 0);
            const retentionHeld = certified * (totals.retentionPct / 100);
            const uncertified = claimed - certified;
            return (
              <div key={item.id} style={styles.row}>
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
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#D9A441" }}>{fmt(retentionHeld)}</span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#4C8C6B" }}>{fmt(certified - retentionHeld)}</span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: uncertified > 0 ? "#E8622C" : "#7C93A6" }}>{fmt(uncertified)}</span>
              </div>
            );
          })}
          <div style={{ ...styles.row, background: "#1A222C", fontWeight: 600 }}>
            <span style={{ ...styles.tdCell, flex: 2.4 }}>Totals</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(totals.claimed)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(totals.certified)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#D9A441" }}>{fmt(totals.retentionHeld)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#4C8C6B" }}>{fmt(totals.paidToDate)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: totals.uncertified > 0 ? "#E8622C" : "#7C93A6" }}>{fmt(totals.uncertified)}</span>
          </div>
        </div>
      )}

      {view === "changeorders" && (
        <div className="no-print" style={styles.ledger}>
          <div style={styles.ledgerHeaderRow}>
            <span style={{ ...styles.thCell, flex: 2.6 }}>Description</span>
            <span style={{ ...styles.thCell, flex: 1, textAlign: "right" }}>Amount</span>
            <span style={{ ...styles.thCell, flex: 1.2, textAlign: "center" }}>Status</span>
            <span style={{ ...styles.thCell, flex: 0.6 }}></span>
          </div>
          {changeOrders.map((co) => (
            <div key={co.id} style={styles.row}>
              <span style={{ ...styles.tdCell, flex: 2.6 }}>{co.description}</span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(co.amount)}</span>
              <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "center" }}>
                <select value={co.status} onChange={(e) => setCoStatus(co.id, e.target.value)}
                  style={{ ...styles.addInput, padding: "4px 8px", fontSize: 12, color: co.status === "approved" ? "#4C8C6B" : co.status === "rejected" ? "#E8622C" : "#D9A441" }}>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </span>
              <span style={{ ...styles.tdCell, flex: 0.6, textAlign: "right" }}>
                <button style={styles.removeBtn} onClick={() => removeChangeOrder(co.id)}>✕</button>
              </span>
            </div>
          ))}
          {changeOrders.length === 0 && (
            <div style={{ padding: 20, fontSize: 13, color: "#7C93A6" }}>
              No change orders yet. Add one below when a client approves a variation to the original budget.
            </div>
          )}
          <div style={styles.addRow}>
            <input style={{ ...styles.addInput, flex: 2.6 }} placeholder="e.g. Additional retaining wall per client request" value={coDesc} onChange={(e) => setCoDesc(e.target.value)} />
            <input style={{ ...styles.addInput, flex: 1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }} placeholder="Amount" type="number" value={coAmount} onChange={(e) => setCoAmount(e.target.value)} />
            <button style={styles.addBtn} onClick={addChangeOrder}>+ Add change order</button>
          </div>
        </div>
      )}

      {view === "trend" && (
        <div className="no-print" style={styles.ledger}>
          <div style={{ padding: 20 }}>
            <button style={styles.addBtn} onClick={logSnapshot}>+ Log snapshot now</button>
            <p style={{ fontSize: 12.5, color: "#7C93A6", marginTop: 10 }}>
              Click this weekly (or before each client meeting) to record where budget vs actual stand right now.
              Over time this builds a trend you can point to instead of a single snapshot.
            </p>
          </div>
          {snapshots.length === 0 ? (
            <div style={{ padding: "0 20px 20px", fontSize: 13, color: "#7C93A6" }}>No snapshots logged yet.</div>
          ) : (
            <div style={{ padding: "0 20px 20px" }}>
              <TrendChart snapshots={snapshots} />
              <div style={{ marginTop: 16 }}>
                {[...snapshots].reverse().map((s) => (
                  <div key={s.id} style={styles.trendRow}>
                    <span style={{ fontSize: 12, color: "#8FA2B3", fontFamily: "'IBM Plex Mono', monospace" }}>
                      {new Date(s.created_at).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}
                    </span>
                    <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(s.actual)}</span>
                    <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", color: Number(s.variance) > 0 ? "#E8622C" : "#4C8C6B", fontWeight: 600 }}>
                      {Number(s.variance) >= 0 ? "+" : ""}{fmt(s.variance)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="no-print" style={styles.footer}>
        Click Actual to log spend, or "Details" on any line to set the subcontractor, dates, quality rating, notes and files.
      </div>
    </div>
  );
}

/* ============================== STYLES ============================== */

const styles = {
  page: {
    minHeight: "100vh",
    background: "#1C2530",
    backgroundImage: "linear-gradient(rgba(61,84,104,0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(61,84,104,0.16) 1px, transparent 1px)",
    backgroundSize: "28px 28px",
    color: "#F2EDE4",
    fontFamily: "'Inter', sans-serif",
    padding: "20px 16px 48px",
  },
  eyebrow: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, letterSpacing: "0.14em", color: "#E8622C", fontWeight: 600 },

  dashHeader: { maxWidth: 1180, margin: "0 auto 16px" },
  dashTitle: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 34, fontWeight: 600, marginTop: 4 },

  topNav: { maxWidth: 1180, margin: "0 auto 20px", display: "flex", gap: 8, borderBottom: "1px solid #2A3644", paddingBottom: 12 },
  topNavBtn: { background: "none", border: "none", color: "#8FA2B3", fontSize: 14, fontWeight: 500, padding: "6px 12px", cursor: "pointer", borderRadius: 3 },
  topNavBtnActive: { background: "#232E3B", color: "#F2EDE4", fontWeight: 600 },

  explainer: { maxWidth: 1180, margin: "0 auto 18px", fontSize: 13, color: "#8FA2B3", lineHeight: 1.6, background: "#1E2733", border: "1px solid #2A3644", borderRadius: 4, padding: "12px 16px" },

  newProjectRow: { maxWidth: 1180, margin: "0 auto 24px", display: "flex", gap: 10 },
  addRowStandalone: { maxWidth: 1180, margin: "0 auto 22px", display: "flex", gap: 10, flexWrap: "wrap" },
  projectGrid: { maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 },
  projectCard: { background: "#232E3B", border: "1px solid #3D5468", borderRadius: 4, padding: "18px 20px", cursor: "pointer" },
  scoreCard: { background: "#232E3B", border: "1px solid #3D5468", borderRadius: 4, padding: "18px 20px" },
  templateCard: { background: "#232E3B", border: "1px solid #3D5468", borderRadius: 4, padding: "18px 20px", marginBottom: 12 },
  projectCardTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  projectName: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 600 },
  deleteProjectBtn: { background: "none", border: "none", color: "#7C93A6", cursor: "pointer", fontSize: 14 },
  projectNums: { display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", color: "#C7D2DC" },
  projectMeta: { fontSize: 12, color: "#7C93A6", marginTop: 8 },
  subItemRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #2A3644" },

  backRow: { maxWidth: 1180, margin: "0 auto 12px", display: "flex", justifyContent: "space-between" },
  backBtn: { background: "none", border: "none", color: "#8FA2B3", fontSize: 13, cursor: "pointer" },
  exportBtn: { background: "#232E3B", border: "1px solid #3D5468", borderRadius: 3, color: "#F2EDE4", fontSize: 13, fontWeight: 500, padding: "8px 16px", cursor: "pointer" },

  titleBlock: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 16, borderBottom: "2px solid #3D5468", paddingBottom: 14, maxWidth: 1180, margin: "0 auto 20px" },
  titleBlockLeft: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 },
  projectInput: { background: "transparent", border: "none", color: "#F2EDE4", fontFamily: "'Barlow Condensed', sans-serif", fontSize: 30, fontWeight: 600, padding: 0, width: "100%" },
  titleBlockRight: { display: "flex", gap: 22 },
  tbCell: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  tbLabel: { fontSize: 10, letterSpacing: "0.1em", color: "#7C93A6" },
  tbValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, color: "#F2EDE4", display: "flex", alignItems: "center", gap: 2 },
  retentionInput: { width: 34, background: "#101820", border: "1px solid #3D5468", borderRadius: 3, color: "#F2EDE4", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, padding: "1px 4px", textAlign: "right" },

  summaryStrip: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, maxWidth: 1180, margin: "0 auto 16px" },
  summaryCard: { background: "#232E3B", border: "1px solid #3D5468", borderRadius: 4, padding: "14px 16px" },
  summaryLabel: { fontSize: 11, letterSpacing: "0.08em", color: "#7C93A6", marginBottom: 6, textTransform: "uppercase" },
  summaryValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 17, fontWeight: 600 },

  warningBanner: { maxWidth: 1180, margin: "0 auto 12px", background: "rgba(232,98,44,0.1)", border: "1px solid #E8622C", borderRadius: 4, padding: "12px 16px", fontSize: 14, color: "#F2C6B0" },

  categoryStrip: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, maxWidth: 1180, margin: "0 auto 16px" },
  categoryCard: { background: "#1E2733", border: "1px solid #2A3644", borderRadius: 4, padding: "10px 14px" },
  categoryHead: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  categoryDot: { width: 8, height: 8, borderRadius: "50%" },
  categoryName: { fontSize: 12, color: "#C7D2DC", fontWeight: 500 },
  categoryNums: { display: "flex", justifyContent: "space-between", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 },
  categoryBudget: { color: "#8FA2B3" },
  categoryVariance: { fontWeight: 600 },

  importRow: { maxWidth: 1180, margin: "0 auto 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  importBtn: { background: "#232E3B", border: "1px solid #3D5468", borderRadius: 3, color: "#F2EDE4", fontSize: 13, fontWeight: 500, padding: "8px 16px", cursor: "pointer" },
  templateLink: { background: "none", border: "none", color: "#8FA2B3", fontSize: 12.5, textDecoration: "underline", cursor: "pointer", padding: 0 },

  viewToggle: { maxWidth: 1180, margin: "0 auto 12px", display: "flex", gap: 8, flexWrap: "wrap" },
  toggleBtn: { background: "#1A222C", border: "1px solid #3D5468", borderRadius: 3, color: "#8FA2B3", fontSize: 13, fontWeight: 500, padding: "8px 16px", cursor: "pointer" },
  toggleBtnActive: { background: "#E8622C", borderColor: "#E8622C", color: "#1C2530", fontWeight: 600 },

  ledger: { maxWidth: 1180, margin: "0 auto", background: "#20293480", borderRadius: 4, overflow: "hidden" },
  ledgerHeaderRow: { display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #3D5468", background: "#1A222C" },
  thCell: { fontSize: 11, letterSpacing: "0.08em", color: "#7C93A6", textTransform: "uppercase" },
  row: { display: "flex", alignItems: "center", padding: "12px 14px", borderBottom: "1px solid #2A3644" },
  tdCell: { fontSize: 14, paddingRight: 8 },
  actualButton: { background: "none", border: "none", color: "#F2EDE4", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, cursor: "pointer", borderBottom: "1px dashed #7C93A6", padding: 0 },
  inlineInput: { width: "100%", background: "#101820", border: "1px solid #E8622C", borderRadius: 3, color: "#F2EDE4", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, padding: "2px 6px", textAlign: "right" },
  miniLink: { background: "none", border: "none", color: "#7C93A6", fontSize: 10.5, textDecoration: "underline", cursor: "pointer", padding: 0 },
  miniLinkBlock: { background: "none", border: "none", color: "#7BA6D9", fontSize: 12, textDecoration: "underline", cursor: "pointer", padding: 0, marginTop: 4 },
  gaugeTrack: { position: "relative", height: 6, background: "#101820", borderRadius: 3, overflow: "visible", marginBottom: 4 },
  gaugeFill: { height: "100%", borderRadius: 3, transition: "width 0.3s ease" },
  gaugeTolMark: { position: "absolute", left: "71.4%", top: -2, width: 1, height: 10, background: "#7C93A6" },
  gaugeLabel: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 },
  dualBarTrack: { position: "relative", height: 16, background: "#101820", borderRadius: 3 },
  dualBarFill: { position: "absolute", left: 0, height: 6, borderRadius: 3, transition: "width 0.3s ease" },
  statusPill: { display: "inline-block", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", padding: "4px 8px", borderRadius: 3 },
  removeBtn: { background: "none", border: "none", color: "#7C93A6", cursor: "pointer", fontSize: 13 },
  addRow: { display: "flex", gap: 10, alignItems: "center", padding: "14px", background: "#1A222C", flexWrap: "wrap" },
  addInput: { background: "#101820", border: "1px solid #3D5468", borderRadius: 3, color: "#F2EDE4", fontSize: 14, padding: "8px 10px" },
  addBtn: { background: "#E8622C", border: "none", borderRadius: 3, color: "#1C2530", fontWeight: 600, fontSize: 13, padding: "9px 14px", cursor: "pointer", whiteSpace: "nowrap" },
  footer: { maxWidth: 1180, margin: "16px auto 0", fontSize: 12, color: "#7C93A6" },

  detailPanel: { background: "#1A222C", padding: "16px 18px", borderBottom: "1px solid #2A3644" },
  detailGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 },
  detailField: { display: "flex", flexDirection: "column", gap: 5 },
  detailLabel: { fontSize: 10.5, letterSpacing: "0.08em", color: "#7C93A6", textTransform: "uppercase" },
  notesTextarea: { width: "100%", minHeight: 60, background: "#101820", border: "1px solid #3D5468", borderRadius: 3, color: "#F2EDE4", fontSize: 13, padding: "8px 10px", fontFamily: "'Inter', sans-serif", resize: "vertical", marginTop: 5 },
  attachmentLink: { fontSize: 12, color: "#7BA6D9", textDecoration: "none" },

  chartGrid: { maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 },
  chartCard: { background: "#232E3B", border: "1px solid #3D5468", borderRadius: 4, padding: "20px 22px" },
  chartTitle: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 600, marginBottom: 2 },
  chartSub: { fontSize: 12, color: "#7C93A6", marginBottom: 16 },

  trendRow: { display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #2A3644" },
};
