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
 * upcoming appointment therefore leaves last_booking_at on the PREVIOUS visit
 * until the appointment has passed. Before migration 027 nothing re-ran the
 * refresh then, and the new cycle was measured against the old visit (gap R4).
 * The daily cron now calls refresh_passed_booking_metadata before reading the
 * store, so the first cron after the appointment re-anchors the cycle on it.
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

describe("R4a fixed: a short gap after a rebooking is anchored on the new visit", () => {
  // Before 027: last_booking_at stayed on day 0 after the day-7 appointment, so
  // the 5-day SMS went out on day 8 (21 hours after the new visit) and the 14-day
  // on day 15, both filed against the old booking.
  // Now: day 8's cron refreshes the anchor to the day-7 visit before it reads the
  // store, so the new cycle runs from it: 5-day on day 13, 14-day on day 22.
  it("sends the 5-day SMS on day 13 and the 14-day on day 22, against the new booking", async () => {
    const id = importPatientSeenOn(0, "Anna Andersson");
    const oldBookingId = clinic.tables.bookings[0].id;
    await clinic.runDays(2);
    const newBookingId = rebookAt(id, 2, 7);
    const newVisit = atSimDay(7, 11);
    await clinic.runDays(5); // days 3..7, blocked (see above)

    // Regression pin: the anchor is still the old visit when day 8's cron starts,
    // and only the cron's refresh sweep moves it.
    setNow(atSimDay(8, 7));
    expect(clinic.patient(id).last_booking_at).toBe(atSimDay(0, 11));

    const days = await runDaysObserving(18, id); // days 8..25

    expect(days.map((d) => d.run.simDay)).toEqual([...Array(18).keys()].map((i) => 8 + i));
    expect(days[0].run.result).toMatchObject({ refreshed_patients: 1 });
    // Idempotent: once the anchor is current the sweep leaves the patient alone.
    expect(days.slice(1).map((d) => d.run.result)).toEqual(
      Array(17).fill(expect.objectContaining({ refreshed_patients: 0 }))
    );
    expect(days[0].status).toBe("Waiting");
    expect(clinic.patient(id).last_booking_at).toBe(newVisit);
    expect(clinic.patient(id).has_future_booking).toBe(false);
    expect(sendRows(id), clinic.formatTimeline([id])).toEqual([
      [13, "sent", 5, newBookingId],
      [22, "sent", 14, newBookingId]
    ]);
    const sends = clinic.sendsFor(id);
    expect(sends.map((entry) => calendarDaysBetween(newVisit, entry.at))).toEqual([6, 15]);
    expect(sends.map((entry) => entry.hoursSinceVisit)).toEqual([5 * 24 + 21, 14 * 24 + 21]);
    expect(sends.every((entry) => entry.bookingId !== oldBookingId)).toBe(true);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([13, 22]);
    // Nothing else in the window: the sends and the reset are the only rows.
    expect(clinic.timeline(id)).toHaveLength(3);
    expect(days.at(-1)!.status).toBe("Waiting");
  });
});

describe("rebooking contrast: metadata already refreshed by another write before the cron", () => {
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

    // The sweep only selects stale anchors, so it has nothing to do here.
    expect(days[0].run.result).toMatchObject({ refreshed_patients: 0 });
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

describe("R4b fixed: the rebooked cycle restarts from the new visit instead of re-picking old steps", () => {
  // Before 027: last_booking_at stayed on day 0 after the day-85 appointment, so
  // the emptied cycle re-picked step 14 against the OLD booking, collided with the
  // day-15 row on the 025 (patient_id, booking_id, step_id) index as a skipped
  // "Redan reserverad" on days 86-90, then sent the old visit's 90-day SMS on day
  // 91 and its 180-day one on day 181.
  // Now: day 86's cron re-anchors on the day-85 visit (21 hours ago, nothing
  // crossed), and the new cycle runs 5-day day 91, 14-day day 100, 90-day day
  // 176, all filed against the new booking.
  it("sends nothing on days 86-90, then the 5-day SMS on day 91 against the new booking", async () => {
    const { id, newBookingId } = await patientWithFinishedShortStepsRebookedForDay85("Anna Andersson");

    const blocked = await runDaysObserving(5, id); // days 81..85
    expect(blocked.map((d) => d.status)).toEqual(Array(5).fill("Future booking"));

    // Regression pin: with the stale day-0 anchor the engine would re-pick step 14
    // (what the store looks like right before day 86's cron). The cron's sweep is
    // what removes it.
    setNow(atSimDay(86, 7));
    const staleStore = clinic.readStore();
    expect(staleStore.patients.find((p) => p.id === id)!.last_booking_at).toBe(atSimDay(0, 11));
    expect(
      getNextSequence(staleStore.patients.find((p) => p.id === id)!, staleStore.reminder_settings[0], staleStore.reminder_logs)
    ).toEqual({ stepId: stepId(14), day: 14, sequenceNumber: 2 });

    const days = await runDaysObserving(6, id); // days 86..91

    expect(days.map((d) => d.run.simDay)).toEqual([86, 87, 88, 89, 90, 91]);
    expect(days[0].run.result).toMatchObject({ refreshed_patients: 1 });
    expect(clinic.patient(id).last_booking_at).toBe(atSimDay(85, 11));
    const store = clinic.readStore();
    expect(getNextSequence(store.patients.find((p) => p.id === id)!, store.reminder_settings[0], store.reminder_logs)).toBeNull();

    expect(logRowsFrom(id, 86), clinic.formatTimeline([id])).toEqual([[91, "sent", 5, null, null, newBookingId]]);
    expect(days.slice(0, 5).map((d) => [d.run.result.processed, d.status])).toEqual(Array(5).fill([0, "Waiting"]));
    expect(days[5].run.result).toMatchObject({ processed: 1, sent: 1 });
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([6, 15, 91]);

    const five = clinic.sendsFor(id).at(-1)!;
    expect(five.stepId).toBe(stepId(5));
    expect(calendarDaysBetween(atSimDay(85, 11), five.at)).toBe(6);
    expect(five.hoursSinceVisit).toBe(5 * 24 + 21);
  });

  it("runs the whole new cycle from the day-85 visit: 14-day on day 100, 90-day on day 176, no collisions", async () => {
    const { id, oldBookingId, newBookingId } = await patientWithFinishedShortStepsRebookedForDay85("Anna Andersson");

    await clinic.runDays(105); // days 81..185

    expect(sendRows(id), clinic.formatTimeline([id])).toEqual([
      [6, "sent", 5, oldBookingId],
      [15, "sent", 14, oldBookingId],
      [91, "sent", 5, newBookingId],
      [100, "sent", 14, newBookingId],
      [176, "sent", 90, newBookingId]
    ]);
    expect(clinic.sendsFor(id).slice(2).map((entry) => calendarDaysBetween(atSimDay(85, 11), entry.at))).toEqual([
      6, 15, 91
    ]);
    // A re-picked step is never reported as a parallel reservation any more: no
    // step is re-picked at all.
    expect(clinic.timeline(id).filter((entry) => entry.error === REDAN_RESERVERAD)).toEqual([]);
    expect(clinic.timeline(id).filter((entry) => entry.status === "skipped")).toEqual([]);
  });

  // Still open in process.ts, though R4 no longer reaches it: a genuine 025
  // collision (the same step and booking) is logged as a parallel reservation.
  it.todo("desired: a re-picked step that already went out for the old booking is not logged as a parallel reservation");
});

describe("R4c fixed: a rebooked patient no longer burns the max_per_day slot", () => {
  // Before 027: the rebooked patient's stale day-0 anchor made its queue key old
  // visit + 5 days, so it sorted ahead of every fresh patient and, with
  // max_per_day 1, its daily "Redan reserverad" row took the only slot on days
  // 86-90 and its 90-day SMS took day 91. A patient seen on day 81 waited until
  // day 92 (and with 5/10 steps lost the 5-day SMS entirely).
  // Now: day 86's cron re-anchors the rebooked patient on its day-85 visit, so it
  // has nothing due until day 91 and never takes a slot before then. The fresh
  // patient gets its 5-day SMS on day 87, the first cron after 5 x 24h.
  async function rebookedPatientAndFreshPatient() {
    clinic.configure({ maxPerDay: 1 });
    const rebooked = await patientWithFinishedShortStepsRebookedForDay85("Anna Andersson");
    await clinic.runDays(1); // day 81 08:00
    const fresh = importPatientSeenOn(81, "Cecilia Carlsson");
    const freshBookingId = clinic.tables.bookings.find((b) => b.patient_id === fresh)!.id;
    return { ...rebooked, fresh, freshBookingId };
  }

  it("gives the fresh patient's 5-day SMS the slot on day 87 with production steps", async () => {
    const { id, newBookingId, fresh, freshBookingId } = await rebookedPatientAndFreshPatient();

    const days = await runDaysObserving(12, fresh); // days 82..93

    const slotHolder = days.map((d) => [d.run.simDay, d.run.result.processed, d.run.result.results?.[0]?.patientId ?? null, d.status]);
    expect(slotHolder, clinic.formatTimeline()).toEqual([
      [82, 0, null, "Waiting"],
      [83, 0, null, "Waiting"],
      [84, 0, null, "Waiting"],
      [85, 0, null, "Waiting"],
      [86, 0, null, "Waiting"], // fresh patient 4d21h in: not due yet
      [87, 1, fresh, "Waiting"],
      [88, 0, null, "Waiting"],
      [89, 0, null, "Waiting"],
      [90, 0, null, "Waiting"],
      [91, 1, id, "Waiting"], // the rebooked patient's 5-day SMS, from the day-85 visit
      [92, 0, null, "Waiting"],
      [93, 0, null, "Waiting"]
    ]);
    expect(logRowsFrom(id, 86), clinic.formatTimeline([id])).toEqual([[91, "sent", 5, null, null, newBookingId]]);
    expect(sendRows(fresh), clinic.formatTimeline([fresh])).toEqual([[87, "sent", 5, freshBookingId]]);
    expect(clinic.timeline(fresh)).toHaveLength(1);
    expect(clinic.sendsFor(fresh)[0].daysSinceVisitDate).toBe(6);
    expect(days.find((d) => d.run.simDay === 87)!.run.result.results?.[0]?.overdueDays).toBe(0);
  });

  it("keeps the fresh patient's 5-day SMS with 5/10 steps", async () => {
    clinic.configure({ steps: STEPS_5_10 });
    const { id, newBookingId, fresh, freshBookingId } = await rebookedPatientAndFreshPatient();

    await clinic.runDays(12); // days 82..93

    // Rebooked patient: 5-day on day 91 from the day-85 visit; its 10-day (day 96) is past the window.
    expect(logRowsFrom(id, 86), clinic.formatTimeline([id])).toEqual([[91, "sent", 5, null, null, newBookingId]]);
    // Fresh patient: 5-day on day 87, 10-day on day 92 (10d21h after the day-81 visit).
    expect(sendRows(fresh), clinic.formatTimeline()).toEqual([
      [87, "sent", 5, freshBookingId],
      [92, "sent", 10, freshBookingId]
    ]);
    expect(clinic.sendsFor(fresh).map((entry) => entry.stepId)).toEqual([stepId(5, STEPS_5_10), stepId(10, STEPS_5_10)]);
  });

  // Still open in process.ts, though R4 no longer reaches it: a genuine 025
  // collision still counts as a processed patient in the capped batch.
  it.todo("desired: a duplicate-reservation skip does not use up a max_per_day slot");
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

describe("R4d fixed: rebooking between the 5- and 14-day SMS", () => {
  // Before 027 (production steps): the 5-day SMS went out on day 6, the webhook
  // on day 8 booked day 11, and last_booking_at stayed on day 0. From day 12 the
  // emptied cycle re-picked step 5 against the OLD booking, collided with the
  // day-6 row on the 025 index as a skipped "Redan reserverad" on days 12-14, then
  // sent the old visit's 14-day SMS on day 15, 4 days after the new visit. With
  // 5/10 steps (rebook day 7 for day 9): one collision on day 10 and the 10-day
  // SMS on day 11.
  // Now: day 12's cron re-anchors on the day-11 visit, so the new cycle is 5-day
  // on day 17 and 14-day on day 26 against the new booking, with no collision
  // rows; 5/10 steps give 5-day on day 15 and 10-day on day 20.
  it("sends the 5-day SMS on day 17 and the 14-day on day 26 after the day-11 visit, without collisions", async () => {
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
      ...[...Array(19).keys()].map((i) => [12 + i, "Waiting", 0])
    ]);
    // Regression pin: the anchor moved at day 12's cron, the first after the visit.
    expect(days.map((d) => [d.run.simDay, (d.run.result as { refreshed_patients?: number }).refreshed_patients])).toEqual(
      days.map((d) => [d.run.simDay, d.run.simDay === 12 ? 1 : 0])
    );
    expect(clinic.patient(id).last_booking_at).toBe(newVisit);

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
    expect(days.map((d) => d.run.result.processed)).toEqual(days.map((d) => ([17, 26].includes(d.run.simDay) ? 1 : 0)));
    const newCycle = clinic.sendsFor(id).slice(1);
    expect(newCycle.map((entry) => calendarDaysBetween(newVisit, entry.at))).toEqual([6, 15]);
    expect(newCycle.map((entry) => entry.hoursSinceVisit)).toEqual([5 * 24 + 21, 14 * 24 + 21]);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([6, 17, 26]);
  });

  it("with 5/10 steps and a day-9 visit: sends the 5-day SMS on day 15 and the 10-day on day 20", async () => {
    clinic.configure({ steps: STEPS_5_10 });
    const { id, oldBookingId, newBookingId, newVisit } = await patientWithFiveDaySentRebooked(7, 9);

    const days = await runDaysObserving(23, id); // days 8..30

    expect(
      days.map((d) => [d.run.simDay, d.status]),
      clinic.formatTimeline([id])
    ).toEqual([
      [8, "Future booking"],
      [9, "Future booking"], // 08:00, before the 11:00 appointment
      ...[...Array(21).keys()].map((i) => [10 + i, "Waiting"])
    ]);
    expect(days[2].run.result).toMatchObject({ refreshed_patients: 1 });
    expect(sendRows(id), clinic.formatTimeline([id])).toEqual([
      [6, "sent", 5, oldBookingId],
      [15, "sent", 5, newBookingId],
      [20, "sent", 10, newBookingId]
    ]);
    expect(logRowsFrom(id, 8).map(([day, status]) => [day, status])).toEqual([
      [15, "sent"],
      [20, "sent"]
    ]);
    const newCycle = clinic.sendsFor(id).slice(1);
    expect(newCycle.map((entry) => entry.stepId)).toEqual([stepId(5, STEPS_5_10), stepId(10, STEPS_5_10)]);
    expect(newCycle.map((entry) => entry.hoursSinceVisit)).toEqual([5 * 24 + 21, 10 * 24 + 21]);
    expect(newCycle.map((entry) => calendarDaysBetween(newVisit, entry.at))).toEqual([6, 11]);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([6, 15, 20]);
  });

  it("contrast: metadata already refreshed by another write gives the same days, 5-day on day 17 and 14-day on day 26", async () => {
    const { id, oldBookingId, newBookingId, newVisit } = await patientWithFiveDaySentRebooked(8, 11);

    const blocked = await runDaysObserving(3, id); // days 9..11
    expect(blocked.map((d) => d.status)).toEqual(Array(3).fill("Future booking"));

    // What any later write (a CSV import) would do, before day 12's cron.
    setNow(atSimDay(12, 7));
    clinic.refreshBookingMetadata(id);
    expect(clinic.patient(id).last_booking_at).toBe(newVisit);

    const days = await runDaysObserving(19, id); // days 12..30

    expect(days[0].run.result).toMatchObject({ refreshed_patients: 0 });
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
});
