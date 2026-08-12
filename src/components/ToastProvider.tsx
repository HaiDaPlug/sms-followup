"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { SendOutcome, SendOutcomeKind } from "@/lib/sms/outcome";

/**
 * Minimal toast host. Deliberately not a new dependency: framer-motion and the
 * CSS tokens are already in use, and every send surface previously hand-rolled
 * its own transient banner — this replaces those with one consistent readout.
 *
 * The distinction that matters: an SMS outcome has six states, and the previous
 * per-component feedback collapsed them into ok/not-ok. `outcome()` below keeps
 * them apart so a skipped or unconfirmed send never renders as success.
 */

type ToastTone = "success" | "info" | "warning" | "error";

type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string | null;
  /** Errors and unknown states stay until dismissed. */
  sticky: boolean;
};

type ToastInput = {
  tone: ToastTone;
  title: string;
  detail?: string | null;
  sticky?: boolean;
};

type ToastContextValue = {
  push: (toast: ToastInput) => void;
  /** Render a send result in the right tone without the caller deciding. */
  outcome: (outcome: SendOutcome) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_BY_KIND: Record<SendOutcomeKind, ToastTone> = {
  sent: "success",
  delivered: "success",
  dry_run: "info",
  skipped: "warning",
  failed: "error",
  unknown: "error",
};

const TONE_STYLES: Record<ToastTone, { bg: string; border: string; fg: string; icon: string }> = {
  success: { bg: "var(--accent-bg)", border: "#b8e0dc", fg: "#1d6b63", icon: "✓" },
  info:    { bg: "var(--blue-bg)",   border: "var(--blue-border)",  fg: "var(--blue)",  icon: "i" },
  warning: { bg: "var(--amber-bg)",  border: "var(--amber-border)", fg: "var(--amber)", icon: "!" },
  error:   { bg: "var(--red-bg)",    border: "var(--red-border)",   fg: "var(--red)",   icon: "✕" },
};

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    const sticky = input.sticky ?? (input.tone === "error");
    setToasts((prev) => [...prev, { id, sticky, ...input }]);

    if (!sticky) {
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, AUTO_DISMISS_MS)
      );
    }
  }, []);

  const outcome = useCallback(
    (result: SendOutcome) => {
      const tone = TONE_BY_KIND[result.kind];
      // A provider-confirmed delivery is worth distinguishing from an accepted
      // request, since "sent" alone was the thing operators could not trust.
      const detail = result.detail && result.detail !== result.message
        ? result.detail
        : result.verified
          ? "Bekräftad av leverantören"
          : null;
      push({
        tone,
        title: result.message,
        detail,
        // Anything the operator must act on stays on screen.
        sticky: tone === "error" || result.kind === "skipped",
      });
    },
    [push]
  );

  const value = useMemo(() => ({ push, outcome, dismiss }), [push, outcome, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return context;
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  const reduced = useReducedMotion();

  return (
    <div
      // aria-live so a screen reader announces the outcome; the previous inline
      // banners were silent.
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 2000,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxWidth: "min(420px, calc(100vw - 40px))",
        pointerEvents: "none",
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const style = TONE_STYLES[toast.tone];
          return (
            <motion.div
              key={toast.id}
              layout
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              role={toast.tone === "error" ? "alert" : "status"}
              style={{
                pointerEvents: "auto",
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "12px 14px",
                background: style.bg,
                border: `1px solid ${style.border}`,
                borderRadius: "var(--radius)",
                boxShadow: "0 8px 24px rgba(4,20,15,0.12)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  background: style.fg,
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: 1,
                }}
              >
                {style.icon}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: style.fg, lineHeight: 1.4 }}>
                  {toast.title}
                </div>
                {toast.detail && (
                  <div
                    style={{
                      fontSize: 14,
                      color: "var(--text-mid)",
                      marginTop: 3,
                      lineHeight: 1.45,
                      wordBreak: "break-word",
                    }}
                  >
                    {toast.detail}
                  </div>
                )}
              </div>

              <button
                onClick={() => onDismiss(toast.id)}
                aria-label="Stäng"
                style={{
                  flexShrink: 0,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  fontSize: 19,
                  lineHeight: 1,
                  padding: 2,
                }}
              >
                ×
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
