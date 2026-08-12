"use client";

import { createSupabaseBrowser } from "@/lib/supabase/browser";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      className="ghost"
      onClick={handleLogout}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        background: "transparent",
        border: "none",
        borderRadius: 6,
        padding: "8px 10px",
        color: "rgba(255,255,255,0.55)",
        fontSize: 14,
        fontWeight: 500,
        cursor: "pointer",
        transition: "background 150ms, color 150ms",
        textAlign: "left",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)";
        (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.85)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.55)";
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
        <path d="M6 3H3a1 1 0 00-1 1v8a1 1 0 001 1h3" strokeLinecap="round" />
        <path d="M11 5l3 3-3 3M14 8H6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Logga ut
    </button>
  );
}
