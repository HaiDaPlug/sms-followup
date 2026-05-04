"use client";

import { useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/browser";
import { useRouter } from "next/navigation";

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createSupabaseBrowser();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      setError("Felaktigt e-post eller lösenord.");
      setBusy(false);
      return;
    }

    router.push(next ?? "/app/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && (
        <div style={{
          background: "var(--red-bg)",
          border: "1px solid var(--red-border)",
          borderRadius: "var(--radius-sm)",
          padding: "10px 14px",
          fontSize: 13,
          color: "var(--red)",
        }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-muted)" }}>
          E-post
        </label>
        <input
          autoComplete="email"
          disabled={busy}
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{
            padding: "9px 12px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            fontSize: 14,
            outline: "none",
            background: "var(--surface)",
            color: "var(--text)",
            transition: "border-color 150ms",
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-muted)" }}>
          Lösenord
        </label>
        <input
          autoComplete="current-password"
          disabled={busy}
          required
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{
            padding: "9px 12px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            fontSize: 14,
            outline: "none",
            background: "var(--surface)",
            color: "var(--text)",
            transition: "border-color 150ms",
          }}
        />
      </div>

      <button
        disabled={busy}
        type="submit"
        style={{
          marginTop: 4,
          padding: "10px 0",
          background: busy ? "#3da89d" : "#073B2C",
          color: "#fff",
          border: "none",
          borderRadius: "var(--radius-sm)",
          fontSize: 14,
          fontWeight: 600,
          cursor: busy ? "wait" : "pointer",
          transition: "background 200ms",
        }}
      >
        {busy ? "Loggar in…" : "Logga in"}
      </button>
    </form>
  );
}
