"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ReminderSettings, SmsStep } from "@/types/clinic";
import { resolveSteps } from "@/lib/reminders/steps";

const VARIABLES_HINT = "{{firstName}} / {{förnamn}}  {{fullName}}  {{lastBookingDate}}  {{bookingLink}}  {{clinicName}}";

// GSM-7 basic charset. Every character listed here is a single GSM-7 unit
// except those also in GSM7_EXTENDED, which consume 2 units (escape + char).
// Anything outside this set forces UCS-2 encoding for the whole message.
const GSM7_CHARS = new Set([
  // Basic table
  ..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !\"#¤%&'()*+,-./:;<=>?¡",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑܧ¿",
  ..."abcdefghijklmnopqrstuvwxyzäöñüà",
  ..."0123456789",
  // Extension table (each costs 2 units)
  ..."[]{}\\^~|€",
]);

// Extension table chars each count as 2 GSM-7 units (ESC + char)
const GSM7_EXTENDED = new Set(..."[]{}\\^~|€");

// Count UCS-2 code units (each BMP char = 1, each emoji/supplementary = 2)
function ucs2Length(text: string): number {
  let n = 0;
  for (const cp of text) {
    n += (cp.codePointAt(0) ?? 0) > 0xFFFF ? 2 : 1;
  }
  return n;
}

// Substitute placeholders with realistic example values so the counter
// reflects what will actually be sent, not the raw template string.
const PLACEHOLDER_EXAMPLES: Record<string, string> = {
  "{{firstName}}":       "Anna",
  "{{förnamn}}":         "Anna",
  "{{fullName}}":        "Anna Svensson",
  "{{fullständigtNamn}}": "Anna Svensson",
  "{{lastName}}":        "Svensson",
  "{{efternamn}}":       "Svensson",
  "{{lastBookingDate}}": "2026-04-01",
  "{{senasteBesök}}":    "2026-04-01",
  "{{bookingLink}}":     "https://bokadirekt.se/osteopaticentrum",
  "{{bokningsLänk}}":    "https://bokadirekt.se/osteopaticentrum",
  "{{clinicName}}":      "Osteopati Centrum",
  "{{klinikNamn}}":      "Osteopati Centrum",
};

function expandTemplate(template: string): string {
  return Object.entries(PLACEHOLDER_EXAMPLES).reduce(
    (t, [key, val]) => t.replaceAll(key, val),
    template
  );
}

function findFirstNonGsm7(text: string): string | null {
  for (const ch of text) {
    if (!GSM7_CHARS.has(ch)) return ch;
  }
  return null;
}

function analyzeSms(text: string) {
  let isUcs2 = false;
  let firstOffender: string | null = null;
  for (const ch of text) {
    if (!GSM7_CHARS.has(ch)) { isUcs2 = true; firstOffender = ch; break; }
  }

  let charCount: number;
  if (isUcs2) {
    charCount = ucs2Length(text);
  } else {
    charCount = 0;
    for (const ch of text) {
      charCount += GSM7_EXTENDED.has(ch) ? 2 : 1;
    }
  }

  const singleLimit = isUcs2 ? 70 : 160;
  const multiLimit  = isUcs2 ? 67 : 153;

  const parts = charCount <= singleLimit ? 1 : Math.ceil(charCount / multiLimit);
  const used  = parts === 1 ? charCount : charCount - multiLimit * (parts - 1);
  const remaining = (parts === 1 ? singleLimit : multiLimit) - used;

  return { charCount, parts, remaining, isUcs2, firstOffender };
}

function SmsCounter({ template }: { template: string }) {
  if (!template.trim()) return null;

  const expanded = expandTemplate(template);
  const { charCount, parts, remaining, isUcs2, firstOffender } = analyzeSms(expanded);

  // Also check the raw template for non-GSM7 so we can warn about it directly
  const rawOffender = findFirstNonGsm7(template);

  const multiPart = parts > 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        fontSize: 11.5,
        color: isUcs2 ? "var(--amber)" : "var(--text-muted)",
        fontVariantNumeric: "tabular-nums",
      }}>
        <span title="Beräknat efter att variabler ersatts med exempelvärden">
          ~{charCount} tecken
        </span>
        <span style={{ color: "var(--border)" }}>·</span>
        <span style={{ fontWeight: multiPart ? 600 : 400, color: multiPart ? "var(--text)" : undefined }}>
          {parts} {parts === 1 ? "SMS-del" : "SMS-delar"}
        </span>
        <span style={{ color: "var(--border)" }}>·</span>
        <span>{remaining} kvar i sista</span>
        {isUcs2 && (
          <span style={{
            background: "var(--amber-bg)",
            border: "1px solid var(--amber-border)",
            color: "var(--amber)",
            borderRadius: 3,
            padding: "1px 6px",
            fontWeight: 700,
            fontSize: 10.5,
          }}>
            UCS-2 · max {parts === 1 ? 70 : 67}/del
          </span>
        )}
      </div>
      {isUcs2 && rawOffender && (
        <div style={{ fontSize: 11, color: "var(--amber)", opacity: 0.85 }}>
          Orsakas av: &ldquo;{rawOffender}&rdquo; — inte ett GSM-7-tecken
        </div>
      )}
      {isUcs2 && !rawOffender && firstOffender && (
        <div style={{ fontSize: 11, color: "var(--amber)", opacity: 0.85 }}>
          Orsakas av exempelvärde: &ldquo;{firstOffender}&rdquo;
        </div>
      )}
    </div>
  );
}

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

// ── Emoji picker ─────────────────────────────────────────────────────────────

const EMOJI_GROUPS = [
  { label: "Vanliga", emojis: ["😊","😄","😁","🙏","👍","❤️","✨","🌟","💪","🎉","👋","😍","🥰","😘","💖","🔥","✅","⭐","🌸","💐"] },
  { label: "Hälsa",  emojis: ["💆","🧘","💉","🩺","🏥","💊","🌿","🍃","🌱","💚","🫁","🦷","👁️","🫀","🤸","🧠","🩹","🩻","🫶","🤍"] },
  { label: "Tid",    emojis: ["📅","📆","⏰","🕐","🗓️","⌚","⏳","🔔","📣","💬","📩","📲","✉️","📋","🗒️","🖊️","📌","🔗","📎","🗂️"] },
];
const ALL_EMOJIS = EMOJI_GROUPS.flatMap((g) => g.emojis);

function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => searchRef.current?.focus(), 30);
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const visibleEmojis = search.trim()
    ? ALL_EMOJIS.filter((e) => e.includes(search.trim()))
    : EMOJI_GROUPS[tab].emojis;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setSearch(""); }}
        title="Lägg till emoji"
        style={{
          background: "none",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "3px 8px",
          fontSize: 15,
          cursor: "pointer",
          lineHeight: 1,
          minHeight: "unset",
          color: "var(--text-muted)",
        }}
      >
        😊
      </button>

      {open && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          left: 0,
          zIndex: 100,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
          width: 292,
          padding: "10px 10px 12px",
        }}>
          {/* Search */}
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Sök emoji…"
            style={{
              width: "100%",
              marginBottom: 8,
              fontSize: 12,
              padding: "5px 8px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "var(--surface-sub)",
              color: "var(--text)",
              boxSizing: "border-box",
            }}
          />

          {/* Tabs — hidden during search */}
          {!search.trim() && (
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {EMOJI_GROUPS.map((g, i) => (
                <button
                  key={g.label}
                  type="button"
                  onClick={() => setTab(i)}
                  style={{
                    flex: 1,
                    fontSize: 11,
                    fontWeight: tab === i ? 700 : 400,
                    padding: "3px 0",
                    border: "none",
                    borderBottom: tab === i ? "2px solid var(--accent)" : "2px solid transparent",
                    background: "none",
                    color: tab === i ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer",
                    minHeight: "unset",
                    borderRadius: 0,
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>
          )}

          {/* Grid */}
          {visibleEmojis.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "10px 0" }}>
              Inga träffar
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 2 }}>
              {visibleEmojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => onPick(emoji)}
                  style={{
                    fontSize: 18,
                    lineHeight: 1,
                    padding: "4px 2px",
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    borderRadius: 4,
                    minHeight: "unset",
                    transition: "background 100ms",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-sub)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function insertEmoji(emoji: string) {
    const el = textareaRef.current;
    if (!el) {
      onChange({ ...step, template: step.template + emoji });
      return;
    }
    const start = el.selectionStart ?? step.template.length;
    const end = el.selectionEnd ?? start;
    const next = step.template.slice(0, start) + emoji + step.template.slice(end);
    onChange({ ...step, template: next });
    // Use raw .length (UTF-16 code units) for selectionRange — same as browser's internal offset
    const newCursor = start + emoji.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    });
  }

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
        ref={textareaRef}
        value={step.template}
        onChange={(e) => onChange({ ...step, template: e.target.value })}
        style={{ minHeight: 100 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <EmojiPicker onPick={insertEmoji} />
        <SmsCounter template={step.template} />
      </div>
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
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"ok" | "error">("ok");
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(settings.dry_run_mode);
  const [sameNumberOverride, setSameNumberOverride] = useState(settings.allow_same_number_override ?? false);
  const [steps, setSteps] = useState<SmsStep[]>(() => resolveSteps(settings));
  const [clinicName, setClinicName] = useState(settings.clinic_name);
  const [bookingLink, setBookingLink] = useState(settings.booking_link);
  const [sendTime, setSendTime] = useState(settings.send_time);
  const [maxPerDay, setMaxPerDay] = useState(settings.max_per_day);

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

    const isActive = (event.currentTarget.elements.namedItem("is_active") as HTMLInputElement)?.checked ?? false;

    // Sort steps by day before saving
    const sortedSteps = [...steps].sort((a, b) => a.day - b.day);

    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        send_time: sendTime,
        max_per_day: Number(maxPerDay),
        booking_link: bookingLink,
        clinic_name: clinicName,
        is_active: isActive,
        dry_run_mode: dryRun,
        allow_same_number_override: sameNumberOverride,
        sms_steps: sortedSteps,
        // Keep legacy fields in sync with step 1/2/3 for backwards compat
        sms_template: sortedSteps[0]?.template ?? settings.sms_template,
        sms_template_2: sortedSteps[1]?.template ?? settings.sms_template_2,
        sms_template_3: sortedSteps[2]?.template ?? settings.sms_template_3,
        days_after_booking: sortedSteps[0]?.day ?? settings.days_after_booking,
      }),
    });
    setBusy(false);
    if (response.ok) {
      const saved = await response.json() as ReminderSettings;
      // Sync all state from the confirmed-saved server response
      const savedSteps = resolveSteps(saved);
      setSteps(savedSteps);
      setClinicName(saved.clinic_name);
      setBookingLink(saved.booking_link);
      setSendTime(saved.send_time);
      setMaxPerDay(saved.max_per_day);
      setDryRun(saved.dry_run_mode);
      setSameNumberOverride(saved.allow_same_number_override ?? false);
      setMessageType("ok");
      // Warn if sms_steps didn't persist (column likely missing in DB)
      if (sortedSteps.length > 0 && !saved.sms_steps) {
        setMessage("Sparade (OBS: sms_steps saknas i databasen — kör migration 003).");
      } else {
        setMessage("Inställningar sparade.");
      }
      router.refresh();
    } else {
      setMessageType("error");
      setMessage("Kunde inte spara.");
    }
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
            <input value={clinicName} onChange={(e) => setClinicName(e.target.value)} id="clinic_name" name="clinic_name" placeholder="Kliniken" />
          </div>
          <div className="field">
            <label htmlFor="booking_link">Bokningslänk</label>
            <input value={bookingLink} onChange={(e) => setBookingLink(e.target.value)} id="booking_link" name="booking_link" type="url" placeholder="https://..." />
          </div>
        </div>

        <div className="grid cols-2">
          <div className="field">
            <label htmlFor="send_time">Sändningstid</label>
            <input value={sendTime} onChange={(e) => setSendTime(e.target.value)} id="send_time" name="send_time" type="time" />
            <span className="field-hint">Klockslag för det dagliga batch-körningen.</span>
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label htmlFor="max_per_day">Max SMS per dag</label>
            <input value={maxPerDay} onChange={(e) => setMaxPerDay(Number(e.target.value))} id="max_per_day" min="1" name="max_per_day" type="number" />
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
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>Daglig körning sker klockan {sendTime} om detta är aktiverat.</div>
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

        <label style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          padding: "14px 16px",
          borderRadius: "var(--radius-sm)",
          border: sameNumberOverride ? "1px solid var(--red-border)" : "1px solid var(--border)",
          cursor: "pointer",
          background: sameNumberOverride ? "var(--red-bg)" : "var(--surface-sub)",
          transition: "background 200ms, border-color 200ms",
        }}>
          <input
            checked={sameNumberOverride}
            name="allow_same_number_override"
            type="checkbox"
            onChange={(e) => setSameNumberOverride(e.target.checked)}
            style={{ marginTop: 2, width: 15, height: 15, accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
          />
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5, color: sameNumberOverride ? "var(--red)" : "var(--text)" }}>
              Tillåt test-SMS till samma nummer
            </div>
            <div style={{ fontSize: 12, color: sameNumberOverride ? "var(--red)" : "var(--text-muted)", opacity: 0.85, marginTop: 2 }}>
              {sameNumberOverride
                ? "Dubbel-skyddet är avstängt — SMS skickas även om sekvensen redan slutförts. Bara för testning av eget nummer."
                : "Dubbel-skyddet är aktivt. Aktivera för att skicka SMS till ett nummer som redan fått hela sekvensen."}
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
