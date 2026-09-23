"use client";

import { useState } from "react";
import type { InboxRow } from "@/types/clinic";

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", minute: "2-digit" }).format(d);
  if (diffDays === 1) return "Igår";
  if (diffDays < 7) return new Intl.DateTimeFormat("sv-SE", { weekday: "short" }).format(d);
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short" }).format(d);
}

function ReplyBox({ row, onReplied }: { row: InboxRow; onReplied: (msg: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/sms/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        incoming_sms_id: row.id,
        to: row.from_number,
        message: text.trim(),
      }),
    });
    setBusy(false);
    if (res.ok) {
      onReplied(text.trim());
      setText("");
    } else {
      const payload = await res.json().catch(() => ({})) as { error?: string };
      setError(payload.error ?? "Kunde inte skicka svar");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
      <textarea
        className="input"
        aria-label="Svar"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Skriv svar…"
        rows={2}
        style={{ minHeight: 72, fontSize: "var(--fs-sm)" }}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button className="sm" onClick={send} disabled={busy || !text.trim()}>
          {busy ? "Skickar…" : "Skicka svar"}
        </button>
        <span className="muted"><kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>
        {error && <span style={{ fontSize: 14, color: "var(--red)" }}>{error}</span>}
      </div>
    </div>
  );
}

function MessageCard({ row }: { row: InboxRow }) {
  const [open, setOpen] = useState(false);
  const [repliedMsg, setRepliedMsg] = useState<string | null>(row.reply_message);
  const [repliedAt, setRepliedAt] = useState<string | null>(row.replied_at);
  const unreplied = !repliedAt;

  return (
    <div
      className="panel"
      style={{
        borderColor: unreplied ? "var(--accent-border)" : undefined,
        boxShadow: unreplied ? "inset 3px 0 0 var(--accent), var(--shadow-card)" : undefined,
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            {row.patient_name ? (
              <span style={{ fontWeight: 600, fontSize: 16, color: "var(--text)" }}>{row.patient_name}</span>
            ) : (
              <span style={{ fontWeight: 600, fontSize: 16, color: "var(--text-muted)" }}>Okänd avsändare</span>
            )}
            <span style={{ fontSize: 14, color: "var(--text-muted)" }}>{row.from_number}</span>
            {unreplied && (
              <span className="chip sm ready">Ny</span>
            )}
          </div>
          <div style={{ fontSize: 16, color: "var(--text)", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {row.message}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 14, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            {formatTime(row.received_at)}
          </span>
          {!repliedAt && (
            <button
              className="secondary sm"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Avbryt" : "Svara"}
            </button>
          )}
        </div>
      </div>

      {/* Sent reply preview */}
      {repliedMsg && repliedAt && (
        <div style={{
          background: "var(--surface-sub)",
          borderRadius: "var(--radius-sm)",
          padding: "8px 12px",
          fontSize: 14,
          color: "var(--text-muted)",
          borderLeft: "3px solid var(--accent)",
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2, color: "var(--text)" }}>Svar skickat {formatTime(repliedAt)}</div>
          {repliedMsg}
        </div>
      )}

      {/* Reply box */}
      {open && !repliedAt && (
        <ReplyBox
          row={row}
          onReplied={(msg) => {
            setRepliedMsg(msg);
            setRepliedAt(new Date().toISOString());
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

export function InboxClient({ initialRows }: { initialRows: InboxRow[] }) {
  const [rows] = useState(initialRows);
  const [filter, setFilter] = useState<"all" | "unreplied">("unreplied");

  const visible = filter === "unreplied" ? rows.filter((r) => !r.replied_at) : rows;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Filter tabs */}
      <div className="tabs" role="tablist" aria-label="Filtrera meddelanden">
        {(["unreplied", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={`tab${filter === f ? " active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "unreplied" ? "Obesvarade" : "Alla"}
            <span className="tab-count">{f === "unreplied" ? rows.filter((r) => !r.replied_at).length : rows.length}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="panel empty-state">
          <span className="empty-title">
            {filter === "unreplied" ? "Inga obesvarade meddelanden" : "Inga inkommande meddelanden ännu"}
          </span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visible.map((row) => <MessageCard key={row.id} row={row} />)}
        </div>
      )}
    </div>
  );
}
