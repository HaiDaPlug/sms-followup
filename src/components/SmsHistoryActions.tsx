"use client";

import { useState } from "react";

export function SmsHistoryActions({
  patientId,
  doNotContact,
}: {
  patientId: string;
  doNotContact: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [dnc, setDnc] = useState(doNotContact);
  const [error, setError] = useState<string | null>(null);

  async function sendSms() {
    setBusy("send");
    setError(null);
    try {
      const res = await fetch("/api/reminders/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId }),
      });
      const data = await res.json().catch(() => ({})) as { status?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? `Fel ${res.status}`);
      } else if (data.status === "failed") {
        setError(data.error ?? "SMS misslyckades");
      } else {
        window.location.reload();
      }
    } catch {
      setError("Nätverksfel — kontrollera anslutningen");
    } finally {
      setBusy(null);
    }
  }

  async function toggleDnc() {
    setBusy("dnc");
    setError(null);
    const url = dnc
      ? `/api/patients/${patientId}/reactivate`
      : `/api/patients/${patientId}/do-not-contact`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? `Fel ${res.status}`);
      } else {
        setDnc((prev) => !prev);
        window.location.reload();
      }
    } catch {
      setError("Nätverksfel — kontrollera anslutningen");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="actions">
        <button disabled={busy !== null || dnc} onClick={sendSms}>
          {busy === "send" ? "Skickar…" : "Skicka SMS"}
        </button>
        <button
          className={dnc ? "secondary" : "danger"}
          disabled={busy !== null}
          onClick={toggleDnc}
        >
          {busy === "dnc" ? "Sparar…" : dnc ? "Återaktivera" : "Ta bort"}
        </button>
      </div>
      {error && (
        <div style={{ fontSize: 11.5, color: "var(--red)", fontWeight: 500, maxWidth: 220 }}>
          {error}
        </div>
      )}
    </div>
  );
}
