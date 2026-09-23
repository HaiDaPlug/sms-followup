"use client";

import { useEffect, useRef } from "react";
import { IconSearch, IconX } from "./ui/icons";

/**
 * Controlled search field for the patients list. Filtering happens in the
 * browser as you type, so there is no debounce and no request here.
 * "/" focuses it from anywhere on the page; Escape clears it.
 */
export function PatientSearch({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="search" role="search">
      <span className="search-icon"><IconSearch /></span>
      <input
        ref={inputRef}
        type="search"
        name="q"
        value={value}
        placeholder="Sök namn, telefon, e-post…"
        aria-label="Sök kunder"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) { e.preventDefault(); onChange(""); }
        }}
      />
      <span className="search-trail">
        {value ? (
          <button
            type="button"
            className="icon-btn sm"
            onClick={() => { onChange(""); inputRef.current?.focus(); }}
            aria-label="Rensa sökningen"
          >
            <IconX size={14} />
          </button>
        ) : (
          <kbd title="Tryck / för att söka">/</kbd>
        )}
      </span>
    </div>
  );
}
