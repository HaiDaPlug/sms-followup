import type { ReminderLog, SmsStep } from "@/types/clinic";

/**
 * Where a patient stands in the follow-up cadence of their CURRENT cycle, one
 * entry per configured step — the row of dots on the patients page.
 *
 * Reads a cycle the way the engine does (eligibility.ts, cycleProgress): only
 * logs since the last cycle_reset count, a log belongs to a step by id first,
 * then by its day snapshot, then by legacy position; a step at or below the
 * furthest day already sent is passed over rather than owed; and when several
 * unsent steps have been crossed, only the latest is due — the engine sends
 * that one (getNextSequence) and the earlier ones are passed over.
 *
 * Presentation only. Nothing here feeds a send decision.
 */

export type TrackState =
  | "sent"      // went out (sent or delivered)
  | "dry_run"   // logged in test mode, never handed to the provider
  | "pending"   // awaiting a delivery receipt, or delivery unknown
  | "failed"    // provider rejected it and nothing replaced it
  | "due"       // the step the engine sends next: the latest one whose day has passed
  | "passed"    // skipped over: a later follow-up already went out, or will go instead
  | "upcoming"  // its day has not been reached yet
  | "inactive"; // switched off in settings and never sent

export type TrackStep = {
  id: string;
  day: number;
  active: boolean;
  state: TrackState;
  /** When the matching log was written, for states backed by one. */
  at: string | null;
};

function belongsTo(log: ReminderLog, step: SmsStep, position: number): boolean {
  if (log.step_id) return log.step_id === step.id;
  if (log.step_day != null) return log.step_day === step.day;
  return log.sequence_number === position;
}

const SENT_LIKE = new Set(["sent", "delivered", "dry_run"]);

/**
 * @param steps       resolveSteps(settings) — sorted by day
 * @param cycleLogs   logsInCurrentCycle(patient.id, logs) — newest first
 * @param daysSinceVisit whole days since last_booking_at, or null
 */
export function followUpTrack(
  steps: SmsStep[],
  cycleLogs: ReminderLog[],
  daysSinceVisit: number | null
): TrackStep[] {
  let maxSentDay = -Infinity;
  for (const log of cycleLogs) {
    if (!SENT_LIKE.has(log.status)) continue;
    const day =
      log.step_day ??
      (log.step_id ? steps.find((s) => s.id === log.step_id)?.day : undefined) ??
      (log.sequence_number ? steps[log.sequence_number - 1]?.day : undefined);
    if (day !== undefined && day > maxSentDay) maxSentDay = day;
  }

  // The one step the engine would send next, if any.
  const crossed = steps.filter(
    (step, index) =>
      step.active &&
      step.day > maxSentDay &&
      daysSinceVisit !== null &&
      daysSinceVisit >= step.day &&
      !cycleLogs.some((log) => SENT_LIKE.has(log.status) && belongsTo(log, step, index + 1))
  );
  const nextId = crossed.at(-1)?.id ?? null;

  return steps.map((step, index) => {
    const own = cycleLogs.filter((log) => belongsTo(log, step, index + 1));
    const pick = (statuses: string[]) => own.find((log) => statuses.includes(log.status));

    const sent = pick(["sent", "delivered"]);
    const dry = pick(["dry_run"]);
    const pending = pick(["pending", "unknown"]);
    const failed = pick(["failed"]);

    const base = { id: step.id, day: step.day, active: step.active };
    if (sent) return { ...base, state: "sent", at: sent.sent_at ?? sent.created_at };
    if (dry) return { ...base, state: "dry_run", at: dry.created_at };
    if (pending) return { ...base, state: "pending", at: pending.created_at };
    if (failed) return { ...base, state: "failed", at: failed.created_at };
    if (!step.active) return { ...base, state: "inactive", at: null };
    if (step.day <= maxSentDay) return { ...base, state: "passed", at: null };
    if (daysSinceVisit !== null && daysSinceVisit >= step.day) {
      return { ...base, state: step.id === nextId ? "due" : "passed", at: null };
    }
    return { ...base, state: "upcoming", at: null };
  });
}
