"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./ToastProvider";
import { defaultMessage, isRealSend, type SendOutcome } from "@/lib/sms/outcome";

type Props = {
  reviewId: string;
  patientId: string;
  phone: string;
  sequenceNumber: number | null;
  initialMessage: string;
};

export function FailedSmsActions({ reviewId, patientId, phone, sequenceNumber, initialMessage }: Props) {
  const [message, setMessage] = useState(initialMessage);
  const [busy, setBusy] = useState<"send" | "resolve" | "ignore" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const toast = useToast();
  const router = useRouter();

  async function send() {
    setBusy("send");
    setResult(null);
    let res: Response;
    let data: { outcome?: SendOutcome; status?: string; error?: string } = {};
    try {
      res = await fetch("/api/reminders/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: patientId,
          phone,
          message,
          review_id: reviewId,
          sequence_number: sequenceNumber,
        }),
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      console.error("[FailedSmsActions] network error", err);
      setBusy(null);
      // The request may have reached the server, so this cannot be reported as
      // a clean failure either.
      const text = "Nätverksfel — kunde inte bekräfta om SMS:et skickades";
      setResult({ ok: false, text });
      toast.push({
        tone: "error",
        title: text,
        detail: "Kontrollera SMS-historiken innan du skickar igen.",
      });
      return;
    }
    setBusy(null);

    // Use the server's outcome rather than re-deriving one from status codes:
    // that hand-mapping is what previously let unknown and skipped read as
    // success. Validation errors carry no outcome, so fall back conservatively.
    const outcome: SendOutcome = data.outcome ?? {
      kind: res.ok ? "unknown" : "failed",
      message: data.error ?? defaultMessage(res.ok ? "unknown" : "failed"),
      detail: res.ok ? null : `HTTP ${res.status}`,
    };

    toast.outcome(outcome);
    setResult({ ok: isRealSend(outcome.kind), text: outcome.message });
    if (isRealSend(outcome.kind) || outcome.kind === "dry_run") router.refresh();
  }

  async function resolve(status: "resolved" | "ignored") {
    setBusy(status === "resolved" ? "resolve" : "ignore");
    setResult(null);
    try {
      const res = await fetch(`/api/review/${reviewId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setResult({ ok: false, text: data.error ?? `Fel ${res.status}` });
      } else {
        window.location.reload();
      }
    } catch {
      setResult({ ok: false, text: "Nätverksfel — kontrollera anslutningen" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 280 }}>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={4}
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--surface-sub)",
          color: "var(--text)",
          resize: "vertical",
          width: "100%",
          boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button
          onClick={send}
          disabled={busy !== null || !message.trim()}
          style={{ fontSize: 14, padding: "5px 12px", minHeight: "unset" }}
        >
          {busy === "send" ? "Skickar…" : "Skicka nu"}
        </button>
        <button
          className="secondary"
          onClick={() => resolve("resolved")}
          disabled={busy !== null}
          style={{ fontSize: 14, padding: "5px 12px", minHeight: "unset" }}
        >
          {busy === "resolve" ? "…" : "Markera löst"}
        </button>
        <button
          className="danger"
          onClick={() => resolve("ignored")}
          disabled={busy !== null}
          style={{ fontSize: 14, padding: "5px 12px", minHeight: "unset" }}
        >
          {busy === "ignore" ? "…" : "Ignorera"}
        </button>
        {result && (
          <span style={{ fontSize: 14, fontWeight: 500, color: result.ok ? "var(--accent)" : "var(--red)" }}>
            {result.text}
          </span>
        )}
      </div>
    </div>
  );
}
