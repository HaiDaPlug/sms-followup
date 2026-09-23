"use client";

import { useState } from "react";
import { Modal } from "./ui/Modal";
import { IconAlert, IconPlus } from "./ui/icons";

type Field = { label: string; name: string; type?: string; placeholder: string; required?: boolean; hint?: string };

const FIELDS: Field[] = [
  { label: "Namn", name: "full_name", placeholder: "För- och efternamn", required: true },
  { label: "Telefon", name: "phone", type: "tel", placeholder: "t.ex. 0701234567", hint: "Krävs för att kunden ska kunna få SMS." },
  { label: "E-post", name: "email", type: "email", placeholder: "namn@exempel.se" },
  { label: "Senaste bokning", name: "last_booking_at", type: "date", placeholder: "", hint: "Uppföljningarna räknas från det här datumet." },
];

export function AddPatientButton() {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setFormKey((k) => k + 1);
    setOpen(true);
  }

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
      <button type="button" onClick={openDialog}>
        <IconPlus size={14} /> Lägg till patient
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        dismissible={!busy}
        size="sm"
        title="Lägg till patient"
        description="Kunden läggs till i registret och följs upp enligt inställningarna."
        padded
      >
        <form key={formKey} onSubmit={handleSubmit} style={{ display: "grid", gap: 16 }}>
          {FIELDS.map((field) => (
            <div className="field" key={field.name}>
              <label className="field-label" htmlFor={`add-${field.name}`}>
                {field.label}
                {field.required && <span className="req">*</span>}
              </label>
              <input
                id={`add-${field.name}`}
                name={field.name}
                type={field.type ?? "text"}
                placeholder={field.placeholder}
                required={field.required}
                autoComplete="off"
              />
              {field.hint && <span className="field-hint">{field.hint}</span>}
            </div>
          ))}

          {error && <div className="notice error" role="alert"><IconAlert /> <span>{error}</span></div>}

          <div className="row" style={{ justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            <button type="button" className="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Avbryt
            </button>
            <button type="submit" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Sparar…" : "Spara patient"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
