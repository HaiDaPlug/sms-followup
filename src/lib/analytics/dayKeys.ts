/**
 * Pure Stockholm-timezone date helpers for analytics bucketing.
 *
 * Deliberately free of "server-only" and any Supabase import so this logic can
 * be unit-tested directly — it is the part of analytics most likely to break
 * silently (DST, day boundaries) and least likely to throw when it does.
 */

const TZ = "Europe/Stockholm";

export function stockholmDayKey(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: TZ }); // "YYYY-MM-DD"
}

function stockholmYmdOf(date: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

// DST-safe: Stockholm midnight -> UTC instant, via iterative offset correction.
// Each pass recomputes the Stockholm UTC offset from the current guess, but
// always applies it against the fixed target wall-clock time (not against the
// previous guess) — applying it against the evolving guess would compound the
// correction on the second pass instead of converging.
function stockholmWallClockAsUtc(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
}

export function stockholmMidnightToUtc(y: number, m: number, d: number): Date {
  const target = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const offsetMs = stockholmWallClockAsUtc(new Date(guess)) - guess;
    guess = target - offsetMs;
  }
  return new Date(guess);
}

// Pure calendar-day arithmetic anchored at UTC noon (never crosses a local DST
// edge because it never represents a local wall-clock instant) — safe to
// subtract whole days with plain millisecond math.
export function buildStockholmDayKeys(days: number, now: Date): string[] {
  const today = stockholmYmdOf(now);
  const anchorUtcNoon = Date.UTC(today.y, today.m - 1, today.d, 12, 0, 0);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(new Date(anchorUtcNoon - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  return keys;
}

/** Start of the analytics window as a UTC instant, aligned to Stockholm midnight. */
export function windowStartIso(dayKeys: string[]): string {
  const [y, m, d] = dayKeys[0].split("-").map(Number);
  return stockholmMidnightToUtc(y, m, d).toISOString();
}
