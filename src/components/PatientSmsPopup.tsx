"use client";

import { useState } from "react";
import type { ReminderLog } from "@/types/clinic";

type LogEntry = Pick<ReminderLog, "id" | "status" | "sequence_number" | "message" | "created_at" | "error" | "sent_at">;

interface Props {
  patientName: string;
  logs: LogEntry[];
}

const statusSv: Record<string, string> = {
  sent:        "Skickat",
  delivered:   "Levererat",
  dry_run:     "Testläge",
  failed:      "Misslyckades",
  skipped:     "Hoppades över",
  cycle_reset: "Cykel återställd",
};

function badgeClass(status: string) {
  if (status === "delivered") return "ready";
  if (status === "sent" || status === "dry_run") return "future";
  if (status === "failed") return "review";
  return "waiting";
}

function formatTs(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

export function PatientSmsPopup({ patientName, logs: initialLogs }: Props) {
  const [open, setOpen]   = useState(false);
  const [logs, setLogs]   = useState(initialLogs);
  const [deleting, setDeleting] = useState<string | null>(null);

  const sentCount = logs.filter((l) => l.status === "sent" || l.status === "delivered").length;
  const hasLogs   = logs.length > 0;

  async function deleteLog(id: string) {
    setDeleting(id);
    const res = await fetch(`/api/logs/${id}`, { method: "DELETE" });
    if (res.ok) setLogs((prev) => prev.filter((l) => l.id !== id));
    setDeleting(null);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => hasLogs && setOpen(true)}
        style={{
          background: "none", border: "none", padding: 0,
          cursor: hasLogs ? "pointer" : "default",
          textAlign: "left", width: "100%",
        }}
      >
        <div className="pt-name" style={{ textDecoration: hasLogs ? "underline" : undefined, textDecorationStyle: "dotted", textUnderlineOffset: 3 }}>
          {patientName}
        </div>
        {sentCount > 0 && (
          <div style={{ fontSize: 11, color: "var(--accent)", marginTop: 1, fontWeight: 600 }}>
            {sentCount} SMS skickat{sentCount !== 1 ? "e" : ""}
          </div>
        )}
      </button>

      {open && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setOpen(false)}
        >
          <div
            style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px 28px", width: "min(560px, 92vw)", maxHeight: "80vh", overflowY: "auto", boxShadow: "0 8px 40px rgba(0,0,0,0.3)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div>
                <div style={{ fontFamily: "var(--font-head)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                  {patientName}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                  {sentCount} skickat{sentCount !== 1 ? "e" : ""} · {logs.length} loggpost{logs.length !== 1 ? "er" : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "var(--text-muted)", padding: "0 4px", lineHeight: 1 }}
              >
                ×
              </button>
            </div>

            {logs.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-faint)", textAlign: "center", padding: "20px 0" }}>
                Inga SMS-poster för den här patienten.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {logs.map((log) => (
                  <div
                    key={log.id}
                    style={{ background: "var(--surface-sub)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={`badge ${badgeClass(log.status)}`} style={{ fontSize: 11 }}>
                        {log.sequence_number
                          ? `SMS ${log.sequence_number} — ${statusSv[log.status] ?? log.status}`
                          : (statusSv[log.status] ?? log.status)}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text-faint)", marginLeft: "auto" }}>
                        {formatTs(log.sent_at ?? log.created_at)}
                      </span>
                      <button
                        type="button"
                        title="Ta bort loggpost"
                        disabled={deleting === log.id}
                        onClick={() => deleteLog(log.id)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", fontSize: 15, padding: "0 2px", lineHeight: 1, opacity: deleting === log.id ? 0.4 : 1, flexShrink: 0 }}
                      >
                        ×
                      </button>
                    </div>
                    {log.message && (
                      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                        {log.message}
                      </div>
                    )}
                    {log.error && (
                      <div style={{ fontSize: 11.5, color: "var(--red)" }}>
                        {log.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
