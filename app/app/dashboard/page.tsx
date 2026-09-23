import Link from "next/link";
import { calculateDashboardStats } from "@/lib/reminders/eligibility";
import { getSettings } from "@/lib/data/repository";
import { KpiStrip } from "@/components/KpiStrip";
import { ActivityPanel } from "@/components/ActivityPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { IconAlert, IconArrowRight, IconCheck, IconFlask, IconInfo, IconPause, IconPulse } from "@/components/ui/icons";
import { PATIENT_STATUS } from "@/components/ui/status";
import { formatNumber } from "@/components/ui/format";

export const dynamic = "force-dynamic";

const TZ = "Europe/Stockholm";

// Where each nudge can be acted on. Keyed by the nudge title the engine emits;
// a nudge without an entry simply renders without a link.
const NUDGE_LINKS: Record<string, { href: string; label: string }> = {
  "Saknar telefonnummer": { href: "/app/patients?status=Missing%20phone", label: "Visa kunder" },
  "SMS-fel": { href: "/app/sms-history?tab=failed", label: "Visa misslyckade" },
  "Har bokat en tid": { href: "/app/patients?status=Future%20booking", label: "Visa kunder" },
};

function statusHref(status: string) {
  return `/app/patients?status=${encodeURIComponent(status)}`;
}

function share(count: number, total: number) {
  if (count === 0) return "0 %";
  const pct = (count / total) * 100;
  return pct < 1 ? "<1 %" : `${Math.round(pct)} %`;
}

function greeting(now: Date) {
  const hour = Number(now.toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ }));
  if (hour < 10) return "God morgon";
  if (hour < 17) return "God dag";
  return "God kväll";
}

export default async function DashboardPage() {
  // Settings come from their own one-row query: the store snapshot is already
  // read inside calculateDashboardStats, and a second full read would double
  // the dashboard's load time.
  const [stats, settings] = await Promise.all([calculateDashboardStats(), getSettings()]);
  const now = new Date();

  const highNudges  = stats.nudges.filter((n) => n.severity === "high");
  const otherNudges = stats.nudges.filter((n) => n.severity !== "high");

  // Every patient, split by where they stand before the next run. "Övriga"
  // is whatever the engine counts as waiting, done or bookingless.
  const d = stats.dryRun;
  const accounted =
    d.eligible_count + d.excluded_future_booking + d.excluded_missing_phone +
    d.excluded_do_not_contact + d.needs_review;
  const pool = [
    { key: "Ready",          label: "Redo att kontakta", sub: "patienter",       count: d.eligible_count,          color: PATIENT_STATUS.Ready.dot },
    { key: "Future booking", label: "Har bokat en tid",  sub: "hoppas över",     count: d.excluded_future_booking, color: PATIENT_STATUS["Future booking"].dot },
    { key: "Needs review",   label: "Granskas",          sub: "inväntar åtgärd", count: d.needs_review,            color: PATIENT_STATUS["Needs review"].dot },
    { key: "Missing phone",  label: "Saknar telefon",    sub: "kan ej nås",      count: d.excluded_missing_phone,  color: PATIENT_STATUS["Missing phone"].dot },
    { key: "Do not contact", label: "Kontakta ej",       sub: "blockerade",      count: d.excluded_do_not_contact, color: PATIENT_STATUS["Do not contact"].dot },
    { key: "Waiting",        label: "Väntar eller klara", sub: "ingen uppföljning aktuell", count: Math.max(0, stats.totalPatients - accounted), color: "#cfd5d2" },
  ];
  const poolTotal = Math.max(1, stats.totalPatients);

  return (
    <div className="page">
      <PageHeader
        eyebrow={now.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ })}
        title="Översikt"
        subtitle={`${greeting(now)} — här är läget för påminnelser, prognos och SMS-aktivitet.`}
        actions={
          <Link href="/app/settings" className="row" title="Ändra i Inställningar" style={{ gap: 8 }}>
            {settings?.is_active ? (
              <span className="chip ok plain"><IconPulse size={14} />Automation på</span>
            ) : (
              <span className="chip warn plain"><IconPause size={14} />Automation pausad</span>
            )}
            {settings?.dry_run_mode ? (
              <span className="chip info plain"><IconFlask size={14} />Testläge</span>
            ) : (
              <span className="chip sent">Skarpt läge</span>
            )}
          </Link>
        }
      />

      {/* ── High-severity alerts ── */}
      {highNudges.length > 0 && (
        <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
          {highNudges.map((nudge, i) => {
            const link = NUDGE_LINKS[nudge.title];
            return (
              <div key={nudge.title} className="alert rise" role="alert" style={{ ["--i" as string]: i }}>
                <span className="alert-icon"><IconAlert /></span>
                <div style={{ minWidth: 0 }}>
                  <p className="alert-title">{nudge.title}</p>
                  <p className="alert-desc">{nudge.description}</p>
                </div>
                {link ? (
                  <Link href={link.href} className="button danger sm alert-action">
                    {link.label} <IconArrowRight size={14} />
                  </Link>
                ) : (
                  <span className="chip danger plain sm alert-action">Åtgärd krävs</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Hero + KPI tiles (client: they open the list dialogs) ── */}
      <KpiStrip
        initial={{
          totalPatients: stats.totalPatients,
          readyForReminder: stats.readyForReminder,
          smsSentThisMonth: stats.smsSentThisMonth,
          needsReviewCount: stats.needsReviewCount,
          wouldSendToday: d.would_send_today,
          maxPerDay: settings?.max_per_day ?? d.would_send_today,
          isActive: settings?.is_active ?? false,
          dryRun: settings?.dry_run_mode ?? false,
        }}
      />

      <div className="grid-12" style={{ alignItems: "start" }}>
        <div className="span-7 stack">
        {/* ── Patient pool (the old "Daglig prognos", as one picture) ── */}
        <section className="panel rise" style={{ ["--i" as string]: 5 }}>
          <div className="panel-head">
            <div>
              <h2 className="panel-title">Daglig prognos</h2>
              <p className="panel-sub">
                Var alla {formatNumber(stats.totalPatients)} kunder står inför nästa körning
                {" · "}{formatNumber(d.estimated_sms_count)} beräknade SMS
              </p>
            </div>
            <Link href="/app/patients" className="panel-link">
              Alla kunder <IconArrowRight size={14} />
            </Link>
          </div>
          <div className="panel-body">
            <div
              className="pool-bar"
              role="img"
              aria-label={pool.map((p) => `${p.label}: ${p.count}`).join(", ")}
            >
              {pool.filter((p) => p.count > 0).map((p) => (
                <span
                  key={p.key}
                  className="pool-seg"
                  title={`${p.label}: ${formatNumber(p.count)}`}
                  style={{ width: `${(p.count / poolTotal) * 100}%`, background: p.color }}
                />
              ))}
            </div>

            <ul className="pool-legend">
              {pool.map((p) => (
                <li key={p.key}>
                  <Link href={statusHref(p.key)}>
                    <span className="pool-dot" style={{ background: p.color }} />
                    <span className="pool-name">
                      {p.label}
                      <small>{p.sub}</small>
                    </span>
                    <span className={`pool-count${p.count === 0 ? " is-zero" : ""}`}>{formatNumber(p.count)}</span>
                    <span className="pool-pct">{share(p.count, poolTotal)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

          {/* ── Warnings ── */}
          <section className="panel rise" style={{ ["--i" as string]: 6 }}>
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Varningar</h2>
                <p className="panel-sub">Saker att hålla koll på</p>
              </div>
              {otherNudges.length > 0 && <span className="tab-count">{otherNudges.length}</span>}
            </div>
            {otherNudges.length === 0 ? (
              <div className="row" style={{ padding: "16px 20px", gap: 10, color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>
                <span className="kpi-icon" style={{ width: 28, height: 28, borderRadius: 8 }}><IconCheck size={14} /></span>
                Inga aktiva varningar.
              </div>
            ) : (
              <ul style={{ listStyle: "none" }}>
                {otherNudges.map((nudge) => {
                  const link = NUDGE_LINKS[nudge.title];
                  return (
                    <li key={nudge.title} className="nudge-row">
                      <span
                        className={`kpi-icon ${nudge.severity === "medium" ? "warn" : "neutral"}`}
                        style={{ width: 28, height: 28, borderRadius: 8 }}
                      >
                        {nudge.severity === "medium" ? <IconAlert size={14} /> : <IconInfo size={14} />}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontWeight: 600, lineHeight: 1.35 }}>{nudge.title}</p>
                        <p className="list-sub">{nudge.description}</p>
                        {link && (
                          <Link href={link.href} className="panel-link" style={{ marginTop: 6 }}>
                            {link.label} <IconArrowRight size={14} />
                          </Link>
                        )}
                      </div>
                      <span className={`chip sm plain ${nudge.severity === "medium" ? "warn" : "neutral"}`}>
                        {nudge.severity === "medium" ? "Medel" : "Låg"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

        </div>

        {/* ── Activity ── */}
        <div className="span-5 rise" style={{ ["--i" as string]: 7 }}>
          <ActivityPanel preview={stats.recentReminderActivity} />
        </div>
      </div>
    </div>
  );
}
