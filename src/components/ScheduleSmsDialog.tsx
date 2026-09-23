"use client";

import { useState } from "react";
import type { StepOption } from "@/types/clinic";
import { useToast } from "./ToastProvider";
import { Modal } from "./ui/Modal";
import { IconAlert } from "./ui/icons";

interface Props {
  /** Defaults to true for callers that mount the dialog only while open. */
  open?: boolean;
  patientId: string;
  patientName?: string;
  steps: StepOption[];
  onClose: () => void;
  onScheduled: () => void;
}

const CLINIC_TIME_ZONE = "Europe/Stockholm";

function toLocalMinute(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Quick picks: tomorrow / in three days / next Monday, all at 09:00 local. */
function presets(): { label: string; value: string }[] {
  const at9 = (d: Date) => { const x = new Date(d); x.setHours(9, 0, 0, 0); return x; };
  const now = new Date();
  const tomorrow = at9(new Date(now.getTime() + 86_400_000));
  const inThree = at9(new Date(now.getTime() + 3 * 86_400_000));
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  return [
    { label: "I morgon 09:00", value: toLocalMinute(tomorrow) },
    { label: "Om 3 dagar", value: toLocalMinute(inThree) },
    { label: "Måndag 09:00", value: toLocalMinute(at9(monday)) },
  ];
}

export function ScheduleSmsDialog({ open = true, patientId, patientName, steps, onClose, onScheduled }: Props) {
  const [scheduledFor, setScheduledFor] = useState("");
  const [stepId, setStepId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

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
      const body: { patientId: string; scheduledFor: string; timeZone: string; stepId?: string } = {
        patientId,
        scheduledFor: selectedDate.toISOString(),
        timeZone,
      };
      if (stepId !== null) body.stepId = stepId;
      const res = await fetch("/api/scheduled-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; scheduled_for?: string };
      if (!res.ok) {
        // 409 is a rejected step (already sent, or out of order) rather than a
        // malformed request — keep it inline where the operator is looking, and
        // mirror it to a toast so it is not missed if the dialog closes.
        const message = data.error ?? "Något gick fel";
        setError(message);
        toast.push({
          tone: res.status === 409 ? "warning" : "error",
          title: "Kunde inte schemalägga SMS",
          detail: message,
        });
        setBusy(false);
        return;
      }
      toast.push({
        tone: "success",
        title: "SMS schemalagt",
        detail: new Intl.DateTimeFormat("sv-SE", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: CLINIC_TIME_ZONE,
        }).format(selectedDate),
      });
      onScheduled();
    } catch {
      setError("Nätverksfel");
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title="Schemalägg SMS"
      description={patientName ? <>Till <strong style={{ color: "var(--text)" }}>{patientName}</strong></> : undefined}
      padded
    >
      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 18 }}>
        <div className="field">
          <label className="field-label" htmlFor="schedule-at">
            Datum och tid <span className="muted" style={{ fontWeight: 400 }}>(Europe/Stockholm)</span>
            <span className="req">*</span>
          </label>
          <input
            id="schedule-at"
            type="datetime-local"
            required
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            min={toLocalMinute(new Date(Date.now() + 60_000))}
          />
          <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
            {presets().map((p) => (
              <button
                key={p.label}
                type="button"
                className="secondary sm"
                aria-pressed={scheduledFor === p.value}
                style={scheduledFor === p.value ? { borderColor: "var(--accent)", background: "var(--accent-bg)", color: "var(--forest)" } : undefined}
                onClick={() => setScheduledFor(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {steps.length > 0 && (
          <div className="field">
            <label className="field-label" htmlFor="schedule-step">Uppföljning</label>
            <select
              id="schedule-step"
              value={stepId ?? ""}
              onChange={(e) => setStepId(e.target.value === "" ? null : e.target.value)}
            >
              <option value="">Automatisk (nästa steg)</option>
              {steps.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.day} dagar{s.active ? "" : " (inaktiv)"}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div className="notice error" role="alert"><IconAlert /> <span>{error}</span></div>
        )}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            Avbryt
          </button>
          <button type="submit" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Schemalägger…" : "Schemalägg"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
