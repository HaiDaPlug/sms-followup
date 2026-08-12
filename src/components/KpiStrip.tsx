"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useToast } from "./ToastProvider";
import { isRealSend } from "@/lib/sms/outcome";
import { requestSend } from "@/lib/sms/sendClient";

type ReadyPatient = {
  id: string;
  full_name: string;
  phone: string | null;
  last_booking_at: string | null;
  latest_treatment: string | null;
  smsCount?: number;
};

type SmsLog = {
  id: string;
  phone: string | null;
  sequence_number: number | null;
  sent_at: string;
  patient_id: string | null;
  full_name: string | null;
};

type ReviewItem = {
  id: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
};

type ModalType = "ready" | "sms" | "review" | null;
type SendState = "idle" | "sending" | "sent" | "failed";
type SortOrder = "oldest" | "recent";

const severityLabel: Record<string, string> = { high: "Hög", medium: "Medel", low: "Låg" };
const severityColor: Record<string, string> = { high: "var(--red)", medium: "var(--amber)", low: "var(--text-muted)" };
const severityBg: Record<string, string> = { high: "var(--red-bg)", medium: "var(--amber-bg)", low: "var(--surface-sub)" };
const severityBorder: Record<string, string> = { high: "var(--red-border)", medium: "var(--amber-border)", low: "var(--border)" };

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("sv-SE");
}

// ── Global styles ─────────────────────────────────────────────────────────────

const globalStyles = `
@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes spin { to { transform: rotate(360deg); } }

.send-btn {
  position: relative;
  overflow: hidden;
  background-color: #073B2C;
  color: #fff;
  border: none;
  border-radius: 5px;
  padding: 6px 13px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  flex-shrink: 0;
  white-space: nowrap;
  transition: color 0.26s ease;
  isolation: isolate;
  min-width: 100px;
  text-align: center;
  justify-content: center;
}
.send-btn.sent {
  background: var(--surface-sub);
  color: var(--text-muted);
  border-color: var(--border);
  cursor: default;
}
.send-btn.sent::before { display: none; }

.send-btn.failed {
  background: var(--red-bg);
  color: var(--red);
  border-color: var(--red-border);
  cursor: default;
}
.send-btn.failed::before { display: none; }

.send-btn.sending {
  opacity: 0.6;
  cursor: wait;
}
.send-btn.sending::before { display: none; }
`;

function GlobalStyles() {
  return <style>{globalStyles}</style>;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton({ width = "100%", height = 13 }: { width?: string | number; height?: number }) {
  return (
    <div style={{
      width, height,
      borderRadius: 4,
      background: "linear-gradient(90deg, var(--surface-sub) 25%, var(--border) 50%, var(--surface-sub) 75%)",
      backgroundSize: "200% 100%",
      animation: "shimmer 1.4s ease-in-out infinite",
    }} />
  );
}

function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 24px",
          borderBottom: "1px solid var(--border)",
          gap: 16,
        }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7 }}>
            <Skeleton width={`${50 + ((i * 37) % 30)}%`} height={14} />
            <Skeleton width={`${28 + ((i * 23) % 22)}%`} height={11} />
          </div>
          <div style={{ width: 72, height: 30, borderRadius: 5, background: "linear-gradient(90deg, var(--surface-sub) 25%, var(--border) 50%, var(--surface-sub) 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.4s ease-in-out infinite" }} />
        </div>
      ))}
    </div>
  );
}

// ── Send button ───────────────────────────────────────────────────────────────

function SendButton({ patientId, onSent }: { patientId: string; onSent: () => void }) {
  const [state, setState] = useState<SendState>("idle");
  const reduced = useReducedMotion();
  const toast = useToast();

  async function handleSend(e: React.MouseEvent) {
    e.stopPropagation();
    if (state !== "idle") return;
    setState("sending");

    const outcome = await requestSend({ patientId });
    toast.outcome(outcome);

    // Only a real send shows the "Skickat ✓" confirmation; a dry run or a
    // refused send falls back to idle so the label never overstates what
    // happened. The toast carries the actual outcome.
    if (isRealSend(outcome.kind)) {
      setState("sent");
      setTimeout(() => onSent(), 700);
    } else if (outcome.kind === "dry_run") {
      setState("idle");
      onSent();
    } else {
      setState("failed");
      setTimeout(() => setState("idle"), 3000);
    }
  }

  const label =
    state === "sending" ? "Skickar…"
    : state === "sent" ? "Skickat ✓"
    : state === "failed" ? "Misslyckades"
    : "Skicka SMS";

  return (
    <button onClick={handleSend} className={`send-btn sweep-btn ${state !== "idle" ? state : ""}`}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state}
          initial={reduced ? {} : { opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? {} : { opacity: 0, y: 5 }}
          transition={{ duration: 0.14 }}
          style={{ display: "flex", alignItems: "center", gap: 5 }}
        >
          {state === "sending" && <Spinner />}
          {label}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function Spinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" style={{ animation: "spin 0.7s linear infinite", flexShrink: 0 }}>
      <circle cx="5.5" cy="5.5" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14 8" />
    </svg>
  );
}

// ── Modal header ──────────────────────────────────────────────────────────────

const HEADER = {
  background: "#073B2C",
  color: "#fff",
} as const;

// ── Modal ─────────────────────────────────────────────────────────────────────

function Modal({ type, onClose, onSmsSent }: {
  type: ModalType;
  onClose: () => void;
  onSmsSent: () => void;
}) {
  const reduced = useReducedMotion();
  const [readyPatients, setReadyPatients] = useState<ReadyPatient[]>([]);
  const [readyTotal, setReadyTotal] = useState(0);
  const [readyTotalPages, setReadyTotalPages] = useState(1);
  const [readyPage, setReadyPage] = useState(1);
  const [smsLogs, setSmsLogs] = useState<SmsLog[]>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortOrder>("oldest");

  const fetchData = useCallback(() => {
    if (!type) return;
    setLoading(true);
    const url =
      type === "ready" ? `/api/dashboard/ready-patients?sort=${sort}&page=${readyPage}`
      : type === "sms" ? "/api/dashboard/sms-this-month"
      : "/api/dashboard/review-items";
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (type === "ready") {
          setReadyPatients(data.items);
          setReadyTotal(data.total);
          setReadyTotalPages(data.totalPages);
        } else if (type === "sms") {
          setSmsLogs(data);
        } else {
          setReviewItems(data);
        }
      })
      .finally(() => setLoading(false));
  }, [type, sort, readyPage]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Reset to page 1 when sort changes
  useEffect(() => { setReadyPage(1); }, [sort]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handlePatientSent(patientId: string) {
    setReadyPatients((prev) => prev.filter((p) => p.id !== patientId));
    setReadyTotal((prev) => prev - 1);
    onSmsSent();
  }

  const title =
    type === "ready" ? "Redo för påminnelse"
    : type === "sms" ? "SMS denna månad"
    : "Inväntar granskning";

  const readyShown = Math.min(readyPage * 50, readyTotal);
  const footerText = loading ? null
    : type === "ready" ? `${readyShown} av ${readyTotal} patienter`
    : type === "sms" ? `${smsLogs.length} SMS`
    : `${reviewItems.length} ärenden`;

  const listVariants = {
    hidden: {},
    show: { transition: { staggerChildren: reduced ? 0 : 0.04, delayChildren: 0.04 } },
  };
  const rowVariants = {
    hidden: { opacity: 0, x: reduced ? 0 : -10 },
    show: { opacity: 1, x: 0, transition: { duration: 0.26, ease: [0, 0, 0.2, 1] as [number,number,number,number] } },
  };

  // Alternating row tint for differentiation
  const rowStyle = (i: number): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    padding: "16px 24px",
    borderBottom: "1px solid var(--border)",
    background: i % 2 === 1 ? "var(--surface-sub)" : "var(--surface)",
  });

  const renderRows = () => {
    if (loading) return <SkeletonRows count={7} />;

    if (type === "ready") {
      if (readyPatients.length === 0)
        return <p style={{ padding: "24px", fontSize: 14, color: "var(--text-muted)" }}>Inga patienter redo just nu.</p>;
      return (
        <motion.div variants={listVariants} initial="hidden" animate="show">
          <AnimatePresence initial={false}>
            {readyPatients.map((p, i) => (
              <motion.div
                key={p.id}
                variants={rowVariants}
                exit={{ opacity: 0, x: 24, transition: { duration: 0.22 } }}
                layout
                style={rowStyle(i)}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ fontWeight: 600, fontSize: 16, color: "var(--text)", marginBottom: 3 }}>{p.full_name}</p>
                  <p style={{ fontSize: 14, color: "var(--text-muted)", letterSpacing: "0.01em" }}>
                    {p.phone ?? "Saknar nummer"}
                    {p.latest_treatment ? <span style={{ color: "var(--text-faint)", margin: "0 5px" }}>·</span> : null}
                    {p.latest_treatment}
                  </p>
                  {(p.smsCount ?? 0) > 0 && (
                    <p style={{ fontSize: 12, fontWeight: 600, color: "#2a7a68", marginTop: 3, letterSpacing: "0.01em" }}>
                      {p.smsCount} SMS skicka{(p.smsCount ?? 0) !== 1 ? "de" : "t"}
                    </p>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                  <span style={{ fontSize: 14, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                    {formatDate(p.last_booking_at)}
                  </span>
                  <SendButton patientId={p.id} onSent={() => handlePatientSent(p.id)} />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      );
    }

    if (type === "sms") {
      if (smsLogs.length === 0)
        return <p style={{ padding: "24px", fontSize: 14, color: "var(--text-muted)" }}>Inga SMS skickade denna månad.</p>;
      return (
        <motion.div variants={listVariants} initial="hidden" animate="show">
          {smsLogs.map((l, i) => (
            <motion.div key={l.id} variants={rowVariants} style={rowStyle(i)}>
              <div>
                <p style={{ fontWeight: 600, fontSize: 16, color: "var(--text)", marginBottom: 3 }}>
                  {l.full_name ?? l.phone ?? "—"}
                </p>
                <p style={{ fontSize: 14, color: "var(--text-muted)" }}>{l.full_name ? (l.phone ?? "") : ""}</p>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
                {l.sequence_number && (
                  <span style={{
                    fontSize: 14, fontWeight: 700, color: "var(--text-muted)",
                    letterSpacing: "0.06em", textTransform: "uppercase",
                    background: "var(--surface-sub)", border: "1px solid var(--border)",
                    borderRadius: 4, padding: "2px 6px",
                  }}>
                    SMS {l.sequence_number}
                  </span>
                )}
                <span style={{ fontSize: 14, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                  {formatDate(l.sent_at)}
                </span>
              </div>
            </motion.div>
          ))}
        </motion.div>
      );
    }

    if (reviewItems.length === 0)
      return <p style={{ padding: "24px", fontSize: 14, color: "var(--text-muted)" }}>Inga ärenden inväntar granskning.</p>;
    return (
      <motion.div variants={listVariants} initial="hidden" animate="show">
        {reviewItems.map((item, i) => (
          <motion.div key={item.id} variants={rowVariants} style={{ ...rowStyle(i), alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <p style={{ fontWeight: 600, fontSize: 16, color: "var(--text)", marginBottom: 4 }}>{item.title}</p>
              <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.5 }}>{item.description}</p>
            </div>
            <span style={{
              fontSize: 12, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
              color: severityColor[item.severity], background: severityBg[item.severity],
              border: `1px solid ${severityBorder[item.severity]}`,
              borderRadius: "var(--radius-sm)", padding: "3px 8px", flexShrink: 0, marginTop: 2,
            }}>
              {severityLabel[item.severity]}
            </span>
          </motion.div>
        ))}
      </motion.div>
    );
  };

  return (
    <>
      <GlobalStyles />
      <motion.div
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.18 }}
        style={{
          position: "fixed", inset: 0,
          background: "rgba(4, 20, 15, 0.55)",
          zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 24,
        }}
      >
        <motion.div
          onClick={(e) => e.stopPropagation()}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
          transition={{ duration: reduced ? 0.15 : 0.28, ease: [0, 0, 0.2, 1] }}
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
            gap: 12,
            padding: "18px 24px",
            background: HEADER.background,
            flexShrink: 0,
          }}>
            <span style={{
              fontFamily: "var(--font-head)",
              fontWeight: 700,
              fontSize: 19,
              color: HEADER.color,
              letterSpacing: "-0.01em",
              flexShrink: 0,
            }}>{title}</span>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Sort toggle — only for ready list */}
              {type === "ready" && (
                <div style={{
                  display: "flex",
                  background: "rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  padding: 2,
                  gap: 2,
                }}>
                  {(["recent", "oldest"] as SortOrder[]).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setSort(opt)}
                      style={{
                        background: sort === opt ? "rgba(255,255,255,0.18)" : "transparent",
                        border: sort === opt ? "1px solid rgba(255,255,255,0.22)" : "1px solid transparent",
                        borderRadius: 4,
                        color: sort === opt ? "#fff" : "rgba(255,255,255,0.55)",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: "0.04em",
                        padding: "3px 9px",
                        transition: "all 0.15s",
                      }}
                    >
                      {opt === "oldest" ? "Äldst" : "Senast"}
                    </button>
                  ))}
                </div>
              )}

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
          </div>

          {/* Body */}
          <div style={{ overflowY: "auto", flex: 1 }}>{renderRows()}</div>

          {/* Footer */}
          <AnimatePresence>
            {footerText && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3, delay: 0.15 }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 16px 10px 24px",
                  borderTop: "1px solid var(--border)",
                  background: "var(--surface-sub)",
                  flexShrink: 0,
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 14, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                  {footerText}
                </span>
                {type === "ready" && readyTotalPages > 1 && (
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <button
                      onClick={() => setReadyPage((p) => Math.max(1, p - 1))}
                      disabled={readyPage === 1 || loading}
                      style={{
                        background: "none",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        cursor: readyPage === 1 ? "default" : "pointer",
                        fontSize: 14,
                        color: readyPage === 1 ? "var(--text-faint)" : "var(--text)",
                        padding: "3px 10px",
                        opacity: readyPage === 1 ? 0.4 : 1,
                      }}
                    >←</button>
                    <span style={{ fontSize: 14, color: "var(--text-muted)", padding: "0 4px", minWidth: 60, textAlign: "center" }}>
                      {readyPage} / {readyTotalPages}
                    </span>
                    <button
                      onClick={() => setReadyPage((p) => Math.min(readyTotalPages, p + 1))}
                      disabled={readyPage === readyTotalPages || loading}
                      style={{
                        background: "none",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        cursor: readyPage === readyTotalPages ? "default" : "pointer",
                        fontSize: 14,
                        color: readyPage === readyTotalPages ? "var(--text-faint)" : "var(--text)",
                        padding: "3px 10px",
                        opacity: readyPage === readyTotalPages ? 0.4 : 1,
                      }}
                    >→</button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </>
  );
}

// ── KpiStrip ──────────────────────────────────────────────────────────────────

type KpiItem = {
  label: string;
  value: number;
  clickable?: ModalType;
};

export function KpiStrip({ items: initialItems }: { items: KpiItem[] }) {
  const [open, setOpen] = useState<ModalType>(null);
  const [items, setItems] = useState(initialItems);
  const close = useCallback(() => setOpen(null), []);

  const refreshStats = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/stats");
      const data = await res.json();
      setItems((prev) =>
        prev.map((item) => {
          if (item.label === "Redo för påminnelse") return { ...item, value: data.readyForReminder };
          if (item.label === "SMS denna månad") return { ...item, value: data.smsSentThisMonth };
          return item;
        })
      );
    } catch { /* stale counts are fine */ }
  }, []);

  return (
    <>
      <GlobalStyles />
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        marginBottom: 20,
      }}>
        {items.map(({ label, value, clickable }, i) => (
          <motion.div
            key={label}
            onClick={clickable ? () => setOpen(clickable) : undefined}
            whileHover={clickable ? { backgroundColor: "var(--surface-sub)" } : undefined}
            whileTap={clickable ? { scale: 0.98 } : undefined}
            transition={{ duration: 0.12 }}
            style={{
              padding: "22px 24px",
              borderRight: i < 3 ? "1px solid var(--border)" : "none",
              cursor: clickable ? "pointer" : "default",
            }}
          >
            <p className="metric" style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {label}
              {clickable && <span style={{ fontSize: 12, color: "var(--text-faint)" }}>↗</span>}
            </p>
            <motion.p
              key={value}
              className="metric-value"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              style={{ color: value === 0 ? "var(--text-faint)" : "var(--text)" }}
            >
              {value}
            </motion.p>
          </motion.div>
        ))}
      </div>

      <AnimatePresence>
        {open && (
          <Modal key={open} type={open} onClose={close} onSmsSent={refreshStats} />
        )}
      </AnimatePresence>
    </>
  );
}
