"use client";

import { useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/browser";
import { useRouter } from "next/navigation";

const formStyles = `
  .lf-field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-bottom: 20px;
  }

  .lf-label {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #8aaa9e;
  }

  .lf-input-wrap {
    position: relative;
  }

  .lf-input {
    width: 100%;
    padding: 13px 16px;
    border: 1.5px solid #e4ede9;
    border-radius: 6px;
    font-size: 14.5px;
    font-family: 'DM Sans', sans-serif;
    font-weight: 300;
    outline: none;
    background: #fff;
    color: #073B2C;
    transition: border-color 200ms, box-shadow 200ms;
    -webkit-appearance: none;
  }

  .lf-input::placeholder { color: #c0d5cc; }

  .lf-input:focus {
    border-color: #5bbfb5;
    box-shadow: 0 0 0 3.5px rgba(91,191,181,0.13);
  }

  .lf-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .lf-submit {
    width: 100%;
    margin-top: 8px;
    padding: 14px 0;
    background: #073B2C;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 13.5px;
    font-family: 'DM Sans', sans-serif;
    font-weight: 500;
    letter-spacing: 0.04em;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    transition: transform 120ms, box-shadow 200ms;
    text-align: center;
  }

  .lf-submit::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(91,191,181,0.25), transparent 60%);
    opacity: 0;
    transition: opacity 250ms;
  }

  .lf-submit:not(:disabled):hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 20px rgba(7,59,44,0.22);
  }
  .lf-submit:not(:disabled):hover::before { opacity: 1; }
  .lf-submit:not(:disabled):active { transform: translateY(0); }

  .lf-submit:disabled {
    cursor: wait;
    background: #3da89d;
  }

  .lf-submit-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  @keyframes lf-spin { to { transform: rotate(360deg); } }
  .lf-spinner {
    width: 14px;
    height: 14px;
    border: 1.5px solid rgba(255,255,255,0.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: lf-spin 0.65s linear infinite;
    flex-shrink: 0;
  }

  .lf-error {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #fdf3f3;
    border: 1px solid #f0d0d0;
    border-radius: 6px;
    padding: 11px 14px;
    font-size: 13px;
    color: #a33030;
    margin-bottom: 20px;
    animation: lf-shake 0.35s cubic-bezier(0.36,0.07,0.19,0.97);
  }

  @keyframes lf-shake {
    0%, 100% { transform: translateX(0); }
    20%       { transform: translateX(-5px); }
    40%       { transform: translateX(5px); }
    60%       { transform: translateX(-3px); }
    80%       { transform: translateX(3px); }
  }
`;

let stylesInjected = false;
function injectFormStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const el = document.createElement("style");
  el.textContent = formStyles;
  document.head.appendChild(el);
}

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (typeof document !== "undefined") injectFormStyles();

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
    <form onSubmit={handleSubmit} noValidate>
      {error && (
        <div className="lf-error" key={error}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ flexShrink: 0 }}>
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5v3.5M8 11v.5" strokeLinecap="round" />
          </svg>
          {error}
        </div>
      )}

      <div className="lf-field">
        <label className="lf-label" htmlFor="lf-email">E-post</label>
        <div className="lf-input-wrap">
          <input
            autoComplete="email"
            className="lf-input"
            disabled={busy}
            id="lf-email"
            placeholder="namn@klinik.se"
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>

      <div className="lf-field">
        <label className="lf-label" htmlFor="lf-password">Lösenord</label>
        <div className="lf-input-wrap">
          <input
            autoComplete="current-password"
            className="lf-input"
            disabled={busy}
            id="lf-password"
            placeholder="••••••••"
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>

      <button className="lf-submit" disabled={busy} type="submit">
        <span className="lf-submit-inner">
          {busy && <span className="lf-spinner" />}
          {busy ? "Loggar in…" : "Logga in"}
        </span>
      </button>
    </form>
  );
}
