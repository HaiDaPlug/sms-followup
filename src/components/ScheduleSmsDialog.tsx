"use client";

import { useState, useRef, useEffect } from "react";
import type { TemplateStep } from "./PatientActions";

interface Props {
  patientId: string;
  steps: TemplateStep[];
  onClose: () => void;
  onScheduled: () => void;
}

const CLINIC_TIME_ZONE = "Europe/Stockholm";

function toLocalMinute(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ScheduleSmsDialog({ patientId, steps, onClose, onScheduled }: Props) {
  const [scheduledFor, setScheduledFor] = useState("");
  const [sequenceOverride, setSequenceOverride] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => firstRef.current?.focus(), 60);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (timeZone !== CLINIC_TIME_ZONE) {
        setError("Schemaläggning måste göras i tidszonen Europe/Stockholm");
        setBusy(false);
        return;
      }
      const selectedDate = new Date(scheduledFor);
      if (Number.isNaN(selectedDate.getTime()) || toLocalMinute(selectedDate) !== scheduledFor) {
        setError("Den valda lokala tiden finns inte på grund av sommartidsomställning");
        setBusy(false);
        return;
      }
      const body: { patientId: string; scheduledFor: string; timeZone: string; sequenceOverride?: number } = {
        patientId,
        scheduledFor: selectedDate.toISOString(),
        timeZone,
      };
      if (sequenceOverride !== null) body.sequenceOverride = sequenceOverride;
      const res = await fetch("/api/scheduled-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setError(data.error ?? "Något gick fel"); setBusy(false); return; }
      onScheduled();
    } catch {
      setError("Nätverksfel");
      setBusy(false);
    }
  }

  return (
    <div
      onClick={() => !busy && onClose()}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(4,20,15,0.55)",
        zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-sms-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          width: "100%",
          maxWidth: 420,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(4,20,15,0.18)",
        }}
      >
        {/* Header */}
        <div style={{
          background: "#073B2C",
          padding: "18px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <span id="schedule-sms-title" style={{ fontWeight: 700, fontSize: 15, color: "#fff", letterSpacing: "-0.01em" }}>
            Schemalägg SMS
          </span>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              background: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 6,
              color: "rgba(255,255,255,0.8)",
              fontSize: 16,
              lineHeight: 1,
              padding: "3px 8px",
              cursor: "pointer",
              minHeight: "unset",
            }}
          >×</button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: "24px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
                Datum och tid (Europe/Stockholm)<span style={{ color: "var(--red)", marginLeft: 2 }}>*</span>
              </span>
              <input
                ref={firstRef}
                type="datetime-local"
                required
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                min={toLocalMinute(new Date(Date.now() + 60_000))}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--surface-sub)",
                  color: "var(--text)",
                  fontSize: 13,
                  padding: "8px 11px",
                  outline: "none",
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            </label>

            {steps.length > 0 && (
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
                  Mall
                </span>
                <select
                  value={sequenceOverride ?? ""}
                  onChange={(e) => setSequenceOverride(e.target.value === "" ? null : Number(e.target.value))}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--surface-sub)",
                    color: "var(--text)",
                    fontSize: 13,
                    padding: "8px 11px",
                    outline: "none",
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                >
                  <option value="">Automatisk</option>
                  {steps.map((s, i) => (
                    <option key={i + 1} value={i + 1}>
                      Mall {i + 1} (dag {s.day})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {error && (
            <p style={{ marginTop: 12, fontSize: 12.5, color: "var(--red)" }}>{error}</p>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
            <button
              type="button"
              className="secondary"
              onClick={onClose}
              disabled={busy}
            >
              Avbryt
            </button>
            <button type="submit" disabled={busy}>
              {busy ? "Schemalägger…" : "Schemalägg"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
