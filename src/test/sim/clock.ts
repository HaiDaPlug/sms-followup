import { vi } from "vitest";

/**
 * Fake wall clock for the follow-up simulator.
 *
 * Only `Date` is faked. The engine reads time exclusively through Date.now() /
 * new Date() (eligibility.daysBetween, queue.dueAt, store.nowIso), so that is
 * all a scenario needs to move. setTimeout/setInterval stay real on purpose:
 * vitest's own timeouts and any awaited microtask keep working, and a scenario
 * can never hang on a timer nobody advances.
 *
 * The clock never moves by itself. Every insert made during one cron run gets
 * the same created_at, which is the closest in-memory stand-in for "the run
 * took a few seconds" without making ordering depend on wall time. See
 * fakeClinic.ts for the tie-break that keeps same-instant rows ordered.
 *
 * Sim days: day 0 is the UTC calendar date of the instant passed to
 * startClock(). Day N starts at 00:00:00.000 UTC on that date + N. Negative
 * days are the past before the scenario began.
 */

/**
 * Hour (UTC) at which the daily cron is scheduled in production: vercel.json
 * schedules /api/cron/daily-reminders at "0 8 * * *", and Vercel cron runs in
 * UTC. That is 09:00 in Stockholm in winter and 10:00 in summer.
 *
 * The project is on Vercel Hobby (migration 020), where a daily cron is only
 * promised within its hour: the real invocation lands anywhere from 08:00:00 to
 * 08:59:59 and can differ from day to day. runDays() fires at minute 0 unless
 * given cronMinute, so a boundary a scenario pins to the minute holds for an
 * on-the-minute invocation only.
 */
export const CRON_HOUR_UTC = 8;

/** Last minute of CRON_HOUR_UTC a Hobby invocation can land in. */
export const CRON_LATEST_MINUTE = 59;

/** Minutes between scheduled-SMS worker ticks: pg_cron "*\/15 * * * *" (migration 020). */
export const WORKER_TICK_MINUTES = 15;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

let day0Ms: number | null = null;

function toMs(value: string | Date): number {
  const ms = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (Number.isNaN(ms)) throw new Error(`clock: invalid time ${String(value)}`);
  return ms;
}

function requireStarted(): number {
  if (day0Ms === null) throw new Error("clock: startClock() (or createClinic()) has not been called");
  return day0Ms;
}

/**
 * Install the fake Date and set it to `iso`. Sim day 0 becomes the UTC date of
 * `iso`. Safe to call again (e.g. in every beforeEach); it simply restarts.
 */
export function startClock(iso: string | Date): Date {
  const ms = toMs(iso);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
  day0Ms = Math.floor(ms / DAY_MS) * DAY_MS;
  return new Date(ms);
}

/**
 * Jump to an absolute instant. Refuses to move backwards: production clocks
 * never do, and a backwards jump would give new rows an older created_at than
 * rows already written, silently reordering the newest-first log reads the
 * cycle logic depends on. Restart with startClock() instead.
 */
export function setNow(iso: string | Date): Date {
  requireStarted();
  const ms = toMs(iso);
  if (ms < Date.now()) {
    throw new Error(
      `clock: setNow(${new Date(ms).toISOString()}) would move backwards from ${new Date(Date.now()).toISOString()}`
    );
  }
  vi.setSystemTime(ms);
  return new Date(ms);
}

/** Move forward by `ms` milliseconds (must be >= 0). */
export function advanceMs(ms: number): Date {
  if (ms < 0) throw new Error("clock: cannot advance by a negative amount");
  return setNow(new Date(Date.now() + ms));
}

/** Move forward by `n` hours (fractions allowed). */
export function advanceHours(n: number): Date {
  return advanceMs(n * HOUR_MS);
}

/** Move forward by `n` whole 24-hour days (fractions allowed). Keeps the time of day. */
export function advanceDays(n: number): Date {
  return advanceMs(n * DAY_MS);
}

/** Current fake time as a Date. */
export function now(): Date {
  return new Date(Date.now());
}

/** Current fake time as an ISO string (same format the fake tables store). */
export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

/** Uninstall the fake Date. Call in afterEach. */
export function restoreClock(): void {
  vi.useRealTimers();
  day0Ms = null;
}

/** Epoch ms of 00:00 UTC on sim day `day`. */
export function simDayStartMs(day: number): number {
  return requireStarted() + day * DAY_MS;
}

/** ISO instant for sim day `day` at `hourUtc`:`minute` UTC. Hours may exceed 23 or be fractional. */
export function atSimDay(day: number, hourUtc = 0, minute = 0): string {
  return new Date(simDayStartMs(day) + hourUtc * HOUR_MS + minute * 60_000).toISOString();
}

/** Sim day (UTC calendar date relative to day 0) that an instant falls on. */
export function simDayOf(value: string | Date): number {
  return Math.floor((toMs(value) - requireStarted()) / DAY_MS);
}

/** Sim day the fake clock is currently on. */
export function currentSimDay(): number {
  return simDayOf(new Date(Date.now()));
}

/** Whole UTC calendar days from the date of `from` to the date of `to` (not elapsed 24h periods). */
export function calendarDaysBetween(from: string | Date, to: string | Date): number {
  return Math.floor(toMs(to) / DAY_MS) - Math.floor(toMs(from) / DAY_MS);
}
