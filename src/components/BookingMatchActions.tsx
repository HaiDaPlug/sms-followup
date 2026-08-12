"use client";

import { useState } from "react";

interface Candidate {
  id: string;
  name: string | null;
  tier: string;
}

interface Props {
  reviewId: string;
  matchedPatientId: string | null;
  matchedPatientName: string | null;
  matchTier: string;
  candidates: Candidate[];
}

export function BookingMatchActions({ reviewId, matchedPatientId, matchedPatientName, matchTier, candidates }: Props) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(patientId: string | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/review/confirm-booking-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewItemId: reviewId, patientId }),
      });
      let json: Record<string, unknown> = {};
      try { json = await res.json(); } catch { /* ignore parse errors */ }
      if (!res.ok) {
        setError(typeof json.error === "string" ? json.error : `Fel ${res.status}`);
        return;
      }
      setDone(true);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nätverksfel");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <span style={{ fontSize: 14, color: "var(--accent)" }}>Bekräftad</span>;

  // Candidate buttons: prefer identity_lookups candidates, fall back to legacy matchedPatientId
  const buttons: { id: string; label: string }[] = [];
  if (candidates.length > 0) {
    for (const c of candidates) {
      const tierSuffix = c.tier === "bokadirekt_id" ? "" : ` (via ${c.tier})`;
      buttons.push({ id: c.id, label: `${c.name ?? c.id}${tierSuffix}` });
    }
  } else if (matchedPatientId) {
    const tierSuffix = matchTier === "bokadirekt_id" ? "" : ` (via ${matchTier})`;
    buttons.push({ id: matchedPatientId, label: `${matchedPatientName ?? matchedPatientId}${tierSuffix}` });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 180 }}>
      {buttons.map((b) => (
        <button
          key={b.id}
          disabled={busy}
          onClick={() => confirm(b.id)}
          style={{ fontSize: 14, padding: "4px 10px", minHeight: "unset" }}
        >
          Bekräfta — {b.label}
        </button>
      ))}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => confirm(null)}
        style={{ fontSize: 14, padding: "4px 10px", minHeight: "unset" }}
      >
        Skapa ny patient
      </button>
      {error && (
        <span style={{ fontSize: 12, color: "#c0392b", maxWidth: 240, lineHeight: 1.3 }}>
          {error}
        </span>
      )}
    </div>
  );
}
