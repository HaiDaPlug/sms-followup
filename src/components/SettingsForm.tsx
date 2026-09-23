"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ReminderSettings, StoredSmsStep } from "@/types/clinic";
import { stepsForEditing } from "@/lib/reminders/steps";

// Insertable variables, shown as chips under each template. Swedish aliases
// ({{förnamn}} etc.) keep working in templates; the chips insert the English
// names the rest of the codebase documents.
const VARIABLES: { token: string; label: string }[] = [
  { token: "{{firstName}}", label: "Förnamn" },
  { token: "{{fullName}}", label: "Fullständigt namn" },
  { token: "{{lastBookingDate}}", label: "Senaste besök" },
  { token: "{{bookingLink}}", label: "Bokningslänk" },
  { token: "{{clinicName}}", label: "Klinikens namn" },
];

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
        fontSize: 14,
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
            fontSize: 12,
          }}>
            UCS-2 · max {parts === 1 ? 70 : 67}/del
          </span>
        )}
      </div>
      {isUcs2 && rawOffender && (
        <div style={{ fontSize: 12, color: "var(--amber)", opacity: 0.85 }}>
          Orsakas av: &ldquo;{rawOffender}&rdquo; — inte ett GSM-7-tecken
        </div>
      )}
      {isUcs2 && !rawOffender && firstOffender && (
        <div style={{ fontSize: 12, color: "var(--amber)", opacity: 0.85 }}>
          Orsakas av exempelvärde: &ldquo;{firstOffender}&rdquo;
        </div>
      )}
    </div>
  );
}

function SectionHeader({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="panel-head" style={{ alignItems: "flex-start" }}>
      <div>
        <h2 className="panel-title" style={{ fontSize: "var(--fs-lg)" }}>{title}</h2>
        <p className="panel-sub">{description}</p>
      </div>
      {children}
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
    gap: 6,
    height: 30,
    fontSize: "var(--fs-sm)",
    fontWeight: 700,
    color: "var(--forest)",
    background: "var(--accent-bg)",
    border: "1px solid var(--accent-border)",
    borderRadius: 7,
    padding: "0 10px",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
  };

  if (editing) {
    return (
      <span style={{ ...chipStyle, cursor: "text", background: "var(--surface)", boxShadow: "var(--ring)" }}>
        Dag{" "}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          type="number"
          min={1}
          aria-label="Antal dagar efter senaste besök"
          style={{
            width: 52,
            border: "none",
            background: "transparent",
            font: "inherit",
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
    <button type="button" className="reset" style={chipStyle} onClick={startEdit} title="Klicka för att ändra dag">
      Dag {value}
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10L11 2.5z" /></svg>
    </button>
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
        className="icon-btn bordered sm"
        aria-label="Lägg till emoji"
        aria-expanded={open}
        style={{ fontSize: 16, width: 32, height: 30 }}
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
              fontSize: 14,
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
                    fontSize: 12,
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
            <div style={{ fontSize: 14, color: "var(--text-muted)", textAlign: "center", padding: "10px 0" }}>
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
                    fontSize: 19,
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

// ── Single follow-up card ─────────────────────────────────────────────────────

function StepCard({
  index,
  step,
  total,
  onChange,
  onRemove,
}: {
  index: number;
  step: StoredSmsStep;
  total: number;
  onChange: (s: StoredSmsStep) => void;
  onRemove: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Inserts at the cursor (emoji or a {{variable}}), replacing any selection.
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

  const active = step.active ?? true;
  const preview = expandTemplate(step.template);

  return (
    <div className={`step-card${active ? "" : " is-paused"}`}>
      <div className="step-card-head">
        <span className="step-index" aria-hidden="true">{index + 1}</span>
        <span style={{ fontWeight: 700, color: "var(--text)" }}>Uppföljning {index + 1}</span>
        <DayChip value={step.day} onChange={(day) => onChange({ ...step, day })} />
        <span className="muted">efter senaste besök{active ? "" : " — pausad"}</span>
        <label
          className="row"
          style={{ gap: 8, marginLeft: "auto", fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--text-mid)", cursor: "pointer" }}
          title="Inaktiva uppföljningar skickas inte automatiskt, men kan fortfarande väljas manuellt."
        >
          <span className="switch">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => onChange({ ...step, active: e.target.checked })}
            />
            <span className="switch-track" />
          </span>
          Aktiv
        </label>
        {total > 1 && (
          <button
            type="button"
            className="icon-btn sm"
            onClick={onRemove}
            title="Ta bort uppföljningen"
            aria-label={`Ta bort uppföljning ${index + 1}`}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.75A.75.75 0 016.75 2h2.5a.75.75 0 01.75.75V4M12.25 4l-.6 8.6a1.5 1.5 0 01-1.5 1.4H5.85a1.5 1.5 0 01-1.5-1.4L3.75 4" /></svg>
          </button>
        )}
      </div>

      <div className="step-card-body">
        <div style={{ display: "grid", gap: 8, minWidth: 0, alignContent: "start" }}>
          <textarea
            ref={textareaRef}
            className="input"
            aria-label={`Meddelande för uppföljning ${index + 1}`}
            value={step.template}
            onChange={(e) => onChange({ ...step, template: e.target.value })}
            style={{ minHeight: 132 }}
          />
          <div className="row wrap" style={{ gap: 6 }}>
            <EmojiPicker onPick={insertEmoji} />
            {VARIABLES.map((v) => (
              <button
                key={v.token}
                type="button"
                className="var-chip"
                onClick={() => insertEmoji(v.token)}
                title={`Infoga ${v.token}`}
              >
                + {v.label}
              </button>
            ))}
          </div>
          <SmsCounter template={step.template} />
        </div>

        <div className="step-preview" aria-label="Förhandsvisning">
          <span className="step-preview-label">Förhandsvisning</span>
          {preview.trim() ? (
            <p className="sms-bubble">{preview}</p>
          ) : (
            <p className="faint" style={{ fontSize: "var(--fs-sm)" }}>Skriv ett meddelande för att se hur det ser ut.</p>
          )}
        </div>
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
  // Seeded from the stored steps as-is so ids round-trip untouched; a resolver
  // fallback id must never be persisted by a save.
  const [steps, setSteps] = useState<StoredSmsStep[]>(() => stepsForEditing(settings));
  const [clinicName, setClinicName] = useState(settings.clinic_name);
  const [bookingLink, setBookingLink] = useState(settings.booking_link);
  const [sendTime, setSendTime] = useState(settings.send_time);
  const [maxPerDay, setMaxPerDay] = useState(settings.max_per_day);

  function updateStep(i: number, s: StoredSmsStep) {
    setSteps((prev) => prev.map((x, idx) => (idx === i ? s : x)));
  }

  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addStep() {
    const lastDay = steps[steps.length - 1]?.day ?? 0;
    // A new step gets its identity here, once, for life.
    setSteps((prev) => [...prev, { id: crypto.randomUUID(), day: lastDay + 30, template: "", active: true }]);
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
      const savedSteps = stepsForEditing(saved);
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
      // The server explains most rejections (for example a stale tab); show it
      // instead of a generic failure when it does.
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setMessageType("error");
      setMessage(payload.error ? `Kunde inte spara: ${payload.error}` : "Kunde inte spara.");
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
    <form onSubmit={submit} style={{ display: "grid", gap: 16, maxWidth: 960 }}>

      {/* ── Körläge ── first: it decides whether anything is sent at all */}
      <section className="panel rise" style={{ ["--i" as string]: 1 }}>
        <SectionHeader
          title="Körläge"
          description="Styr om automationen är aktiv och om SMS ska skickas på riktigt."
        />
        <div className="panel-body" style={{ display: "grid", gap: 10 }}>
          <label className="toggle-row">
            <span className="switch">
              <input defaultChecked={settings.is_active} name="is_active" type="checkbox" />
              <span className="switch-track" />
            </span>
            <span>
              <span className="toggle-title">Aktivera automatiska uppföljningar</span>
              <span className="toggle-desc">Den dagliga körningen skickar till kunder som är redo — högst {maxPerDay} per dag.</span>
            </span>
          </label>

          <label className={`toggle-row${dryRun ? " is-warn" : ""}`}>
            <span className="switch warn">
              <input
                checked={dryRun}
                name="dry_run_mode"
                type="checkbox"
                onChange={(e) => setDryRun(e.target.checked)}
              />
              <span className="switch-track" />
            </span>
            <span>
              <span className="toggle-title">{dryRun ? "Testläge aktiverat" : "Testläge avaktiverat"}</span>
              <span className="toggle-desc">
                {dryRun
                  ? "SMS loggas men skickas inte. Avaktivera när du är redo att skicka på riktigt."
                  : "SMS skickas på riktigt. Aktivera testläget igen om du vill simulera."}
              </span>
            </span>
          </label>

          <label className={`toggle-row${sameNumberOverride ? " is-danger" : ""}`}>
            <span className="switch danger">
              <input
                checked={sameNumberOverride}
                name="allow_same_number_override"
                type="checkbox"
                onChange={(e) => setSameNumberOverride(e.target.checked)}
              />
              <span className="switch-track" />
            </span>
            <span>
              <span className="toggle-title">Tillåt test-SMS till samma nummer</span>
              <span className="toggle-desc">
                {sameNumberOverride
                  ? "Dubbel-skyddet är avstängt — SMS skickas även om sekvensen redan slutförts. Bara för testning av eget nummer."
                  : "Dubbel-skyddet är aktivt. Aktivera för att skicka SMS till ett nummer som redan fått hela sekvensen."}
              </span>
            </span>
          </label>
        </div>
      </section>

      {/* ── Automatiska uppföljningar ── */}
      <section className="panel rise" style={{ ["--i" as string]: 2 }}>
        <SectionHeader
          title="Automatiska uppföljningar"
          description="Kontakta automatiskt patienter som inte har återkommit efter en viss tid. Klicka på dagen för att ändra när uppföljningen skickas."
        >
          <span className="tag" title="Aktiva uppföljningar">
            {steps.filter((step) => step.active !== false).length} av {steps.length} aktiva
          </span>
        </SectionHeader>

        <div className="panel-body" style={{ display: "grid", gap: 14 }}>
          {steps.length > 0 && steps.every((step) => step.active === false) && (
            <div className="notice">
              Inga uppföljningar är aktiva — inget skickas automatiskt.
            </div>
          )}

          {steps.map((step, i) => (
            <StepCard
              key={step.id ?? i}
              index={i}
              step={step}
              total={steps.length}
              onChange={(s) => updateStep(i, s)}
              onRemove={() => removeStep(i)}
            />
          ))}

          <button type="button" className="reset add-step" onClick={addStep}>
            + Lägg till uppföljning
          </button>
        </div>
      </section>

      {/* ── Klinik & timing ── */}
      <section className="panel rise" style={{ ["--i" as string]: 3 }}>
        <SectionHeader
          title="Klinik & timing"
          description="Vad kliniken heter, när SMS skickas och hur många per dag."
        />
        <div className="panel-body" style={{ display: "grid", gap: 18 }}>
          <div className="grid cols-2">
            <div className="field">
              <label htmlFor="clinic_name">Klinikens namn</label>
              <input value={clinicName} onChange={(e) => setClinicName(e.target.value)} id="clinic_name" name="clinic_name" placeholder="Kliniken" />
              <span className="field-hint">Visas där mallen använder {"{{clinicName}}"}.</span>
            </div>
            <div className="field">
              <label htmlFor="booking_link">Bokningslänk</label>
              <input value={bookingLink} onChange={(e) => setBookingLink(e.target.value)} id="booking_link" name="booking_link" type="url" placeholder="https://..." />
              <span className="field-hint">Visas där mallen använder {"{{bookingLink}}"}.</span>
            </div>
          </div>

          <div className="grid cols-2">
            <div className="field">
              <label htmlFor="send_time">Sändningstid</label>
              <input value={sendTime} onChange={(e) => setSendTime(e.target.value)} id="send_time" name="send_time" type="time" />
              <span className="field-hint">Klockslag för det dagliga batch-körningen.</span>
            </div>
            <div className="field">
              <label htmlFor="max_per_day">Max SMS per dag</label>
              <input value={maxPerDay} onChange={(e) => setMaxPerDay(Number(e.target.value))} id="max_per_day" min="1" name="max_per_day" type="number" />
              <span className="field-hint">Tak per körning — skyddar mot oavsiktliga mass-skick.</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Save bar — sticks to the bottom so it is reachable from every section ── */}
      <div className="save-bar">
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <button disabled={busy} type="submit">
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Sparar…" : "Spara inställningar"}
          </button>
          {dryRun && (
            <button className="secondary" disabled={busy} onClick={testSms} type="button">
              Skicka test-SMS
            </button>
          )}
        </div>
        {message && (
          <span role="status" className={`save-msg ${messageType === "ok" ? "ok" : "error"}`}>
            {message}
          </span>
        )}
      </div>

    </form>
  );
}
