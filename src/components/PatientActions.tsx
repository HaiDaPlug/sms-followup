"use client";

import { useState } from "react";

type SendState = "idle" | "sending" | "sent" | "failed";

export type TemplateStep = { day: number; template: string };

const styles = `
@keyframes pa-spin { to { transform: rotate(360deg); } }

.pa-sms-btn {
  position: relative;
  overflow: hidden;
  background: #073B2C;
  color: #fff;
  border: none;
  border-radius: 5px;
  padding: 0 14px;
  height: 32px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  white-space: nowrap;
  isolation: isolate;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: color 0.26s ease;
  min-width: 100px;
  justify-content: center;
}
.pa-sms-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: #5bbfb5;
  transform-origin: left center;
  transform: scaleX(0);
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 0;
}
.pa-sms-btn:not([disabled]):hover::before { transform: scaleX(1); }
.pa-sms-btn > span { position: relative; z-index: 1; display: flex; align-items: center; gap: 5px; }

.pa-sms-btn.pa-sending {
  background: #073B2C;
  opacity: 0.6;
  cursor: wait;
}
.pa-sms-btn.pa-sending::before { display: none; }

.pa-sms-btn.pa-sent {
  background: #edf7f6;
  color: #3da89d;
  cursor: default;
}
.pa-sms-btn.pa-sent::before { display: none; }

.pa-sms-btn.pa-failed {
  background: #fdf0f0;
  color: #a33030;
  cursor: default;
}
.pa-sms-btn.pa-failed::before { display: none; }

.pa-dnc-btn {
  position: relative;
  overflow: hidden;
  background: transparent;
  color: #a33030;
  border: 1px solid #f0d0d0;
  border-radius: 5px;
  padding: 0 12px;
  height: 32px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  white-space: nowrap;
  isolation: isolate;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background 0.22s ease, border-color 0.22s ease;
}
.pa-dnc-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: #a33030;
  transform-origin: left center;
  transform: scaleX(0);
  transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 0;
}
.pa-dnc-btn:not([disabled]):hover::before { transform: scaleX(1); }
.pa-dnc-btn:not([disabled]):hover { color: #fff; border-color: #a33030; }
.pa-dnc-btn > span { position: relative; z-index: 1; display: flex; align-items: center; gap: 4px; }

.pa-dnc-btn.pa-busy { opacity: 0.5; cursor: wait; }
.pa-dnc-btn.pa-busy::before { display: none; }

.pa-reactivate-btn {
  position: relative;
  overflow: hidden;
  background: transparent;
  color: #1a6b5a;
  border: 1px solid #b0dbd5;
  border-radius: 5px;
  padding: 0 12px;
  height: 32px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  white-space: nowrap;
  isolation: isolate;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background 0.22s ease, border-color 0.22s ease;
}
.pa-reactivate-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: #1a6b5a;
  transform-origin: left center;
  transform: scaleX(0);
  transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 0;
}
.pa-reactivate-btn:not([disabled]):hover::before { transform: scaleX(1); }
.pa-reactivate-btn:not([disabled]):hover { color: #fff; border-color: #1a6b5a; }
.pa-reactivate-btn > span { position: relative; z-index: 1; display: flex; align-items: center; gap: 4px; }
.pa-reactivate-btn.pa-busy { opacity: 0.5; cursor: wait; }
.pa-reactivate-btn.pa-busy::before { display: none; }

.pa-delete-btn {
  position: relative;
  overflow: hidden;
  background: transparent;
  color: #888;
  border: 1px solid #e0e0e0;
  border-radius: 5px;
  padding: 0 10px;
  height: 32px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  white-space: nowrap;
  isolation: isolate;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background 0.22s ease, border-color 0.22s ease, color 0.22s ease;
}
.pa-delete-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: #c0392b;
  transform-origin: left center;
  transform: scaleX(0);
  transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 0;
}
.pa-delete-btn:not([disabled]):hover::before { transform: scaleX(1); }
.pa-delete-btn:not([disabled]):hover { color: #fff; border-color: #c0392b; }
.pa-delete-btn > span { position: relative; z-index: 1; display: flex; align-items: center; gap: 4px; }
.pa-delete-btn.pa-busy { opacity: 0.5; cursor: wait; }
.pa-delete-btn.pa-busy::before { display: none; }

.pa-spinner {
  animation: pa-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.pa-tpl-select {
  height: 32px;
  border: 1px solid #1a5a40;
  border-radius: 5px;
  background: #073B2C;
  color: rgba(255,255,255,0.85);
  font-size: 12px;
  font-weight: 500;
  padding: 0 8px;
  cursor: pointer;
  outline: none;
  white-space: nowrap;
  transition: border-color 0.2s, background 0.2s;
  max-width: 120px;
}
.pa-tpl-select:hover { background: #0a4f38; border-color: #5bbfb5; }
.pa-tpl-select:focus { border-color: #5bbfb5; }
.pa-tpl-select option { background: #073B2C; color: #fff; }
`;

let injected = false;
function injectStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const el = document.createElement("style");
  el.textContent = styles;
  document.head.appendChild(el);
}

export function PatientActions({
  patientId,
  doNotContact = false,
  steps = [],
}: {
  patientId: string;
  doNotContact?: boolean;
  steps?: TemplateStep[];
}) {
  const [sendState, setSendState] = useState<SendState>("idle");
  const [dncBusy, setDncBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [isDnc, setIsDnc] = useState(doNotContact);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);

  if (typeof document !== "undefined") injectStyles();

  async function handleSend() {
    if (sendState !== "idle") return;
    setSendState("sending");
    try {
      const body: { patientId: string; sequenceOverride?: number; forceNext: boolean } = { patientId, forceNext: true };
      if (selectedSeq !== null) body.sequenceOverride = selectedSeq;
      const res = await fetch("/api/reminders/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const ok = data.status === "sent" || data.status === "dry_run";
      setSendState(ok ? "sent" : "failed");
      if (ok) setTimeout(() => window.location.reload(), 900);
      else setTimeout(() => setSendState("idle"), 3000);
    } catch {
      setSendState("failed");
      setTimeout(() => setSendState("idle"), 3000);
    }
  }

  async function handleDnc() {
    if (dncBusy) return;
    setDncBusy(true);
    const endpoint = isDnc
      ? `/api/patients/${patientId}/reactivate`
      : `/api/patients/${patientId}/do-not-contact`;
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    setIsDnc(!isDnc);
    setDncBusy(false);
    window.location.reload();
  }

  async function handleDelete() {
    if (deleteBusy) return;
    if (!window.confirm("Ta bort patienten permanent? Detta kan inte ångras.")) return;
    setDeleteBusy(true);
    await fetch(`/api/patients/${patientId}`, { method: "DELETE" });
    window.location.reload();
  }

  const smsLabel =
    sendState === "sending" ? "Skickar…"
    : sendState === "sent" ? "Skickat ✓"
    : sendState === "failed" ? "Misslyckades"
    : "Skicka SMS";

  const smsClass = `pa-sms-btn${sendState !== "idle" ? ` pa-${sendState}` : ""}`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {steps.length > 0 && (
        <select
          className="pa-tpl-select"
          disabled={sendState !== "idle"}
          value={selectedSeq ?? ""}
          onChange={(e) => setSelectedSeq(e.target.value === "" ? null : Number(e.target.value))}
          title="Välj mall"
        >
          <option value="">Automatisk</option>
          {steps.map((s, i) => (
            <option key={i + 1} value={i + 1}>
              Mall {i + 1} (dag {s.day})
            </option>
          ))}
        </select>
      )}
      <button
        className={smsClass}
        disabled={sendState !== "idle"}
        onClick={handleSend}
      >
        <span>
          {sendState === "sending" && (
            <svg className="pa-spinner" width="11" height="11" viewBox="0 0 11 11">
              <circle cx="5.5" cy="5.5" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14 8" />
            </svg>
          )}
          {smsLabel}
        </span>
      </button>

      {isDnc ? (
        <button
          className={`pa-reactivate-btn${dncBusy ? " pa-busy" : ""}`}
          disabled={dncBusy}
          onClick={handleDnc}
        >
          <span>{dncBusy ? "Sparar…" : "Återaktivera"}</span>
        </button>
      ) : (
        <button
          className={`pa-dnc-btn${dncBusy ? " pa-busy" : ""}`}
          disabled={dncBusy}
          onClick={handleDnc}
        >
          <span>{dncBusy ? "Sparar…" : "Kontakta ej"}</span>
        </button>
      )}

      <button
        className={`pa-delete-btn${deleteBusy ? " pa-busy" : ""}`}
        disabled={deleteBusy}
        onClick={handleDelete}
      >
        <span>{deleteBusy ? "…" : "Ta bort"}</span>
      </button>
    </div>
  );
}
