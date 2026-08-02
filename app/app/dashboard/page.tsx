import { calculateDashboardStats } from "@/lib/reminders/eligibility";
import { formatDate } from "@/lib/patients/status";
import { KpiStrip } from "@/components/KpiStrip";
import { ActivityPanel } from "@/components/ActivityPanel";

export const dynamic = "force-dynamic";

const dryRunLabels: Record<string, { label: string; sub: string }> = {
  eligible_count:           { label: "Redo att kontakta",   sub: "patienter" },
  would_send_today:         { label: "Skickas idag",         sub: "enligt dagsgräns" },
  excluded_missing_phone:   { label: "Saknar telefon",       sub: "kan ej nås" },
  excluded_future_booking:  { label: "Har bokat en tid",      sub: "hoppas över" },
  excluded_do_not_contact:  { label: "Kontakta ej",          sub: "blockerade" },
  needs_review:             { label: "Granskas",             sub: "inväntar åtgärd" },
  estimated_sms_count:      { label: "Beräknade SMS",        sub: "nästa körning" },
};

const statusSv: Record<string, string> = {
  sent:      "Skickat",
  dry_run:   "Testläge",
  failed:    "Misslyckades",
  skipped:   "Hoppades över",
};

const S = {
  sectionHeader: {
    padding: "12px 20px",
    borderBottom: "1px solid var(--border)",
    background: "var(--surface-sub)",
  } as React.CSSProperties,
  sectionLabel: {
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: "0.07em",
    textTransform: "uppercase" as const,
    color: "var(--text-muted)",
  } as React.CSSProperties,
  panel: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    overflow: "hidden",
  } as React.CSSProperties,
};

export default async function DashboardPage() {
  const stats = await calculateDashboardStats();

  const highNudges  = stats.nudges.filter((n) => n.severity === "high");
  const otherNudges = stats.nudges.filter((n) => n.severity !== "high");

  return (
    <div style={{ maxWidth: 1020 }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 32 }}>
        <p style={{ ...S.sectionLabel, marginBottom: 8 }}>
          {new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" })}
        </p>
        <h2 className="page-title">Översikt</h2>
        <p className="page-subtitle">Daglig sammanfattning av påminnelser, prognoser och SMS-aktivitet.</p>
      </div>

      {/* ── KPI strip — 4 numbers separated by hairlines ── */}
      <KpiStrip items={[
        { label: "Kunder totalt",    value: stats.totalPatients },
        { label: "Redo för påminnelse", value: stats.readyForReminder, clickable: "ready" },
        { label: "SMS denna månad",     value: stats.smsSentThisMonth, clickable: "sms" },
        { label: "Inväntar granskning", value: stats.needsReviewCount, clickable: "review" },
      ]} />

      {/* ── High-severity alerts ── */}
      {highNudges.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginBottom: 20 }}>
          {highNudges.map((nudge) => (
            <div key={nudge.title} style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              background: "var(--red-bg)",
              border: "1px solid var(--red-border)",
              borderRadius: "var(--radius)",
              padding: "13px 18px",
            }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: 14, color: "var(--red)", marginRight: 10 }}>
                  {nudge.title}
                </span>
                <span style={{ fontSize: 13, color: "var(--red)", opacity: 0.75 }}>{nudge.description}</span>
              </div>
              <span style={{
                ...S.sectionLabel,
                color: "var(--red)",
                opacity: 0.6,
                flexShrink: 0,
              }}>Åtgärd krävs</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Two-column: Prognos | Varningar + Aktivitet ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Prognos */}
        <div style={S.panel}>
          <div style={S.sectionHeader}>
            <span style={S.sectionLabel}>Daglig prognos</span>
          </div>
          {Object.entries(stats.dryRun).map(([key, value]) => {
            const meta = dryRunLabels[key];
            if (!meta) return null;
            return (
              <div key={key} style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "11px 20px",
                borderBottom: "1px solid var(--border)",
              }}>
                <div>
                  <span style={{ fontWeight: 500, fontSize: 13.5, color: "var(--text)" }}>{meta.label}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 6 }}>{meta.sub}</span>
                </div>
                <span style={{
                  fontFamily: "var(--font-head)",
                  fontSize: 20,
                  fontWeight: 900,
                  letterSpacing: "-0.02em",
                  color: value === 0 ? "var(--text-faint)" : "var(--text)",
                }}>{value}</span>
              </div>
            );
          })}
        </div>

        {/* Right column */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>

          {/* Varningar */}
          <div style={S.panel}>
            <div style={S.sectionHeader}>
              <span style={S.sectionLabel}>Varningar</span>
            </div>
            {otherNudges.length === 0 ? (
              <p style={{ padding: "16px 20px", fontSize: 13, color: "var(--text-muted)" }}>
                Inga aktiva varningar.
              </p>
            ) : (
              otherNudges.map((nudge) => (
                <div key={nudge.title} style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "12px 20px",
                  borderBottom: "1px solid var(--border)",
                }}>
                  <div>
                    <p style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 2 }}>{nudge.title}</p>
                    <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.4 }}>{nudge.description}</p>
                  </div>
                  <span style={{
                    ...S.sectionLabel,
                    background: "var(--amber-bg)",
                    color: "var(--amber)",
                    borderRadius: "var(--radius-sm)",
                    padding: "3px 7px",
                    flexShrink: 0,
                    border: "1px solid var(--amber-border)",
                  }}>
                    {nudge.severity === "medium" ? "Medel" : "Låg"}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Senaste aktivitet */}
          <ActivityPanel
            preview={stats.recentReminderActivity}
            sectionHeaderStyle={S.sectionHeader}
            sectionLabelStyle={S.sectionLabel}
          />

        </div>
      </div>
    </div>
  );
}
