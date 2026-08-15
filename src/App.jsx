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
      else if (ch === "," && !inQuotes) {
        cells.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };

  const header = splitRow(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z%]/g, ""));
  const findCol = (...aliases) => {
    for (const a of aliases) {
      const idx = header.indexOf(a);
      if (idx !== -1) return idx;
    }
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
      name,
      category,
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

export default function SiteMargin() {
  const [route, setRoute] = useState({ page: "dashboard", projectId: null });

  return route.page === "dashboard" ? (
    <Dashboard onOpen={(id) => setRoute({ page: "project", projectId: id })} />
  ) : (
    <ProjectView projectId={route.projectId} onBack={() => setRoute({ page: "dashboard", projectId: null })} />
  );
}

/* ============================== DASHBOARD ============================== */

function Dashboard({ onOpen }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  async function loadProjects() {
    setLoading(true);
    const { data: projs, error } = await supabase.from("projects_v2").select("*").order("created_at", { ascending: false });
    if (error || !projs) {
      setProjects([]);
      setLoading(false);
      return;
    }
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

  useEffect(() => {
    loadProjects();
  }, []);

  async function createProject() {
    if (!newName.trim() || creating) return;
    setCreating(true);
    const { data, error } = await supabase
      .from("projects_v2")
      .insert({ name: newName.trim() })
      .select()
      .single();
    setCreating(false);
    if (!error && data) {
      setNewName("");
      onOpen(data.id);
    }
  }

  async function deleteProject(id, name) {
    if (!window.confirm(`Delete "${name}"? This removes all its line items, change orders, and history permanently.`)) return;
    await supabase.from("projects_v2").delete().eq("id", id);
    loadProjects();
  }

  return (
    <div style={styles.page}>
      <GlobalStyles />
      <div style={styles.dashHeader}>
        <div>
          <div style={styles.eyebrow}>SITEMARGIN</div>
          <h1 style={styles.dashTitle}>Your projects</h1>
        </div>
      </div>

      <div style={styles.newProjectRow}>
        <input
          style={styles.addInput}
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
        <div style={{ ...styles.footer, textAlign: "center", padding: 40 }}>
          No projects yet — create your first one above.
        </div>
      ) : (
        <div style={styles.projectGrid}>
          {projects.map((p) => {
            const pct = p.budget ? (p.variance / p.budget) * 100 : 0;
            const color = p.variance > 0 ? "#E8622C" : "#4C8C6B";
            return (
              <div key={p.id} style={styles.projectCard} onClick={() => onOpen(p.id)}>
                <div style={styles.projectCardTop}>
                  <div style={styles.projectName}>{p.name}</div>
                  <button
                    style={styles.deleteProjectBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteProject(p.id, p.name);
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div style={styles.projectNums}>
                  <span>{fmt(p.budget)} budget</span>
                  <span style={{ color, fontWeight: 600 }}>
                    {p.variance >= 0 ? "+" : ""}
                    {fmt(p.variance)} ({pct >= 0 ? "+" : ""}
                    {pct.toFixed(1)}%)
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

/* ============================== PROJECT VIEW ============================== */

function ProjectView({ projectId, onBack }) {
  const [project, setProject] = useState(null);
  const [items, setItems] = useState([]);
  const [changeOrders, setChangeOrders] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("ledger"); // ledger | payments | changeorders | trend
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState(CATEGORIES[0]);
  const [newBudget, setNewBudget] = useState("");
  const [editingCell, setEditingCell] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [expandedNotes, setExpandedNotes] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [importMessage, setImportMessage] = useState(null);
  const [coDesc, setCoDesc] = useState("");
  const [coAmount, setCoAmount] = useState("");
  const fileInputRef = useRef(null);
  const attachInputRef = useRef(null);
  const attachTargetItem = useRef(null);
  const saveTimers = useRef({});

  async function loadAll() {
    const { data: proj } = await supabase.from("projects_v2").select("*").eq("id", projectId).single();
    const { data: lineItems } = await supabase
      .from("line_items")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    const { data: cos } = await supabase
      .from("change_orders")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    const { data: snaps } = await supabase
      .from("snapshots")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    setProject(proj);
    setItems(lineItems || []);
    setChangeOrders(cos || []);
    setSnapshots(snaps || []);
    setLoaded(true);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
    const paidToDate = certified - retentionHeld;
    const uncertified = claimed - certified;
    return {
      budget,
      revisedBudget,
      actual,
      variance: actual - revisedBudget,
      pct: revisedBudget ? ((actual - revisedBudget) / revisedBudget) * 100 : 0,
      claimed,
      certified,
      retentionHeld,
      paidToDate,
      uncertified,
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
      const budget = catItems.reduce((s, i) => s + Number(i.budget || 0), 0);
      const actual = catItems.reduce((s, i) => s + Number(i.actual || 0), 0);
      return { category: cat, budget, actual, variance: actual - budget, count: catItems.length };
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
      .insert({
        project_id: projectId,
        name: newName.trim(),
        category: newCategory,
        budget: Number(newBudget),
      })
      .select()
      .single();
    if (!error && data) {
      setItems((prev) => [...prev, data]);
      setNewName("");
      setNewBudget("");
    }
  }

  async function removeItem(id) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    await supabase.from("line_items").delete().eq("id", id);
  }

  function startEdit(id, field, currentValue) {
    setEditingCell(`${id}:${field}`);
    setEditValue(String(currentValue ?? ""));
  }

  function saveEdit(id, field) {
    scheduleSave(id, { [field]: Number(editValue) || 0 });
    setEditingCell(null);
  }

  function openNotes(item) {
    setExpandedNotes(item.id);
    setNoteDraft(item.notes || "");
  }

  function saveNote(id) {
    scheduleSave(id, { notes: noteDraft });
    setExpandedNotes(null);
  }

  function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const { items: parsed, error } = parseCsvToItems(evt.target.result);
      if (error) {
        setImportMessage({ type: "error", text: error });
      } else {
        const rows = parsed.map((p) => ({ ...p, project_id: projectId }));
        const { data, error: insertErr } = await supabase.from("line_items").insert(rows).select();
        if (insertErr) {
          setImportMessage({ type: "error", text: "Import failed — please try again." });
        } else {
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
    a.href = url;
    a.download = "sitemargin-budget-template.csv";
    a.click();
    URL.revokeObjectURL(url);
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
      .select()
      .single();
    if (!error && data) {
      setChangeOrders((prev) => [data, ...prev]);
      setCoDesc("");
      setCoAmount("");
    }
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
      .select()
      .single();
    if (!error && data) setSnapshots((prev) => [...prev, data]);
  }

  function exportPdf() {
    window.print();
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
        <button style={styles.backBtn} onClick={onBack}>
          ← All projects
        </button>
        <button style={styles.exportBtn} onClick={exportPdf}>
          Export PDF
        </button>
      </div>

      {/* Title block */}
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
              <input
                type="number"
                value={totals.retentionPct}
                onChange={(e) => {
                  const v = Number(e.target.value) || 0;
                  setProject((p) => ({ ...p, retention_pct: v }));
                  supabase.from("projects_v2").update({ retention_pct: v }).eq("id", projectId);
                }}
                style={styles.retentionInput}
              />
              %
            </span>
          </div>
          <div style={styles.tbCell}>
            <span style={styles.tbLabel}>LINES</span>
            <span style={styles.tbValue}>{items.length}</span>
          </div>
        </div>
      </div>

      {/* Summary strip */}
      <div style={styles.summaryStrip}>
        <SummaryCard label="Original budget" value={fmt(totals.budget)} />
        {approvedCoTotal !== 0 && (
          <SummaryCard label="Revised budget" value={fmt(totals.revisedBudget)} accent="#D9A441" />
        )}
        <SummaryCard label="Actual spend" value={fmt(totals.actual)} />
        <SummaryCard
          label="Variance"
          value={`${totals.variance >= 0 ? "+" : ""}${fmt(totals.variance)}`}
          accent={totals.variance > 0 ? "#E8622C" : "#4C8C6B"}
        />
        <SummaryCard label="Retention held" value={fmt(totals.retentionHeld)} />
        <SummaryCard
          label="Flagged lines"
          value={`${overCount} over · ${watchCount} watch`}
          accent={overCount ? "#E8622C" : watchCount ? "#D9A441" : "#4C8C6B"}
        />
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

      {/* Category rollup */}
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
                {c.variance >= 0 ? "+" : ""}
                {fmt(c.variance)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Import row */}
      <div className="no-print" style={styles.importRow}>
        <button style={styles.importBtn} onClick={() => fileInputRef.current?.click()}>
          Import budget CSV
        </button>
        <button style={styles.templateLink} onClick={downloadTemplate}>
          Download template
        </button>
        {importMessage && (
          <span style={{ fontSize: 12.5, color: importMessage.type === "error" ? "#E8622C" : "#4C8C6B" }}>{importMessage.text}</span>
        )}
      </div>

      {/* View toggle */}
      <div className="no-print" style={styles.viewToggle}>
        {[
          ["ledger", "Cost & Progress"],
          ["payments", "Payments & Retention"],
          ["changeorders", `Change Orders${changeOrders.length ? ` (${changeOrders.length})` : ""}`],
          ["trend", "Trend"],
        ].map(([key, label]) => (
          <button
            key={key}
            style={{ ...styles.toggleBtn, ...(view === key ? styles.toggleBtnActive : {}) }}
            onClick={() => setView(key)}
          >
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
            <span style={{ ...styles.thCell, flex: 1.6 }} className="no-print">Tolerance</span>
            <span style={{ ...styles.thCell, flex: 1.4 }} className="no-print">Progress vs spend</span>
            <span style={{ ...styles.thCell, flex: 0.9, textAlign: "center" }}>Status</span>
            <span style={{ ...styles.thCell, flex: 0.8 }} className="no-print"></span>
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
            const isNotesOpen = expandedNotes === item.id;

            return (
              <React.Fragment key={item.id}>
                <div style={styles.row}>
                  <span style={{ ...styles.tdCell, flex: 2.4 }}>
                    <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500 }}>{item.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: CATEGORY_COLOR[item.category] || "#7C93A6" }} />
                        <span style={{ fontSize: 11, color: "#8FA2B3" }}>{item.category || "Other"}</span>
                      </span>
                      <button className="no-print" style={styles.miniLink} onClick={() => (isNotesOpen ? setExpandedNotes(null) : openNotes(item))}>
                        {item.notes ? "Notes ✓" : "Add note"}
                      </button>
                      <button className="no-print" style={styles.miniLink} onClick={() => triggerAttach(item)}>
                        {item.attachments?.length ? `Files (${item.attachments.length})` : "Attach"}
                      </button>
                    </div>
                  </span>
                  <span style={{ ...styles.tdCell, flex: 1.1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(item.budget)}</span>
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
                      <button className="no-print-inline" style={styles.actualButton} onClick={() => startEdit(item.id, "actual", item.actual)}>
                        {fmt(item.actual)}
                      </button>
                    )}
                  </span>
                  <span style={{ ...styles.tdCell, flex: 1.6 }} className="no-print">
                    <div style={styles.gaugeTrack}>
                      <div style={styles.gaugeTolMark} />
                      <div style={{ ...styles.gaugeFill, width: `${Math.min(ratio * 71.4, 100)}%`, background: s.color }} />
                    </div>
                    <span style={{ ...styles.gaugeLabel, color: s.color }}>
                      {pctLabel > 0 ? "+" : ""}
                      {pctLabel}%
                    </span>
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
                    <div style={{ marginTop: 3 }}>
                      {editingCell === `${item.id}:percent_complete` ? (
                        <input
                          autoFocus
                          style={styles.inlineInputSmall}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => saveEdit(item.id, "percent_complete")}
                          onKeyDown={(e) => e.key === "Enter" && saveEdit(item.id, "percent_complete")}
                          type="number"
                          placeholder="% complete"
                        />
                      ) : (
                        <button style={styles.editProgressLink} onClick={() => startEdit(item.id, "percent_complete", item.percent_complete)}>
                          Set % complete
                        </button>
                      )}
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
                  <span style={{ ...styles.tdCell, flex: 0.8, textAlign: "right" }} className="no-print">
                    <button style={styles.removeBtn} onClick={() => removeItem(item.id)}>
                      ✕
                    </button>
                  </span>
                </div>
                {isNotesOpen && (
                  <div className="no-print" style={styles.notesPanel}>
                    <textarea
                      autoFocus
                      style={styles.notesTextarea}
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder="Why is this over/under? e.g. supplier price increase in March, or scope reduced on site."
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      <button style={styles.addBtn} onClick={() => saveNote(item.id)}>
                        Save note
                      </button>
                      <button style={styles.templateLink} onClick={() => setExpandedNotes(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {item.attachments?.length > 0 && (
                  <div style={styles.attachmentsRow}>
                    {item.attachments.map((a, idx) => (
                      <a key={idx} href={a.url} target="_blank" rel="noreferrer" style={styles.attachmentLink}>
                        📎 {a.name}
                      </a>
                    ))}
                  </div>
                )}
              </React.Fragment>
            );
          })}

          <div className="no-print" style={styles.addRow}>
            <input style={{ ...styles.addInput, flex: 2 }} placeholder="New line item" value={newName} onChange={(e) => setNewName(e.target.value)} />
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
            const paid = certified - retentionHeld;
            const uncertified = claimed - certified;
            return (
              <div key={item.id} style={styles.row}>
                <span style={{ ...styles.tdCell, flex: 2.4, fontFamily: "'Inter', sans-serif", fontWeight: 500 }}>{item.name}</span>
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
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#D9A441" }}>{fmt(retentionHeld)}</span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#4C8C6B" }}>{fmt(paid)}</span>
                <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: uncertified > 0 ? "#E8622C" : "#7C93A6" }}>
                  {fmt(uncertified)}
                </span>
              </div>
            );
          })}
          <div style={{ ...styles.row, background: "#1A222C", fontWeight: 600 }}>
            <span style={{ ...styles.tdCell, flex: 2.4 }}>Totals</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(totals.claimed)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(totals.certified)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#D9A441" }}>{fmt(totals.retentionHeld)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: "#4C8C6B" }}>{fmt(totals.paidToDate)}</span>
            <span style={{ ...styles.tdCell, flex: 1.2, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: totals.uncertified > 0 ? "#E8622C" : "#7C93A6" }}>
              {fmt(totals.uncertified)}
            </span>
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
                <select
                  value={co.status}
                  onChange={(e) => setCoStatus(co.id, e.target.value)}
                  style={{
                    ...styles.addInput,
                    padding: "4px 8px",
                    fontSize: 12,
                    color: co.status === "approved" ? "#4C8C6B" : co.status === "rejected" ? "#E8622C" : "#D9A441",
                  }}
                >
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </span>
              <span style={{ ...styles.tdCell, flex: 0.6, textAlign: "right" }}>
                <button style={styles.removeBtn} onClick={() => removeChangeOrder(co.id)}>
                  ✕
                </button>
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
            <input
              style={{ ...styles.addInput, flex: 1, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}
              placeholder="Amount"
              type="number"
              value={coAmount}
              onChange={(e) => setCoAmount(e.target.value)}
            />
            <button style={styles.addBtn} onClick={addChangeOrder}>
              + Add change order
            </button>
          </div>
        </div>
      )}

      {view === "trend" && (
        <div className="no-print" style={styles.ledger}>
          <div style={{ padding: 20 }}>
            <button style={styles.addBtn} onClick={logSnapshot}>
              + Log snapshot now
            </button>
            <p style={{ fontSize: 12.5, color: "#7C93A6", marginTop: 10 }}>
              Click this weekly (or before each client meeting) to record where budget vs actual stand right now. Over time this builds a trend
              you can point to instead of a single snapshot.
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
                    <span
                      style={{
                        fontSize: 12,
                        fontFamily: "'IBM Plex Mono', monospace",
                        color: s.variance > 0 ? "#E8622C" : "#4C8C6B",
                        fontWeight: 600,
                      }}
                    >
                      {s.variance >= 0 ? "+" : ""}
                      {fmt(s.variance)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="no-print" style={styles.footer}>
        Click Actual to log spend. Notes and attachments sit inline per line item. Retention rate top-right applies to the Payments view.
      </div>
    </div>
  );
}

function TrendChart({ snapshots }) {
  const width = 100;
  const height = 30;
  const values = snapshots.map((s) => s.variance);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const points = snapshots
    .map((s, i) => {
      const x = (i / Math.max(snapshots.length - 1, 1)) * width;
      const y = height - ((s.variance - min) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");
  const zeroY = height - ((0 - min) / range) * height;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: 80, display: "block" }} preserveAspectRatio="none">
      <line x1="0" y1={zeroY} x2={width} y2={zeroY} stroke="#3D5468" strokeWidth="0.5" strokeDasharray="1,1" />
      <polyline points={points} fill="none" stroke="#E8622C" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
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

  dashHeader: { maxWidth: 1180, margin: "0 auto 20px" },
  dashTitle: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 34, fontWeight: 600, marginTop: 4 },
  newProjectRow: { maxWidth: 1180, margin: "0 auto 24px", display: "flex", gap: 10 },
  projectGrid: { maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 },
  projectCard: { background: "#232E3B", border: "1px solid #3D5468", borderRadius: 4, padding: "18px 20px", cursor: "pointer" },
  projectCardTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 },
  projectName: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 600 },
  deleteProjectBtn: { background: "none", border: "none", color: "#7C93A6", cursor: "pointer", fontSize: 14 },
  projectNums: { display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", color: "#C7D2DC" },
  projectMeta: { fontSize: 12, color: "#7C93A6", marginTop: 8 },

  backRow: { maxWidth: 1180, margin: "0 auto 12px", display: "flex", justifyContent: "space-between" },
  backBtn: { background: "none", border: "none", color: "#8FA2B3", fontSize: 13, cursor: "pointer" },
  exportBtn: { background: "#232E3B", border: "1px solid #3D5468", borderRadius: 3, color: "#F2EDE4", fontSize: 13, fontWeight: 500, padding: "8px 16px", cursor: "pointer" },

  titleBlock: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 16, borderBottom: "2px solid #3D5468", paddingBottom: 14, marginBottom: 20, maxWidth: 1180, margin: "0 auto 20px" },
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

  importRow: { maxWidth: 1180, margin: "0 auto 14px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" },
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
  inlineInputSmall: { width: "100%", background: "#101820", border: "1px solid #E8622C", borderRadius: 3, color: "#F2EDE4", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, padding: "2px 6px" },
  editProgressLink: { background: "none", border: "none", color: "#7C93A6", fontSize: 10, textDecoration: "underline", cursor: "pointer", padding: 0 },
  miniLink: { background: "none", border: "none", color: "#7C93A6", fontSize: 10.5, textDecoration: "underline", cursor: "pointer", padding: 0 },
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

  notesPanel: { maxWidth: 1180, margin: "0 auto", background: "#1A222C", padding: "12px 14px", borderBottom: "1px solid #2A3644" },
  notesTextarea: { width: "100%", minHeight: 60, background: "#101820", border: "1px solid #3D5468", borderRadius: 3, color: "#F2EDE4", fontSize: 13, padding: "8px 10px", fontFamily: "'Inter', sans-serif", resize: "vertical" },
  attachmentsRow: { maxWidth: 1180, margin: "0 auto", padding: "0 14px 10px", display: "flex", gap: 10, flexWrap: "wrap" },
  attachmentLink: { fontSize: 12, color: "#7BA6D9", textDecoration: "none" },

  trendRow: { display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #2A3644" },
};
