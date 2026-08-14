import React, { useState, useMemo, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

const fmt = (n) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(n || 0);

const STATUS = {
  ok: { label: "ON TRACK", color: "#4C8C6B", bg: "rgba(76,140,107,0.12)" },
  watch: { label: "WATCH", color: "#D9A441", bg: "rgba(217,164,65,0.12)" },
  over: { label: "OVER", color: "#E8622C", bg: "rgba(232,98,44,0.14)" },
};

function statusFor(budget, actual) {
  if (budget <= 0) return "ok";
  const ratio = actual / budget;
  if (ratio > 1) return "over";
  if (ratio > 0.85) return "watch";
  return "ok";
}

const seedItems = [
  { id: 1, name: "Excavation & earthworks", budget: 185000, actual: 172000 },
  { id: 2, name: "Concrete & foundations", budget: 420000, actual: 448000 },
  { id: 3, name: "Structural steel", budget: 310000, actual: 298000 },
  { id: 4, name: "Roofing", budget: 165000, actual: 149500 },
  { id: 5, name: "Electrical rough-in", budget: 140000, actual: 134800 },
  { id: 6, name: "Plumbing rough-in", budget: 118000, actual: 126000 },
];

// Single-project scope for now — swap for real per-user project IDs once auth is added
const PROJECT_ID = "default";

export default function SiteMargin() {
  const [projectName, setProjectName] = useState("Fernwood Residence — Phase 2");
  const [items, setItems] = useState(seedItems);
  const [newName, setNewName] = useState("");
  const [newBudget, setNewBudget] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editActual, setEditActual] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const saveTimer = useRef(null);

  // Load saved project on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("projects")
          .select("project_name, items")
          .eq("id", PROJECT_ID)
          .maybeSingle();

        if (!cancelled && !error && data) {
          if (data.project_name) setProjectName(data.project_name);
          if (Array.isArray(data.items)) setItems(data.items);
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

  // Debounced autosave whenever project data changes (after initial load)
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
  }, [projectName, items, loaded]);

  const totals = useMemo(() => {
    const budget = items.reduce((s, i) => s + Number(i.budget || 0), 0);
    const actual = items.reduce((s, i) => s + Number(i.actual || 0), 0);
    return { budget, actual, variance: actual - budget, pct: budget ? ((actual - budget) / budget) * 100 : 0 };
  }, [items]);

  const overCount = items.filter((i) => statusFor(i.budget, i.actual) === "over").length;
  const watchCount = items.filter((i) => statusFor(i.budget, i.actual) === "watch").length;

  function addItem() {
    if (!newName.trim() || !newBudget) return;
    setItems([...items, { id: Date.now(), name: newName.trim(), budget: Number(newBudget), actual: 0 }]);
    setNewName("");
    setNewBudget("");
  }

  function removeItem(id) {
    setItems(items.filter((i) => i.id !== id));
  }

  function startEdit(item) {
    setEditingId(item.id);
    setEditActual(String(item.actual));
  }

  function saveEdit(id) {
    setItems(items.map((i) => (i.id === id ? { ...i, actual: Number(editActual) || 0 } : i)));
    setEditingId(null);
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
        input:focus { outline: 2px solid #E8622C; outline-offset: 1px; }
        button:focus-visible { outline: 2px solid #E8622C; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>

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
            <span style={styles.tbLabel}>REV</span>
            <span style={styles.tbValue}>A</span>
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

      <div style={styles.summaryStrip}>
        <SummaryCard label="Budget" value={fmt(totals.budget)} />
        <SummaryCard label="Actual spend" value={fmt(totals.actual)} />
        <SummaryCard
          label="Variance"
          value={`${totals.variance >= 0 ? "+" : ""}${fmt(totals.variance)}`}
          accent={totals.variance > 0 ? "#E8622C" : "#4C8C6B"}
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

      <div style={styles.ledger}>
        <div style={styles.ledgerHeaderRow}>
          <span style={{ ...styles.thCell, flex: 3 }}>Line item</span>
          <span style={{ ...styles.thCell, flex: 1.4, textAlign: "right" }}>Budget</span>
          <span style={{ ...styles.thCell, flex: 1.4, textAlign: "right" }}>Actual</span>
          <span style={{ ...styles.thCell, flex: 2 }}>Tolerance</span>
          <span style={{ ...styles.thCell, flex: 1, textAlign: "center" }}>Status</span>
          <span style={{ ...styles.thCell, flex: 0.6 }}></span>
        </div>

        {items.map((item) => {
          const status = statusFor(item.budget, item.actual);
          const s = STATUS[status];
          const ratio = item.budget ? Math.min(item.actual / item.budget, 1.4) : 0;
          const pctLabel = item.budget ? (((item.actual - item.budget) / item.budget) * 100).toFixed(1) : "0.0";

          return (
            <div key={item.id} style={styles.row}>
              <span style={{ ...styles.tdCell, flex: 3, fontFamily: "'Inter', sans-serif", fontWeight: 500 }}>
                {item.name}
              </span>
              <span style={{ ...styles.tdCell, flex: 1.4, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                {fmt(item.budget)}
              </span>
              <span style={{ ...styles.tdCell, flex: 1.4, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                {editingId === item.id ? (
                  <input
                    autoFocus
                    style={styles.inlineInput}
                    value={editActual}
                    onChange={(e) => setEditActual(e.target.value)}
                    onBlur={() => saveEdit(item.id)}
                    onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id)}
                    type="number"
                  />
                ) : (
                  <button style={styles.actualButton} onClick={() => startEdit(item)} aria-label={`Edit actual spend for ${item.name}`}>
                    {fmt(item.actual)}
                  </button>
                )}
              </span>
              <span style={{ ...styles.tdCell, flex: 2 }}>
                <div style={styles.gaugeTrack}>
                  <div style={styles.gaugeTolMark} />
                  <div
                    style={{
                      ...styles.gaugeFill,
                      width: `${Math.min(ratio * 71.4, 100)}%`,
                      background: s.color,
                    }}
                  />
                </div>
                <span style={{ ...styles.gaugeLabel, color: s.color }}>
                  {pctLabel > 0 ? "+" : ""}
                  {pctLabel}%
                </span>
              </span>
              <span style={{ ...styles.tdCell, flex: 1, textAlign: "center" }}>
                <span style={{ ...styles.statusPill, color: s.color, background: s.bg }}>{s.label}</span>
              </span>
              <span style={{ ...styles.tdCell, flex: 0.6, textAlign: "right" }}>
                <button style={styles.removeBtn} onClick={() => removeItem(item.id)} aria-label={`Remove ${item.name}`}>
                  ✕
                </button>
              </span>
            </div>
          );
        })}

        <div style={styles.addRow}>
          <input
            style={{ ...styles.addInput, flex: 3 }}
            placeholder="New line item (e.g. Drywall & finishes)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            style={{ ...styles.addInput, flex: 1.4, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}
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

      <div style={styles.footer}>
        Click any "Actual" figure to log spend. Tolerance gauge flags amber past 85% of budget, orange once over.
        Your data saves automatically to Supabase.{" "}
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
    maxWidth: 1040,
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
  tbValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, color: "#F2EDE4" },

  summaryStrip: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
    maxWidth: 1040,
    margin: "0 auto 16px",
  },
  summaryCard: {
    background: "#232E3B",
    border: "1px solid #3D5468",
    borderRadius: 4,
    padding: "14px 16px",
  },
  summaryLabel: { fontSize: 11, letterSpacing: "0.08em", color: "#7C93A6", marginBottom: 6, textTransform: "uppercase" },
  summaryValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 20, fontWeight: 600 },

  warningBanner: {
    maxWidth: 1040,
    margin: "0 auto 16px",
    background: "rgba(232,98,44,0.1)",
    border: "1px solid #E8622C",
    borderRadius: 4,
    padding: "12px 16px",
    fontSize: 14,
    color: "#F2C6B0",
  },

  ledger: { maxWidth: 1040, margin: "0 auto", background: "#20293480", borderRadius: 4, overflow: "hidden" },
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
    maxWidth: 1040,
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