"use client";

import { useState } from "react";

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

  async function send() {
    setBusy("send");
    setResult(null);
    const res = await fetch("/api/reminders/send-message", {
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
    const data = await res.json().catch(() => ({})) as { status?: string; error?: string };
    setBusy(null);
    if (res.ok) {
      setResult({ ok: true, text: data.status === "dry_run" ? "Loggad (testläge)" : "Skickat!" });
      setTimeout(() => window.location.reload(), 900);
    } else {
      setResult({ ok: false, text: data.error ?? "Misslyckades" });
    }
  }

  async function resolve(status: "resolved" | "ignored") {
    setBusy(status === "resolved" ? "resolve" : "ignore");
    await fetch(`/api/review/${reviewId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    window.location.reload();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 280 }}>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={4}
        style={{
          fontSize: 12.5,
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
          style={{ fontSize: 12, padding: "5px 12px", minHeight: "unset" }}
        >
          {busy === "send" ? "Skickar…" : "Skicka nu"}
        </button>
        <button
          className="secondary"
          onClick={() => resolve("resolved")}
          disabled={busy !== null}
          style={{ fontSize: 12, padding: "5px 12px", minHeight: "unset" }}
        >
          {busy === "resolve" ? "…" : "Markera löst"}
        </button>
        <button
          className="danger"
          onClick={() => resolve("ignored")}
          disabled={busy !== null}
          style={{ fontSize: 12, padding: "5px 12px", minHeight: "unset" }}
        >
          {busy === "ignore" ? "…" : "Ignorera"}
        </button>
        {result && (
          <span style={{ fontSize: 12, fontWeight: 500, color: result.ok ? "var(--accent)" : "var(--red)" }}>
            {result.text}
          </span>
        )}
      </div>
    </div>
  );
}
