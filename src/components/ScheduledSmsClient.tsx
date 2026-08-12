"use client";

import { useState } from "react";
import type { ScheduledSms } from "@/types/clinic";

export type ScheduledSmsRow = ScheduledSms & {
  patientName: string | null;
  patientPhone: string | null;
};

const statusLabels: Record<string, string> = {
  pending: "Väntar",
  processing: "Bearbetas",
  skipped: "Hoppades över",
  unknown: "Okänd leverans",
  dry_run: "Testkörning",
  sent: "Skickat",
  cancelled: "Avbruten",
  failed: "Misslyckades",
};

function badgeClass(status: string) {
  if (status === "sent") return "sent";
  if (status === "dry_run") return "dry-run";
  if (status === "cancelled" || status === "skipped") return "resolved";
  if (status === "failed" || status === "unknown") return "failed";
  if (status === "processing") return "ready";
  return "waiting";
}

function formatScheduled(iso: string) {
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

function contentLabel(row: ScheduledSmsRow) {
  if (row.sequence_override != null) return `SMS ${row.sequence_override}`;
  if (row.message_override) return "Fryst meddelande";
  return "Automatisk";
}

export function ScheduledSmsClient({ initialRows }: { initialRows: ScheduledSmsRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function cancel(id: string) {
    setBusyId(id);
    setErrorId(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/scheduled-sms/${id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      if (!res.ok) {
        setErrorId(id);
        setErrorMsg(data.error ?? "Kunde inte avbryta");
        return;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, status: (data.status as ScheduledSmsRow["status"]) ?? "cancelled" } : r
        )
      );
    } catch {
      setErrorId(id);
      setErrorMsg("Nätverksfel");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <style>{`
        .ss-head {
          display: grid;
          grid-template-columns: 4px 1fr;
          background: var(--surface-sub);
          border: 1px solid var(--border);
          border-bottom: 2px solid var(--border-dark);
          border-radius: var(--radius) var(--radius) 0 0;
        }
        .ss-head-bar { background: transparent; }
        .ss-head-inner {
          display: grid;
          grid-template-columns: 200px 160px 170px 1fr 130px 110px;
          align-items: center;
        }
        .ss-head-cell {
          padding: 12px 18px;
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--text-muted);
        }

        .ss-row {
          display: grid;
          grid-template-columns: 4px 1fr;
          background: var(--surface);
          border-bottom: 1px solid var(--border);
        }
        .ss-row:last-child { border-bottom: 0; }
        .ss-row:nth-child(even) .ss-row-inner { background: var(--surface-sub); }

        .ss-row-inner {
          display: grid;
          grid-template-columns: 200px 160px 170px 1fr 130px 110px;
          align-items: center;
        }
        .ss-cell {
          padding: 14px 18px;
          font-size: 16px;
          color: var(--text);
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ss-name {
          font-weight: 700;
          font-size: 16px;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ss-phone { font-size: 14px; color: var(--text-muted); white-space: nowrap; }
        .ss-date { font-size: 14px; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
        .ss-content { font-size: 14px; color: var(--text-muted); }
      `}</style>

      <div className="ss-head">
        <div className="ss-head-bar" />
        <div className="ss-head-inner">
          <div className="ss-head-cell">Patient</div>
          <div className="ss-head-cell">Telefon</div>
          <div className="ss-head-cell">Schemalagt</div>
          <div className="ss-head-cell">Innehåll</div>
          <div className="ss-head-cell" style={{ borderLeft: "1px solid var(--border)" }}>Status</div>
          <div className="ss-head-cell">Åtgärd</div>
        </div>
      </div>

      <div className="table-wrap" style={{ borderRadius: "0 0 var(--radius) var(--radius)", overflow: "hidden" }}>
        {rows.length === 0 && <div className="empty-state">Inga schemalagda SMS.</div>}
        {rows.map((row) => (
          <div key={row.id} className="ss-row">
            <div style={{ background: "#c8d4d0", flexShrink: 0 }} />
            <div className="ss-row-inner">
              <div className="ss-cell">
                <div className="ss-name">{row.patientName ?? "Okänd patient"}</div>
              </div>
              <div className="ss-cell">
                <span className="ss-phone">{row.patientPhone ?? "—"}</span>
              </div>
              <div className="ss-cell">
                <span className="ss-date">{formatScheduled(row.scheduled_for)}</span>
              </div>
              <div className="ss-cell">
                <span className="ss-content">{contentLabel(row)}</span>
              </div>
              <div className="ss-cell" style={{ borderLeft: "1px solid var(--border)" }}>
                <span className={`badge ${badgeClass(row.status)}`}>{statusLabels[row.status] ?? row.status}</span>
              </div>
              <div className="ss-cell">
                {row.status === "pending" ? (
                  <>
                    <button
                      className="danger"
                      onClick={() => cancel(row.id)}
                      disabled={busyId === row.id}
                      style={{ fontSize: 14, padding: "5px 12px", minHeight: "unset" }}
                    >
                      {busyId === row.id ? "…" : "Avbryt"}
                    </button>
                    {errorId === row.id && errorMsg && (
                      <div style={{ marginTop: 4, fontSize: 12, color: "var(--red)" }}>{errorMsg}</div>
                    )}
                  </>
                ) : (
                  <span style={{ color: "var(--text-faint)", fontSize: 14 }}>—</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
