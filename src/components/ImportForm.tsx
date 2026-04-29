"use client";

import { useState } from "react";
import type { ImportSummary } from "@/types/clinic";

const summaryLabels: Record<string, string> = {
  totalRows: "Totalt rader",
  importedBookings: "Importerade bokningar",
  importedOrUpdatedPatients: "Patienter (nya/uppdaterade)",
  skippedRows: "Hoppade rader",
  missingPhoneCount: "Saknar telefon",
  cancelledCount: "Avbokade",
  futureBookingCount: "Framtida bokningar",
  reviewItemsCreated: "Granskningsärenden"
};

export function ImportForm() {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("csv") as File | null;
    if (!file) return;

    setBusy(true);
    setError(null);
    setSummary(null);

    const csvText = await file.text();
    const response = await fetch("/api/import/bokadirekt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csvText })
    });
    const payload = (await response.json()) as { summary?: ImportSummary; error?: string };
    setBusy(false);

    if (!response.ok || !payload.summary) {
      setError(payload.error ?? "Importen misslyckades");
      return;
    }

    setSummary(payload.summary);
  }

  return (
    <form className="form-panel" onSubmit={submit}>
      <div className="field">
        <label htmlFor="csv">BokaDirekt CSV-fil</label>
        <input accept=".csv,text/csv" id="csv" name="csv" required type="file" />
        <span className="field-hint">Välj den semikolonseparerade exportfilen från BokaDirekt.</span>
      </div>
      <div>
        <button disabled={busy} type="submit">
          {busy ? "Importerar…" : "Starta import"}
        </button>
      </div>
      {error ? <div className="notice">{error}</div> : null}
      {summary ? (
        <>
          <p className="muted" style={{ margin: 0 }}>Import klar</p>
          <div className="grid cols-2">
            {Object.entries(summary).map(([key, value]) => (
              <div className="card" key={key} style={{ padding: "14px 16px" }}>
                <p className="metric">{summaryLabels[key] ?? key}</p>
                <p className="metric-value">{value}</p>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </form>
  );
}
