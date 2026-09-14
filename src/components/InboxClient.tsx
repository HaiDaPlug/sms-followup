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
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Skriv svar…"
        rows={2}
        style={{ resize: "vertical", fontSize: 14 }}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={send} disabled={busy || !text.trim()} style={{ fontSize: 14 }}>
          {busy ? "Skickar…" : "Skicka svar"}
        </button>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Ctrl+Enter</span>
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
    <div style={{
      background: "var(--surface)",
      border: `1px solid ${unreplied ? "var(--accent)" : "var(--border)"}`,
      borderRadius: "var(--radius)",
      padding: "14px 18px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
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
              <span style={{
                fontSize: 12, fontWeight: 700, letterSpacing: "0.05em",
                background: "var(--accent)", color: "#fff",
                borderRadius: 3, padding: "1px 6px",
              }}>NY</span>
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
              className="secondary"
              onClick={() => setOpen((o) => !o)}
              style={{ fontSize: 14, padding: "3px 10px", minHeight: "unset" }}
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
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", paddingBottom: 0 }}>
        {(["unreplied", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              background: "none",
              border: "none",
              borderBottom: filter === f ? "2px solid var(--accent)" : "2px solid transparent",
              borderRadius: 0,
              fontSize: 14,
              fontWeight: filter === f ? 600 : 400,
              color: filter === f ? "var(--accent)" : "var(--text-muted)",
              padding: "6px 14px",
              cursor: "pointer",
              minHeight: "unset",
            }}
          >
            {f === "unreplied" ? `Obesvarade (${rows.filter((r) => !r.replied_at).length})` : `Alla (${rows.length})`}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "40px 24px",
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: 16,
        }}>
          {filter === "unreplied" ? "Inga obesvarade meddelanden." : "Inga inkommande meddelanden ännu."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visible.map((row) => <MessageCard key={row.id} row={row} />)}
        </div>
      )}
    </div>
  );
}
