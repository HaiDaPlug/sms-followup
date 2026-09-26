import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRON_LATEST_MINUTE,
  PRODUCTION_STEPS,
  STEPS_5_10,
  advanceHours,
  atSimDay,
  createClinic,
  restoreClock,
  setNow,
  simDayOf,
  stepId,
  type FakeClinic,
  type SimDayRun
} from "@/test/sim";

vi.mock("@/lib/data/repository", async () => (await import("@/test/sim/fakeClinic")).repositoryMock);
vi.mock("@/lib/data/readStoreForUi", async () => (await import("@/test/sim/fakeClinic")).readStoreForUiMock);
vi.mock("@/lib/supabase/client", async () => ({ supabase: (await import("@/test/sim/fakeClinic")).supabaseMock }));
vi.mock("@/lib/sms/provider", async () => (await import("@/test/sim/fakeClinic")).providerMock);

let clinic: FakeClinic;

beforeEach(() => {
  clinic = createClinic();
});

afterEach(() => {
  restoreClock();
});

/** [simDay, stepDay] of every step-consuming log, oldest first. */
function sendDays(patientId: string): [number, number | null][] {
  return clinic.sendsFor(patientId).map((entry) => [entry.simDay, entry.stepDay]);
}

/** The cohort the cron counted on `day`: proof it ran and evaluated everyone, even when it sent nothing. */
function snapshotOn(day: number) {
  const snapshots = clinic.tables.daily_snapshots.filter((row) => simDayOf(row.snapped_at) === day);
  expect(snapshots, `expected exactly one cron run on sim day ${day}`).toHaveLength(1);
  return snapshots[0];
}

/** Patients the cron handed to sendReminderToPatient in that run (queue order, after the cap). */
function processedIn(run: SimDayRun): string[] {
  // The inactive-automation early return carries no results.
  return (run.result.results ?? []).map((row) => row.patientId);
}

function runOn(runs: SimDayRun[], day: number): SimDayRun {
  const run = runs.find((candidate) => candidate.simDay === day);
  if (!run) throw new Error(`no cron run on sim day ${day}`);
  return run;
}

function range(from: number, toInclusive: number): number[] {
  return Array.from({ length: toInclusive - from + 1 }, (_, i) => from + i);
}

function rendered(template: string, firstName: string): string {
  return template.replaceAll("{{firstName}}", firstName).replaceAll("{{bookingLink}}", "https://bokat.se/osteopaticentrum");
}

describe("known gap R2: 'day N' means N x 24 elapsed hours at the 08:00 UTC cron", () => {
  // Current: daysBetween floors (now - last_booking_at) / 24h, and the only
  // chance to send is the daily cron scheduled for 08:00 UTC (09:00 Stockholm
  // in winter, 10:00 in summer). On Vercel Hobby it actually fires somewhere
  // between 08:00 and 08:59 UTC. A visit later in the day than that has only
  // accumulated N x 24h minus a few hours by the Nth morning, so it waits one
  // more cron: the 5-day SMS goes out on calendar day 6 and the 14-day one on
  // day 15. Visits stored at or before 08:00 UTC are always on time, visits at
  // 09:00 UTC or later always slip, and visits in between depend on that
  // morning's invocation minute.
  // Which UTC instant a visit is stored at depends on how it arrived. The CSV
  // import parses the wall-clock time in the server's time zone
  // (parseBookingDate, normalizers.ts), which is UTC on Vercel, so an imported
  // 09:00 appointment is stored as 09:00Z and slips; for imported visits the
  // on-time cutoff is 08:00 local wall-clock time all year. A visit stored
  // with its real Stockholm offset gets the 09:00 (winter) / 10:00 (summer)
  // local cutoff instead. Either way nearly every appointment slips, so this
  // is the common case, not an edge. The simulator takes stored UTC instants
  // directly and never goes through parseBookingDate.
  // Desired: the follow-up lands on the Nth calendar day after the visit
  // whatever the visit hour.

  it("at an on-the-minute 08:00:00 invocation, a visit at or before 08:00 UTC gets the 5- and 14-day SMS on days 5 and 14, a later one on days 6 and 15", async () => {
    // Clock after the last visit so the import can record all four.
    setNow(atSimDay(0, 11));
    const at0700 = clinic.addPatient({ name: "Tidig Patient", visitDay: 0, visitHourUtc: 7 });
    const at0800 = clinic.addPatient({ name: "Prick Patient", visitDay: 0, visitHourUtc: 8 });
    const at0801 = clinic.addPatient({ name: "Minut Patient", visitDay: 0, visitHourUtc: 8, visitAt: atSimDay(0, 8, 1) });
    const at1100 = clinic.addPatient({ name: "Sen Patient", visitDay: 0, visitHourUtc: 11 });

    const runs = await clinic.runDays(20);

    // Day 0's cron (08:00) was already past, so twenty crons cover days 1..20.
    expect(runs.map((run) => run.simDay)).toEqual(range(1, 20));

    const summary = (id: string) =>
      clinic.sendsFor(id).map((entry) => [entry.daysSinceVisitDate, entry.stepDay, entry.hoursSinceVisit]);
    const table = clinic.formatTimeline();
    expect(summary(at0700), table).toEqual([[5, 5, 121], [14, 14, 337]]);
    // Exactly 120h at the day-5 cron still floors to 5: the boundary is inclusive.
    expect(summary(at0800), table).toEqual([[5, 5, 120], [14, 14, 336]]);
    // One minute later: 119h59m on day 5 floors to 4, so it slips a whole day
    // and goes out at 143h59m instead. This minute-sharp boundary exists only
    // because runDays fires at 08:00:00 exactly; see the Hobby case below.
    expect(summary(at0801), table).toEqual([[6, 5, (6 * 24 * 60 - 1) / 60], [15, 14, (15 * 24 * 60 - 1) / 60]]);
    expect(summary(at1100), table).toEqual([[6, 5, 141], [15, 14, 357]]);

    // Both late visits were evaluated on day 5 and counted as Waiting, not missed.
    expect(processedIn(runOn(runs, 5)), table).toEqual([at0700, at0800]);
    expect(snapshotOn(5)).toMatchObject({ total_patients: 4, ready: 2, waiting: 2 });
    expect(processedIn(runOn(runs, 6)), table).toEqual([at0801, at1100]);
    expect(processedIn(runOn(runs, 14)), table).toEqual([at0700, at0800]);
    expect(processedIn(runOn(runs, 15)), table).toEqual([at0801, at1100]);

    expect(clinic.sent.map((call) => [call.simDay, call.patientId]), table).toEqual([
      [5, at0700], [5, at0800], [6, at0801], [6, at1100],
      [14, at0700], [14, at0800], [15, at0801], [15, at1100]
    ]);
  });

  it("on Vercel Hobby the invocation minute moves the boundary: visits between 08:00 and 08:59 UTC go either way from day to day, an 11:00 visit always slips", async () => {
    // Hobby only promises the "0 8 * * *" cron within its hour. Here day 5's
    // invocation lands at 08:45, day 14's at 08:15 and every other day's at
    // the latest possible 08:59.
    const minuteOn = (simDay: number) => (simDay === 5 ? 45 : simDay === 14 ? 15 : CRON_LATEST_MINUTE);
    setNow(atSimDay(0, 11));
    const at0800 = clinic.addPatient({ name: "Prick Patient", visitDay: 0, visitHourUtc: 8 });
    const at0801 = clinic.addPatient({ name: "Minut Patient", visitDay: 0, visitHourUtc: 8, visitAt: atSimDay(0, 8, 1) });
    const at0830 = clinic.addPatient({ name: "Halv Patient", visitDay: 0, visitHourUtc: 8, visitAt: atSimDay(0, 8, 30) });
    const at0859 = clinic.addPatient({ name: "Sista Patient", visitDay: 0, visitHourUtc: 8, visitAt: atSimDay(0, 8, 59) });
    const at1100 = clinic.addPatient({ name: "Sen Patient", visitDay: 0, visitHourUtc: 11 });

    const runs = await clinic.runDays(20, { cronMinute: minuteOn });
    expect(runs.map((run) => run.simDay)).toEqual(range(1, 20));
    expect(runOn(runs, 5).at).toBe(atSimDay(5, 8, 45));
    expect(runOn(runs, 14).at).toBe(atSimDay(14, 8, 15));
    expect(runOn(runs, 6).at).toBe(atSimDay(6, 8, 59));

    const table = clinic.formatTimeline();
    // The 08:01 visit that slipped at an on-the-minute cron is on time here.
    expect(sendDays(at0800), table).toEqual([[5, 5], [14, 14]]);
    expect(sendDays(at0801), table).toEqual([[5, 5], [14, 14]]);
    // Same patient, both outcomes: 120h15m at day 5's 08:45 run, but only
    // 335h45m at day 14's 08:15 run, so the 14-day SMS slips to day 15.
    expect(sendDays(at0830), table).toEqual([[5, 5], [15, 14]]);
    expect(clinic.sendsFor(at0830).map((entry) => entry.hoursSinceVisit)).toEqual([120.25, (360 * 60 + 29) / 60]);
    expect(sendDays(at0859), table).toEqual([[6, 5], [15, 14]]);
    // 11:00 is past the whole window, so even the latest invocation cannot save it.
    expect(sendDays(at1100), table).toEqual([[6, 5], [15, 14]]);
    // 141h59m and 357h59m: 2h01m short of the next whole day at 08:59.
    expect(clinic.sendsFor(at1100).map((entry) => entry.hoursSinceVisit)).toEqual([
      (6 * 24 * 60 - 121) / 60,
      (15 * 24 * 60 - 121) / 60
    ]);

    expect(processedIn(runOn(runs, 5)), table).toEqual([at0800, at0801, at0830]);
    expect(processedIn(runOn(runs, 6)), table).toEqual([at0859, at1100]);
    expect(processedIn(runOn(runs, 14)), table).toEqual([at0800, at0801]);
    expect(processedIn(runOn(runs, 15)), table).toEqual([at0830, at0859, at1100]);
  });

  it("the mechanism is the cron hour: at 12:00 UTC the 11:00 visit is back on days 5 and 14", async () => {
    setNow(atSimDay(0, 11));
    const at0700 = clinic.addPatient({ name: "Tidig Patient", visitDay: 0, visitHourUtc: 7 });
    const at1100 = clinic.addPatient({ name: "Sen Patient", visitDay: 0, visitHourUtc: 11 });

    const runs = await clinic.runDays(20, { cronHourUtc: 12 });

    // 11:00 is before today's 12:00 cron, so day 0 runs too.
    expect(runs.map((run) => run.simDay)).toEqual(range(0, 19));
    expect(runs.every((run) => run.at.endsWith("T12:00:00.000Z"))).toBe(true);

    const summary = (id: string) =>
      clinic.sendsFor(id).map((entry) => [entry.daysSinceVisitDate, entry.stepDay, entry.hoursSinceVisit]);
    const table = clinic.formatTimeline();
    expect(summary(at1100), table).toEqual([[5, 5, 121], [14, 14, 337]]);
    expect(summary(at0700), table).toEqual([[5, 5, 125], [14, 14, 341]]);
    // A visit after 12:00 would slip again: moving the cron shifts the boundary, it does not remove it.
  });

  it.todo("desired: a visit on calendar day D gets the 5-day SMS on D+5 and the 14-day SMS on D+14 regardless of visit hour");
});

describe("full journey", () => {
  it("PRODUCTION_STEPS: five SMS on days 5, 14, 90, 180 and 365, each once, then nothing for 54 more days", async () => {
    setNow(atSimDay(0, 7));
    const id = clinic.addPatient({ name: "Anna Andersson", visitDay: 0, visitHourUtc: 7 });

    const runs = await clinic.runDays(420);
    expect(runs.map((run) => run.simDay)).toEqual(range(0, 419));

    const table = clinic.formatTimeline();
    const calls = clinic.providerCallsFor(id);
    expect(calls.map((call) => call.simDay), table).toEqual([5, 14, 90, 180, 365]);
    expect(calls.map((call) => call.message)).toEqual(PRODUCTION_STEPS.map((step) => rendered(step.template, "Anna")));

    expect(
      clinic.sendsFor(id).map((entry) => [entry.simDay, entry.daysSinceVisitDate, entry.status, entry.stepDay, entry.stepId, entry.sequenceNumber]),
      table
    ).toEqual([
      [5, 5, "sent", 5, stepId(5), 1],
      [14, 14, "sent", 14, stepId(14), 2],
      [90, 90, "sent", 90, stepId(90), 3],
      [180, 180, "sent", 180, stepId(180), 4],
      [365, 365, "sent", 365, stepId(365), 5]
    ]);
    // Only Ready patients reach sendReminderToPatient, so Waiting days leave no rows.
    expect(clinic.timeline(id), table).toHaveLength(5);

    // Between steps the cron still counts the patient, as Waiting.
    expect(snapshotOn(6)).toMatchObject({ total_patients: 1, ready: 0, waiting: 1 });
    expect(snapshotOn(364)).toMatchObject({ total_patients: 1, ready: 0, waiting: 1 });

    // After 365 the sequence is complete: 54 crons ran, each saw the patient as Sent and processed nobody.
    const after = runs.filter((run) => run.simDay > 365);
    expect(after).toHaveLength(54);
    expect(after.every((run) => run.result.processed === 0)).toBe(true);
    expect(snapshotOn(366)).toMatchObject({ ready: 0, waiting: 0, sent_complete: 1 });
    expect(snapshotOn(419)).toMatchObject({ ready: 0, waiting: 0, sent_complete: 1 });
    expect(await clinic.statusOf(id)).toBe("Sent");
  });

  it("STEPS_5_10: the 10-day SMS lands on day 10 for a 07:00 visit and on day 11 for an 11:00 visit (R2)", async () => {
    clinic.configure({ steps: STEPS_5_10 });
    setNow(atSimDay(0, 11));
    const early = clinic.addPatient({ name: "Tidig Patient", visitDay: 0, visitHourUtc: 7 });
    const late = clinic.addPatient({ name: "Sen Patient", visitDay: 0, visitHourUtc: 11 });

    const runs = await clinic.runDays(380);
    expect(runs.at(-1)?.simDay).toBe(380);

    const table = clinic.formatTimeline();
    expect(sendDays(early), table).toEqual([[5, 5], [10, 10], [90, 90], [180, 180], [365, 365]]);
    expect(sendDays(late), table).toEqual([[6, 5], [11, 10], [91, 90], [181, 180], [366, 365]]);
    // Same id as the 14-day step (010 re-timed it in place); the log snapshots day 10.
    expect(clinic.sendsFor(early)[1]).toMatchObject({ stepId: stepId(10, STEPS_5_10), stepDay: 10, sequenceNumber: 2 });
    expect(stepId(10, STEPS_5_10)).toBe(stepId(14));
    expect(clinic.sent).toHaveLength(10);
    expect(await clinic.statusOf(early)).toBe("Sent");
    expect(await clinic.statusOf(late)).toBe("Sent");
  });
});

describe("late discovery: the highest crossed step wins", () => {
  it("patients first seen 16, 100 and 200 days after their visit start at 14, 90 and 180, never 5, then stay on schedule", async () => {
    setNow(atSimDay(0, 7));
    const d16 = clinic.addPatient({ name: "Sexton Dagar", visitDay: -16, visitHourUtc: 7 });
    const d100 = clinic.addPatient({ name: "Hundra Dagar", visitDay: -100, visitHourUtc: 7 });
    const d200 = clinic.addPatient({ name: "Tvåhundra Dagar", visitDay: -200, visitHourUtc: 7 });

    const runs = await clinic.runDays(350);
    expect(runs.map((run) => run.simDay)).toEqual(range(0, 349));

    const table = clinic.formatTimeline();
    // All three are due on the first cron; one message each, the highest threshold crossed.
    expect(processedIn(runOn(runs, 0)).sort(), table).toEqual([d16, d100, d200].sort());
    expect(clinic.firstMessageFor(d16), table).toMatchObject({ simDay: 0, daysSinceVisitDate: 16, stepDay: 14, stepId: stepId(14) });
    expect(clinic.firstMessageFor(d100), table).toMatchObject({ simDay: 0, daysSinceVisitDate: 100, stepDay: 90, stepId: stepId(90) });
    expect(clinic.firstMessageFor(d200), table).toMatchObject({ simDay: 0, daysSinceVisitDate: 200, stepDay: 180, stepId: stepId(180) });

    // Later steps are counted from the original visit, not from discovery.
    expect(sendDays(d16), table).toEqual([[0, 14], [74, 90], [164, 180], [349, 365]]);
    expect(sendDays(d100), table).toEqual([[0, 90], [80, 180], [265, 365]]);
    expect(sendDays(d200), table).toEqual([[0, 180], [165, 365]]);

    // The skipped lower steps are gone for good: sending 14/90/180 raised the
    // cycle's high-water mark past them.
    expect(clinic.tables.reminder_logs.filter((log) => log.step_day === 5 || log.step_id === stepId(5)), table).toEqual([]);
    expect(clinic.tables.reminder_logs.filter((log) => log.patient_id !== d16 && log.step_day === 14), table).toEqual([]);
    expect(clinic.sent).toHaveLength(9);
  });
});

describe("inactive step", () => {
  const WITHOUT_14 = PRODUCTION_STEPS.map((step) => (step.day === 14 ? { ...step, active: false } : { ...step }));

  it("with 14 inactive a fresh patient gets 5 then 90; 14 is never sent and never blocks", async () => {
    clinic.configure({ steps: WITHOUT_14 });
    setNow(atSimDay(0, 7));
    const id = clinic.addPatient({ name: "Anna Andersson", visitDay: 0, visitHourUtc: 7 });

    const runs = await clinic.runDays(100);
    expect(runs.at(-1)?.simDay).toBe(99);

    const table = clinic.formatTimeline();
    expect(
      clinic.sendsFor(id).map((entry) => [entry.simDay, entry.stepDay, entry.stepId, entry.sequenceNumber]),
      table
    ).toEqual([
      [5, 5, stepId(5), 1],
      // The position counts the inactive step, so 90 is still sequence 3.
      [90, 90, stepId(90), 3]
    ]);
    expect(clinic.tables.reminder_logs.some((log) => log.step_id === stepId(14)), table).toBe(false);
    // Day 14 and every day up to 89: evaluated, Waiting, nothing processed.
    expect(snapshotOn(14)).toMatchObject({ total_patients: 1, ready: 0, waiting: 1 });
    expect(snapshotOn(89)).toMatchObject({ total_patients: 1, ready: 0, waiting: 1 });
    expect(runs.filter((run) => run.simDay >= 6 && run.simDay <= 89).every((run) => run.result.processed === 0)).toBe(true);
    expect(clinic.timeline(id), table).toHaveLength(2);
  });

  it("with 14 inactive a patient discovered at day 16 gets the 5-day message 16 days late, then 90", async () => {
    clinic.configure({ steps: WITHOUT_14 });
    setNow(atSimDay(0, 7));
    const id = clinic.addPatient({ name: "Sexton Dagar", visitDay: -16, visitHourUtc: 7 });

    await clinic.runDays(80);

    const table = clinic.formatTimeline();
    // The only active step crossed is 5, so it is the highest crossed one.
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.daysSinceVisitDate, entry.stepDay]), table).toEqual([
      [0, 16, 5],
      [74, 90, 90]
    ]);
  });
});

describe("one SMS per patient per cron day", () => {
  it("patients far past several thresholds get exactly one message on the first cron, the highest one", async () => {
    setNow(atSimDay(0, 7));
    const ids = [-400, -200, -95, -15, -6].map((visitDay) =>
      clinic.addPatient({ name: `Patient ${-visitDay}`, visitDay, visitHourUtc: 7 })
    );

    await clinic.runDays(30);

    const table = clinic.formatTimeline();
    const perPatientDay = new Map<string, number>();
    for (const call of clinic.sent) {
      const key = `${call.patientId}@${call.simDay}`;
      perPatientDay.set(key, (perPatientDay.get(key) ?? 0) + 1);
    }
    expect([...perPatientDay.values()].every((count) => count === 1), table).toBe(true);

    expect(
      ids.map((id) => clinic.sendsFor(id).filter((entry) => entry.simDay === 0).map((entry) => entry.stepDay)),
      table
    ).toEqual([[365], [180], [90], [14], [5]]);
    // Only the 6-day patient has another step within 30 days: 14 on day 8.
    expect(sendDays(ids[4]), table).toEqual([[0, 5], [8, 14]]);
    expect(clinic.sent).toHaveLength(6);
  });

  it("after a 100-day cron outage only the 90-day SMS goes out, and a second run the same day sends nothing", async () => {
    setNow(atSimDay(0, 7));
    const id = clinic.addPatient({ name: "Anna Andersson", visitDay: 0, visitHourUtc: 7 });

    setNow(atSimDay(100, 7));
    const [outageEnd] = await clinic.runDays(1);
    expect(outageEnd.simDay).toBe(100);
    expect(processedIn(outageEnd)).toEqual([id]);

    // A manual trigger later the same day: the patient is evaluated again and is Waiting for 180.
    advanceHours(4);
    const again = await clinic.runDailyCron();
    expect(again.processed).toBe(0);
    expect(clinic.tables.daily_snapshots.at(-1)).toMatchObject({ ready: 0, waiting: 1 });

    const table = clinic.formatTimeline();
    expect(sendDays(id), table).toEqual([[100, 90]]);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay), table).toEqual([100]);
    expect(await clinic.statusOf(id)).toBe("Waiting");
  });
});

describe("a patient visiting today", () => {
  it("stays Waiting until exactly 120 hours after the visit, then gets the 5-day SMS at the next cron", async () => {
    setNow(atSimDay(0, 7));
    const id = clinic.addPatient({ name: "Anna Andersson", visitDay: 0, visitHourUtc: 7 });

    const firstWeek = await clinic.runDays(5);
    expect(firstWeek.map((run) => run.simDay)).toEqual([0, 1, 2, 3, 4]);
    for (const run of firstWeek) {
      expect(run.result.processed, `day ${run.simDay}`).toBe(0);
      expect(snapshotOn(run.simDay), `day ${run.simDay}`).toMatchObject({ total_patients: 1, ready: 0, waiting: 1 });
    }
    expect(clinic.timeline(id)).toEqual([]);
    expect(clinic.sent).toEqual([]);

    // The threshold itself: one millisecond short of 5 x 24h is still Waiting.
    setNow(new Date(Date.parse(atSimDay(5, 7)) - 1));
    expect(await clinic.statusOf(id)).toBe("Waiting");
    setNow(atSimDay(5, 7));
    expect(await clinic.statusOf(id)).toBe("Ready");

    const [day5] = await clinic.runDays(1);
    expect(day5.simDay).toBe(5);
    expect(processedIn(day5)).toEqual([id]);
    expect(sendDays(id), clinic.formatTimeline()).toEqual([[5, 5]]);
    expect(await clinic.statusOf(id)).toBe("Waiting");
  });
});

describe("known gap R4: a new patient confirmed from the review queue before the first visit never gets follow-ups", () => {
  // Current: the BokaDirekt webhook never creates a patient. For an unknown
  // customer it stages an open pending_booking_match review item, and the
  // patient only appears when an operator confirms it (confirm_booking_match
  // -> apply_bokadirekt_booking with a null patient). That refreshes
  // last_booking_at over PAST bookings only, so a confirmation made before the
  // visit leaves it null. Once the visit passes nothing refreshes it (the cron
  // only refreshes has_future_booking), so the patient drops from
  // "Future booking" to "No valid booking", a hard block the cron does not
  // even log for, until a CSV import or another write happens to recompute it.
  // A confirmation made AFTER the visit does not have the gap: the refresh then
  // sees the visit and the patient enters the sequence normally.
  // Desired: the patient enters the 5/14-day sequence from the visit once it
  // has happened, whenever the operator confirmed.

  it("confirmed before the visit: stays Future booking, then No valid booking, and receives nothing in 20 days", async () => {
    setNow(atSimDay(0, 9));
    // Booked online and confirmed by the operator in the same minute.
    const id = clinic.addPatient({ name: "Webb Patient", via: "confirmedMatch", visitDay: 2, visitHourUtc: 11 });
    expect(clinic.patient(id)).toMatchObject({ last_booking_at: null, source: "bokadirekt_webhook" });
    expect(clinic.logsFor(id).map((log) => log.is_cycle_reset)).toEqual([true]);
    expect(clinic.tables.review_items.map((item) => [item.type, item.status])).toEqual([["pending_booking_match", "resolved"]]);

    const runs = await clinic.runDays(20);
    expect(runs.map((run) => run.simDay)).toEqual(range(1, 20));

    const table = clinic.formatTimeline();
    expect(snapshotOn(2)).toMatchObject({ total_patients: 1, future_booking: 1 });
    expect(snapshotOn(3)).toMatchObject({ total_patients: 1, future_booking: 0, no_valid_booking: 1 });
    expect(snapshotOn(20)).toMatchObject({ total_patients: 1, no_valid_booking: 1 });
    expect(runs.every((run) => run.result.processed === 0), table).toBe(true);
    expect(clinic.sent, table).toEqual([]);
    expect(clinic.patient(id).last_booking_at).toBeNull();
    expect(await clinic.statusOf(id)).toBe("No valid booking");
  });

  it("contrast, confirmed after the visit: last_booking_at is the visit and the 5- and 14-day SMS follow it", async () => {
    setNow(atSimDay(0, 9));
    const reviewItemId = clinic.stageNewPatientBooking({ name: "Webb Patient", visitDay: 2, visitHourUtc: 11 });

    // Until the operator acts there is no patient at all, only the open item.
    const before = await clinic.runDays(3);
    expect(before.map((run) => run.simDay)).toEqual([1, 2, 3]);
    expect(snapshotOn(3)).toMatchObject({ total_patients: 0 });
    expect(clinic.tables.patients).toEqual([]);
    expect(clinic.tables.review_items.map((item) => [item.id, item.status])).toEqual([[reviewItemId, "open"]]);

    setNow(atSimDay(3, 10));
    const id = clinic.confirmNewPatient(reviewItemId);
    expect(clinic.patient(id).last_booking_at).toBe(atSimDay(2, 11));
    expect(clinic.tables.review_items[0].status).toBe("resolved");
    expect(await clinic.statusOf(id)).toBe("Waiting");

    const runs = await clinic.runDays(20);
    expect(runs.map((run) => run.simDay)).toEqual(range(4, 23));

    const table = clinic.formatTimeline();
    // Counted from the 11:00 visit, so R2 puts them on days 5+1 and 14+1 after it.
    expect(
      clinic.sendsFor(id).map((entry) => [entry.simDay, entry.daysSinceVisitDate, entry.stepDay]),
      table
    ).toEqual([
      [8, 6, 5],
      [17, 15, 14]
    ]);
    // The cycle_reset carries the confirmation time, a day after the visit.
    expect(clinic.timeline(id)[0]).toMatchObject({ isCycleReset: true, simDay: 3, daysSinceVisitDate: 1 });
  });

  it.todo("desired: a new patient confirmed before the first visit gets the 5-day SMS 5 days after that visit");
});
