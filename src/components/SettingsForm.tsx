"use client";

import { useState } from "react";
import type { ReminderSettings } from "@/types/clinic";

const VARIABLES_HINT = "{{firstName}}  {{fullName}}  {{lastBookingDate}}  {{bookingLink}}  {{clinicName}}";

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 18, marginBottom: 6 }}>
      <div style={{ fontFamily: "var(--font-head)", fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 3 }}>
        {title}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{description}</div>
    </div>
  );
}

function TemplateField({
  id,
  name,
  label,
  badge,
  defaultValue,
}: {
  id: string;
  name: string;
  label: string;
  badge: string;
  defaultValue: string;
}) {
  return (
    <div className="field" style={{ gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label htmlFor={id} style={{ margin: 0 }}>{label}</label>
        <span style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          background: "var(--accent-bg)",
          color: "var(--accent)",
          borderRadius: 4,
          padding: "2px 7px",
        }}>{badge}</span>
      </div>
      <textarea defaultValue={defaultValue} id={id} name={name} style={{ minHeight: 100 }} />
      <div style={{
        background: "var(--surface-sub)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: "7px 11px",
        fontSize: 11.5,
        color: "var(--text-muted)",
        letterSpacing: "0.02em",
        fontFamily: "ui-monospace, monospace",
        lineHeight: 1.8,
      }}>
        {VARIABLES_HINT}
      </div>
    </div>
  );
}

export function SettingsForm({ settings }: { settings: ReminderSettings }) {
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"ok" | "error">("ok");
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(settings.dry_run_mode);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        days_after_booking: Number(data.get("days_after_booking")),
        send_time: data.get("send_time"),
        max_per_day: Number(data.get("max_per_day")),
        sms_template: data.get("sms_template"),
        sms_template_2: data.get("sms_template_2"),
        sms_template_3: data.get("sms_template_3"),
        booking_link: data.get("booking_link"),
        clinic_name: data.get("clinic_name"),
        is_active: data.get("is_active") === "on",
        dry_run_mode: data.get("dry_run_mode") === "on",
      }),
    });
    setBusy(false);
    setMessageType(response.ok ? "ok" : "error");
    setMessage(response.ok ? "Inställningar sparade." : "Kunde inte spara.");
  }

  async function testSms() {
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/reminders/test", { method: "POST" });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; status?: string };
    setBusy(false);
    setMessageType(response.ok ? "ok" : "error");
    setMessage(response.ok ? "Testmeddelande skickat." : payload.error ?? "Test misslyckades.");
  }

  const step = settings.days_after_booking;

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 0, maxWidth: 760 }}>

      {/* ── Klinik & timing ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px 28px", display: "grid", gap: 20 }}>
        <SectionHeader
          title="Klinik & timing"
          description="Vad kliniken heter, när SMS skickas och hur många per dag."
        />

        <div className="grid cols-2">
          <div className="field">
            <label htmlFor="clinic_name">Klinikens namn</label>
            <input defaultValue={settings.clinic_name} id="clinic_name" name="clinic_name" placeholder="Kliniken" />
          </div>
          <div className="field">
            <label htmlFor="booking_link">Bokningslänk</label>
            <input defaultValue={settings.booking_link} id="booking_link" name="booking_link" type="url" placeholder="https://..." />
          </div>
        </div>

        <div className="grid cols-2">
          <div className="field">
            <label htmlFor="days_after_booking">Dagar mellan steg</label>
            <input
              defaultValue={settings.days_after_booking}
              id="days_after_booking"
              min="1"
              name="days_after_booking"
              type="number"
            />
            <span className="field-hint">SMS 1 på dag {step}, SMS 2 på dag {step * 2}, SMS 3 på dag {step * 3}.</span>
          </div>
          <div className="field">
            <label htmlFor="send_time">Sändningstid</label>
            <input defaultValue={settings.send_time} id="send_time" name="send_time" type="time" />
            <span className="field-hint">Klockslag för det dagliga batch-körningen.</span>
          </div>
        </div>

        <div className="field" style={{ maxWidth: 220 }}>
          <label htmlFor="max_per_day">Max SMS per dag</label>
          <input defaultValue={settings.max_per_day} id="max_per_day" min="1" name="max_per_day" type="number" />
          <span className="field-hint">Tak per körning — skyddar mot oavsiktliga mass-skick.</span>
        </div>
      </div>

      {/* ── SMS-mallar ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderTop: "none", padding: "24px 28px", display: "grid", gap: 24 }}>
        <SectionHeader
          title="SMS-mallar"
          description="Tre meddelanden — ett per steg. Varje mall skickas exakt en gång per cykel per patient."
        />

        <TemplateField
          id="sms_template"
          name="sms_template"
          label={`SMS 1 — dag ${step}`}
          badge="Steg 1"
          defaultValue={settings.sms_template}
        />
        <TemplateField
          id="sms_template_2"
          name="sms_template_2"
          label={`SMS 2 — dag ${step * 2}`}
          badge="Steg 2"
          defaultValue={settings.sms_template_2}
        />
        <TemplateField
          id="sms_template_3"
          name="sms_template_3"
          label={`SMS 3 — dag ${step * 3}`}
          badge="Steg 3"
          defaultValue={settings.sms_template_3}
        />
      </div>

      {/* ── Körläge ── */}
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderTop: "none",
        borderRadius: "0 0 var(--radius) var(--radius)",
        padding: "24px 28px",
        display: "grid",
        gap: 16,
      }}>
        <SectionHeader
          title="Körläge"
          description="Styr om automationen är aktiv och om SMS ska skickas på riktigt."
        />

        <label style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          padding: "14px 16px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)",
          cursor: "pointer",
          background: "var(--surface-sub)",
        }}>
          <input defaultChecked={settings.is_active} name="is_active" type="checkbox" style={{ marginTop: 2, width: 15, height: 15, accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)" }}>Aktivera automatiska påminnelser</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>Daglig körning sker klockan {settings.send_time} om detta är aktiverat.</div>
          </div>
        </label>

        <label style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          padding: "14px 16px",
          borderRadius: "var(--radius-sm)",
          border: dryRun ? "1px solid var(--amber-border)" : "1px solid var(--border)",
          cursor: "pointer",
          background: dryRun ? "var(--amber-bg)" : "var(--surface-sub)",
          transition: "background 200ms, border-color 200ms",
        }}>
          <input
            checked={dryRun}
            name="dry_run_mode"
            type="checkbox"
            onChange={(e) => setDryRun(e.target.checked)}
            style={{ marginTop: 2, width: 15, height: 15, accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
          />
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5, color: dryRun ? "var(--amber)" : "var(--text)" }}>
              {dryRun ? "Testläge aktiverat" : "Testläge avaktiverat"}
            </div>
            <div style={{ fontSize: 12, color: dryRun ? "var(--amber)" : "var(--text-muted)", opacity: 0.85, marginTop: 2 }}>
              {dryRun ? "SMS loggas men skickas inte. Avaktivera när du är redo att skicka på riktigt." : "SMS skickas på riktigt. Aktivera testläget igen om du vill simulera."}
            </div>
          </div>
        </label>

        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 4 }}>
          <button disabled={busy} type="submit">
            {busy ? "Sparar…" : "Spara inställningar"}
          </button>
          {dryRun && (
            <button className="secondary" disabled={busy} onClick={testSms} type="button">
              Skicka test-SMS
            </button>
          )}
          {message && (
            <span style={{ fontSize: 13, color: messageType === "ok" ? "var(--accent)" : "var(--red)", fontWeight: 500 }}>
              {message}
            </span>
          )}
        </div>
      </div>

    </form>
  );
}
