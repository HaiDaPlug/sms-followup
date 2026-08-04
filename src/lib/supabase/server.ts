import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requirePublicConfig } from "@/lib/supabase/keys";

export async function createSupabaseServer() {
  const cookieStore = await cookies();
  const { url, key } = requirePublicConfig();
  return createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll called from a Server Component — middleware handles refresh
          }
        }
      }
    }
  );
}
