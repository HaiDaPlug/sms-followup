"use client";

import { useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

export function PatientSearch({ defaultValue, currentParams }: {
  defaultValue: string;
  currentParams: { status?: string; sort?: string };
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  const submit = useCallback((value: string) => {
    const params = new URLSearchParams();
    if (currentParams.status && currentParams.status !== "all") params.set("status", currentParams.status);
    if (currentParams.sort && currentParams.sort !== "oldest") params.set("sort", currentParams.sort);
    if (value.trim()) params.set("q", value.trim());
    // Reset to page 1 on new search
    const qs = params.toString();
    router.push(`/app/patients${qs ? `?${qs}` : ""}`);
  }, [router, currentParams]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => submit(value), 350);
  }, [submit]);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
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
