"use client";

import { useState, useRef, useEffect } from "react";

type Field = { label: string; name: string; type?: string; placeholder: string; required?: boolean };

const FIELDS: Field[] = [
  { label: "Namn", name: "full_name", placeholder: "För- och efternamn", required: true },
  { label: "Telefon", name: "phone", type: "tel", placeholder: "t.ex. 0701234567" },
  { label: "E-post", name: "email", type: "email", placeholder: "namn@exempel.se" },
  { label: "Senaste bokning", name: "last_booking_at", type: "date", placeholder: "" },
];

export function AddPatientButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => firstRef.current?.focus(), 60);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const body = Object.fromEntries(
      [...fd.entries()].map(([k, v]) => [k, String(v).trim()])
    );
    try {
      const res = await fetch("/api/patients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setError(data.error ?? "Något gick fel"); setBusy(false); return; }
      setOpen(false);
      window.location.reload();
    } catch {
      setError("Nätverksfel");
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="pt-add-btn">
        <span>+ Lägg till patient</span>
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(4,20,15,0.55)",
            zIndex: 1000,
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              width: "100%",
              maxWidth: 420,
              overflow: "hidden",
              boxShadow: "0 24px 64px rgba(4,20,15,0.18)",
            }}
          >
            {/* Header */}
            <div style={{
              background: "#073B2C",
              padding: "18px 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "#fff", letterSpacing: "-0.01em" }}>
                Lägg till patient
              </span>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: "rgba(255,255,255,0.12)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 6,
                  color: "rgba(255,255,255,0.8)",
                  fontSize: 16,
                  lineHeight: 1,
                  padding: "3px 8px",
                  cursor: "pointer",
                  minHeight: "unset",
                }}
              >×</button>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} style={{ padding: "24px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {FIELDS.map((field, i) => (
                  <label key={field.name} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
                      {field.label}{field.required && <span style={{ color: "var(--red)", marginLeft: 2 }}>*</span>}
                    </span>
                    <input
                      ref={i === 0 ? firstRef : undefined}
                      name={field.name}
                      type={field.type ?? "text"}
                      placeholder={field.placeholder}
                      required={field.required}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--surface-sub)",
                        color: "var(--text)",
                        fontSize: 13,
                        padding: "8px 11px",
                        outline: "none",
                        width: "100%",
                        boxSizing: "border-box",
                      }}
                    />
                  </label>
                ))}
              </div>

              {error && (
                <p style={{ marginTop: 12, fontSize: 12.5, color: "var(--red)" }}>{error}</p>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setOpen(false)}
                  disabled={busy}
                >
                  Avbryt
                </button>
                <button type="submit" disabled={busy}>
                  {busy ? "Sparar…" : "Spara patient"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
