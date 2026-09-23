"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Modal } from "./ui/Modal";
import { IconArrowRight, IconMessage } from "./ui/icons";
import { formatRelative } from "./ui/format";
import { logStatusMeta } from "./ui/status";

type ActivityLog = {
  id: string;
  full_name: string | null;
  phone: string | null;
  sequence_number: number | null;
  step_day?: number | null;
  status: string;
  created_at: string;
};

function initials(name: string | null) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** "Uppföljning 30 d" when the step is known, else the legacy position. */
function stepLabel(log: ActivityLog): string | null {
  if (log.step_day != null) return `Uppföljning ${log.step_day} d`;
  if (log.sequence_number) return `SMS ${log.sequence_number}`;
  return null;
}

function FeedRow({ log }: { log: ActivityLog }) {
  const meta = logStatusMeta(log.status);
  const step = stepLabel(log);
  return (
    <>
      <span className="avatar" aria-hidden="true">{initials(log.full_name)}</span>
      <div style={{ minWidth: 0 }}>
        <p className="truncate" style={{ fontWeight: 600, color: "var(--text)", lineHeight: 1.35 }}>
          {log.full_name ?? log.phone ?? "—"}
        </p>
        <p className="list-sub truncate">
          {step ? <>{step} · </> : null}
          {formatRelative(log.created_at)}
        </p>
      </div>
      <span className={`badge sm ${meta.chip}`}>{meta.label}</span>
    </>
  );
}

function ActivityModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reduced = useReducedMotion();
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setLoadError(false);
    fetch("/api/dashboard/activity")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(setLogs)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="All aktivitet"
      description="Varje SMS-händelse, senaste först."
      footer={<span className="tnum">{loading ? "Laddar…" : `${logs.length} händelser`}</span>}
    >
      {loading ? (
        <div aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="list-row">
              <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
                <span className="skeleton" style={{ width: 32, height: 32, flex: "0 0 auto" }} />
                <div style={{ display: "grid", gap: 6, flex: 1 }}>
                  <span className="skeleton" style={{ width: `${45 + ((i * 29) % 30)}%`, height: 12 }} />
                  <span className="skeleton" style={{ width: `${25 + ((i * 17) % 20)}%`, height: 10 }} />
                </div>
              </div>
              <span className="skeleton" style={{ width: 76, height: 22 }} />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <div className="empty-state">
          <span className="empty-title">Kunde inte ladda aktiviteten</span>
          <span>Stäng och försök igen om en stund.</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon"><IconMessage /></span>
          <span className="empty-title">Inga påminnelser skickade ännu</span>
        </div>
      ) : (
        <motion.ul
          className="feed"
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: reduced ? 0 : 0.025 } } }}
        >
          {logs.map((log) => (
            <motion.li
              key={log.id}
              style={{ padding: "12px 24px" }}
              variants={{
                hidden: { opacity: 0, y: reduced ? 0 : 4 },
                show: { opacity: 1, y: 0, transition: { duration: 0.22 } },
              }}
            >
              <FeedRow log={log} />
            </motion.li>
          ))}
        </motion.ul>
      )}
    </Modal>
  );
}

export function ActivityPanel({ preview }: { preview: ActivityLog[] }) {
  const [modalOpen, setModalOpen] = useState(false);
  const close = useCallback(() => setModalOpen(false), []);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Senaste aktivitet</h2>
            <p className="panel-sub">De senaste SMS-händelserna</p>
          </div>
          <button type="button" className="reset panel-link" onClick={() => setModalOpen(true)}>
            Visa alla <IconArrowRight size={14} />
          </button>
        </div>

        {preview.length === 0 ? (
          <div className="empty-state" style={{ padding: "32px 20px" }}>
            <span className="empty-icon"><IconMessage /></span>
            <span className="empty-title">Inga påminnelser skickade ännu</span>
          </div>
        ) : (
          <ul className="feed">
            {preview.map((log) => (
              <li key={log.id}>
                <FeedRow log={log} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <ActivityModal open={modalOpen} onClose={close} />
    </>
  );
}
