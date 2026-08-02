import { vi } from "vitest";

/** Minimal chainable stand-in for the subset of the Supabase query builder
 * used by store.ts / process.ts (from().insert/update().eq().select().single()). */
export function makeSupabaseChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;
  chain.insert = vi.fn(self);
  chain.update = vi.fn(self);
  chain.select = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.lt = vi.fn(async () => result);
  chain.single = vi.fn(async () => result);
  chain.maybeSingle = vi.fn(async () => result);
  return chain;
}

export function pgrst116NotFound() {
  return { data: null, error: { code: "PGRST116", message: "Results contain 0 rows" } };
}
