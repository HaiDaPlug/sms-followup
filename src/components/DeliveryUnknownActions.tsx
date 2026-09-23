"use client";

import { useState } from "react";

type Props = {
  reviewId: string;
  reminderLogId: string;
};

export function DeliveryUnknownActions({ reviewId, reminderLogId }: Props) {
  const [busy, setBusy] = useState<"sent" | "failed" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(outcome: "sent" | "failed") {
    setBusy(outcome);
    setError(null);

    try {
      const response = await fetch("/api/review/resolve-delivery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId, reminderLogId, outcome }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? `Fel ${response.status}`);
        return;
      }
      window.location.reload();
    } catch {
      setError("Nätverksfel - kontrollera anslutningen");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 190 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          className="sm"
          disabled={busy !== null || !reminderLogId}
          onClick={() => resolve("sent")}
        >
          {busy === "sent" ? "Sparar..." : "Markera skickad"}
        </button>
        <button
          className="danger sm"
          disabled={busy !== null || !reminderLogId}
          onClick={() => resolve("failed")}
        >
          {busy === "failed" ? "Sparar..." : "Markera misslyckad"}
        </button>
      </div>
      {error ? <span style={{ fontSize: 14, color: "var(--red)" }}>{error}</span> : null}
    </div>
  );
}
