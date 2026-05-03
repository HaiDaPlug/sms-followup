"use client";

import { useState, useRef } from "react";
import type { ReminderSettings, SmsStep } from "@/types/clinic";
import { resolveSteps } from "@/lib/reminders/steps";

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

// ── Inline day editor chip ────────────────────────────────────────────────────

function DayChip({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(String(value));
    setEditing(true);
    setTimeout(() => { inputRef.current?.select(); }, 20);
  }

  function commit() {
    const n = parseInt(draft, 10);
    if (!Number.isNaN(n) && n > 0) onChange(n);
    setEditing(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") setEditing(false);
  }

  const chipStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    background: "var(--surface-sub)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    padding: "2px 8px",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
  };

  if (editing) {
    return (
      <span style={{ ...chipStyle, padding: "1px 6px", cursor: "text" }}>
        dag{" "}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          type="number"
          min={1}
          style={{
            width: 44,
            border: "none",
            background: "transparent",
            font: "inherit",
            fontSize: 11,
            fontWeight: 700,
            color: "var(--text)",
            outline: "none",
            padding: 0,
            textAlign: "center",
          }}
        />
      </span>
    );
  }

  return (
    <span style={chipStyle} onClick={startEdit} title="Klicka för att ändra dag">
      dag {value} ✎
    </span>
  );
}

// ── Single SMS step card ──────────────────────────────────────────────────────

function StepCard({
  index,
  step,
  total,
  onChange,
  onRemove,
}: {
  index: number;
  step: SmsStep;
  total: number;
  onChange: (s: SmsStep) => void;
  onRemove: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-muted)" }}>
          SMS {index + 1} —
        </span>
        <DayChip value={step.day} onChange={(day) => onChange({ ...step, day })} />
        {total > 1 && (
          <button
            type="button"
            className="secondary"
            onClick={onRemove}
            style={{
              marginLeft: "auto",
              fontSize: 11,
              padding: "2px 9px",
              minHeight: "unset",
              color: "var(--text-muted)",
            }}
          >
            Ta bort
          </button>
        )}
      </div>
      <textarea
        value={step.template}
        onChange={(e) => onChange({ ...step, template: e.target.value })}
        style={{ minHeight: 100 }}
      />
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

// ── Main form ─────────────────────────────────────────────────────────────────

export function SettingsForm({ settings }: { settings: ReminderSettings }) {
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"ok" | "error">("ok");
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(settings.dry_run_mode);
  const [steps, setSteps] = useState<SmsStep[]>(() => resolveSteps(settings));

  function updateStep(i: number, s: SmsStep) {
    setSteps((prev) => prev.map((x, idx) => (idx === i ? s : x)));
  }

  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addStep() {
    const lastDay = steps[steps.length - 1]?.day ?? 0;
    setSteps((prev) => [...prev, { day: lastDay + 30, template: "" }]);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const data = new FormData(event.currentTarget);

    // Sort steps by day before saving
    const sortedSteps = [...steps].sort((a, b) => a.day - b.day);

    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        send_time: data.get("send_time"),
        max_per_day: Number(data.get("max_per_day")),
        booking_link: data.get("booking_link"),
        clinic_name: data.get("clinic_name"),
        is_active: data.get("is_active") === "on",
        dry_run_mode: data.get("dry_run_mode") === "on",
        sms_steps: sortedSteps,
        // Keep legacy fields in sync with step 1/2/3 for backwards compat
        sms_template: sortedSteps[0]?.template ?? settings.sms_template,
        sms_template_2: sortedSteps[1]?.template ?? settings.sms_template_2,
        sms_template_3: sortedSteps[2]?.template ?? settings.sms_template_3,
        days_after_booking: sortedSteps[0]?.day ?? settings.days_after_booking,
      }),
    });
    setBusy(false);
    setMessageType(response.ok ? "ok" : "error");
    setMessage(response.ok ? "Inställningar sparade." : "Kunde inte spara.");
    if (response.ok) setSteps(sortedSteps);
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
            <label htmlFor="send_time">Sändningstid</label>
            <input defaultValue={settings.send_time} id="send_time" name="send_time" type="time" />
            <span className="field-hint">Klockslag för det dagliga batch-körningen.</span>
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label htmlFor="max_per_day">Max SMS per dag</label>
            <input defaultValue={settings.max_per_day} id="max_per_day" min="1" name="max_per_day" type="number" />
            <span className="field-hint">Tak per körning — skyddar mot oavsiktliga mass-skick.</span>
          </div>
        </div>
      </div>

      {/* ── SMS-mallar ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderTop: "none", padding: "24px 28px", display: "grid", gap: 24 }}>
        <SectionHeader
          title="SMS-mallar"
          description="Ett meddelande per steg. Klicka på dagen för att ändra när det skickas."
        />

        {steps.map((step, i) => (
          <StepCard
            key={i}
            index={i}
            step={step}
            total={steps.length}
            onChange={(s) => updateStep(i, s)}
            onRemove={() => removeStep(i)}
          />
        ))}

        <button
          type="button"
          className="secondary"
          onClick={addStep}
          style={{ alignSelf: "flex-start", fontSize: 12.5 }}
        >
          + Lägg till steg
        </button>
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
