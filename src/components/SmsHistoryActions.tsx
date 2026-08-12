"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ToastProvider";
import { isRealSend } from "@/lib/sms/outcome";
import { requestSend } from "@/lib/sms/sendClient";

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
  const toast = useToast();
  const router = useRouter();

  async function sendSms() {
    setBusy("send");
    setError(null);
    const outcome = await requestSend({ patientId });
    toast.outcome(outcome);
    setBusy(null);
    // router.refresh() instead of window.location.reload(): a full reload
    // discards the toast before it can be read, which is why the previous
    // version communicated success only by the absence of an error.
    if (isRealSend(outcome.kind) || outcome.kind === "dry_run") router.refresh();
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
        const message = data.error ?? `Fel ${res.status}`;
        setError(message);
        toast.push({ tone: "error", title: message });
      } else {
        setDnc((prev) => !prev);
        toast.push({
          tone: "success",
          title: dnc ? "Patienten återaktiverad" : "Patienten borttagen från utskick",
        });
        router.refresh();
      }
    } catch {
      const message = "Nätverksfel — kontrollera anslutningen";
      setError(message);
      toast.push({ tone: "error", title: message });
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
        <div style={{ fontSize: 14, color: "var(--red)", fontWeight: 500, maxWidth: 220 }}>
          {error}
        </div>
      )}
    </div>
  );
}
