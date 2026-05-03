"use client";

import { useState } from "react";

type SendState = "idle" | "sending" | "sent" | "failed";

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

.pa-spinner {
  animation: pa-spin 0.7s linear infinite;
  flex-shrink: 0;
}
`;

let injected = false;
function injectStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const el = document.createElement("style");
  el.textContent = styles;
  document.head.appendChild(el);
}

export function PatientActions({ patientId }: { patientId: string }) {
  const [sendState, setSendState] = useState<SendState>("idle");
  const [dncBusy, setDncBusy] = useState(false);

  if (typeof document !== "undefined") injectStyles();

  async function handleSend() {
    if (sendState !== "idle") return;
    setSendState("sending");
    try {
      const res = await fetch("/api/reminders/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId }),
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
    await fetch(`/api/patients/${patientId}/do-not-contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId }),
    });
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

      <button
        className={`pa-dnc-btn${dncBusy ? " pa-busy" : ""}`}
        disabled={dncBusy}
        onClick={handleDnc}
      >
        <span>
          {dncBusy ? "Sparar…" : "Kontakta ej"}
        </span>
      </button>
    </div>
  );
}
