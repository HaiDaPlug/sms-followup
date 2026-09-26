import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STEPS_5_10,
  atSimDay,
  calendarDaysBetween,
  createClinic,
  restoreClock,
  setNow,
  stepId,
  type FakeClinic,
  type SimDayRun
} from "@/test/sim";
import { getNextSequence } from "@/lib/reminders/eligibility";

vi.mock("@/lib/data/repository", async () => (await import("@/test/sim/fakeClinic")).repositoryMock);
vi.mock("@/lib/data/readStoreForUi", async () => (await import("@/test/sim/fakeClinic")).readStoreForUiMock);
vi.mock("@/lib/supabase/client", async () => ({ supabase: (await import("@/test/sim/fakeClinic")).supabaseMock }));
vi.mock("@/lib/sms/provider", async () => (await import("@/test/sim/fakeClinic")).providerMock);

/**
 * Rebooking through the BokaDirekt webhook (migration 023).
 *
 * The webhook writes a cycle_reset and refreshes last_booking_at, but 022's
 * refresh only counts visits with booking_at <= now(). A rebooking for an
 * upcoming appointment therefore leaves last_booking_at on the PREVIOUS visit,
 * and nothing re-runs the refresh when that appointment passes. From then on
 * the new cycle (logs after the reset) is measured against the old visit date.
 *
 * Every visit here is at 11:00 UTC, after the 08:00 UTC cron, so a step with
 * trigger day N first fires on calendar day N + 1 after its anchor visit (R2).
 */

const REDAN_RESERVERAD = "Redan reserverad av parallell förfrågan";
const SCHEDULE_CANCELLED = "Avbruten: patienten bokade en ny tid";

let clinic: FakeClinic;

beforeEach(() => {
  clinic = createClinic();
});

afterEach(() => {
  restoreClock();
});

/** Import a patient seen on `visitDay` at 11:00 UTC, recorded at 12:00 that day. */
function importPatientSeenOn(visitDay: number, name: string): string {
  setNow(atSimDay(visitDay, 12));
  return clinic.addPatient({ name, visitDay, visitHourUtc: 11 });
}

/** The BokaDirekt webhook at 10:00 UTC on `onDay` (after that day's cron) for an appointment on `forDay` at 11:00. */
function rebookAt(patientId: string, onDay: number, forDay: number): string {
  setNow(atSimDay(onDay, 10));
  return clinic.webhookRebook(patientId, { day: forDay, hourUtc: 11 });
}

/** One cron per day, recording the patient's status and that day's snapshot right after it. */
async function runDaysObserving(n: number, patientId: string) {
  const days: { run: SimDayRun; status: string; futureBookingCount: number }[] = [];
  for (let i = 0; i < n; i++) {
    const [run] = await clinic.runDays(1);
    const snapshot = clinic.tables.daily_snapshots.at(-1)!;
    days.push({ run, status: await clinic.statusOf(patientId), futureBookingCount: snapshot.future_booking });
  }
  return days;
}

function sendRows(patientId: string) {
  return clinic.sendsFor(patientId).map((entry) => [entry.simDay, entry.status, entry.stepDay, entry.bookingId]);
}

describe("rebooking for an upcoming appointment", () => {
  it("writes a cycle_reset, keeps last_booking_at on the old visit and blocks sends until the appointment", async () => {
    const id = importPatientSeenOn(0, "Anna Andersson");
    // Same visit, never rebooked: shows the 5-day step really is due inside the blocked window.
    const control = clinic.addPatient({ name: "Bo Berg", visitDay: 0, visitHourUtc: 11 });
    const oldBookingId = clinic.tables.bookings[0].id;
    const oldVisit = atSimDay(0, 11);
    expect(clinic.patient(id).last_booking_at).toBe(oldVisit);

    await clinic.runDays(2); // days 1 and 2, before the webhook
    const newBookingId = rebookAt(id, 2, 7);

    const resets = clinic.logsFor(id).filter((log) => log.is_cycle_reset);
    expect(resets, clinic.formatTimeline([id])).toHaveLength(1);
    expect(resets[0]).toMatchObject({ status: "cycle_reset", booking_id: newBookingId, created_at: atSimDay(2, 10) });
    // 022 refresh ignores the future appointment.
    expect(clinic.patient(id).last_booking_at).toBe(oldVisit);
    expect(newBookingId).not.toBe(oldBookingId);
    expect(await clinic.statusOf(id)).toBe("Future booking");

    const days = await runDaysObserving(5, id); // days 3..7

    expect(days.map((d) => d.run.simDay)).toEqual([3, 4, 5, 6, 7]);
    // The cron evaluated the patient every day and counted it as a future booking,
    // right up to day 7 08:00 (the appointment is at 11:00).
    expect(days.map((d) => d.status)).toEqual(Array(5).fill("Future booking"));
    expect(days.map((d) => d.futureBookingCount)).toEqual([1, 1, 1, 1, 1]);
    expect(clinic.patient(id).has_future_booking).toBe(true);
    expect(clinic.patient(id).last_booking_at).toBe(oldVisit);
    expect(clinic.providerCallsFor(id), clinic.formatTimeline()).toEqual([]);
    // Only the reset: Future booking patients never reach sendReminderToPatient in the cron.
    expect(clinic.timeline(id).map((entry) => entry.isCycleReset)).toEqual([true]);

    // Control: 5 days elapse at day 5 11:00, so the 08:00 cron sends on day 6.
    expect(clinic.providerCallsFor(control).map((call) => call.simDay), clinic.formatTimeline()).toEqual([6]);
    expect(days[3].run.result).toMatchObject({ processed: 1, sent: 1 });
  });
});

describe("known gap R4a: short gap after a rebooking is anchored on the old visit", () => {
  // Current: once the day-7 appointment passes, last_booking_at still says day 0.
  // The new cycle has no sends yet and the patient is already 7+ days past the
  // OLD visit, so the 5-day SMS goes out the morning after the new visit and the
  // 14-day SMS on old-visit day 15, only 8 days after the new visit. Both logs
  // reference the old booking (latestValidBooking matches last_booking_at).
  // Desired: the cycle is anchored on the day-7 visit, i.e. 5-day on day 13 and
  // 14-day on day 22 (the refreshed contrast below).
  it("sends the 5-day SMS on day 8 and the 14-day on day 15, 1 and 8 days after the new visit", async () => {
    const id = importPatientSeenOn(0, "Anna Andersson");
    const oldBookingId = clinic.tables.bookings[0].id;
    await clinic.runDays(2);
    const newBookingId = rebookAt(id, 2, 7);
    const newVisit = atSimDay(7, 11);
    await clinic.runDays(5); // days 3..7, blocked (see above)

    const days = await runDaysObserving(18, id); // days 8..25

    expect(days.map((d) => d.run.simDay)).toEqual([...Array(18).keys()].map((i) => 8 + i));
    expect(clinic.patient(id).last_booking_at).toBe(atSimDay(0, 11));
    expect(clinic.patient(id).has_future_booking).toBe(false);
    expect(sendRows(id), clinic.formatTimeline([id])).toEqual([
      [8, "sent", 5, oldBookingId],
      [15, "sent", 14, oldBookingId]
    ]);
    const sends = clinic.sendsFor(id);
    expect(sends.map((entry) => calendarDaysBetween(newVisit, entry.at))).toEqual([1, 8]);
    // Day 8 08:00 is 7d21h after the old visit (floor 7 >= 5) but only 21h after the new one.
    expect(sends.map((entry) => (Date.parse(entry.at) - Date.parse(newVisit)) / 3_600_000)).toEqual([21, 189]);
    expect(sends.map((entry) => entry.hoursSinceVisit)).toEqual([7 * 24 + 21, 14 * 24 + 21]);
    expect(sends.every((entry) => entry.bookingId !== newBookingId)).toBe(true);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([8, 15]);
    // Nothing else in the window: the sends and the reset are the only rows.
    expect(clinic.timeline(id)).toHaveLength(3);
    expect(days.at(-1)!.status).toBe("Waiting");
  });

  it.todo("desired: after the day-7 visit passes, the 5-day SMS goes out on day 13 and the 14-day on day 22");
});

describe("rebooking contrast: metadata refreshed after the new visit", () => {
  it("anchors the cycle on the new visit, so the 5-day SMS lands 6 calendar days after it", async () => {
    const id = importPatientSeenOn(0, "Anna Andersson");
    await clinic.runDays(2);
    const newBookingId = rebookAt(id, 2, 7);
    const newVisit = atSimDay(7, 11);
    await clinic.runDays(5); // days 3..7

    // What any later write (a CSV import) would do, before day 8's cron.
    setNow(atSimDay(8, 7));
    clinic.refreshBookingMetadata(id);
    expect(clinic.patient(id).last_booking_at).toBe(newVisit);

    const days = await runDaysObserving(18, id); // days 8..25

    expect(days[0].status).toBe("Waiting");
    expect(sendRows(id), clinic.formatTimeline([id])).toEqual([
      [13, "sent", 5, newBookingId],
      [22, "sent", 14, newBookingId]
    ]);
    const sends = clinic.sendsFor(id);
    expect(sends.map((entry) => entry.daysSinceVisitDate)).toEqual([6, 15]);
    expect(sends.map((entry) => entry.hoursSinceVisit)).toEqual([5 * 24 + 21, 14 * 24 + 21]);
    expect(sends.map((entry) => calendarDaysBetween(newVisit, entry.at))).toEqual([6, 15]);
  });
});

/**
 * Visit day 0; both short steps sent (5-day on day 6, 14-day on day 15, or
 * 10-day on day 11 with 5/10 steps); waiting through day 80; rebooked on day 80
 * for day 85.
 */
async function patientWithFinishedShortStepsRebookedForDay85(name: string) {
  const id = importPatientSeenOn(0, name);
  const oldBookingId = clinic.tables.bookings.find((b) => b.patient_id === id)!.id;
  const secondDay = clinic.settings().sms_steps![1].day;
  await clinic.runDays(80); // days 1..80
  expect(sendRows(id), clinic.formatTimeline([id])).toEqual([
    [6, "sent", 5, oldBookingId],
    [secondDay + 1, "sent", secondDay, oldBookingId]
  ]);
  const newBookingId = rebookAt(id, 80, 85);
  return { id, oldBookingId, newBookingId };
}

describe("known gap R4b: the rebooked cycle re-picks a step already sent for the old booking", () => {
  // Current: after the day-85 appointment passes, last_booking_at is still day 0
  // and the reset emptied the cycle, so getNextSequence picks the highest crossed
  // step, 14, again. Its reservation reuses the OLD booking_id, collides with the
  // day-15 row on the 025 (patient_id, booking_id, step_id) index, and the cron
  // logs a skipped "Redan reserverad" every day until old-visit day 90 is
  // crossed. Then the 90-day SMS goes out 6 days after the new visit, and the
  // 180-day one on old-visit day 181.
  // Desired: the day-85 visit anchors the new cycle (5-day on day 91, 14-day on
  // day 100) and a step collision is never reported as a parallel reservation.
  it("collides on step 14 on days 86-90, then sends the 90-day SMS on day 91", async () => {
    const { id, oldBookingId } = await patientWithFinishedShortStepsRebookedForDay85("Anna Andersson");

    const blocked = await runDaysObserving(5, id); // days 81..85
    expect(blocked.map((d) => d.status)).toEqual(Array(5).fill("Future booking"));

    setNow(atSimDay(86, 7));
    const store = clinic.readStore();
    const next = getNextSequence(store.patients.find((p) => p.id === id)!, store.reminder_settings[0], store.reminder_logs);
    expect(next).toEqual({ stepId: stepId(14), day: 14, sequenceNumber: 2 });

    const days = await runDaysObserving(6, id); // days 86..91

    expect(days.map((d) => d.run.simDay)).toEqual([86, 87, 88, 89, 90, 91]);
    const afterReset = clinic.timeline(id).filter((entry) => entry.simDay >= 86);
    expect(
      afterReset.map((entry) => [entry.simDay, entry.status, entry.stepDay, entry.skipReason, entry.error, entry.bookingId]),
      clinic.formatTimeline([id])
    ).toEqual([
      [86, "skipped", null, "sequence_complete", REDAN_RESERVERAD, oldBookingId],
      [87, "skipped", null, "sequence_complete", REDAN_RESERVERAD, oldBookingId],
      [88, "skipped", null, "sequence_complete", REDAN_RESERVERAD, oldBookingId],
      [89, "skipped", null, "sequence_complete", REDAN_RESERVERAD, oldBookingId],
      [90, "skipped", null, "sequence_complete", REDAN_RESERVERAD, oldBookingId],
      [91, "sent", 90, null, null, oldBookingId]
    ]);
    // Each collision still counts as a processed patient in the daily batch.
    expect(days.slice(0, 5).map((d) => d.run.result)).toEqual(
      Array(5).fill(expect.objectContaining({ processed: 1, sent: 0, skipped: 1 }))
    );
    expect(days.slice(0, 5).map((d) => d.status)).toEqual(Array(5).fill("Ready"));
    expect(days[5].run.result).toMatchObject({ processed: 1, sent: 1 });
    // The collisions never reached the provider.
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([6, 15, 91]);

    const ninety = clinic.sendsFor(id).at(-1)!;
    expect(ninety.stepId).toBe(stepId(90));
    expect(calendarDaysBetween(atSimDay(85, 11), ninety.at)).toBe(6);
    expect(ninety.hoursSinceVisit).toBe(90 * 24 + 21);
    expect(clinic.patient(id).last_booking_at).toBe(atSimDay(0, 11));
  });

  it("keeps the old anchor for the 180-day SMS: day 181, 96 days after the new visit", async () => {
    const { id, oldBookingId } = await patientWithFinishedShortStepsRebookedForDay85("Anna Andersson");

    await clinic.runDays(105); // days 81..185

    expect(sendRows(id), clinic.formatTimeline([id])).toEqual([
      [6, "sent", 5, oldBookingId],
      [15, "sent", 14, oldBookingId],
      [91, "sent", 90, oldBookingId],
      [181, "sent", 180, oldBookingId]
    ]);
    expect(calendarDaysBetween(atSimDay(85, 11), clinic.sendsFor(id).at(-1)!.at)).toBe(96);
    expect(clinic.timeline(id).filter((entry) => entry.error === REDAN_RESERVERAD)).toHaveLength(5);
  });

  it.todo("desired: after the day-85 visit the cycle restarts from it (5-day on day 91, 14-day on day 100)");
  it.todo("desired: a re-picked step that already went out for the old booking is not logged as a parallel reservation");
});

describe("known gap R4c: a colliding patient burns the max_per_day slot", () => {
  // Current: the colliding patient's queue key is old visit + 5 days (the earliest
  // step still owed in the emptied cycle), so it sorts ahead of every fresh
  // patient. With max_per_day 1 its daily "Redan reserverad" row takes the only
  // slot on days 86-90, then its (legitimate) 90-day SMS takes day 91. A patient
  // seen on day 81 is Ready from day 87 but first gets a slot on day 92.
  // Desired: a collision does not consume a slot, and the colliding patient does
  // not outrank patients whose own visit is recent.
  async function collidingPatientAndFreshPatient() {
    clinic.configure({ maxPerDay: 1 });
    const colliding = await patientWithFinishedShortStepsRebookedForDay85("Anna Andersson");
    await clinic.runDays(1); // day 81 08:00
    const fresh = importPatientSeenOn(81, "Cecilia Carlsson");
    const freshBookingId = clinic.tables.bookings.find((b) => b.patient_id === fresh)!.id;
    return { ...colliding, fresh, freshBookingId };
  }

  it("starves a fresh patient's 5-day SMS from day 87 to day 92 with production steps", async () => {
    const { id, fresh, freshBookingId } = await collidingPatientAndFreshPatient();

    const days = await runDaysObserving(12, fresh); // days 82..93

    const slotHolder = days.map((d) => [d.run.simDay, d.run.result.processed, d.run.result.results?.[0]?.patientId ?? null, d.status]);
    expect(slotHolder, clinic.formatTimeline()).toEqual([
      [82, 0, null, "Waiting"],
      [83, 0, null, "Waiting"],
      [84, 0, null, "Waiting"],
      [85, 0, null, "Waiting"],
      [86, 1, id, "Waiting"], // fresh patient 4d21h in: not due yet
      [87, 1, id, "Ready"],
      [88, 1, id, "Ready"],
      [89, 1, id, "Ready"],
      [90, 1, id, "Ready"],
      [91, 1, id, "Ready"], // the colliding patient's 90-day SMS
      [92, 1, fresh, "Waiting"],
      [93, 0, null, "Waiting"]
    ]);
    expect(
      clinic.timeline(id).filter((entry) => entry.simDay >= 86).map((entry) => [entry.simDay, entry.status, entry.error])
    ).toEqual([
      [86, "skipped", REDAN_RESERVERAD],
      [87, "skipped", REDAN_RESERVERAD],
      [88, "skipped", REDAN_RESERVERAD],
      [89, "skipped", REDAN_RESERVERAD],
      [90, "skipped", REDAN_RESERVERAD],
      [91, "sent", null]
    ]);
    // Queued patients past the cap get no log at all, so the only trace of the wait is the late send.
    expect(sendRows(fresh), clinic.formatTimeline([fresh])).toEqual([[92, "sent", 5, freshBookingId]]);
    expect(clinic.timeline(fresh)).toHaveLength(1);
    expect(clinic.sendsFor(fresh)[0].daysSinceVisitDate).toBe(11);
    expect(days.find((d) => d.run.simDay === 92)!.run.result.results?.[0]?.overdueDays).toBe(5);
  });

  it("makes a fresh patient skip the 5-day SMS entirely with 5/10 steps", async () => {
    clinic.configure({ steps: STEPS_5_10 });
    const { id, fresh, freshBookingId } = await collidingPatientAndFreshPatient();

    await clinic.runDays(12); // days 82..93

    // 10 and 14 share a step id, so the collision pattern is identical.
    expect(
      clinic.timeline(id).filter((entry) => entry.simDay >= 86).map((entry) => [entry.simDay, entry.status, entry.stepDay])
    ).toEqual([
      [86, "skipped", null],
      [87, "skipped", null],
      [88, "skipped", null],
      [89, "skipped", null],
      [90, "skipped", null],
      [91, "sent", 90]
    ]);
    // Day 92 08:00 is 10d21h after the day-81 visit: the highest crossed step is 10, so 5 is never sent.
    expect(sendRows(fresh), clinic.formatTimeline()).toEqual([[92, "sent", 10, freshBookingId]]);
    expect(clinic.sendsFor(fresh)[0].stepId).toBe(stepId(10, STEPS_5_10));
    expect(clinic.sendsFor(fresh).some((entry) => entry.stepDay === 5)).toBe(false);
  });

  it.todo("desired: a duplicate-reservation skip does not use up a max_per_day slot");
  it.todo("desired: the fresh patient gets the 5-day SMS on day 87 despite the colliding patient");
});

describe("cancelled rebooking", () => {
  it("lifts the future block and sends exactly as if the rebooking never happened", async () => {
    const id = importPatientSeenOn(0, "Anna Andersson");
    const control = clinic.addPatient({ name: "Bo Berg", visitDay: 0, visitHourUtc: 11 });
    const oldBookingId = clinic.tables.bookings[0].id;
    await clinic.runDays(2);
    const newBookingId = rebookAt(id, 2, 7);

    const blocked = await runDaysObserving(2, id); // days 3, 4 (cron before the cancel)
    expect(blocked.map((d) => [d.run.simDay, d.status, d.futureBookingCount])).toEqual([
      [3, "Future booking", 1],
      [4, "Future booking", 1]
    ]);

    setNow(atSimDay(4, 10));
    expect(clinic.cancelBooking(newBookingId)).toBe(true);
    // 023 deletes the reset, so the old cycle simply continues.
    expect(clinic.logsFor(id).filter((log) => log.is_cycle_reset)).toEqual([]);
    expect(clinic.tables.bookings.find((b) => b.id === newBookingId)).toMatchObject({ cancelled: true, status: "Cancelled" });
    expect(clinic.patient(id).last_booking_at).toBe(atSimDay(0, 11));
    // 3d23h since the visit: nothing crossed yet.
    expect(await clinic.statusOf(id)).toBe("Waiting");

    const days = await runDaysObserving(16, id); // days 5..20

    expect(days.map((d) => d.futureBookingCount)).toEqual(Array(16).fill(0));
    expect(days[0].status).toBe("Waiting");
    expect(sendRows(id), clinic.formatTimeline()).toEqual([
      [6, "sent", 5, oldBookingId],
      [15, "sent", 14, oldBookingId]
    ]);
    expect(clinic.sendsFor(control).map((entry) => [entry.simDay, entry.stepDay])).toEqual([
      [6, 5],
      [15, 14]
    ]);
    expect(clinic.timeline(id)).toHaveLength(2);
  });
});

describe("rebooking cancels a pending scheduled SMS", () => {
  it("cancels the row and the worker never sends it, while an untouched schedule goes out", async () => {
    const id = importPatientSeenOn(0, "Anna Andersson");
    const control = clinic.addPatient({ name: "Bo Berg", visitDay: 0, visitHourUtc: 11 });

    setNow(atSimDay(1, 12));
    const scheduled = await clinic.scheduleSms({ patientId: id, stepDay: 5, day: 5, hourUtc: 9 });
    const controlScheduled = await clinic.scheduleSms({ patientId: control, stepDay: 5, day: 5, hourUtc: 9 });
    expect(scheduled).toMatchObject({ status: "pending", step_id: stepId(5) });

    await clinic.runDays(1, { scheduledWorker: true }); // day 2 08:00
    rebookAt(id, 2, 7);

    expect(clinic.scheduledFor(id)).toEqual([
      expect.objectContaining({
        id: scheduled.id,
        status: "cancelled",
        error: SCHEDULE_CANCELLED,
        completed_at: atSimDay(2, 10),
        attempt_count: 0,
        reminder_log_id: null
      })
    ]);
    expect(clinic.scheduledFor(control)[0].status).toBe("pending");

    await clinic.runDays(3, { scheduledWorker: true }); // days 3..5 at 08:00, before the 09:00 slot
    const ticks = await clinic.runWorkerTicksUntil(atSimDay(5, 10));

    // Only the control row was due at day 5 09:00; the cancelled row was never claimed.
    expect(ticks.map((tick) => [tick.at, tick.result.processed, tick.result.results[0]?.scheduledSmsId])).toEqual([
      [atSimDay(5, 9), 1, controlScheduled.id]
    ]);
    expect(clinic.providerCallsFor(control).map((call) => [call.simDay, call.message])).toEqual([
      [5, controlScheduled.message_override]
    ]);

    const later = await clinic.runDays(2, { scheduledWorker: true }); // days 6, 7
    expect(later.map((run) => run.scheduled?.processed)).toEqual([0, 0]);
    expect(clinic.providerCallsFor(id), clinic.formatTimeline()).toEqual([]);
    expect(clinic.scheduledFor(id)[0]).toMatchObject({ status: "cancelled", attempt_count: 0 });
    expect(await clinic.statusOf(id)).toBe("Future booking");
    expect(clinic.timeline(id).map((entry) => entry.isCycleReset)).toEqual([true]);
  });
});

/**
 * Visit day 0 at 11:00, 5-day SMS on day 6 (the first 08:00 cron after 5 x 24h),
 * crons through `webhookDay` 08:00, then the webhook at 10:00 that day for an
 * appointment on `appointmentDay` at 11:00. Works for PRODUCTION_STEPS and
 * STEPS_5_10 alike because both start with the 5-day step.
 */
async function patientWithFiveDaySentRebooked(webhookDay: number, appointmentDay: number) {
  const id = importPatientSeenOn(0, "Anna Andersson");
  const oldBookingId = clinic.tables.bookings.find((b) => b.patient_id === id)!.id;
  await clinic.runDays(webhookDay); // days 1..webhookDay
  expect(sendRows(id), clinic.formatTimeline([id])).toEqual([[6, "sent", 5, oldBookingId]]);
  const newBookingId = rebookAt(id, webhookDay, appointmentDay);
  return { id, oldBookingId, newBookingId, newVisit: atSimDay(appointmentDay, 11) };
}

/** Timeline rows written after `fromDay`, in the shape the collision assertions compare. */
function logRowsFrom(patientId: string, fromDay: number) {
  return clinic
    .timeline(patientId)
    .filter((entry) => entry.simDay >= fromDay)
    .map((entry) => [entry.simDay, entry.status, entry.stepDay, entry.skipReason, entry.error, entry.bookingId]);
}

describe("known gap R4d: rebooking between the 5- and 14-day SMS", () => {
  // Current (production steps): the 5-day SMS went out on day 6, the webhook on
  // day 8 books day 11. The reset empties the cycle, but last_booking_at stays on
  // day 0 (022 ignores the upcoming appointment and nothing refreshes it once it
  // passes). From day 12 the engine therefore sees an empty cycle 12+ days after
  // the OLD visit: the highest crossed step is 5 again. latestValidBooking
  // matches last_booking_at, so the reservation carries the OLD booking id and
  // collides with the day-6 row on the 025 (patient, booking, step) index, which
  // process.ts reports as a skipped "Redan reserverad av parallell förfrågan".
  // That repeats until old-visit day 14 is crossed (day 15 08:00 = 14d21h), when
  // the 14-day SMS goes out, filed against the old booking, only 4 calendar
  // days (93 hours) after the new visit. Nothing else follows until the 90-day
  // step of the OLD visit (day 91).
  // With 5/10 steps (rebook day 7 for day 9) the same mechanics give one
  // collision on day 10 and the 10-day SMS on day 11, 2 days after the visit.
  // Desired: the day-11 visit anchors the new cycle (5-day on day 17, 14-day on
  // day 26), exactly the refreshed contrast below, with no collision rows.
  it("collides on step 5 on days 12-14, then sends the 14-day SMS on day 15, 4 days after the new visit", async () => {
    const { id, oldBookingId, newBookingId, newVisit } = await patientWithFiveDaySentRebooked(8, 11);
    expect(clinic.patient(id).last_booking_at).toBe(atSimDay(0, 11));

    const days = await runDaysObserving(22, id); // days 9..30

    expect(days.map((d) => d.run.simDay)).toEqual([...Array(22).keys()].map((i) => 9 + i));
    expect(
      days.map((d) => [d.run.simDay, d.status, d.futureBookingCount]),
      clinic.formatTimeline([id])
    ).toEqual([
      // Day 11 08:00 is still before the 11:00 appointment.
      [9, "Future booking", 1],
      [10, "Future booking", 1],
      [11, "Future booking", 1],
      // A skipped collision is not a send, so the 5-step stays "crossed and unsent".
      [12, "Ready", 0],
      [13, "Ready", 0],
      [14, "Ready", 0],
      ...[...Array(16).keys()].map((i) => [15 + i, "Waiting", 0])
    ]);
    expect(logRowsFrom(id, 9), clinic.formatTimeline([id])).toEqual([
      [12, "skipped", null, "sequence_complete", REDAN_RESERVERAD, oldBookingId],
      [13, "skipped", null, "sequence_complete", REDAN_RESERVERAD, oldBookingId],
      [14, "skipped", null, "sequence_complete", REDAN_RESERVERAD, oldBookingId],
      [15, "sent", 14, null, null, oldBookingId]
    ]);
    // Each collision is a processed patient in the daily batch (it holds a max_per_day slot, R4c).
    expect(days.slice(3, 6).map((d) => d.run.result)).toEqual(
      Array(3).fill(expect.objectContaining({ processed: 1, sent: 0, skipped: 1 }))
    );
    expect(days[6].run.result).toMatchObject({ processed: 1, sent: 1 });
    // Nothing is picked from day 16 to day 30: the next step is the OLD visit's 90-day.
    expect(days.slice(7).map((d) => d.run.result.processed)).toEqual(Array(15).fill(0));

    const fourteen = clinic.sendsFor(id).at(-1)!;
    expect(fourteen.stepId).toBe(stepId(14));
    expect(fourteen.hoursSinceVisit).toBe(14 * 24 + 21); // measured from the old visit
    expect(calendarDaysBetween(newVisit, fourteen.at)).toBe(4);
    expect((Date.parse(fourteen.at) - Date.parse(newVisit)) / 3_600_000).toBe(3 * 24 + 21);
    expect(clinic.logsFor(id).some((log) => log.booking_id === newBookingId && !log.is_cycle_reset)).toBe(false);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([6, 15]);
    expect(clinic.patient(id).last_booking_at).toBe(atSimDay(0, 11));
  });

  it("with 5/10 steps: collides on step 5 on day 10, then sends the 10-day SMS on day 11, 2 days after the new visit", async () => {
    clinic.configure({ steps: STEPS_5_10 });
    const { id, oldBookingId, newVisit } = await patientWithFiveDaySentRebooked(7, 9);

    const days = await runDaysObserving(23, id); // days 8..30

    expect(
      days.map((d) => [d.run.simDay, d.status]),
      clinic.formatTimeline([id])
    ).toEqual([
      [8, "Future booking"],
      [9, "Future booking"], // 08:00, before the 11:00 appointment
      [10, "Ready"], // 9d21h after the old visit: only the 5-step is crossed
      ...[...Array(20).keys()].map((i) => [11 + i, "Waiting"])
    ]);
    expect(logRowsFrom(id, 8), clinic.formatTimeline([id])).toEqual([
      [10, "skipped", null, "sequence_complete", REDAN_RESERVERAD, oldBookingId],
      [11, "sent", 10, null, null, oldBookingId]
    ]);
    const ten = clinic.sendsFor(id).at(-1)!;
    expect(ten.stepId).toBe(stepId(10, STEPS_5_10));
    expect(ten.hoursSinceVisit).toBe(10 * 24 + 21);
    expect(calendarDaysBetween(newVisit, ten.at)).toBe(2);
    expect((Date.parse(ten.at) - Date.parse(newVisit)) / 3_600_000).toBe(45);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([6, 11]);
  });

  it("contrast: metadata refreshed after the new visit anchors the 5-day on day 17 and the 14-day on day 26", async () => {
    const { id, oldBookingId, newBookingId, newVisit } = await patientWithFiveDaySentRebooked(8, 11);

    const blocked = await runDaysObserving(3, id); // days 9..11
    expect(blocked.map((d) => d.status)).toEqual(Array(3).fill("Future booking"));

    // What any later write (a CSV import) would do, before day 12's cron.
    setNow(atSimDay(12, 7));
    clinic.refreshBookingMetadata(id);
    expect(clinic.patient(id).last_booking_at).toBe(newVisit);

    const days = await runDaysObserving(19, id); // days 12..30

    expect(days[0].status).toBe("Waiting");
    expect(sendRows(id), clinic.formatTimeline([id])).toEqual([
      [6, "sent", 5, oldBookingId],
      [17, "sent", 5, newBookingId],
      [26, "sent", 14, newBookingId]
    ]);
    // Only the reset and the two new sends after the webhook: no collision rows.
    expect(logRowsFrom(id, 8).map(([day, status]) => [day, status])).toEqual([
      [8, "cycle_reset"],
      [17, "sent"],
      [26, "sent"]
    ]);
    const newCycle = clinic.sendsFor(id).slice(1);
    expect(newCycle.map((entry) => calendarDaysBetween(newVisit, entry.at))).toEqual([6, 15]);
    expect(newCycle.map((entry) => entry.hoursSinceVisit)).toEqual([5 * 24 + 21, 14 * 24 + 21]);
  });

  it.todo("desired: after a rebooking between the 5- and 14-day SMS, the 5-day goes out on day 17 and the 14-day on day 26 without a refresh");
  it.todo("desired: with 5/10 steps and a day-9 visit, the 5-day goes out on day 15 and the 10-day on day 20");
});
