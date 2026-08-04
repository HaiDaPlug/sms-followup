/**
 * Supabase key resolution, tolerant of both the new and legacy naming.
 *
 * Supabase replaced the anon/service_role JWTs with publishable/secret keys
 * (`sb_publishable_...` / `sb_secret_...`). This resolves the new names first
 * and falls back to the old ones, so the rename can be deployed before the
 * values are swapped and either environment keeps working during the cutover.
 *
 * IMPORTANT — the NEXT_PUBLIC_* values are written out longhand rather than
 * looked up dynamically. Next.js inlines `process.env.NEXT_PUBLIC_FOO` at
 * build time by literal textual match; `process.env[someVariable]` is NOT
 * inlined and resolves to undefined in the browser. Do not "simplify" these
 * into a loop or a helper that takes the name as an argument.
 */

/** Publishable (formerly anon) key — safe to expose to the browser. */
export const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabasePublicUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Secret (formerly service_role) key — server-only, bypasses RLS.
 * Never import this from client code.
 */
export function resolveSupabaseSecret(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase server credentials: set SUPABASE_URL and SUPABASE_SECRET_KEY " +
        "(or the legacy SUPABASE_SERVICE_ROLE_KEY)"
    );
  }

  return { url, key };
}

/** Throws with a useful message rather than letting a `!` assertion produce a
 *  confusing runtime failure deep inside the Supabase client. */
export function requirePublicConfig(): { url: string; key: string } {
  if (!supabasePublicUrl || !supabasePublishableKey) {
    throw new Error(
      "Missing Supabase public config: set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY)"
    );
  }
  return { url: supabasePublicUrl, key: supabasePublishableKey };
}
