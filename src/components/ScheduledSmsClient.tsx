"use client";

import { useState } from "react";
import type { ScheduledSms, SmsStep } from "@/types/clinic";
import { IconCalendar, IconX } from "./ui/icons";
import { formatDate, formatTime } from "./ui/format";

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
  return "pending";
}

type Tab = "active" | "sent" | "other" | "all";

function tabOf(status: string): Exclude<Tab, "all"> {
  if (status === "pending" || status === "processing") return "active";
  if (status === "sent" || status === "dry_run") return "sent";
  return "other";
}

/** "i dag 14:00", "i morgon 09:00", "om 5 dagar", or a date for the past. */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  const dayMs = 86_400_000;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(d) - startOf(new Date())) / dayMs);
  if (diffDays === 0) return `i dag ${formatTime(iso)}`;
  if (diffDays === 1) return `i morgon ${formatTime(iso)}`;
  if (diffDays > 1 && diffDays < 14) return `om ${diffDays} dagar`;
  if (diffDays === -1) return `igår ${formatTime(iso)}`;
  return "";
}

function contentLabel(row: ScheduledSmsRow, steps: SmsStep[]) {
  const step = row.step_id ? steps.find((s) => s.id === row.step_id) : undefined;
  if (step) return `${step.day} dagar`;
  // Rows scheduled before follow-ups had ids, or whose step has been deleted.
  if (row.sequence_override != null) return `SMS ${row.sequence_override}`;
  if (row.message_override) return "Fryst meddelande";
  return "Automatisk";
}

export function ScheduledSmsClient({
  initialRows,
  steps = [],
}: {
  initialRows: ScheduledSmsRow[];
  steps?: SmsStep[];
}) {
  const [rows, setRows] = useState(initialRows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const initialActive = initialRows.some((r) => tabOf(r.status) === "active");
  const [tab, setTab] = useState<Tab>(initialActive ? "active" : "all");

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

  const counts: Record<Tab, number> = { active: 0, sent: 0, other: 0, all: rows.length };
  for (const r of rows) counts[tabOf(r.status)]++;
  const visible = tab === "all" ? rows : rows.filter((r) => tabOf(r.status) === tab);

  const tabs: { key: Tab; label: string }[] = [
    { key: "active", label: "Aktiva" },
    { key: "sent", label: "Skickade" },
    { key: "other", label: "Avbrutna och övriga" },
    { key: "all", label: "Alla" },
  ];

  return (
    <div className="panel rise" style={{ ["--i" as string]: 1 }}>
      <div className="tabs" style={{ padding: "0 12px" }} role="tablist" aria-label="Filtrera schemalagda SMS">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? " active" : ""}${counts[t.key] === 0 && tab !== t.key ? " is-empty" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            <span className="tab-count">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Patient</th>
              <th>Telefon</th>
              <th>Schemalagt</th>
              <th>Innehåll</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Åtgärd</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const when = whenLabel(row.scheduled_for);
              return (
                <tr key={row.id}>
                  <td className="strong">{row.patientName ?? "Okänd patient"}</td>
                  <td className="tnum">{row.patientPhone ?? <span className="faint">—</span>}</td>
                  <td>
                    <div className="tnum" style={{ fontWeight: 600, color: "var(--text)" }}>
                      {formatDate(row.scheduled_for)} {formatTime(row.scheduled_for)}
                    </div>
                    {when && tabOf(row.status) === "active" && <div className="muted">{when}</div>}
                  </td>
                  <td><span className="tag">{contentLabel(row, steps)}</span></td>
                  <td>
                    <span className={`badge ${badgeClass(row.status)}`}>{statusLabels[row.status] ?? row.status}</span>
                    {row.error && row.status !== "pending" && (
                      <div className="muted" style={{ color: "var(--danger)", marginTop: 4, whiteSpace: "normal", maxWidth: 260 }}>
                        {row.error}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {row.status === "pending" ? (
                      <>
                        <button
                          type="button"
                          className="danger sm"
                          onClick={() => cancel(row.id)}
                          disabled={busyId === row.id}
                        >
                          {busyId === row.id ? <span className="spinner" aria-hidden="true" /> : <IconX size={14} />}
                          {busyId === row.id ? "Avbryter…" : "Avbryt"}
                        </button>
                        {errorId === row.id && errorMsg && (
                          <div style={{ marginTop: 4, fontSize: "var(--fs-xs)", color: "var(--danger)", fontWeight: 600 }}>{errorMsg}</div>
                        )}
                      </>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {visible.length === 0 && (
        <div className="empty-state">
          <span className="empty-icon"><IconCalendar /></span>
          <span className="empty-title">{rows.length === 0 ? "Inga schemalagda SMS" : "Inga SMS i den här vyn"}</span>
          <span>Schemalägg ett SMS från en kund på sidan Kunder (menyn ⋯ på raden).</span>
        </div>
      )}
    </div>
  );
}
