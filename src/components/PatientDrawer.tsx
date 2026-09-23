"use client";

import { useEffect, useState } from "react";
import { Modal } from "./ui/Modal";
import { IconAlert, IconCalendar, IconMail, IconMessage, IconPhone, IconTrash } from "./ui/icons";
import { daysSince, formatDate, formatDateTime } from "./ui/format";
import { logStatusMeta, statusMeta } from "./ui/status";
import { FollowUpTrack, TRACK_LABELS } from "./FollowUpTrack";
import type { TrackStep } from "@/lib/patients/followupTrack";
import type { ReminderLog } from "@/types/clinic";

export type DrawerLog = Pick<
  ReminderLog,
  "id" | "status" | "sequence_number" | "step_day" | "message" | "created_at" | "error" | "sent_at"
>;

export type DrawerPatient = {
  id: string;
  name: string;
  phone: string | null;
  normalizedPhone: string | null;
  email: string | null;
  lastBookingAt: string | null;
  treatment: string | null;
  status: string;
};

const TIMELINE_DOT: Record<string, string> = {
  sent: "var(--done-dot)",
  delivered: "var(--ok-dot)",
  dry_run: "var(--info-dot)",
  pending: "var(--warn-dot)",
  unknown: "var(--warn-dot)",
  failed: "var(--danger-dot)",
  skipped: "var(--neutral-dot)",
};

function stepLabel(log: DrawerLog): string | null {
  if (log.step_day != null) return `Uppföljning ${log.step_day} d`;
  if (log.sequence_number) return `SMS ${log.sequence_number}`;
  return null;
}

/**
 * Everything about one patient in a side drawer: contact, last visit, where
 * they are in the follow-up cadence, and every SMS with its message text.
 * The history is fetched when the drawer opens — the list itself only carries
 * counts. Log rows can be deleted here.
 */
export function PatientDrawer({
  open,
  onClose,
  patient,
  track,
  onLogDeleted,
}: {
  open: boolean;
  onClose: () => void;
  patient: DrawerPatient;
  track: TrackStep[];
  onLogDeleted: (log: DrawerLog) => void;
}) {
  const [logs, setLogs] = useState<DrawerLog[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadError(false);
    fetch(`/api/logs?patientId=${encodeURIComponent(patient.id)}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<DrawerLog[]>;
      })
      .then(setLogs)
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setLoadError(true);
      });
    return () => controller.abort();
  }, [open, patient.id]);

  const meta = statusMeta(patient.status);
  const days = daysSince(patient.lastBookingAt);
  const sentCount = logs?.filter((l) => l.status === "sent" || l.status === "delivered").length ?? 0;

  async function deleteLog(log: DrawerLog) {
    setDeleting(log.id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/logs/${log.id}`, { method: "DELETE" });
      if (res.ok) {
        setLogs((prev) => prev?.filter((l) => l.id !== log.id) ?? prev);
        onLogDeleted(log);
      } else {
        setDeleteError("Kunde inte ta bort loggposten.");
      }
    } catch {
      setDeleteError("Nätverksfel — kunde inte ta bort loggposten.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="drawer"
      title={patient.name}
      description={
        <span className="row wrap" style={{ gap: 8, marginTop: 6 }}>
          <span className={`chip sm ${meta.chip}`} title={meta.hint}>{meta.label}</span>
          {logs && (
            <span>
              {sentCount} skicka{sentCount !== 1 ? "de" : "t"} · {logs.length} loggpost{logs.length !== 1 ? "er" : ""}
            </span>
          )}
        </span>
      }
    >
      <section className="drawer-section">
        <h3 className="drawer-label">Kontakt</h3>
        <div className="facts">
          <IconPhone />
          <div>
            {patient.phone ? (
              <>
                <span className="tnum">{patient.phone}</span>
                {patient.normalizedPhone && patient.normalizedPhone !== patient.phone && (
                  <span className="muted tnum" style={{ marginLeft: 8 }}>{patient.normalizedPhone}</span>
                )}
              </>
            ) : (
              <span className="pt-missing">Saknar telefonnummer</span>
            )}
          </div>
          <IconMail />
          <div className="truncate">
            {patient.email ?? <span className="faint">Ingen e-post</span>}
          </div>
        </div>
      </section>

      <section className="drawer-section">
        <h3 className="drawer-label">Senaste besök</h3>
        <div className="facts">
          <IconCalendar />
          <div>
            {patient.lastBookingAt ? (
              <>
                <strong style={{ fontWeight: 600 }}>{formatDate(patient.lastBookingAt)}</strong>
                {days != null && <span className="muted" style={{ marginLeft: 8 }}>{days} dagar sedan</span>}
              </>
            ) : (
              <span className="faint">Inget registrerat besök</span>
            )}
          </div>
          <span />
          <div className="muted">{patient.treatment ?? "Ingen behandling angiven"}</div>
        </div>
      </section>

      {track.length > 0 && (
        <section className="drawer-section">
          <h3 className="drawer-label">Uppföljningar i den här cykeln</h3>
          <ul style={{ listStyle: "none", display: "grid", gap: 10 }}>
            {track.map((step) => (
              <li key={step.id} className="row-between">
                <span className="row" style={{ gap: 10 }}>
                  <FollowUpTrack track={[step]} compact />
                  <span style={{ fontWeight: 600 }}>{step.day} dagar</span>
                  {!step.active && <span className="tag">inaktiv</span>}
                </span>
                <span className="muted">
                  {TRACK_LABELS[step.state]}
                  {step.at ? ` · ${formatDate(step.at)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="drawer-section">
        <h3 className="drawer-label">
          SMS-historik
          {logs && logs.length > 0 && <span className="tab-count">{logs.length}</span>}
        </h3>

        {deleteError && <div className="notice error" style={{ marginBottom: 12 }}>{deleteError}</div>}

        {loadError ? (
          <div className="notice error"><IconAlert /><span>Kunde inte ladda SMS-historiken.</span></div>
        ) : logs === null ? (
          <div style={{ display: "grid", gap: 12 }} aria-label="Laddar SMS-historik">
            {[0, 1, 2].map((i) => (
              <span key={i} className="skeleton" style={{ height: 72, borderRadius: 10 }} />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="empty-state" style={{ padding: "20px 0" }}>
            <span className="empty-icon"><IconMessage /></span>
            <span className="empty-title">Inga SMS ännu</span>
            <span>Utskick till den här kunden visas här.</span>
          </div>
        ) : (
          <ol className="timeline">
            {logs.map((log) => {
              const m = logStatusMeta(log.status);
              const step = stepLabel(log);
              return (
                <li key={log.id}>
                  <span className="timeline-dot" style={{ background: TIMELINE_DOT[log.status] ?? "var(--neutral-dot)" }} />
                  <div className="timeline-card" style={{ opacity: deleting === log.id ? 0.5 : 1 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className={`badge sm ${m.chip}`}>{m.label}</span>
                      {step && <span className="tag">{step}</span>}
                      <span className="muted tnum" style={{ marginLeft: "auto" }}>
                        {formatDateTime(log.sent_at ?? log.created_at)}
                      </span>
                      <button
                        type="button"
                        className="icon-btn sm"
                        title="Ta bort loggpost"
                        aria-label="Ta bort loggpost"
                        disabled={deleting === log.id}
                        onClick={() => deleteLog(log)}
                      >
                        <IconTrash size={14} />
                      </button>
                    </div>
                    {log.message && <p className="msg">{log.message}</p>}
                    {log.error && <p className="err">{log.error}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </Modal>
  );
}
