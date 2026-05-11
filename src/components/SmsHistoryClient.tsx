"use client";

import { useState } from "react";

const statusSv: Record<string, string> = {
  sent:      "Skickat",
  delivered: "Levererat",
  dry_run:   "Testläge",
  failed:    "Misslyckades",
  skipped:   "Hoppades över",
};

function chipColor(status: string): { dot: string; text: string; bg: string; border: string } {
  if (status === "delivered") return { dot: "#5bbfb5", text: "#1a6b5c", bg: "#edf7f6", border: "#b8e8e5" };
  if (status === "sent")      return { dot: "#3da89d", text: "#2a7a68", bg: "#edf7f6", border: "#b8e8e5" };
  if (status === "dry_run")   return { dot: "#4a8ab5", text: "#1a4f78", bg: "#edf3fa", border: "#c8dced" };
  if (status === "failed")    return { dot: "#c94040", text: "#8b2020", bg: "#fdf0f0", border: "#f0d0d0" };
  if (status === "skipped")   return { dot: "#8fa8a0", text: "#4a5a56", bg: "#f6f8f7", border: "#e4e9e7" };
  return { dot: "#8fa8a0", text: "#4a5a56", bg: "#f6f8f7", border: "#e4e9e7" };
}

function cardAccent(row: PatientRow): string {
  if (row.failedCount > 0 && row.sentCount === 0) return "#c94040";
  if (row.failedCount > 0) return "#e08040";
  if (row.sentCount > 0)   return "#5bbfb5";
  return "#c8d4d0";
}

function formatTs(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

export type LogRow = {
  id: string;
  status: string;
  sequence_number: number | null;
  message: string;
  error: string | null;
  sent_at: string | null;
  created_at: string;
};

export type PatientRow = {
  patientId: string;
  name: string;
  phone: string | null;
  doNotContact: boolean;
  logs: LogRow[];
  sentCount: number;
  failedCount: number;
  lastActivity: string;
};

export type Tab = "all" | "failed" | "sent";

// ── Trash icon ────────────────────────────────────────────────────────────────
function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3.5h9M5 3.5V2.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M10.5 3.5l-.7 7a.5.5 0 0 1-.5.5H3.7a.5.5 0 0 1-.5-.5l-.7-7"/>
    </svg>
  );
}

// ── SMS message popup ─────────────────────────────────────────────────────────
function SmsPopup({ log, onClose }: { log: LogRow; onClose: () => void }) {
  const colors = chipColor(log.status);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          padding: "24px 28px",
          maxWidth: 480,
          width: "90%",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: colors.dot, flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: colors.text }}>
              {log.sequence_number ? `SMS ${log.sequence_number}` : log.status}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
              {formatTs(log.sent_at ?? log.created_at)}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--text-muted)", lineHeight: 1, padding: "0 4px" }}
          >
            ×
          </button>
        </div>

        <div style={{
          background: "var(--surface-sub)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "14px 16px",
          fontSize: 13.5,
          color: "var(--text)",
          lineHeight: 1.65,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}>
          {log.message || <span style={{ color: "var(--text-faint)" }}>Inget meddelandeinnehåll</span>}
        </div>

        {log.status === "failed" && log.error && (
          <div style={{ fontSize: 12, color: "var(--red)", background: "var(--red-bg, #fdf0f0)", border: "1px solid var(--red-border, #f0d0d0)", borderRadius: "var(--radius-sm)", padding: "8px 12px" }}>
            Fel: {log.error}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Log chip ──────────────────────────────────────────────────────────────────
function LogChip({ log, onDeleted }: { log: LogRow; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const colors = chipColor(log.status);

  const label = log.sequence_number
    ? `SMS ${log.sequence_number}${log.status === "delivered" ? " ✓" : log.status === "failed" ? " ✗" : ""}`
    : (statusSv[log.status] ?? log.status);

  async function del() {
    setDeleting(true);
    const res = await fetch(`/api/logs/${log.id}`, { method: "DELETE" });
    if (res.ok) onDeleted();
    else setDeleting(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {showPopup && <SmsPopup log={log} onClose={() => setShowPopup(false)} />}
      <div
        onClick={() => setShowPopup(true)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: colors.bg, border: `1px solid ${colors.border}`,
          borderRadius: 20, padding: "3px 8px 3px 6px",
          maxWidth: "fit-content",
          cursor: "pointer",
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: colors.dot, flexShrink: 0 }} />
        <span style={{ fontSize: 11.5, fontWeight: 600, color: colors.text, whiteSpace: "nowrap" }}>
          {label}
        </span>
        <span style={{ fontSize: 10.5, color: "#a8bdb8", whiteSpace: "nowrap" }}>
          {formatTs(log.sent_at ?? log.created_at)}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); del(); }}
          disabled={deleting}
          title="Ta bort"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "#c8d4d0", padding: 0, lineHeight: 1, display: "flex",
            opacity: deleting ? 0.3 : 1, marginLeft: 2,
          }}
        >
          ×
        </button>
      </div>
      {log.status === "failed" && log.error && (
        <div style={{ fontSize: 11, color: "#8b2020", paddingLeft: 6, lineHeight: 1.4, maxWidth: 320 }}>
          {log.error}
        </div>
      )}
    </div>
  );
}

// ── Patient card ──────────────────────────────────────────────────────────────
function PatientCard({
  row,
  onLogDeleted,
  onPatientCleared,
}: {
  row: PatientRow;
  onLogDeleted: (patientId: string, logId: string) => void;
  onPatientCleared: (patientId: string) => void;
}) {
  const [clearing, setClearing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const accent = cardAccent(row);
  const visible = expanded ? row.logs : row.logs.slice(0, 3);

  async function clearPatient() {
    setClearing(true);
    const res = await fetch(`/api/logs?patientId=${row.patientId}`, { method: "DELETE" });
    if (res.ok) onPatientCleared(row.patientId);
    setClearing(false);
  }

  return (
    <div style={{
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius)",
      borderLeft: `3px solid ${accent}`,
      boxShadow: "0 1px 4px rgba(7,59,44,0.06)",
      padding: "16px 20px",
      display: "grid",
      gridTemplateColumns: "200px 140px 1fr auto",
      gap: "0 20px",
      alignItems: "start",
      transition: "box-shadow 150ms",
    }}
    onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 3px 12px rgba(7,59,44,0.1)")}
    onMouseLeave={e => (e.currentTarget.style.boxShadow = "0 1px 4px rgba(7,59,44,0.06)")}
    >
      {/* Name col */}
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", lineHeight: 1.3 }}>
          {row.name}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 2 }}>
          {row.phone ?? "—"}
        </div>
        <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
          {row.doNotContact && (
            <span className="badge ignored" style={{ fontSize: 10 }}>Kontakta ej</span>
          )}
          {row.sentCount > 0 && (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#2a7a68", letterSpacing: "0.02em" }}>
              {row.sentCount} skickat{row.sentCount !== 1 ? "e" : ""}
            </span>
          )}
          {row.failedCount > 0 && (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#8b2020", letterSpacing: "0.02em" }}>
              {row.failedCount} misslyckade
            </span>
          )}
        </div>
      </div>

      {/* Date col */}
      <div style={{ fontSize: 12, color: "var(--text-muted)", paddingTop: 2 }}>
        {formatTs(row.lastActivity)}
      </div>

      {/* History col */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {visible.map((log) => (
          <LogChip
            key={log.id}
            log={log}
            onDeleted={() => onLogDeleted(row.patientId, log.id)}
          />
        ))}
        {row.logs.length > 3 && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 11.5, color: "var(--accent)", padding: 0,
              textAlign: "left", fontWeight: 700, width: "fit-content",
            }}
          >
            {expanded ? "Visa färre ↑" : `+${row.logs.length - 3} till`}
          </button>
        )}
      </div>

      {/* Actions col */}
      <div style={{ paddingTop: 1 }}>
        <button
          onClick={clearPatient}
          disabled={clearing}
          title="Rensa historik för denna patient"
          style={{
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-faint)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            padding: "5px 9px",
            opacity: clearing ? 0.4 : 1,
            transition: "border-color 140ms, color 140ms",
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--red-border)";
            (e.currentTarget as HTMLButtonElement).style.color = "var(--red)";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-faint)";
          }}
        >
          <TrashIcon />
          {clearing ? "…" : "Rensa"}
        </button>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export function SmsHistoryClient({ initialRows }: { initialRows: PatientRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [tab, setTab] = useState<Tab>("all");
  const [clearingAll, setClearingAll] = useState(false);

  function recount(logs: LogRow[]) {
    return {
      sentCount:    logs.filter(l => l.status === "sent" || l.status === "delivered").length,
      failedCount:  logs.filter(l => l.status === "failed").length,
      lastActivity: logs[0]?.created_at ?? "",
    };
  }

  function handleLogDeleted(patientId: string, logId: string) {
    setRows(prev =>
      prev
        .map(r => {
          if (r.patientId !== patientId) return r;
          const logs = r.logs.filter(l => l.id !== logId);
          return { ...r, logs, ...recount(logs) };
        })
        .filter(r => r.logs.length > 0)
    );
  }

  function handlePatientCleared(patientId: string) {
    setRows(prev => prev.filter(r => r.patientId !== patientId));
  }

  async function clearAll() {
    if (!confirm("Är du säker? All SMS-historik raderas permanent.")) return;
    setClearingAll(true);
    const res = await fetch("/api/logs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    if (res.ok) setRows([]);
    setClearingAll(false);
  }

  const totalAll    = rows.length;
  const totalFailed = rows.filter(r => r.failedCount > 0).length;
  const totalSent   = rows.filter(r => r.sentCount > 0).length;

  const filtered = rows.filter(r => {
    if (tab === "failed") return r.failedCount > 0;
    if (tab === "sent")   return r.sentCount > 0;
    return true;
  });

  return (
    <>
      {/* Controls bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>

        {/* Segmented tabs */}
        <div style={{
          display: "inline-flex",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 3,
          gap: 2,
        }}>
          {([
            ["all",    `Alla`,         totalAll,    "var(--text)"],
            ["failed", `Misslyckade`,  totalFailed, "var(--red)"],
            ["sent",   `Skickade`,     totalSent,   "var(--accent)"],
          ] as [Tab, string, number, string][]).map(([t, label, count, countColor]) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                background: tab === t ? "var(--surface-sub)" : "transparent",
                border: tab === t ? "1px solid var(--border)" : "1px solid transparent",
                borderRadius: "var(--radius-sm)",
                color: tab === t ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: tab === t ? 600 : 500,
                padding: "5px 14px",
                display: "flex",
                alignItems: "center",
                gap: 6,
                transition: "all 120ms",
                minHeight: "unset",
              }}
            >
              {label}
              <span style={{
                fontSize: 11,
                fontWeight: 700,
                color: tab === t ? countColor : "var(--text-faint)",
                background: tab === t ? "transparent" : "none",
                minWidth: 16,
                textAlign: "center",
              }}>
                {count}
              </span>
            </button>
          ))}
        </div>

        {/* Clear all — outlined danger */}
        <button
          className="danger"
          onClick={clearAll}
          disabled={clearingAll || rows.length === 0}
          style={{ fontSize: 12, padding: "5px 14px", minHeight: "unset", display: "flex", alignItems: "center", gap: 6 }}
        >
          <TrashIcon />
          {clearingAll ? "Rensar…" : "Rensa all historik"}
        </button>
      </div>

      {/* Card list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map(row => (
          <PatientCard
            key={row.patientId}
            row={row}
            onLogDeleted={handleLogDeleted}
            onPatientCleared={handlePatientCleared}
          />
        ))}
        {filtered.length === 0 && (
          <div style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "40px 24px",
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 13.5,
          }}>
            Inga poster matchar det valda filtret.
          </div>
        )}
      </div>
    </>
  );
}
