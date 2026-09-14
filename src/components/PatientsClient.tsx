"use client";

import { useState, useCallback } from "react";
import { PatientSmsPopup } from "@/components/PatientSmsPopup";
import { PatientActions, type TemplateStep } from "@/components/PatientActions";
import { useToast } from "@/components/ToastProvider";
import { isRealSend } from "@/lib/sms/outcome";
import { requestSend } from "@/lib/sms/sendClient";
import type { Patient, ReminderLog } from "@/types/clinic";

export type PatientRow = {
  patient: Patient;
  status: string;
  logs: ReminderLog[];
};

type BulkState = "idle" | "sending" | "done";

// Status → left-bar accent color (duplicated from page for client use)
const statusAccent: Record<string, string> = {
  Ready:              "#5bbfb5",
  Sent:               "#3da89d",
  "Future booking":   "#1a4f78",
  "Missing phone":    "#a33030",
  "Needs review":     "#a33030",
  "Delivery pending": "#a33030",
  "Do not contact":   "#7a5200",
  Waiting:            "#c8d4d0",
  "No valid booking": "#c8d4d0",
};

const statusLabels: Record<string, string> = {
  Ready:              "Redo",
  Sent:               "Skickat",
  "Future booking":   "Har bokat en tid",
  "Missing phone":    "Saknar telefon",
  "Do not contact":   "Kontakta ej",
  "Needs review":     "Behöver granskas",
  "Delivery pending": "Leverans väntar",
  Waiting:            "Väntar",
  "No valid booking": "Ingen giltig bokning",
};

function badgeClass(status: string) {
  if (status === "Ready" || status === "Sent") return "ready";
  if (status === "Future booking") return "future";
  if (status === "Missing phone") return "missing";
  if (status === "Needs review" || status === "Delivery pending") return "review";
  if (status === "Do not contact") return "ignored";
  return "waiting";
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("sv-SE");
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function patientDisplayName(p: Patient) {
  if (p.first_name || p.last_name) return [p.first_name, p.last_name].filter(Boolean).join(" ");
  return p.full_name;
}

export function PatientsClient({ rows, steps = [] }: { rows: PatientRow[]; steps?: TemplateStep[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkState, setBulkState] = useState<BulkState>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [bulkErrors, setBulkErrors] = useState<{ name: string; reason: string }[]>([]);
  const toast = useToast();

  const allIds = rows.map((r) => r.patient.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setBulkState("idle");
    setDoneMessage(null);
  }, []);

  async function sendToSelected() {
    if (bulkState !== "idle") return;
    const ids = [...selected];
    setBulkState("sending");
    setBulkErrors([]);
    setProgress({ done: 0, total: ids.length });

    let sent = 0;
    let skipped = 0;
    let dryRun = 0;
    const failures: { name: string; reason: string }[] = [];
    for (const id of ids) {
      const patientName = rows.find((r) => r.patient.id === id)?.patient.full_name ?? id;
      const outcome = await requestSend({ patientId: id });
      if (isRealSend(outcome.kind)) {
        sent++;
      } else if (outcome.kind === "dry_run") {
        dryRun++;
      } else if (outcome.kind === "skipped") {
        // Not a failure, but not a send either — counted separately so the
        // summary cannot imply these patients were contacted.
        skipped++;
        failures.push({ name: patientName, reason: outcome.message });
      } else {
        failures.push({ name: patientName, reason: outcome.detail ?? outcome.message });
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setBulkState("done");
    setBulkErrors(failures);
    const problems = failures.length - skipped;
    const parts = [`${sent} skickade`];
    if (dryRun > 0) parts.push(`${dryRun} i testläge`);
    if (skipped > 0) parts.push(`${skipped} hoppades över`);
    if (problems > 0) parts.push(`${problems} misslyckades`);
    const msg = parts.join(", ");
    setDoneMessage(msg);
    toast.push({
      tone: problems > 0 ? "error" : skipped > 0 ? "warning" : "success",
      title: msg,
      detail: failures.length > 0
        ? failures.slice(0, 3).map((f) => `${f.name}: ${f.reason}`).join(" · ")
        : null,
    });
    setSelected(new Set());
    setTimeout(() => { setBulkState("idle"); setDoneMessage(null); setBulkErrors([]); }, 10000);
  }

  return (
    <>
      <style>{`
        .pt-row {
          display: grid;
          grid-template-columns: 4px 1fr;
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          transition: background 120ms;
        }
        .pt-row:last-child { border-bottom: 0; }
        .pt-row:nth-child(even) .pt-row-inner { background: var(--surface-sub); }
        .pt-row:hover .pt-row-inner { background: #edf7f6; }
        .pt-row.pt-selected .pt-row-inner {
          background: rgba(91,191,181,0.07) !important;
        }

        .pt-row-inner {
          display: grid;
          grid-template-columns: 36px 200px 160px 160px 110px 70px 1fr 175px auto;
          align-items: center;
          gap: 0;
          padding: 0;
          transition: background 120ms;
        }

        .pt-cell {
          padding: 16px 18px;
          font-size: 16px;
          color: var(--text);
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .pt-cell-name { padding: 16px 20px; }
        .pt-cell-cb {
          padding: 0 0 0 12px;
          display: flex;
          align-items: center;
          justify-content: flex-start;
        }

        .pt-cb {
          width: 15px;
          height: 15px;
          accent-color: var(--accent);
          cursor: pointer;
          flex-shrink: 0;
        }

        .pt-name {
          font-weight: 700;
          font-size: 16px;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pt-email {
          font-size: 14px;
          color: var(--text-faint);
          margin-top: 3px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pt-phone-main {
          font-size: 16px;
          color: var(--text);
          white-space: nowrap;
        }
        .pt-phone-norm {
          font-size: 14px;
          color: var(--text-faint);
          margin-top: 2px;
          font-variant-numeric: tabular-nums;
        }
        .pt-days {
          font-variant-numeric: tabular-nums;
          font-weight: 700;
          font-size: 19px;
          color: var(--text-mid);
        }
        .pt-days-label {
          font-size: 14px;
          color: var(--text-faint);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-top: 1px;
        }
        .pt-treatment {
          font-size: 14px;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pt-date {
          font-size: 16px;
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }

        .pt-head {
          display: grid;
          grid-template-columns: 4px 1fr;
          background: var(--surface-sub);
          border: 1px solid var(--border);
          border-bottom: 2px solid var(--border-dark);
          position: sticky;
          top: 0;
          z-index: 10;
        }
        .pt-head-bar { background: transparent; }
        .pt-head-inner {
          display: grid;
          grid-template-columns: 36px 200px 160px 160px 110px 70px 1fr 175px auto;
          align-items: center;
        }
        .pt-head-cell {
          padding: 12px 18px;
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .pt-head-cell:nth-child(2) { padding-left: 20px; }
        .pt-head-cell-cb {
          padding: 0 0 0 12px;
          display: flex;
          align-items: center;
        }
        .pt-actions-cell { padding: 12px 18px 12px 8px; }

        /* Bulk action bar */
        .pt-bulk-bar {
          display: flex;
          align-items: center;
          gap: 10;
          padding: 10px 16px;
          background: #073B2C;
          border: 1px solid var(--border);
          border-bottom: none;
          border-radius: var(--radius) var(--radius) 0 0;
          animation: slideDown 0.18s ease;
        }
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .pt-bulk-count {
          font-size: 14px;
          font-weight: 600;
          color: rgba(255,255,255,0.9);
          flex: 1;
          white-space: nowrap;
        }
        .pt-bulk-send {
          background: #5bbfb5;
          color: #fff;
          border: none;
          border-radius: 5px;
          padding: 6px 14px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          transition: opacity 150ms;
        }
        .pt-bulk-send:disabled { opacity: 0.5; cursor: default; }
        .pt-bulk-clear {
          background: rgba(255,255,255,0.12);
          color: rgba(255,255,255,0.8);
          border: 1px solid rgba(255,255,255,0.2);
          border-radius: 5px;
          padding: 6px 12px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: background 150ms;
        }
        .pt-bulk-clear:hover { background: rgba(255,255,255,0.2); }
        .pt-bulk-msg {
          font-size: 14px;
          color: rgba(255,255,255,0.7);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
      `}</style>

      {/* Bulk action bar */}
      {someSelected && (
        <div className="pt-bulk-bar">
          <span className="pt-bulk-count">
            {selected.size} {selected.size === 1 ? "vald" : "valda"}
          </span>
          {bulkState === "sending" && (
            <span className="pt-bulk-msg">Skickar {progress.done}/{progress.total}…</span>
          )}
          {bulkState === "done" && doneMessage && (
            <span className="pt-bulk-msg" style={{ color: bulkErrors.length > 0 ? "var(--red)" : undefined }}>
              {doneMessage}
            </span>
          )}
          {bulkState === "done" && bulkErrors.length > 0 && (
            <span style={{ fontSize: 14, color: "var(--red)", lineHeight: 1.4 }}>
              {bulkErrors.map((e) => `${e.name}: ${e.reason}`).join(" · ")}
            </span>
          )}
          <button
            className="pt-bulk-send"
            disabled={bulkState !== "idle"}
            onClick={sendToSelected}
          >
            {bulkState === "sending" ? `Skickar ${progress.done}/${progress.total}…` : "Skicka SMS till valda"}
          </button>
          <button className="pt-bulk-clear" onClick={clearSelection}>
            Avmarkera
          </button>
        </div>
      )}

      {/* Sticky column header */}
      <div
        className="pt-head"
        style={{
          borderRadius: someSelected
            ? "0 0 0 0"
            : "var(--radius) var(--radius) 0 0",
        }}
      >
        <div className="pt-head-bar" />
        <div className="pt-head-inner">
          <div className="pt-head-cell-cb">
            <input
              type="checkbox"
              className="pt-cb"
              checked={allSelected}
              onChange={toggleAll}
              title={allSelected ? "Avmarkera alla" : "Markera alla"}
            />
          </div>
          <div className="pt-head-cell">Namn</div>
          <div className="pt-head-cell">Telefon</div>
          <div className="pt-head-cell">E-post</div>
          <div className="pt-head-cell">Senaste bokning</div>
          <div className="pt-head-cell">Dagar</div>
          <div className="pt-head-cell">Behandling</div>
          <div className="pt-head-cell" style={{ borderLeft: "1px solid var(--border)" }}>Status</div>
          <div className="pt-head-cell pt-actions-cell">Åtgärder</div>
        </div>
      </div>

      <div className="table-wrap" style={{ borderRadius: "0 0 var(--radius) var(--radius)", overflow: "hidden" }}>
        {rows.length === 0 && (
          <div className="empty-state">Inga patienter matchar det valda filtret.</div>
        )}
        {rows.map(({ patient, status, logs }) => {
          const accent = statusAccent[status] ?? "#c8d4d0";
          const days = daysSince(patient.last_booking_at);
          const isSelected = selected.has(patient.id);
          return (
            <div
              key={patient.id}
              className={`pt-row${isSelected ? " pt-selected" : ""}`}
            >
              <div style={{ background: accent, flexShrink: 0 }} />
              <div className="pt-row-inner">
                {/* Checkbox */}
                <div className="pt-cell pt-cell-cb">
                  <input
                    type="checkbox"
                    className="pt-cb"
                    checked={isSelected}
                    onChange={() => toggleOne(patient.id)}
                  />
                </div>

                {/* Name + email */}
                <div className="pt-cell pt-cell-name">
                  <PatientSmsPopup
                    patientName={patientDisplayName(patient)}
                    logs={logs}
                  />
                  {patient.email && (
                    <div className="pt-email">{patient.email}</div>
                  )}
                </div>

                {/* Phone */}
                <div className="pt-cell">
                  {patient.phone ? (
                    <>
                      <div className="pt-phone-main">{patient.phone}</div>
                      {patient.normalized_phone && (
                        <div className="pt-phone-norm">{patient.normalized_phone}</div>
                      )}
                    </>
                  ) : (
                    <span style={{ color: "var(--text-faint)", fontSize: 14 }}>—</span>
                  )}
                </div>

                {/* Email column */}
                <div className="pt-cell" style={{ color: "var(--text-muted)", fontSize: 14 }}>
                  {patient.email ?? <span style={{ color: "var(--text-faint)" }}>—</span>}
                </div>

                {/* Last booking */}
                <div className="pt-cell">
                  <span className="pt-date">{formatDate(patient.last_booking_at)}</span>
                </div>

                {/* Days since */}
                <div className="pt-cell">
                  {days != null ? (
                    <>
                      <div className="pt-days">{days}</div>
                      <div className="pt-days-label">dagar</div>
                    </>
                  ) : (
                    <span style={{ color: "var(--text-faint)", fontSize: 14 }}>—</span>
                  )}
                </div>

                {/* Treatment */}
                <div className="pt-cell">
                  <span className="pt-treatment">
                    {patient.latest_treatment ?? <span style={{ color: "var(--text-faint)" }}>—</span>}
                  </span>
                </div>

                {/* Status badge */}
                <div className="pt-cell" style={{ borderLeft: "1px solid var(--border)" }}>
                  <span className={`badge ${badgeClass(status)}`}>
                    {statusLabels[status] ?? status}
                  </span>
                </div>

                {/* Actions */}
                <div className="pt-cell pt-actions-cell">
                  <PatientActions patientId={patient.id} doNotContact={patient.do_not_contact} steps={steps} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
