"use client";

import { useState } from "react";

interface Props {
  reviewId: string;
  matchedPatientId: string | null;
  matchedPatientName: string | null;
  matchTier: string;
}

export function BookingMatchActions({ reviewId, matchedPatientId, matchedPatientName, matchTier }: Props) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function confirm(patientId: string | null) {
    setBusy(true);
    await fetch("/api/review/confirm-booking-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewItemId: reviewId, patientId }),
    });
    setBusy(false);
    setDone(true);
    window.location.reload();
  }

  if (done) return <span style={{ fontSize: 12, color: "var(--accent)" }}>Bekräftad</span>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 180 }}>
      {matchedPatientId && (
        <button
          disabled={busy}
          onClick={() => confirm(matchedPatientId)}
          style={{ fontSize: 12, padding: "4px 10px", minHeight: "unset" }}
        >
          Bekräfta — {matchedPatientName ?? matchedPatientId}
          {matchTier === "bokadirekt_id" ? "" : ` (via ${matchTier})`}
        </button>
      )}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => confirm(null)}
        style={{ fontSize: 12, padding: "4px 10px", minHeight: "unset" }}
      >
        Skapa ny patient
      </button>
    </div>
  );
}
