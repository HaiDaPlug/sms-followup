"use client";

import { useState } from "react";

export function PatientActions({ patientId }: { patientId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function post(url: string, busyKey: string) {
    setBusy(busyKey);
    setMessage(null);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId })
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; status?: string };
    setBusy(null);
    setMessage(response.ok ? payload.status ?? "Klart" : payload.error ?? "Något gick fel");
    window.location.reload();
  }

  return (
    <div className="actions">
      <button disabled={busy !== null} onClick={() => post("/api/reminders/send", "send")}>
        {busy === "send" ? "Skickar…" : "Skicka SMS"}
      </button>
      <button
        className="danger"
        disabled={busy !== null}
        onClick={() => post(`/api/patients/${patientId}/do-not-contact`, "dnc")}
      >
        {busy === "dnc" ? "Sparar…" : "Kontakta ej"}
      </button>
      {message ? <span className="muted">{message}</span> : null}
    </div>
  );
}
