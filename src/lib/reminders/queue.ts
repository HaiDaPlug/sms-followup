import type { NextSequenceInfo } from "@/types/clinic";

/**
 * Ordering for the daily batch.
 *
 * `max_per_day` is a rate limit, not a targeting rule, so the cap must fall on
 * a deliberate order rather than whatever order the patients table came back
 * in. Previously it was `patients.created_at desc`, which handed every slot to
 * the most recently imported records and could starve an old backlog forever.
 *
 * The key is when the patient FIRST became due — `last_booking_at` plus the
 * earliest active follow-up they are still owed — so the queue drains
 * first-come-first-served. Two properties matter:
 *
 *   - It is monotonic per patient. Waiting longer only ever improves your
 *     position. Measuring against the step being sent instead would make a
 *     patient's priority collapse the moment they crossed a later threshold,
 *     so under sustained cap pressure someone near a boundary would be pushed
 *     to the back on the very day they became more overdue.
 *   - A never-contacted patient 400 days out ranks above one at 179 days,
 *     which is the intuitive reading of "most overdue first".
 *
 * Known consequence, inherent to "send the highest threshold crossed" rather
 * than to this ordering: with day 5 and day 14 only nine days apart, a fresh
 * patient sitting behind a large backlog can pass day 14 before their slot
 * comes up and receive the 14-day message instead of the 5-day one.
 */
export type QueueCandidate = {
  patientId: string;
  lastBookingAt: string;
  daysSince: number;
  /** Trigger day of the earliest active step still owed. */
  firstDueDay: number;
  next: NonNullable<NextSequenceInfo>;
};

/** The instant this patient became eligible for the step they are owed. */
export function dueAt(candidate: QueueCandidate): number {
  return Date.parse(candidate.lastBookingAt) + candidate.firstDueDay * 86_400_000;
}

/** Days waited since becoming due. Reported in the cron result, not used for sorting. */
export function overdueDays(candidate: QueueCandidate): number {
  return candidate.daysSince - candidate.firstDueDay;
}

/**
 * Oldest due date first. `dueAt` ascending and "most overdue" descending are
 * the same order at finer granularity, so this sorts on the timestamp and lets
 * overdueDays stay a reporting concern. Patient id breaks ties so repeated runs
 * over the same data produce the same batch.
 */
export function prioritizeQueue(candidates: QueueCandidate[]): QueueCandidate[] {
  return [...candidates].sort(
    (a, b) => dueAt(a) - dueAt(b) || a.patientId.localeCompare(b.patientId)
  );
}
