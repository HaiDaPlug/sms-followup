import "server-only";
import { createClient } from "@supabase/supabase-js";
import { resolveSupabaseSecret } from "@/lib/supabase/keys";

// Privileged client: bypasses RLS. Every write path and most reads use this.
const { url, key } = resolveSupabaseSecret();

export const supabase = createClient(url, key);
