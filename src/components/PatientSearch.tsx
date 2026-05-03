"use client";

import { useRef, useCallback } from "react";

export function PatientSearch({ defaultValue }: { defaultValue: string }) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value.trim().toLowerCase();
    const rows = document.querySelectorAll<HTMLElement>("[data-search]");
    let visible = 0;
    rows.forEach((row) => {
      const match = !q || row.dataset.search!.includes(q);
      row.style.display = match ? "" : "none";
      if (match) visible++;
    });
    const chip = document.getElementById("pt-count-chip");
    if (chip) chip.textContent = `${visible} / ${rows.length}`;
    const empty = document.getElementById("pt-empty");
    if (empty) empty.style.display = visible === 0 ? "" : "none";
  }, []);

  return (
    <div className="pt-search-wrap">
      <span className="pt-search-icon">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
          <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.4"/>
          <path d="M8.5 8.5L11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
      </span>
      <input
        ref={inputRef}
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder="Sök namn, telefon, e-post…"
        className="pt-search-input"
        onChange={handleInput}
      />
    </div>
  );
}
