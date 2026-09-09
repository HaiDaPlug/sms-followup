import { isWithinAttributionWindow } from "./attributionWindow";

/**
 * Lifetime SMS performance.
 *
 * Two questions the 30/60/90-day attribution picker cannot separate:
 *
 *   1. Did this patient ever come back after we contacted them?  (eventual)
 *   2. Can we reasonably credit the SMS for it?                  (attributed)
 *
 * Both are answered here from the same pass, so attributed is always a subset
 * of eventual rather than a separately-derived number that could disagree.
 *
 * This is deliberately NOT read from sms_conversions: that table only holds
 * webhook bookings, is capped at a 365-day write-time lookback, and predates
 * the rows imported from CSV. It stays the record behind the period view; this
 * pass is the superset.
 *
 * Pure and free of "server-only" so it can be unit-tested directly.
 */

export type LifetimeLog = {
  id: string;
  patient_id: string | null;
  sent_at: string | null;
  step_id: string | null;
  step_day: number | null;
  sequence_number: number | null;
};

export type LifetimeBooking = {
  id: string;
  patient_id: string | null;
  /** event_created_at ?? created_at — when the booking entered the system. */
  recorded_at: string | null;
  booking_at: string | null;
  cancelled: boolean;
};

export type LifetimeStep = {
  id: string;
  day: number;
  active: boolean;
};

export type FollowUpPerformance = {
  key: string;
  label: string;
  day: number | null;
  active: boolean;
  exists: boolean;
  smsSent: number;
  patientsContacted: number;
  rebookings: number;
  rebookedPatients: number;
  eventualRate: number | null;
  attributed: number;
  attributedRate: number | null;
  medianDays: number | null;
};

export type LifetimeStats = {
  smsSent: number;
  patientsContacted: number;
  patientsRebooked: number;
  eventualRate: number | null;
  attributedBookings: number;
  attributedPatients: number;
  attributedRate: number | null;
  firstSmsAt: string | null;
  distribution: { label: string; count: number }[];
  perStep: FollowUpPerformance[];
};

/** Bucket edges in days, inclusive of both ends as written. */
const BUCKETS: { label: string; max: number }[] = [
  { label: "0–7 dagar", max: 7 },
  { label: "8–30 dagar", max: 30 },
  { label: "31–60 dagar", max: 60 },
  { label: "61–90 dagar", max: 90 },
  { label: "90+ dagar", max: Infinity },
];

/**
 * When the booking was actually made.
 *
 * A booking cannot be made after the appointment it is for, so the appointment
 * time is an upper bound on it. Taking the minimum guards two real cases in
 * this data: a CSV import whose created_at is import time rather than booking
 * time, and a historical appointment imported long after it happened.
 */
function effectiveAt(booking: LifetimeBooking): number | null {
  const recorded = booking.recorded_at ? Date.parse(booking.recorded_at) : NaN;
  const appointment = booking.booking_at ? Date.parse(booking.booking_at) : NaN;
  if (Number.isNaN(recorded)) return Number.isNaN(appointment) ? null : appointment;
  if (Number.isNaN(appointment)) return recorded;
  return Math.min(recorded, appointment);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

type Credit = { log: LifetimeLog; days: number; patientId: string };

/**
 * Walk each patient's timeline once, crediting the first booking after a run of
 * follow-ups to the most recent of them, then closing that cycle.
 *
 * The alternative — crediting every later booking to the last SMS before it —
 * would count a patient who came back three times as three "eventual
 * rebookings" for one message. A rebooking is the event that ends a follow-up
 * cycle; visits after that, with no new SMS in between, were not prompted by us.
 */
function creditBookings(logs: LifetimeLog[], bookings: LifetimeBooking[]): Credit[] {
  type Event =
    | { at: number; kind: "sms"; log: LifetimeLog }
    | { at: number; kind: "booking" };

  const byPatient = new Map<string, Event[]>();

  for (const log of logs) {
    if (!log.patient_id || !log.sent_at) continue;
    const at = Date.parse(log.sent_at);
    if (Number.isNaN(at)) continue;
    const events = byPatient.get(log.patient_id) ?? [];
    events.push({ at, kind: "sms", log });
    byPatient.set(log.patient_id, events);
  }

  for (const booking of bookings) {
    if (!booking.patient_id || booking.cancelled) continue;
    const at = effectiveAt(booking);
    if (at === null) continue;
    const events = byPatient.get(booking.patient_id);
    // A booking for a patient we never messaged can credit nothing.
    if (!events) continue;
    events.push({ at, kind: "booking" });
  }

  const credits: Credit[] = [];
  for (const [patientId, events] of byPatient) {
    // Bookings sort before SMS at the same instant, keeping "sent strictly
    // before the booking" true rather than crediting a message sent the moment
    // the patient booked.
    events.sort((a, b) => a.at - b.at || (a.kind === "booking" ? -1 : 1));

    let pending: { log: LifetimeLog; at: number } | null = null;
    for (const event of events) {
      if (event.kind === "sms") {
        // A later follow-up in the same cycle supersedes an earlier one.
        pending = { log: event.log, at: event.at };
        continue;
      }
      if (!pending) continue; // no SMS since the previous booking — not ours
      credits.push({
        log: pending.log,
        days: Math.floor((event.at - pending.at) / 86_400_000),
        patientId,
      });
      pending = null; // the cycle is closed
    }
  }
  return credits;
}

function stepKey(log: LifetimeLog): string {
  if (log.step_id) return log.step_id;
  if (log.step_day !== null) return `day:${log.step_day}`;
  if (log.sequence_number !== null) return `seq:${log.sequence_number}`;
  return "unknown";
}

export function calculateLifetimeStats(
  logs: LifetimeLog[],
  bookings: LifetimeBooking[],
  steps: LifetimeStep[],
  attributionDays: number
): LifetimeStats {
  const sentLogs = logs.filter((log) => log.sent_at);
  const credits = creditBookings(sentLogs, bookings);

  const contacted = new Set(sentLogs.flatMap((l) => (l.patient_id ? [l.patient_id] : [])));
  const rebooked = new Set(credits.map((c) => c.patientId).filter((id) => contacted.has(id)));
  const attributedCredits = credits.filter((c) => isWithinAttributionWindow(c.days, attributionDays));
  const attributedPatients = new Set(
    attributedCredits.map((c) => c.patientId).filter((id) => contacted.has(id))
  );

  const firstSmsAt = sentLogs
    .map((l) => l.sent_at!)
    .sort()
    .at(0) ?? null;

  const distribution = BUCKETS.map((bucket, index) => {
    const min = index === 0 ? 0 : BUCKETS[index - 1].max + 1;
    return {
      label: bucket.label,
      count: credits.filter((c) => c.days >= min && c.days <= bucket.max).length,
    };
  });

  // Group by step identity. Configured steps are seeded so a follow-up that has
  // never been sent still appears with zeros rather than vanishing.
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const groups = new Map<string, { logs: LifetimeLog[]; credits: Credit[] }>();
  for (const step of steps) groups.set(step.id, { logs: [], credits: [] });
  for (const log of sentLogs) {
    const key = stepKey(log);
    const group = groups.get(key) ?? { logs: [], credits: [] };
    group.logs.push(log);
    groups.set(key, group);
  }
  for (const credit of credits) {
    const key = stepKey(credit.log);
    const group = groups.get(key);
    if (group) group.credits.push(credit);
  }

  const perStep: FollowUpPerformance[] = [...groups.entries()].map(([key, group]) => {
    const configured = stepById.get(key);
    const snapshotDay = group.logs.find((l) => l.step_day !== null)?.step_day ?? null;
    const day = configured?.day ?? snapshotDay;

    let label: string;
    if (configured) {
      // A step whose day was edited after these messages went out: name it by
      // what it is now, but keep what it was, so the row stays recognisable.
      label =
        snapshotDay !== null && snapshotDay !== configured.day
          ? `${configured.day} dagar (tidigare ${snapshotDay})`
          : `${configured.day} dagar`;
    } else if (snapshotDay !== null) {
      label = `${snapshotDay} dagar (borttagen)`;
    } else {
      label = "Okänt steg";
    }

    const groupContacted = new Set(group.logs.flatMap((l) => (l.patient_id ? [l.patient_id] : [])));
    const groupRebooked = new Set(group.credits.map((c) => c.patientId));
    const groupAttributed = group.credits.filter((c) =>
      isWithinAttributionWindow(c.days, attributionDays)
    );

    return {
      key,
      label,
      day,
      active: configured?.active ?? false,
      exists: !!configured,
      smsSent: group.logs.length,
      patientsContacted: groupContacted.size,
      rebookings: group.credits.length,
      rebookedPatients: groupRebooked.size,
      eventualRate: rate(groupRebooked.size, groupContacted.size),
      attributed: groupAttributed.length,
      attributedRate: rate(
        new Set(groupAttributed.map((c) => c.patientId)).size,
        groupContacted.size
      ),
      medianDays: median(group.credits.map((c) => c.days)),
    };
  });

  // Configured steps in cadence order first, then anything historical.
  perStep.sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1;
    return (a.day ?? Infinity) - (b.day ?? Infinity);
  });

  return {
    smsSent: sentLogs.length,
    patientsContacted: contacted.size,
    patientsRebooked: rebooked.size,
    eventualRate: rate(rebooked.size, contacted.size),
    attributedBookings: attributedCredits.length,
    attributedPatients: attributedPatients.size,
    attributedRate: rate(attributedPatients.size, contacted.size),
    firstSmsAt,
    distribution,
    perStep,
  };
}
