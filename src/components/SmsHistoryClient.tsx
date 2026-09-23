"use client";

import { useState, useCallback } from "react";
import { useToast } from "@/components/ToastProvider";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconMessage, IconSearch, IconSend, IconTrash, IconX } from "@/components/ui/icons";
import { formatDateTime, formatRelative } from "@/components/ui/format";
import { logStatusMeta } from "@/components/ui/status";
import { isRealSend } from "@/lib/sms/outcome";
import { requestSend } from "@/lib/sms/sendClient";

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

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function accentFor(row: PatientRow): string {
  if (row.failedCount > 0 && row.sentCount === 0) return "var(--danger-dot)";
  if (row.failedCount > 0) return "var(--warn-dot)";
  if (row.sentCount > 0) return "var(--ok-dot)";
  return "var(--neutral-dot)";
}

// ── Message dialog ───────────────────────────────────────────────────────────
function MessageDialog({ open, log, onClose }: { open: boolean; log: LogRow | null; onClose: () => void }) {
  const meta = log ? logStatusMeta(log.status) : null;
  return (
    <Modal
      open={open && log !== null}
      onClose={onClose}
      size="sm"
      title={log?.sequence_number ? `SMS ${log.sequence_number}` : "SMS"}
      description={
        log && meta ? (
          <span className="row" style={{ gap: 8, marginTop: 6 }}>
            <span className={`badge sm ${meta.chip}`}>{meta.label}</span>
            <span className="tnum">{formatDateTime(log.sent_at ?? log.created_at)}</span>
          </span>
        ) : undefined
      }
      padded
    >
      {log && (
        <div style={{ display: "grid", gap: 14 }}>
          {log.message ? (
            <p className="sms-bubble">{log.message}</p>
          ) : (
            <p className="faint">Inget meddelandeinnehåll</p>
          )}
          {log.status === "failed" && log.error && (
            <div className="notice error"><span><strong>Fel:</strong> {log.error}</span></div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Log chip ─────────────────────────────────────────────────────────────────
function LogChip({ log, onOpen, onDeleted }: { log: LogRow; onOpen: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const meta = logStatusMeta(log.status);

  const label = log.sequence_number
    ? `SMS ${log.sequence_number}${log.status === "delivered" ? " ✓" : log.status === "failed" ? " ✗" : ""}`
    : meta.label;

  async function del() {
    setDeleting(true);
    const res = await fetch(`/api/logs/${log.id}`, { method: "DELETE" });
    if (res.ok) onDeleted();
    else setDeleting(false);
  }

  return (
    <div style={{ display: "grid", gap: 4, opacity: deleting ? 0.4 : 1 }}>
      <span className={`log-chip badge ${meta.chip}`}>
        <button type="button" className="reset log-chip-open" onClick={onOpen} title={`${meta.label} — visa meddelandet`}>
          <span>{label}</span>
          <span className="log-chip-time tnum">{formatRelative(log.sent_at ?? log.created_at)}</span>
        </button>
        <button
          type="button"
          className="reset log-chip-del"
          onClick={del}
          disabled={deleting}
          title="Ta bort loggpost"
          aria-label="Ta bort loggpost"
        >
          <IconX size={12} />
        </button>
      </span>
      {log.status === "failed" && log.error && (
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--danger)", paddingLeft: 8, lineHeight: 1.4, maxWidth: 340 }}>
          {log.error}
        </span>
      )}
    </div>
  );
}

// ── Patient row ──────────────────────────────────────────────────────────────
function HistoryRow({
  row,
  selected,
  onToggle,
  onOpenLog,
  onLogDeleted,
  onPatientCleared,
}: {
  row: PatientRow;
  selected: boolean;
  onToggle: () => void;
  onOpenLog: (log: LogRow) => void;
  onLogDeleted: (patientId: string, logId: string) => void;
  onPatientCleared: (patientId: string) => void;
}) {
  const [clearing, setClearing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? row.logs : row.logs.slice(0, 3);

  async function clearPatient() {
    setClearing(true);
    const res = await fetch(`/api/logs?patientId=${row.patientId}`, { method: "DELETE" });
    if (res.ok) onPatientCleared(row.patientId);
    setClearing(false);
  }

  return (
    <li className={`hist-row${selected ? " is-selected" : ""}`} style={{ ["--accent-line" as string]: accentFor(row) }}>
      <input
        type="checkbox"
        className="cb"
        checked={selected}
        onChange={onToggle}
        aria-label={`Markera ${row.name}`}
        style={{ marginTop: 10 }}
      />

      <div className="row" style={{ gap: 12, alignItems: "flex-start", minWidth: 0 }}>
        <span className="avatar" aria-hidden="true">{initials(row.name)}</span>
        <div style={{ minWidth: 0 }}>
          <p className="list-title truncate">{row.name}</p>
          <p className="list-sub tnum">{row.phone ?? "—"}</p>
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            {row.doNotContact && <span className="chip sm blocked">Kontakta ej</span>}
            {row.sentCount > 0 && (
              <span className="tag" style={{ color: "var(--ok)" }}>
                {row.sentCount} skicka{row.sentCount !== 1 ? "de" : "t"}
              </span>
            )}
            {row.failedCount > 0 && (
              <span className="tag" style={{ color: "var(--danger)" }}>{row.failedCount} misslyckade</span>
            )}
          </div>
        </div>
      </div>

      <div className="muted" style={{ paddingTop: 4 }}>
        <span className="tnum" title={formatDateTime(row.lastActivity)}>{formatRelative(row.lastActivity)}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
        {visible.map((log) => (
          <LogChip
            key={log.id}
            log={log}
            onOpen={() => onOpenLog(log)}
            onDeleted={() => onLogDeleted(row.patientId, log.id)}
          />
        ))}
        {row.logs.length > 3 && (
          <button type="button" className="reset panel-link" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Visa färre" : `+${row.logs.length - 3} till`}
          </button>
        )}
      </div>

      <button
        type="button"
        className="icon-btn bordered"
        onClick={clearPatient}
        disabled={clearing}
        title="Rensa historik för denna patient"
        aria-label={`Rensa historik för ${row.name}`}
      >
        {clearing ? <span className="spinner" aria-hidden="true" /> : <IconTrash size={14} />}
      </button>
    </li>
  );
}

type BulkState = "idle" | "sending" | "done";

// ── Main ─────────────────────────────────────────────────────────────────────
export function SmsHistoryClient({ initialRows, initialTab = "all" }: { initialRows: PatientRow[]; initialTab?: Tab }) {
  const [rows, setRows] = useState(initialRows);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [clearingAll, setClearingAll] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkState, setBulkState] = useState<BulkState>("idle");
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  // The last opened message stays set while its dialog animates closed.
  const [openLog, setOpenLog] = useState<LogRow | null>(null);
  const [messageOpen, setMessageOpen] = useState(false);
  const toast = useToast();

  function recount(logs: LogRow[]) {
    return {
      sentCount:    logs.filter(l => l.status === "sent" || l.status === "delivered").length,
      failedCount:  logs.filter(l => l.status === "failed").length,
      lastActivity: logs[0]?.created_at ?? "",
    };
  }

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setBulkState("idle");
    setBulkMsg(null);
  }, []);

  function toggleOne(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function sendToSelected() {
    if (bulkState !== "idle") return;
    const ids = [...selected];
    setBulkState("sending");
    setBulkProgress({ done: 0, total: ids.length });
    let sent = 0, failed = 0, skipped = 0, dryRun = 0;
    for (const id of ids) {
      const outcome = await requestSend({ patientId: id });
      if (isRealSend(outcome.kind)) sent++;
      else if (outcome.kind === "dry_run") dryRun++;
      else if (outcome.kind === "skipped") skipped++;
      else failed++;
      setBulkProgress(p => ({ ...p, done: p.done + 1 }));
    }
    setBulkState("done");
    const parts = [`${sent} skickade`];
    if (dryRun > 0) parts.push(`${dryRun} i testläge`);
    if (skipped > 0) parts.push(`${skipped} hoppades över`);
    if (failed > 0) parts.push(`${failed} misslyckades`);
    const msg = parts.join(", ");
    setBulkMsg(msg);
    toast.push({
      tone: failed > 0 ? "error" : skipped > 0 ? "warning" : "success",
      title: msg,
    });
    setSelected(new Set());
    setTimeout(() => { setBulkState("idle"); setBulkMsg(null); }, 4000);
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
    setClearingAll(true);
    const res = await fetch("/api/logs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    if (res.ok) setRows([]);
    setClearingAll(false);
    setConfirmClearAll(false);
  }

  const totalAll    = rows.length;
  const totalFailed = rows.filter(r => r.failedCount > 0).length;
  const totalSent   = rows.filter(r => r.sentCount > 0).length;

  const q = query.trim().toLowerCase();
  const filtered = rows.filter(r => {
    if (tab === "failed" && r.failedCount === 0) return false;
    if (tab === "sent" && r.sentCount === 0) return false;
    if (q && !r.name.toLowerCase().includes(q) && !(r.phone ?? "").toLowerCase().includes(q)) return false;
    return true;
  });

  const showBulkBar = selected.size > 0 || bulkState !== "idle";
  const pct = bulkProgress.total > 0 ? Math.round((bulkProgress.done / bulkProgress.total) * 100) : 0;

  const tabs: [Tab, string, number, string][] = [
    ["all",    "Alla",        totalAll,    "var(--neutral-dot)"],
    ["failed", "Misslyckade", totalFailed, "var(--danger-dot)"],
    ["sent",   "Skickade",    totalSent,   "var(--ok-dot)"],
  ];

  return (
    <>
      <div className="panel rise" style={{ ["--i" as string]: 1 }}>
        <div className="tabs" style={{ padding: "0 12px" }} role="tablist" aria-label="Filtrera SMS-historik">
          {tabs.map(([t, label, count, dot]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`tab${tab === t ? " active" : ""}${count === 0 && tab !== t ? " is-empty" : ""}`}
              onClick={() => setTab(t)}
            >
              {t !== "all" && <span className="tab-dot" style={{ background: dot }} />}
              {label}
              <span className="tab-count">{count}</span>
            </button>
          ))}
        </div>

        <div className="pt-toolbar">
          <div className="search">
            <span className="search-icon"><IconSearch /></span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Sök namn eller telefon…"
              aria-label="Sök i SMS-historiken"
            />
            {query && (
              <span className="search-trail">
                <button type="button" className="icon-btn sm" aria-label="Rensa sökningen" onClick={() => setQuery("")}>
                  <IconX size={14} />
                </button>
              </span>
            )}
          </div>
          <span className="pt-toolbar-meta">{filtered.length} {filtered.length === 1 ? "kund" : "kunder"}</span>
          <div className="pt-toolbar-end">
            <button
              type="button"
              className="danger sm"
              onClick={() => setConfirmClearAll(true)}
              disabled={clearingAll || rows.length === 0}
            >
              <IconTrash size={14} />
              {clearingAll ? "Rensar…" : "Rensa all historik"}
            </button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><IconMessage /></span>
            <span className="empty-title">{rows.length === 0 ? "Ingen SMS-historik ännu" : "Inga poster matchar det valda filtret"}</span>
            {rows.length > 0 && <span>Prova en annan flik eller sökning.</span>}
          </div>
        ) : (
          <ul className="hist-list">
            {filtered.map(row => (
              <HistoryRow
                key={row.patientId}
                row={row}
                selected={selected.has(row.patientId)}
                onToggle={() => toggleOne(row.patientId)}
                onOpenLog={(log) => { setOpenLog(log); setMessageOpen(true); }}
                onLogDeleted={handleLogDeleted}
                onPatientCleared={handlePatientCleared}
              />
            ))}
          </ul>
        )}
      </div>

      {showBulkBar && (
        <div className="bulk-bar" role="region" aria-label="Massåtgärder">
          <span className="bulk-count">
            {bulkState === "idle"
              ? `${selected.size} ${selected.size === 1 ? "vald" : "valda"}`
              : bulkState === "sending"
                ? `Skickar ${bulkProgress.done}/${bulkProgress.total}`
                : "Klart"}
          </span>
          {bulkState === "sending" && (
            <span className="bulk-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
          )}
          {bulkState === "done" && bulkMsg && <span className="bulk-msg" aria-live="polite">{bulkMsg}</span>}
          <span className="bulk-sep" aria-hidden="true" />
          {bulkState !== "done" && (
            <button type="button" className="accent sm" onClick={sendToSelected} disabled={bulkState !== "idle" || selected.size === 0}>
              {bulkState === "sending" ? <span className="spinner" aria-hidden="true" /> : <IconSend size={14} />}
              {bulkState === "sending" ? `Skickar ${bulkProgress.done}/${bulkProgress.total}…` : "Skicka SMS till valda"}
            </button>
          )}
          <button type="button" className="ghost sm" onClick={clearSelection} disabled={bulkState === "sending"}>
            <IconX size={14} /> {bulkState === "done" ? "Stäng" : "Avmarkera"}
          </button>
        </div>
      )}

      <MessageDialog open={messageOpen} log={openLog} onClose={() => setMessageOpen(false)} />

      <ConfirmDialog
        open={confirmClearAll}
        title="Rensa all SMS-historik?"
        description="All SMS-historik raderas permanent för alla kunder. Detta kan inte ångras."
        confirmLabel="Rensa allt"
        busy={clearingAll}
        onConfirm={clearAll}
        onClose={() => setConfirmClearAll(false)}
      />
    </>
  );
}
