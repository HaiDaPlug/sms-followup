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

  async function sendSms() {
    setBusy("send");
    await fetch("/api/reminders/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId }),
    });
    setBusy(null);
    window.location.reload();
  }

  async function toggleDnc() {
    setBusy("dnc");
    const url = dnc
      ? `/api/patients/${patientId}/reactivate`
      : `/api/patients/${patientId}/do-not-contact`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId }),
    });
    setBusy(null);
    setDnc((prev) => !prev);
    window.location.reload();
  }

  return (
    <div className="actions">
      <button disabled={busy !== null || dnc} onClick={sendSms}>
        {busy === "send" ? "Skickar…" : "Skicka SMS"}
      </button>
      <button
        className={dnc ? "secondary" : "danger"}
        disabled={busy !== null}
        onClick={toggleDnc}
      >
        {busy === "dnc"
          ? "Sparar…"
          : dnc
          ? "Återaktivera"
          : "Ta bort"}
      </button>
    </div>
  );
}
