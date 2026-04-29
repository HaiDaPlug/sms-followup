"use client";

import { useState } from "react";

export function ReviewActions({ reviewId }: { reviewId: string }) {
  const [busy, setBusy] = useState(false);

  async function setStatus(status: "resolved" | "ignored") {
    setBusy(true);
    await fetch(`/api/review/${reviewId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    window.location.reload();
  }

  return (
    <div className="actions">
      <button className="secondary" disabled={busy} onClick={() => setStatus("resolved")}>
        Markera löst
      </button>
      <button className="danger" disabled={busy} onClick={() => setStatus("ignored")}>
        Ignorera
      </button>
    </div>
  );
}
