"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";

type ActivityLog = {
  id: string;
  full_name: string | null;
  phone: string | null;
  sequence_number: number | null;
  status: string;
  created_at: string;
};

const statusSv: Record<string, string> = {
  sent: "Skickat",
  dry_run: "Testläge",
  failed: "Misslyckades",
  skipped: "Hoppades över",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("sv-SE");
}

const shimmerStyle = `
@keyframes shimmer2 {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
`;

function Skeleton({ width = "100%", height = 13 }: { width?: string | number; height?: number }) {
  return (
    <>
      <style>{shimmerStyle}</style>
      <div style={{
        width, height,
        borderRadius: 4,
        background: "linear-gradient(90deg, var(--surface-sub) 25%, var(--border) 50%, var(--surface-sub) 75%)",
        backgroundSize: "200% 100%",
        animation: "shimmer2 1.4s ease-in-out infinite",
      }} />
    </>
  );
}

function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 20px",
          borderBottom: "1px solid var(--border)",
          gap: 12,
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1 }}>
            <Skeleton width={`${45 + ((i * 29) % 30)}%`} height={13} />
            <Skeleton width={`${25 + ((i * 17) % 20)}%`} height={11} />
          </div>
          <Skeleton width={52} height={18} />
        </div>
      ))}
    </div>
  );
}

function ActivityModal({ onClose }: { onClose: () => void }) {
  const reduced = useReducedMotion();
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/activity")
      .then((r) => r.json())
      .then(setLogs)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const listVariants = {
    hidden: {},
    show: { transition: { staggerChildren: reduced ? 0 : 0.035, delayChildren: 0.04 } },
  };
  const rowVariants = {
    hidden: { opacity: 0, x: reduced ? 0 : -8 },
    show: { opacity: 1, x: 0, transition: { duration: 0.26, ease: [0, 0, 0.2, 1] as [number,number,number,number] } },
  };

  return (
    <motion.div
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.18 }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
        transition={{ duration: reduced ? 0.15 : 0.26, ease: [0, 0, 0.2, 1] }}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          width: "100%",
          maxWidth: 620,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(4,20,15,0.18)",
        }}
      >
        {/* Header — sidebar green */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "18px 24px",
          background: "#073B2C",
          flexShrink: 0,
        }}>
          <span style={{
            fontFamily: "var(--font-head)",
            fontWeight: 700,
            fontSize: 19,
            color: "#fff",
            letterSpacing: "-0.01em",
          }}>All aktivitet</span>
          <motion.button
            onClick={onClose}
            whileHover={{ scale: 1.15, opacity: 1 }}
            whileTap={{ scale: 0.88 }}
            transition={{ type: "spring", stiffness: 400, damping: 20 }}
            style={{
              background: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 19,
              color: "rgba(255,255,255,0.8)",
              lineHeight: 1,
              padding: "3px 8px",
              opacity: 0.85,
            }}
          >×</motion.button>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading ? (
            <SkeletonRows count={8} />
          ) : logs.length === 0 ? (
            <p style={{ padding: "24px", fontSize: 14, color: "var(--text-muted)" }}>
              Inga påminnelser skickade ännu.
            </p>
          ) : (
            <motion.div variants={listVariants} initial="hidden" animate="show">
              {logs.map((log, i) => (
                <motion.div
                  key={log.id}
                  variants={rowVariants}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    padding: "15px 24px",
                    borderBottom: "1px solid var(--border)",
                    background: i % 2 === 1 ? "var(--surface-sub)" : "var(--surface)",
                  }}
                >
                  <div>
                    <p style={{ fontWeight: 600, fontSize: 16, color: "var(--text)", marginBottom: 3 }}>
                      {log.full_name ?? log.phone ?? "—"}
                    </p>
                    <p style={{ fontSize: 14, color: "var(--text-muted)" }}>
                      {formatDate(log.created_at)}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    {log.sequence_number ? (
                      <span style={{
                        fontSize: 14, fontWeight: 700,
                        color: "var(--text-muted)", letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        background: "var(--surface-sub)",
                        border: "1px solid var(--border)",
                        borderRadius: 4, padding: "2px 6px",
                      }}>
                        SMS {log.sequence_number}
                      </span>
                    ) : null}
                    <span className={`badge ${log.status}`}>
                      {statusSv[log.status] ?? log.status}
                    </span>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )}
        </div>

        {/* Footer */}
        <AnimatePresence>
          {!loading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, delay: 0.15 }}
              style={{
                padding: "11px 24px",
                borderTop: "1px solid var(--border)",
                fontSize: 14,
                color: "var(--text-faint)",
                background: "var(--surface-sub)",
                flexShrink: 0,
              }}
            >
              {logs.length} händelser
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

export function ActivityPanel({
  preview,
  sectionHeaderStyle,
  sectionLabelStyle,
}: {
  preview: {
    id: string;
    full_name: string | null;
    phone: string | null;
    sequence_number: number | null;
    status: string;
    created_at: string;
  }[];
  sectionHeaderStyle: React.CSSProperties;
  sectionLabelStyle: React.CSSProperties;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const close = useCallback(() => setModalOpen(false), []);

  return (
    <>
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
      }}>
        <div style={{
          ...sectionHeaderStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <span style={sectionLabelStyle}>Senaste aktivitet</span>
          <motion.button
            onClick={() => setModalOpen(true)}
            whileHover={{ opacity: 0.7 }}
            whileTap={{ scale: 0.96 }}
            transition={{ duration: 0.12 }}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              padding: 0,
            }}
          >
            Visa alla ↗
          </motion.button>
        </div>

        {preview.length === 0 ? (
          <p style={{ padding: "16px 20px", fontSize: 14, color: "var(--text-muted)" }}>
            Inga påminnelser skickade ännu.
          </p>
        ) : (
          preview.map((log) => (
            <div key={log.id} style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "10px 20px",
              borderBottom: "1px solid var(--border)",
            }}>
              <div>
                <p style={{ fontWeight: 500, fontSize: 16 }}>
                  {log.full_name ?? log.phone ?? "—"}
                </p>
                <p style={{ fontSize: 14, color: "var(--text-muted)" }}>
                  {formatDate(log.created_at)}
                </p>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {log.sequence_number ? (
                  <span style={{
                    fontSize: 12, fontWeight: 600,
                    color: "var(--text-muted)", letterSpacing: "0.04em",
                  }}>SMS {log.sequence_number}</span>
                ) : null}
                <span className={`badge ${log.status}`}>
                  {statusSv[log.status] ?? log.status}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <AnimatePresence>
        {modalOpen && <ActivityModal key="activity-modal" onClose={close} />}
      </AnimatePresence>
    </>
  );
}
