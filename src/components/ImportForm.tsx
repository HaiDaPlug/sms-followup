"use client";

import Link from "next/link";
import { useState } from "react";
import type { ImportSummary } from "@/types/clinic";
import { IconAlert, IconArrowRight, IconCheck, IconFile, IconUpload } from "./ui/icons";

const summaryLabels: Record<string, string> = {
  totalRows: "Totalt rader",
  importedBookings: "Importerade bokningar",
  importedOrUpdatedPatients: "Kunder (nya/uppdaterade)",
  skippedRows: "Hoppade rader",
  missingPhoneCount: "Saknar telefon",
  cancelledCount: "Avbokade",
  futureBookingCount: "Framtida bokningar",
  reviewItemsCreated: "Granskningsärenden"
};

// Counts that mean "someone should look at this" get a warning tint.
const attentionKeys = new Set(["skippedRows", "missingPhoneCount", "reviewItemsCreated"]);

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImportForm() {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("csv") as File | null;
    if (!file) return;

    setBusy(true);
    setError(null);
    setSummary(null);

    try {
      const csvText = await file.text();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);

      const response = await fetch("/api/import/bokadirekt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const payload = (await response.json()) as { summary?: ImportSummary; error?: string };

      if (!response.ok || !payload.summary) {
        setError(payload.error ?? `Server svarade med ${response.status}`);
        return;
      }

      setSummary(payload.summary);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("Importen tog för lång tid (>60 s). Försök med en mindre fil.");
      } else {
        setError(err instanceof Error ? err.message : "Nätverksfel — kontrollera anslutningen.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel rise" style={{ ["--i" as string]: 1, maxWidth: 820 }} onSubmit={submit}>
      <div className="panel-body" style={{ display: "grid", gap: 16 }}>
        <label
          className={`dropzone${dragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDrop={() => setDragging(false)}
        >
          {/* The input covers the zone, so a dropped file lands on it natively. */}
          <input
            accept=".csv,text/csv"
            id="csv"
            name="csv"
            required
            type="file"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              setFile(f ? { name: f.name, size: f.size } : null);
              setSummary(null);
              setError(null);
            }}
          />
          <span className="dropzone-icon">{file ? <IconFile size={20} /> : <IconUpload size={20} />}</span>
          {file ? (
            <>
              <span className="dropzone-title">{file.name}</span>
              <span className="muted">{formatSize(file.size)} · klicka för att välja en annan fil</span>
            </>
          ) : (
            <>
              <span className="dropzone-title">Släpp BokaDirekt-exporten här</span>
              <span className="muted">eller klicka för att välja en semikolonseparerad CSV-fil</span>
            </>
          )}
        </label>

        <div className="row" style={{ gap: 12 }}>
          <button disabled={busy || !file} type="submit" className="lg">
            {busy ? <span className="spinner" aria-hidden="true" /> : <IconUpload size={16} />}
            {busy ? "Importerar…" : "Starta import"}
          </button>
          {busy && <span className="muted">Det kan ta upp till en minut för stora filer.</span>}
        </div>

        {error ? <div className="notice error" role="alert"><IconAlert /><span>{error}</span></div> : null}
      </div>

      {summary ? (
        <div style={{ borderTop: "1px solid var(--hairline)" }}>
          <div className="panel-head flush" style={{ paddingTop: 18 }}>
            <p className="panel-title">
              <span className="kpi-icon" style={{ width: 26, height: 26, borderRadius: 7 }}><IconCheck size={14} /></span>
              Import klar
            </p>
          </div>
          <div className="panel-body" style={{ paddingTop: 12 }}>
            <div className="grid cols-4">
              {Object.entries(summary).map(([key, value]) => {
                const attention = attentionKeys.has(key) && Number(value) > 0;
                return (
                  <div
                    className="stat-card"
                    key={key}
                    style={attention ? { background: "var(--warn-bg)", borderColor: "var(--warn-border)", boxShadow: "none" } : { boxShadow: "none" }}
                  >
                    <div className="stat" style={{ padding: "14px 16px" }}>
                      <p className="stat-label" style={attention ? { color: "var(--warn)" } : undefined}>{summaryLabels[key] ?? key}</p>
                      <p className={`kpi-value${Number(value) === 0 ? " is-zero" : ""}`}>{value}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="row wrap" style={{ gap: 16, marginTop: 16 }}>
              <Link href="/app/patients" className="panel-link">Till Kunder <IconArrowRight size={14} /></Link>
              {summary.reviewItemsCreated > 0 && (
                <Link href="/app/review" className="panel-link">Granska {summary.reviewItemsCreated} nya ärenden <IconArrowRight size={14} /></Link>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
