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
    <button type="button" className="reset sidebar-logout" onClick={handleLogout}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
        <path d="M6 3H3a1 1 0 00-1 1v8a1 1 0 001 1h3" strokeLinecap="round" />
        <path d="M11 5l3 3-3 3M14 8H6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Logga ut
    </button>
  );
}
