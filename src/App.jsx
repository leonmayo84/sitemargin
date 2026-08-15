import React, { useState, useMemo, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

const fmt = (n) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(n || 0);

const STATUS = {
  ok: { label: "ON TRACK", color: "#4C8C6B", bg: "rgba(76,140,107,0.12)" },
  watch: { label: "WATCH", color: "#D9A441", bg: "rgba(217,164,65,0.12)" },
  over: { label: "OVER", color: "#E8622C", bg: "rgba(232,98,44,0.14)" },
};

const CATEGORIES = ["Labour", "Materials", "Subcontractors", "Other"];
const CATEGORY_COLOR = {
  Labour: "#7BA6D9",
  Materials: "#D9A441",
  Subcontractors: "#C186D9",
  Other: "#7C93A6",
};

function statusFor(budget, actual) {
  if (budget <= 0) return "ok";
  const ratio = actual / budget;
  if (ratio > 1) return "over";
  if (ratio > 0.85) return "watch";
  return "ok";
}

// The core early-warning signal: money spent running ahead of physical progress.
// A line item can look "on budget" in rand terms while still being in real trouble
// if 90% of the budget is spent for 60% of the work done.
function progressGapFor(budget, actual, percentComplete) {
  if (!budget || percentComplete == null || percentComplete === "") return null;
  const spentPct = (actual / budget) * 100;
  return spentPct - Number(percentComplete);
}

const seedItems = [
  { id: 1, name: "Excavation & earthworks", category: "Subcontractors", budget: 185000, actual: 172000, percentComplete: 100, claimed: 172000, certified: 172000 },
  { id: 2, name: "Concrete & foundations", category: "Materials", budget: 420000, actual: 448000, percentComplete: 95, claimed: 448000, certified: 420000 },
  { id: 3, name: "Structural steel", category: "Subcontractors", budget: 310000, actual: 298000, percentComplete: 90, claimed: 298000, certified: 280000 },
  { id: 4, name: "Roofing", category: "Subcontractors", budget: 165000, actual: 149500, percentComplete: 85, claimed: 149500, certified: 149500 },
  { id: 5, name: "Electrical rough-in", category: "Labour", budget: 140000, actual: 134800, percentComplete: 80, claimed: 134800, certified: 120000 },
  { id: 6, name: "Plumbing rough-in", category: "Labour", budget: 118000, actual: 126000, percentComplete: 70, claimed: 126000, certified: 110000 },
];

const DEFAULT_RETENTION_PCT = 5;

// Single-project scope for now — swap for real per-user project IDs once auth is added
const PROJECT_ID = "default";

export default function SiteMargin() {
  const [projectName, setProjectName] = useState("Fernwood Residence — Phase 2");
  const [items, setItems] = useState(seedItems);
  const [retentionPct, setRetentionPct] = useState(DEFAULT_RETENTION_PCT);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState(CATEGORIES[0]);
  const [newBudget, setNewBudget] = useState("");
  const [editingCell, setEditingCell] = useState(null); // `${id}:${field}`
  const [editValue, setEditValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [view, setView] = useState("ledger"); // ledger | payments
  const saveTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("projects")
          .select("project_name, items, retention_pct")
          .eq("id", PROJECT_ID)
          .maybeSingle();

        if (!cancelled && !error && data) {
          if (data.project_name) setProjectName(data.project_name);
          if (Array.isArray(data.items)) setItems(data.items);
          if (data.retention_pct != null) setRetentionPct(data.retention_pct);
        }
      } catch (e) {
        console.error("SiteMargin: failed to load project", e);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const { error } = await supabase
          .from("projects")
          .upsert({
            id: PROJECT_ID,
            project_name: projectName,
            items,
            retention_pct: retentionPct,
            updated_at: new Date().toISOString(),
          });
        setSaveState(error ? "error" : "saved");
        if (error) console.error("SiteMargin: save failed", error);
      } catch (e) {
        setSaveState("error");
        console.error("SiteMargin: save failed", e);
      }
    }, 600);
    return () => clearTimeout(saveTimer.current);
  }, [projectName, items, retentionPct, loaded]);

  const totals = useMemo(() => {
    const budget = items.reduce((s, i) => s + Number(i.budget || 0), 0);
    const actual = items.reduce((s, i) => s + Number(i.actual || 0), 0);
    const claimed = items.reduce((s, i) => s + Number(i.claimed || 0), 0);
    const certified = items.reduce((s, i) => s + Number(i.certified || 0), 0);
    const retentionHeld = certified * (retentionPct / 100);
    const paidToDate = certified - retentionHeld;
    const uncertified = claimed - certified;
    return {
      budget,
      actual,
      variance: actual - budget,
      pct: budget ? ((actual - budget) / budget) * 100 : 0,
      claimed,
      certified,
      retentionHeld,
      paidToDate,
      uncertified,
    };
  }, [items, retentionPct]);

  const overCount = items.filter((i) => statusFor(i.budget, i.actual) === "over").length;
  const watchCount = items.filter((i) => statusFor(i.budget, i.actual) === "watch").length;
  const aheadCount = items.filter((i) => {
    const gap = progressGapFor(i.budget, i.actual, i.percentComplete);
    return gap != null && gap > 15;
  }).length;

  const categoryRollup = useMemo(() => {
    return CATEGORIES.map((cat) => {
      const catItems = items.filter((i) => (i.category || "Other") === cat);
      const budget = catItems.reduce((s, i) => s + Number(i.budget || 0), 0);
      const actual = catItems.reduce((s, i) => s + Number(i.actual || 0), 0);
      return { category: cat, budget, actual, variance: actual - budget, count: catItems.length };
    }).filter((c) => c.count > 0);
  }, [items]);

  function addItem() {
    if (!newName.trim() || !newBudget) return;
    setItems([
      ...items,
      {
        id: Date.now(),
        name: newName.trim(),
        category: newCategory,
        budget: Number(newBudget),
        actual: 0,
        percentComplete: 0,
        claimed: 0,
        certified: 0,
      },
    ]);
    setNewName("");
    setNewBudget("");
  }

  function removeItem(id) {
    setItems(items.filter((i) => i.id !== id));
  }

  function startEdit(id, field, currentValue) {
    setEditingCell(`${id}:${field}`);
    setEditValue(String(currentValue ?? ""));
  }

  function saveEdit(id, field) {
    setItems(items.map((i) => (i.id === id ? { ...i, [field]: field === "category" ? editValue : Number(editValue) || 0 } : i)));
    setEditingCell(null);
  }

  async function resetProject() {
    if (!window.confirm("Clear this project and start fresh?")) return;
    try {
      await supabase.from("projects").delete().eq("id", PROJECT_ID);
    } catch (e) {
      console.error("SiteMargin: reset failed", e);
    }
    setProjectName("Untitled Project");
    setItems([]);
  }

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        input:focus, select:focus { outline: 2px solid #E8622C; outline-offset: 1px; }
        button:focus-visible { outline: 2px solid #E8622C; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>

      {/* Title block */}
      <div style={styles.titleBlock}>
        <div style={styles.titleBlockLeft}>
          <div style={styles.eyebrow}>SITEMARGIN — COST VARIANCE SHEET</div>
          <input
            style={styles.projectInput}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            aria-label="Project name"
          />
        </div>
        <div style={styles.titleBlockRight}>
          <div style={styles.tbCell}>
            <span style={styles.tbLabel}>DATE</span>
            <span style={styles.tbValue}>{new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}</span>
          </div>
          <div style={styles.tbCell}>
            <span style={styles.tbLabel}>RETENTION</span>
            <span style={styles.tbValue}>
              <input
                type="number"
                value={retentionPct}
                onChange={(e) => setRetentionPct(Number(e.target.value) || 0)}
                style={styles.retentionInput}
              />%
            </span>
          </div>
          <div style={styles.tbCell}>
            <span style={styles.tbLabel}>LINES</span>
            <span style={styles.tbValue}>{items.length}</span>
          </div>
          <div style={styles.tbCell}>
            <span style={styles.tbLabel}>STATUS</span>
            <span style={{ ...styles.tbValue, fontSize: 11, color: saveState === "error" ? "#E8622C" : "#7C93A6" }}>
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : ""}
            </span>
          </div>
        </div>
      </div>

      {/* Summary strip */}
      <div style={styles.summaryStrip}>
        <SummaryCard label="Budget" value={fmt(totals.budget)} />
        <SummaryCard label="Actual spend" value={fmt(totals.actual)} />
        <SummaryCard
          label="Variance"
          value={`${totals.variance >= 0 ? "+" : ""}${fmt(totals.variance)}`}
          accent={totals.variance > 0 ? "#E8622C" : "#4C8C6B"}
        />
        <SummaryCard
          label="Retention held"
          value={fmt(totals.retentionHeld)}
        />
        <SummaryCard
          label="Flagged lines"
          value={`${overCount} over · ${watchCount} watch`}
          accent={overCount ? "#E8622C" : watchCount ? "#D9A441" : "#4C8C6B"}
        />
      </div>

      {totals.pct > 0 && (
        <div style={styles.warningBanner}>
          You're trending {totals.pct.toFixed(1)}% over budget on this project. Review flagged lines below before your next client meeting.
        </div>
      )}
      {aheadCount > 0 && (
        <div style={{ ...styles.warningBanner, borderColor: "#D9A441", background: "rgba(217,164,65,0.1)", color: "#F2DDB0" }}>
          {aheadCount} line{aheadCount > 1 ? "s are" : " is"} spending ahead of physical progress — money is going out faster than work is getting done. Check the Progress column below.
        </div>
      )}

      {/* Category rollup */}
      <div style={styles.categoryStrip}>
        {categoryRollup.map((c) => (
          <div key={c.category} style={styles.categoryCard}>
            <div style={styles.categoryHead}>
              <span style={{ ...styles.categoryDot, background: CATEGORY_COLOR[c.category] }} />
              <span style={styles.categoryName}>{c.category}</span>
            </div>
            <div style={styles.categoryNums}>
              <span style={styles.categoryBudget}>{fmt(c.budget)}</span>
              <span
                style={{
                  ...styles.categoryVariance,
                  color: c.variance > 0 ? "#E8622C" : "#4C8C6B",
                }}
              >
                {c.variance >= 0 ? "+" : ""}
                {fmt(c.variance)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* View toggle */}
      <div style={styles.viewToggle}>
        <button
          style={{ ...styles.toggleBtn, ...(view === "ledger" ? styles.toggleBtnActive : {}) }}
          onClick={() => setView("ledger")}
        >
          Cost & Progress
        </button>
        <button
          style={{ ...styles.toggleBtn, ...(view === "payments" ? styles.toggleBtnActive : {}) }}
          onClick={() => setView("payments")}
        >
          Payments & Retention
        </button>
      </div>

      {view === "ledger" ? (
        <div style={styles.ledger}>
          <div style={styles.ledgerHeaderRow}>
            <span style={{ ...styles.thCell, flex: 2.4 }}>Line item</span>
            <span style={{ ...styles.thCell, flex: 1.1, textAlign: "right" }}>Budget</span>
            <span style={{ ...styles.thCell, flex: 1.1, textAlign: "right" }}>Actual</span>
            <span style={{ ...styles.thCell, flex: 1.6 }}>Tolerance</span>
            <span style={{ ...styles.thCell, flex: 1.4 }}>Progress vs spend</span>
            <span style={{ ...styles.thCell, flex: 0.9, textAlign: "center" }}>Status</span>
            <span style={{ ...styles.thCell, flex: 0.5 }}></span>
          </div>

          {items.map((item) => {
            const status = statusFor(item.budget, item.actual);
            const s = STATUS[status];
            const ratio = item.budget ? Math.min(item.actual / item.budget, 1.4) : 0;
            const pctLabel = item.budget ? (((item.actual - item.budget) / item.budget) * 100).toFixed(1) : "0.0";
            const gap = progressGapFor(item.budget, item.actual, item.percentComplete);
            const spentPct = item.budget ? Math.min((item.actual / item.budget) * 100, 100) : 0;
            const progPct = item.percentComplete != null ? Math.min(Number(item.percentComplete), 100) : 0;
            const gapFlag = gap != null && gap > 15;

            return (
              <div key={item.id} style={styles.row}>
                <span style={{ ...styles.tdCell, flex: 2.4 }}>
                  <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500 }}>{item.name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 3 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: CATEGORY_COLOR[item.category] || "#7C93A6" }} />
                    <span style={{ fontSize: 11, color: "#8FA2B3" }}>{item.category || "Other"}</span>
                  </div>
                </span>
                <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                  {fmt(item.budget)}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                  {editingCell === `${item.id}:actual` ? (
                    <input
                      autoFocus
                      style={styles.inlineInput}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(item.id, "actual")}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "actual")}
                      type="number"
                    />
                  ) : (
                    <button style={styles.actualButton} onClick={() => startEdit(item.id, "actual", item.actual)}>
                      {fmt(item.actual)}
                    </button>
                  )}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.6 }}>
                  <div style={styles.gaugeTrack}>
                    <div style={styles.gaugeTolMark} />
                    <div style={{ ...styles.gaugeFill, width: `${Math.min(ratio * 71.4, 100)}%`, background: s.color }} />
                  </div>
                  <span style={{ ...styles.gaugeLabel, color: s.color }}>
                    {pctLabel > 0 ? "+" : ""}
                    {pctLabel}%
                  </span>
                </span>
                <span style={{ ...styles.tdCell, flex: 1.4 }}>
                  <div style={styles.dualBarTrack}>
                    <div style={{ ...styles.dualBarFill, width: `${progPct}%`, background: "#4C8C6B", top: 0 }} />
                    <div style={{ ...styles.dualBarFill, width: `${spentPct}%`, background: gapFlag ? "#E8622C" : "#7BA6D9", top: 8 }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                    <span style={{ fontSize: 10, color: "#4C8C6B" }}>{progPct.toFixed(0)}% done</span>
                    <span style={{ fontSize: 10, color: gapFlag ? "#E8622C" : "#7BA6D9" }}>{spentPct.toFixed(0)}% spent</span>
                  </div>
                  <div style={{ marginTop: 3 }}>
                    {editingCell === `${item.id}:percentComplete` ? (
                      <input
                        autoFocus
                        style={styles.inlineInputSmall}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => saveEdit(item.id, "percentComplete")}
                        onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "percentComplete")}
                        type="number"
                        placeholder="% complete"
                      />
                    ) : (
                      <button
                        style={styles.editProgressLink}
                        onClick={() => startEdit(item.id, "percentComplete", item.percentComplete)}
                      >
                        Set % complete
                      </button>
                    )}
                  </div>
                </span>
                <span style={{ ...styles.tdCell, flex: 0.9, textAlign: "center" }}>
                  <span style={{ ...styles.statusPill, color: s.color, background: s.bg }}>{s.label}</span>
                  {gapFlag && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ ...styles.statusPill, color: "#E8622C", background: "rgba(232,98,44,0.14)", fontSize: 9 }}>
                        SPEND AHEAD
                      </span>
                    </div>
                  )}
                </span>
                <span style={{ ...styles.tdCell, flex: 0.5, textAlign: "right" }}>
                  <button style={styles.removeBtn} onClick={() => removeItem(item.id)} aria-label={`Remove ${item.name}`}>
                    ✕
                  </button>
                </span>
              </div>
            );
          })}

          <div style={styles.addRow}>
            <input
              style={{ ...styles.addInput, flex: 2 }}
              placeholder="New line item (e.g. Drywall & finishes)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <select style={{ ...styles.addInput, flex: 1.2 }} value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              style={{ ...styles.addInput, flex: 1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}
              placeholder="Budget"
              type="number"
              value={newBudget}
              onChange={(e) => setNewBudget(e.target.value)}
            />
            <button style={styles.addBtn} onClick={addItem}>
              + Add line
            </button>
          </div>
        </div>
      ) : (
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
            const retentionHeld = certified * (retentionPct / 100);
            const paid = certified - retentionHeld;
            const uncertified = claimed - certified;

            return (
              <div key={item.id} style={styles.row}>
                <span style={{ ...styles.tdCell, flex: 2.4, fontFamily: "'Inter', sans-serif", fontWeight: 500 }}>
                  {item.name}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                  {editingCell === `${item.id}:claimed` ? (
                    <input
                      autoFocus
                      style={styles.inlineInput}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(item.id, "claimed")}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "claimed")}
                      type="number"
                    />
                  ) : (
                    <button style={styles.actualButton} onClick={() => startEdit(item.id, "claimed", item.claimed)}>
                      {fmt(claimed)}
                    </button>
                  )}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                  {editingCell === `${item.id}:certified` ? (
                    <input
                      autoFocus
                      style={styles.inlineInput}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(item.id, "certified")}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "certified")}
                      type="number"
                    />
                  ) : (
                    <button style={styles.actualButton} onClick={() => startEdit(item.id, "certified", item.certified)}>
                      {fmt(certified)}
                    </button>
                  )}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#D9A441" }}>
                  {fmt(retentionHeld)}
                </span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#4C8C6B" }}>
                  {fmt(paid)}
                </span>
                <span
                  style={{
                    ...styles.tdCell,
                    flex: 1.2,
                    textAlign: "right",
                    fontFamily: "'IBM Plex Mono', monospace",
                    color: uncertified > 0 ? "#E8622C" : "#7C93A6",
                  }}
                >
                  {fmt(uncertified)}
                </span>
              </div>
            );
          })}

          <div style={{ ...styles.row, background: "#1A222C", fontWeight: 600 }}>
            <span style={{ ...styles.tdCell, flex: 2.4 }}>Totals</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
              {fmt(totals.claimed)}
            </span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
              {fmt(totals.certified)}
            </span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#D9A441" }}>
              {fmt(totals.retentionHeld)}
            </span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#4C8C6B" }}>
              {fmt(totals.paidToDate)}
            </span>
            <span
              style={{
                ...styles.tdCell,
                flex: 1.2,
                textAlign: "right",
                fontFamily: "'IBM Plex Mono', monospace",
                color: totals.uncertified > 0 ? "#E8622C" : "#7C93A6",
              }}
            >
              {fmt(totals.uncertified)}
            </span>
          </div>
        </div>
      )}

      <div style={styles.footer}>
        {view === "ledger"
          ? "Click Actual to log spend. Set % complete to compare progress against spend — the gap is where cost overruns hide."
          : "Click Claimed or Certified to update. Retention is held back at the rate set top-right, and released once certified."}
        {" "}Your data saves automatically to Supabase.{" "}
        <button style={styles.resetLink} onClick={resetProject}>
          Reset project
        </button>
      </div>
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

const styles = {
  page: {
    minHeight: "100vh",
    background: "#1C2530",
    backgroundImage:
      "linear-gradient(rgba(61,84,104,0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(61,84,104,0.16) 1px, transparent 1px)",
    backgroundSize: "28px 28px",
    color: "#F2EDE4",
    fontFamily: "'Inter', sans-serif",
    padding: "20px 16px 48px",
  },
  titleBlock: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 16,
    borderBottom: "2px solid #3D5468",
    paddingBottom: 14,
    marginBottom: 20,
    maxWidth: 1180,
    margin: "0 auto 20px",
  },
  titleBlockLeft: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 },
  eyebrow: {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontSize: 12,
    letterSpacing: "0.14em",
    color: "#E8622C",
    fontWeight: 600,
  },
  projectInput: {
    background: "transparent",
    border: "none",
    color: "#F2EDE4",
    fontFamily: "'Barlow Condensed', sans-serif",
    fontSize: 30,
    fontWeight: 600,
    padding: 0,
    width: "100%",
  },
  titleBlockRight: { display: "flex", gap: 22 },
  tbCell: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  tbLabel: { fontSize: 10, letterSpacing: "0.1em", color: "#7C93A6" },
  tbValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, color: "#F2EDE4", display: "flex", alignItems: "center", gap: 2 },
  retentionInput: {
    width: 34,
    background: "#101820",
    border: "1px solid #3D5468",
    borderRadius: 3,
    color: "#F2EDE4",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 14,
    padding: "1px 4px",
    textAlign: "right",
  },

  summaryStrip: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 12,
    maxWidth: 1180,
    margin: "0 auto 16px",
  },
  summaryCard: {
    background: "#232E3B",
    border: "1px solid #3D5468",
    borderRadius: 4,
    padding: "14px 16px",
  },
  summaryLabel: { fontSize: 11, letterSpacing: "0.08em", color: "#7C93A6", marginBottom: 6, textTransform: "uppercase" },
  summaryValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 18, fontWeight: 600 },

  warningBanner: {
    maxWidth: 1180,
    margin: "0 auto 12px",
    background: "rgba(232,98,44,0.1)",
    border: "1px solid #E8622C",
    borderRadius: 4,
    padding: "12px 16px",
    fontSize: 14,
    color: "#F2C6B0",
  },

  categoryStrip: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 10,
    maxWidth: 1180,
    margin: "0 auto 16px",
  },
  categoryCard: {
    background: "#1E2733",
    border: "1px solid #2A3644",
    borderRadius: 4,
    padding: "10px 14px",
  },
  categoryHead: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  categoryDot: { width: 8, height: 8, borderRadius: "50%" },
  categoryName: { fontSize: 12, color: "#C7D2DC", fontWeight: 500 },
  categoryNums: { display: "flex", justifyContent: "space-between", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 },
  categoryBudget: { color: "#8FA2B3" },
  categoryVariance: { fontWeight: 600 },

  viewToggle: {
    maxWidth: 1180,
    margin: "0 auto 12px",
    display: "flex",
    gap: 8,
  },
  toggleBtn: {
    background: "#1A222C",
    border: "1px solid #3D5468",
    borderRadius: 3,
    color: "#8FA2B3",
    fontSize: 13,
    fontWeight: 500,
    padding: "8px 16px",
    cursor: "pointer",
  },
  toggleBtnActive: {
    background: "#E8622C",
    borderColor: "#E8622C",
    color: "#1C2530",
    fontWeight: 600,
  },

  ledger: { maxWidth: 1180, margin: "0 auto", background: "#20293480", borderRadius: 4, overflow: "hidden" },
  ledgerHeaderRow: {
    display: "flex",
    alignItems: "center",
    padding: "10px 14px",
    borderBottom: "1px solid #3D5468",
    background: "#1A222C",
  },
  thCell: { fontSize: 11, letterSpacing: "0.08em", color: "#7C93A6", textTransform: "uppercase" },
  row: {
    display: "flex",
    alignItems: "center",
    padding: "12px 14px",
    borderBottom: "1px solid #2A3644",
  },
  tdCell: { fontSize: 14, paddingRight: 8 },
  actualButton: {
    background: "none",
    border: "none",
    color: "#F2EDE4",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 14,
    cursor: "pointer",
    borderBottom: "1px dashed #7C93A6",
    padding: 0,
  },
  inlineInput: {
    width: "100%",
    background: "#101820",
    border: "1px solid #E8622C",
    borderRadius: 3,
    color: "#F2EDE4",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 14,
    padding: "2px 6px",
    textAlign: "right",
  },
  inlineInputSmall: {
    width: "100%",
    background: "#101820",
    border: "1px solid #E8622C",
    borderRadius: 3,
    color: "#F2EDE4",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11,
    padding: "2px 6px",
  },
  editProgressLink: {
    background: "none",
    border: "none",
    color: "#7C93A6",
    fontSize: 10,
    textDecoration: "underline",
    cursor: "pointer",
    padding: 0,
  },
  gaugeTrack: {
    position: "relative",
    height: 6,
    background: "#101820",
    borderRadius: 3,
    overflow: "visible",
    marginBottom: 4,
  },
  gaugeFill: { height: "100%", borderRadius: 3, transition: "width 0.3s ease" },
  gaugeTolMark: {
    position: "absolute",
    left: "71.4%",
    top: -2,
    width: 1,
    height: 10,
    background: "#7C93A6",
  },
  gaugeLabel: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 },
  dualBarTrack: {
    position: "relative",
    height: 16,
    background: "#101820",
    borderRadius: 3,
  },
  dualBarFill: {
    position: "absolute",
    left: 0,
    height: 6,
    borderRadius: 3,
    transition: "width 0.3s ease",
  },
  statusPill: {
    display: "inline-block",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.06em",
    padding: "4px 8px",
    borderRadius: 3,
  },
  removeBtn: {
    background: "none",
    border: "none",
    color: "#7C93A6",
    cursor: "pointer",
    fontSize: 13,
  },
  addRow: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    padding: "14px",
    background: "#1A222C",
  },
  addInput: {
    background: "#101820",
    border: "1px solid #3D5468",
    borderRadius: 3,
    color: "#F2EDE4",
    fontSize: 14,
    padding: "8px 10px",
  },
  addBtn: {
    background: "#E8622C",
    border: "none",
    borderRadius: 3,
    color: "#1C2530",
    fontWeight: 600,
    fontSize: 13,
    padding: "9px 14px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  footer: {
    maxWidth: 1180,
    margin: "16px auto 0",
    fontSize: 12,
    color: "#7C93A6",
  },
  resetLink: {
    background: "none",
    border: "none",
    color: "#E8622C",
    fontSize: 12,
    textDecoration: "underline",
    cursor: "pointer",
    padding: 0,
  },
};
