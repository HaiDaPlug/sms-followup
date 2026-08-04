import { createBrowserClient } from "@supabase/ssr";
import { requirePublicConfig } from "@/lib/supabase/keys";

export function createSupabaseBrowser() {
  const { url, key } = requirePublicConfig();
  return createBrowserClient(url, key);
}
