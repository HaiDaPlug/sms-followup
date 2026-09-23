"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useToast } from "./ToastProvider";
import { Modal } from "./ui/Modal";
import {
  IconAlert,
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconFlask,
  IconMessage,
  IconPause,
  IconSend,
  IconUsers,
} from "./ui/icons";
import { daysSince, formatDate, formatNumber, plural } from "./ui/format";
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

type ModalType = "ready" | "sms" | "review";
type SendState = "idle" | "sending" | "sent" | "failed";
type SortOrder = "oldest" | "recent";

const severityLabel: Record<string, string> = { high: "Hög", medium: "Medel", low: "Låg" };
const severityChip: Record<string, string> = { high: "danger", medium: "warn", low: "neutral" };

function initials(name: string | null) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

// ── Send button ───────────────────────────────────────────────────────────────

function SendButton({ patientId, onSent }: { patientId: string; onSent: () => void }) {
  const [state, setState] = useState<SendState>("idle");
  const toast = useToast();

  async function handleSend(e: React.MouseEvent) {
    e.stopPropagation();
    if (state !== "idle") return;
    setState("sending");

    const outcome = await requestSend({ patientId });
    toast.outcome(outcome);

    // Only a real send shows the "Skickat" confirmation; a dry run or a
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

  return (
    <button
      type="button"
      onClick={handleSend}
      aria-busy={state === "sending"}
      className={`sm send-btn${state === "sent" ? " is-sent" : state === "failed" ? " is-failed" : ""}`}
      style={state === "sending" ? { opacity: 0.75, cursor: "progress" } : undefined}
    >
      {state === "sending" && <span className="spinner" aria-hidden="true" />}
      {state === "sent" && <IconCheck size={14} />}
      {state === "idle" && <IconSend size={14} />}
      {state === "sending" ? "Skickar…" : state === "sent" ? "Skickat" : state === "failed" ? "Misslyckades" : "Skicka SMS"}
    </button>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="list-row">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
            <span className="skeleton" style={{ width: 32, height: 32, flex: "0 0 auto" }} />
            <div style={{ flex: 1, display: "grid", gap: 7 }}>
              <span className="skeleton" style={{ width: `${46 + ((i * 37) % 30)}%`, height: 12 }} />
              <span className="skeleton" style={{ width: `${26 + ((i * 23) % 22)}%`, height: 10 }} />
            </div>
          </div>
          <span className="skeleton" style={{ width: 104, height: 30, borderRadius: 7 }} />
        </div>
      ))}
    </div>
  );
}

// ── List dialog ───────────────────────────────────────────────────────────────

function Empty({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <span className="empty-title">{title}</span>
      {sub && <span>{sub}</span>}
    </div>
  );
}

function ListDialog({ type, open, onClose, onSmsSent }: {
  type: ModalType;
  open: boolean;
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
  const [loadError, setLoadError] = useState(false);
  const [sort, setSort] = useState<SortOrder>("oldest");

  const fetchData = useCallback(() => {
    if (!open) return;
    setLoading(true);
    setLoadError(false);
    const url =
      type === "ready" ? `/api/dashboard/ready-patients?sort=${sort}&page=${readyPage}`
      : type === "sms" ? "/api/dashboard/sms-this-month"
      : "/api/dashboard/review-items";
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
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
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [type, open, sort, readyPage]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Reset to page 1 when sort changes
  useEffect(() => { setReadyPage(1); }, [sort]);

  function handlePatientSent(patientId: string) {
    setReadyPatients((prev) => prev.filter((p) => p.id !== patientId));
    setReadyTotal((prev) => prev - 1);
    onSmsSent();
  }

  const title =
    type === "ready" ? "Redo för påminnelse"
    : type === "sms" ? "SMS denna månad"
    : "Inväntar granskning";

  const description =
    type === "ready" ? "Kunder som har passerat en uppföljningsdag. Skicka direkt härifrån."
    : type === "sms" ? "Alla SMS som gått ut sedan den 1:a denna månad."
    : "Öppna ärenden som behöver ett beslut.";

  const readyFrom = readyTotal === 0 ? 0 : (readyPage - 1) * 50 + 1;
  const readyTo = Math.min(readyPage * 50, readyTotal);
  const footerText = loading ? "Laddar…"
    : type === "ready" ? (readyTotal === 0 ? "0 kunder" : `${readyFrom}–${readyTo} av ${formatNumber(readyTotal)} kunder`)
    : type === "sms" ? `${smsLogs.length} SMS`
    : `${reviewItems.length} ${plural(reviewItems.length, "ärende", "ärenden")}`;

  const listVariants = {
    hidden: {},
    show: { transition: { staggerChildren: reduced ? 0 : 0.03, delayChildren: 0.03 } },
  };
  const rowVariants = {
    hidden: { opacity: 0, y: reduced ? 0 : 4 },
    show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
  };

  const renderRows = () => {
    if (loading) return <SkeletonRows count={7} />;
    if (loadError) {
      return (
        <div className="empty-state">
          <span className="empty-icon"><IconAlert /></span>
          <span className="empty-title">Kunde inte ladda listan</span>
          <button type="button" className="secondary sm" onClick={fetchData} style={{ marginTop: 8 }}>Försök igen</button>
        </div>
      );
    }

    if (type === "ready") {
      if (readyPatients.length === 0) return <Empty icon={<IconCheck />} title="Inga kunder redo just nu" sub="Nya kunder dyker upp här när de passerar en uppföljningsdag." />;
      return (
        <motion.div variants={listVariants} initial="hidden" animate="show">
          <AnimatePresence initial={false}>
            {readyPatients.map((p) => {
              const days = daysSince(p.last_booking_at);
              return (
                <motion.div
                  key={p.id}
                  variants={rowVariants}
                  exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
                  layout
                  className="list-row"
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
                    <span className="avatar" aria-hidden="true">{initials(p.full_name)}</span>
                    <div style={{ minWidth: 0 }}>
                      <p className="list-title truncate">{p.full_name}</p>
                      <p className="list-sub truncate">
                        {p.phone ?? "Saknar nummer"}
                        {p.latest_treatment ? <> · {p.latest_treatment}</> : null}
                      </p>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <p className="tnum" style={{ fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--text-mid)" }}>
                        {days != null ? `${days} dagar sedan` : "—"}
                      </p>
                      <p className="list-sub">
                        {(p.smsCount ?? 0) > 0
                          ? `${p.smsCount} SMS skicka${(p.smsCount ?? 0) !== 1 ? "de" : "t"}`
                          : `Besök ${formatDate(p.last_booking_at)}`}
                      </p>
                    </div>
                    <SendButton patientId={p.id} onSent={() => handlePatientSent(p.id)} />
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </motion.div>
      );
    }

    if (type === "sms") {
      if (smsLogs.length === 0) return <Empty icon={<IconMessage />} title="Inga SMS skickade denna månad" />;
      return (
        <motion.div variants={listVariants} initial="hidden" animate="show">
          {smsLogs.map((l) => (
            <motion.div key={l.id} variants={rowVariants} className="list-row">
              <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                <span className="avatar" aria-hidden="true">{initials(l.full_name)}</span>
                <div style={{ minWidth: 0 }}>
                  <p className="list-title truncate">{l.full_name ?? l.phone ?? "—"}</p>
                  {l.full_name && l.phone && <p className="list-sub">{l.phone}</p>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
                {l.sequence_number ? <span className="tag">SMS {l.sequence_number}</span> : null}
                <span className="muted tnum">{formatDate(l.sent_at)}</span>
              </div>
            </motion.div>
          ))}
        </motion.div>
      );
    }

    if (reviewItems.length === 0) return <Empty icon={<IconCheck />} title="Inga ärenden inväntar granskning" />;
    return (
      <motion.div variants={listVariants} initial="hidden" animate="show">
        {reviewItems.map((item) => (
          <motion.div key={item.id} variants={rowVariants} className="list-row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="list-title">{item.title}</p>
              <p className="list-sub" style={{ marginTop: 2 }}>{item.description}</p>
            </div>
            <span className={`chip sm ${severityChip[item.severity]}`} style={{ marginTop: 2 }}>
              {severityLabel[item.severity]}
            </span>
          </motion.div>
        ))}
      </motion.div>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      headerExtra={
        type === "ready" ? (
          <div className="seg seg-sm" role="group" aria-label="Sortering">
            {(["oldest", "recent"] as SortOrder[]).map((opt) => (
              <button
                key={opt}
                type="button"
                className={sort === opt ? "active" : undefined}
                aria-pressed={sort === opt}
                onClick={() => setSort(opt)}
              >
                {opt === "oldest" ? "Äldst besök" : "Senast besök"}
              </button>
            ))}
          </div>
        ) : null
      }
      footer={
        <>
          <span className="tnum">{footerText}</span>
          {type === "ready" && readyTotalPages > 1 && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                type="button"
                className="icon-btn sm bordered"
                aria-label="Föregående sida"
                onClick={() => setReadyPage((p) => Math.max(1, p - 1))}
                disabled={readyPage === 1 || loading}
              >
                <IconArrowLeft size={14} />
              </button>
              <span className="tnum" style={{ minWidth: 56, textAlign: "center" }}>
                {readyPage} / {readyTotalPages}
              </span>
              <button
                type="button"
                className="icon-btn sm bordered"
                aria-label="Nästa sida"
                onClick={() => setReadyPage((p) => Math.min(readyTotalPages, p + 1))}
                disabled={readyPage === readyTotalPages || loading}
              >
                <IconArrowRight size={14} />
              </button>
            </div>
          )}
        </>
      }
    >
      {renderRows()}
    </Modal>
  );
}

// ── Dashboard overview: hero + KPI tiles ─────────────────────────────────────

export type DashboardOverviewProps = {
  totalPatients: number;
  readyForReminder: number;
  smsSentThisMonth: number;
  needsReviewCount: number;
  wouldSendToday: number;
  maxPerDay: number;
  isActive: boolean;
  dryRun: boolean;
};

export function KpiStrip({ initial }: { initial: DashboardOverviewProps }) {
  const [open, setOpenState] = useState<ModalType | null>(null);
  // The last opened list stays mounted while it animates closed.
  const [shown, setShown] = useState<ModalType>("ready");
  const [stats, setStats] = useState(initial);
  const close = useCallback(() => setOpenState(null), []);
  const setOpen = useCallback((type: ModalType) => {
    setShown(type);
    setOpenState(type);
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/stats");
      if (!res.ok) return;
      const data = await res.json();
      setStats((prev) => ({
        ...prev,
        readyForReminder: data.readyForReminder ?? prev.readyForReminder,
        smsSentThisMonth: data.smsSentThisMonth ?? prev.smsSentThisMonth,
        wouldSendToday: data.dryRun?.would_send_today ?? prev.wouldSendToday,
      }));
    } catch { /* stale counts are fine */ }
  }, []);

  const ready = stats.readyForReminder;

  return (
    <>
      <div className="grid-12" style={{ marginBottom: 16 }}>
        {/* Hero — the day's one question: who can we contact now? */}
        <section className="hero span-7 rise" style={{ ["--i" as string]: 1 }} aria-labelledby="hero-title">
          <p className="hero-eyebrow" id="hero-title">
            <IconSend size={14} /> Redo för påminnelse
          </p>
          <div className="hero-figure">
            <span className="hero-value">{formatNumber(ready)}</span>
            <p className="hero-text">
              {ready === 0
                ? "Ingen kund har passerat en uppföljningsdag just nu."
                : `${plural(ready, "kund har", "kunder har")} passerat en uppföljningsdag och kan kontaktas nu.`}
            </p>
          </div>

          <div className="hero-meta">
            {stats.isActive ? (
              <span>
                <strong>{formatNumber(stats.wouldSendToday)}</strong>
                SMS beräknas gå ut vid nästa automatiska körning
              </span>
            ) : (
              <span className="hero-note warn"><IconPause size={14} /> Automationen är pausad — inget skickas automatiskt</span>
            )}
            <span><strong>{formatNumber(stats.maxPerDay)}</strong>max per dag</span>
            {stats.dryRun && (
              <span className="hero-note"><IconFlask size={14} /> Testläge — SMS loggas men skickas inte</span>
            )}
          </div>

          <div className="hero-actions">
            <button type="button" className="accent" onClick={() => setOpen("ready")}>
              Visa och skicka <IconArrowRight size={14} />
            </button>
            <Link href="/app/patients?status=Ready" className="hero-link">
              Öppna i Kunder
            </Link>
          </div>
        </section>

        {/* Secondary KPIs */}
        <div className="span-5" style={{ display: "grid", gap: 12, alignContent: "stretch" }}>
          <button type="button" className="kpi-row rise" style={{ ["--i" as string]: 2 }} onClick={() => setOpen("sms")}>
            <span className="kpi-icon violet"><IconMessage /></span>
            <span>
              <span className="kpi-label" style={{ display: "block" }}>SMS denna månad</span>
              <span className="kpi-meta">Visa alla utskick</span>
            </span>
            <span className={`kpi-value${stats.smsSentThisMonth === 0 ? " is-zero" : ""}`}>
              {formatNumber(stats.smsSentThisMonth)}
            </span>
            <IconArrowRight className="kpi-arrow" />
          </button>

          <button type="button" className="kpi-row rise" style={{ ["--i" as string]: 3 }} onClick={() => setOpen("review")}>
            <span className={`kpi-icon ${stats.needsReviewCount > 0 ? "warn" : "neutral"}`}><IconAlert /></span>
            <span>
              <span className="kpi-label" style={{ display: "block" }}>Inväntar granskning</span>
              <span className="kpi-meta">{stats.needsReviewCount > 0 ? "Behöver ett beslut" : "Allt är granskat"}</span>
            </span>
            <span className={`kpi-value${stats.needsReviewCount === 0 ? " is-zero" : ""}`}>
              {formatNumber(stats.needsReviewCount)}
            </span>
            <IconArrowRight className="kpi-arrow" />
          </button>

          <Link href="/app/patients" className="kpi-row rise" style={{ ["--i" as string]: 4 }}>
            <span className="kpi-icon neutral"><IconUsers /></span>
            <span>
              <span className="kpi-label" style={{ display: "block" }}>Kunder totalt</span>
              <span className="kpi-meta">I registret</span>
            </span>
            <span className={`kpi-value${stats.totalPatients === 0 ? " is-zero" : ""}`}>
              {formatNumber(stats.totalPatients)}
            </span>
            <IconArrowRight className="kpi-arrow" />
          </Link>
        </div>
      </div>

      <ListDialog key={shown} type={shown} open={open !== null} onClose={close} onSmsSent={refreshStats} />
    </>
  );
}
