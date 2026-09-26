import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking, Patient, ReminderLog, ScheduledSms } from "@/types/clinic";

// The real engine and data layer run against the local database; only the SMS
// provider is replaced. Every entry throws so that, even if dry_run_mode were
// switched off, no code path can reach 46elks or a webhook provider.
const providerMock = vi.hoisted(() => {
  const refuse = async () => {
    throw new Error("Sandbox: the SMS provider must never be reached");
  };
  return { sendSms: vi.fn(refuse), verifyDelivery: vi.fn(refuse), fetchDeliveryStatus: vi.fn(refuse) };
});
vi.mock("@/lib/sms/provider", () => providerMock);

import { supabase } from "@/lib/supabase/client";
import { createScheduledSms, readStore } from "@/lib/storage/store";
import { processDailyReminders, processScheduledSms } from "@/lib/reminders/process";
import {
  getNextSchedulableSequence,
  latestValidBooking,
  renderSmsTemplate,
  resolveSteps
} from "@/lib/reminders/eligibility";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// Mirrors supabase/seed.sql. Fixed there so a test can name a step directly.
const STEPS = [
  { id: "5a4db0c5-0000-4000-8000-000000000005", day: 5 },
  { id: "5a4db0c5-0000-4000-8000-000000000014", day: 14 },
  { id: "5a4db0c5-0000-4000-8000-000000000090", day: 90 },
  { id: "5a4db0c5-0000-4000-8000-000000000180", day: 180 },
  { id: "5a4db0c5-0000-4000-8000-000000000365", day: 365 }
] as const;
const STEP_BY_DAY = new Map<number, string>(STEPS.map((step) => [step.day, step.id]));

// Same array, same order as sandbox_reset() in supabase/seed.sql: a patient's
// phone number is its age's position here.
const COHORT_AGES = [0, 3, 4, 5, 6, 9, 10, 13, 14, 15, 16, 60, 89, 90, 91, 179, 180, 200, 364, 365, 400] as const;

const pad12 = (key: number) => String(key).padStart(12, "0");
const patientId = (key: number) => `00000000-5a4d-4000-8000-${pad12(key)}`;
const cohortBookingId = (key: number) => `00000000-b00c-4000-8000-${pad12(key)}`;

// PTS's range for fiction, 070-1740605 to 070-1740699; sandbox_add_patient
// refuses any index outside it.
function fictionPhone(index: number) {
  const suffix = String(605 + index);
  return { national: `0701740${suffix}`, e164: `+46701740${suffix}` };
}
const cohortPhone = (age: number) => fictionPhone(COHORT_AGES.indexOf(age as (typeof COHORT_AGES)[number]));

async function rpc<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(`rpc ${name}: ${error.message}`);
  return data as T;
}

async function loadPatients(): Promise<Patient[]> {
  const { data, error } = await supabase.from("patients").select("*");
  if (error) throw new Error(error.message);
  return data as Patient[];
}

async function loadLogs(): Promise<ReminderLog[]> {
  const { data, error } = await supabase
    .from("reminder_logs")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data as ReminderLog[];
}

/** Whole days elapsed, exactly as daysBetween() in eligibility.ts counts them. */
function elapsedDays(lastBookingAt: string, now: number): number {
  return Math.floor((now - Date.parse(lastBookingAt)) / DAY_MS);
}

/**
 * Independent statement of the documented pick rule: the highest active step
 * whose day has been crossed and that lies beyond everything already sent in
 * this cycle. Kept deliberately separate from getNextSequence so the test
 * checks the engine against the rule rather than against itself.
 */
function expectedStepDay(elapsed: number, maxSentDay = -Infinity): number | null {
  const crossed = STEPS.filter((step) => step.day <= elapsed && step.day > maxSentDay);
  return crossed.length > 0 ? crossed[crossed.length - 1].day : null;
}

type DailyResult = Awaited<ReturnType<typeof processDailyReminders>>;
type DailyRow = NonNullable<DailyResult["results"]>[number];

async function runDaily(): Promise<{ result: DailyResult; rows: DailyRow[]; startedAt: number }> {
  // Per run, not just per test: a test's second or third run can land on the
  // boundary long after beforeEach checked it.
  await steerClearOfVisitBoundary();
  const startedAt = Date.now();
  const result = await processDailyReminders();
  return { result, rows: result.results ?? [], startedAt };
}

// Longer than one processDailyReminders run takes against the local stack, so
// the engine's own Date.now() calls land on the same side of 11:00 as startedAt.
const VISIT_BOUNDARY_MARGIN_MS = 60_000;

/**
 * Every cohort visit is at 11:00:00 UTC, so an assertion computed a moment
 * before 11:00 could disagree with the engine running a moment after. Waiting
 * out that narrow window keeps the tests valid at any wall-clock time.
 */
async function steerClearOfVisitBoundary() {
  const now = new Date();
  const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11);
  const untilBoundary = boundary - now.getTime();
  if (untilBoundary > 0 && untilBoundary < VISIT_BOUNDARY_MARGIN_MS) {
    await new Promise((resolve) => setTimeout(resolve, untilBoundary + 1_000));
  }
}

/** Inserts one patient whose only visit is at `visitAt`, keyed like the cohort. */
async function addPatient(key: number, phoneIndex: number, visitAt: Date, label: string): Promise<Patient> {
  const id = await rpc<string>("sandbox_add_patient", {
    p_key: key,
    p_phone_index: phoneIndex,
    p_visit_at: visitAt.toISOString(),
    p_label: label
  });
  const { data, error } = await supabase.from("patients").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data as Patient;
}

// Seeding, refresh_patient_booking_metadata and the claim function run on the
// Docker VM's clock; the engine and every expectation here run on the host's.
// WSL2 VMs drift after the host sleeps, and a drift of minutes would move the
// 11:00 visit boundary out from under steerClearOfVisitBoundary.
const MAX_CLOCK_SKEW_MS = 5_000;

beforeAll(async () => {
  const before = Date.now();
  const dbNow = Date.parse(await rpc<string>("sandbox_now"));
  const after = Date.now();
  const skew = dbNow - (before + after) / 2;
  if (!Number.isFinite(skew) || Math.abs(skew) > MAX_CLOCK_SKEW_MS) {
    throw new Error(
      `Sandbox refused: database clock is ${Math.round(skew)} ms off the host clock. ` +
        'Restart Docker Desktop (or run "wsl --shutdown") to resync the VM clock.'
    );
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  await steerClearOfVisitBoundary();
  await rpc("sandbox_reset");
});

describe("daily follow-ups against the real schema", () => {
  it("dry-runs the highest crossed step for every due cohort patient, oldest due first", async () => {
    const patients = await loadPatients();
    const { result, rows, startedAt } = await runDaily();

    const due = patients
      .filter((p) => p.last_booking_at && expectedStepDay(elapsedDays(p.last_booking_at, startedAt)) !== null)
      // Nothing has been sent yet, so every candidate's earliest owed step is
      // day 5 and dueAt order collapses to last_booking_at order.
      .sort((a, b) => Date.parse(a.last_booking_at!) - Date.parse(b.last_booking_at!) || a.id.localeCompare(b.id));
    const expected = due.slice(0, 25);

    expect(result.dry_run).toBe(expected.length);
    expect(rows.map((row) => row.patientId)).toEqual(expected.map((p) => p.id));
    for (const row of rows) {
      const patient = patients.find((p) => p.id === row.patientId)!;
      const day = expectedStepDay(elapsedDays(patient.last_booking_at!, startedAt));
      expect(row.status, patient.full_name).toBe("dry_run");
      expect(row.stepDay, patient.full_name).toBe(day);
      expect(row.stepId, patient.full_name).toBe(STEP_BY_DAY.get(day!));
    }

    const logs = await loadLogs();
    const dryRuns = logs.filter((log) => log.status === "dry_run");
    expect(dryRuns).toHaveLength(expected.length);
    for (const log of dryRuns) {
      const age = Number(patients.find((p) => p.id === log.patient_id)!.last_name!.replace("Dag ", ""));
      // The booking the cycle is anchored on is the cohort visit itself: the
      // string match in latestValidBooking holds against real PostgREST output.
      expect(log.booking_id).toBe(cohortBookingId(age));
      expect(log.message).toBe(
        `Hej Sandbox! ${log.step_day} dagar sedan besöket. Boka: https://sandbox.invalid/boka`
      );
    }

    // Below five elapsed days nobody is even considered: no log row at all.
    const notDue = patients.filter((p) => !due.includes(p));
    for (const patient of notDue) {
      expect(logs.filter((log) => log.patient_id === patient.id), patient.full_name).toEqual([]);
    }
    expect(providerMock.sendSms).not.toHaveBeenCalled();
  });

  it("R2: a visit at 11:00 UTC is not due at the 08:00 UTC cron on calendar day 5, and gets step 5 on day 14", async () => {
    // What the production cron sees on calendar day 5 (and 14) after an 11:00
    // UTC visit: three hours short of whole days. Placed relative to the host
    // clock rather than at 11:00, so the gap is exercised at any time of day
    // instead of only in runs before 11:00 UTC.
    const shortOfFive = await addPatient(900_117, 21, new Date(Date.now() - (5 * DAY_MS - 3 * HOUR_MS)), "117 h");
    const shortOfFourteen = await addPatient(900_333, 22, new Date(Date.now() - (14 * DAY_MS - 3 * HOUR_MS)), "333 h");

    const { rows, startedAt } = await runDaily();
    const elapsedWholeHours = (patient: Patient) =>
      Math.floor((startedAt - Date.parse(patient.last_booking_at!)) / HOUR_MS);
    expect(elapsedWholeHours(shortOfFive)).toBe(117);
    expect(elapsedWholeHours(shortOfFourteen)).toBe(333);

    // Calendar day 5, 117 hours: not even considered, no log row at all.
    expect(rows.find((row) => row.patientId === shortOfFive.id)).toBeUndefined();
    const logs = await loadLogs();
    expect(logs.filter((log) => log.patient_id === shortOfFive.id)).toEqual([]);

    // Calendar day 14, 333 hours: still the 5-day step, and the 14-day one has
    // to wait for the next day's run.
    expect(rows.find((row) => row.patientId === shortOfFourteen.id)).toMatchObject({
      status: "dry_run",
      stepDay: 5,
      stepId: STEP_BY_DAY.get(5)
    });

    // Sanity check on the cohort's real 11:00 UTC visits, derived from the
    // stored instant (not the hour of day) so a reset and a run on either side
    // of 00:00 UTC still agree.
    const patients = await loadPatients();
    const elapsedHours = (age: number) =>
      (startedAt - Date.parse(patients.find((p) => p.id === patientId(age))!.last_booking_at!)) / HOUR_MS;
    const dag5 = rows.find((row) => row.patientId === patientId(5));
    expect(Boolean(dag5)).toBe(elapsedHours(5) >= 120);
    const dag14 = rows.find((row) => row.patientId === patientId(14));
    expect(dag14?.stepDay).toBe(elapsedHours(14) >= 14 * 24 ? 14 : 5);
  });

  it("time travel: nine days later the 5-day recipients get the 14-day step and nobody gets a step twice", async () => {
    const first = await runDaily();
    const firstPick = new Map(first.rows.map((row) => [row.patientId, row.stepDay!]));
    const gotFiveDay = first.rows.filter((row) => row.stepDay === 5).map((row) => row.patientId);
    expect(gotFiveDay.length).toBeGreaterThan(0);

    await rpc("sandbox_advance_days", { p_days: 9 });
    const patients = await loadPatients();
    const second = await runDaily();

    const expected = patients
      .filter((p) => p.last_booking_at)
      .map((p) => ({
        id: p.id,
        day: expectedStepDay(elapsedDays(p.last_booking_at!, second.startedAt), firstPick.get(p.id))
      }))
      .filter((e) => e.day !== null);
    expect(second.rows.map((row) => [row.patientId, row.stepDay]).sort()).toEqual(
      expected.map((e) => [e.id, e.day]).sort()
    );
    for (const id of gotFiveDay) {
      expect(second.rows.find((row) => row.patientId === id)?.stepDay).toBe(14);
    }

    const logs = await loadLogs();
    const consumed = logs.filter((log) => log.status === "dry_run").map((log) => `${log.patient_id}:${log.step_id}`);
    expect(new Set(consumed).size).toBe(consumed.length);
    expect(logs.filter((log) => log.status === "skipped")).toEqual([]);
  });
});

describe("known gap R4: a webhook rebooking leaves last_booking_at on the old visit", () => {
  // Payload values shaped like src/lib/webhooks/bokadirekt.ts bookingRpcParams.
  async function rebook(age: number, bookingAt: Date) {
    const phone = cohortPhone(age);
    const external = `sandbox-r4-${age}`;
    const payload = {
      Id: external,
      BookingStartDate: bookingAt.toISOString(),
      ServiceName: "Sandbox-behandling",
      Customer: { Id: `sandbox-kund-${age}`, FirstName: "Sandbox", LastName: `Dag ${age}`, MobilePhone: phone.national }
    };
    await rpc("apply_bokadirekt_booking_auto_matched", {
      p_patient_id: patientId(age),
      p_bokadirekt_customer_id: `sandbox-kund-${age}`,
      p_full_name: `Sandbox Dag ${age}`,
      p_first_name: "Sandbox",
      p_last_name: `Dag ${age}`,
      p_phone: phone.national,
      p_normalized_phone: phone.e164,
      p_email: null,
      p_booking_id_external: external,
      p_booking_at: bookingAt.toISOString(),
      p_service_name: "Sandbox-behandling",
      p_practitioner_name: "Sandbox-osteopat",
      p_location_name: "Sandbox",
      p_price: 0,
      p_booked_online: true,
      p_event_created_at: new Date().toISOString(),
      p_raw_data: payload
    });
    // 023 stamps its bookings source 'bokadirekt_webhook', which is one of the
    // real-data signals sandbox_assert_local() refuses on: left as is, the next
    // sandbox_advance_days / sandbox_reset would refuse. The engine never reads
    // bookings.source, so relabelling changes nothing the test observes.
    const { data, error } = await supabase
      .from("bookings")
      .update({ source: "sandbox" })
      .eq("bokadirekt_booking_id", external)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return data as Booking;
  }

  it("anchors the new cycle on the old visit: early sends and a daily 'Redan reserverad' collision", async () => {
    // Dag 3: nothing sent yet. Dag 6: already had the 5-day step for the old
    // visit. Dag 364: already had the 180-day step, 365 not yet crossed.
    const ages = [3, 6, 364];
    const first = await runDaily();
    expect(first.rows.find((row) => row.patientId === patientId(6))?.stepDay).toBe(5);
    expect(first.rows.find((row) => row.patientId === patientId(364))?.stepDay).toBe(180);

    const before = new Map((await loadPatients()).map((p) => [p.id, p.last_booking_at]));
    const newBookings = new Map<number, Booking>();
    for (const age of ages) {
      newBookings.set(age, await rebook(age, new Date(Date.now() + 2 * DAY_MS)));
    }

    const afterWebhook = new Map((await loadPatients()).map((p) => [p.id, p.last_booking_at]));
    const logsAfterWebhook = await loadLogs();
    for (const age of ages) {
      // 022's definition: a future appointment never sets last_booking_at.
      expect(afterWebhook.get(patientId(age))).toBe(before.get(patientId(age)));
      const resets = logsAfterWebhook.filter(
        (log) => log.patient_id === patientId(age) && log.status === "cycle_reset"
      );
      expect(resets.map((log) => log.booking_id)).toEqual([newBookings.get(age)!.id]);
    }

    // Three days on, the new appointment is a day in the past. Nothing in
    // production refreshes last_booking_at on time passing, and the shift
    // mirrors that, so the column still names the OLD visit.
    await rpc("sandbox_advance_days", { p_days: 3 });
    const shifted = await loadPatients();
    const { data: oldBookings } = await supabase
      .from("bookings")
      .select("id, booking_at")
      .in("id", ages.map(cohortBookingId));
    for (const age of ages) {
      const patient = shifted.find((p) => p.id === patientId(age))!;
      const oldVisit = oldBookings!.find((b) => b.id === cohortBookingId(age))!;
      expect(Date.parse(patient.last_booking_at!)).toBe(Date.parse(oldVisit.booking_at));
    }

    const second = await runDaily();
    const row = (age: number) => second.rows.find((r) => r.patientId === patientId(age));
    const logs = await loadLogs();
    const lastLog = (age: number) => logs.filter((log) => log.patient_id === patientId(age)).at(-1)!;

    // Dag 3: the 5-day message goes out one day after the NEW visit, counted
    // from the old one, and is filed against the old booking.
    expect(row(3)).toMatchObject({ status: "dry_run", stepDay: 5 });
    expect(lastLog(3).booking_id).toBe(cohortBookingId(3));

    // Dag 6: the fresh cycle owes the 5-day step again, but the reservation is
    // keyed on (patient, OLD booking, step) which the previous cycle already
    // holds. 23505 becomes a skip -- and it took one of the 25 daily slots.
    expect(row(6)).toMatchObject({ status: "skipped", error: "Redan reserverad av parallell förfrågan" });
    expect(lastLog(6).booking_id).toBe(cohortBookingId(6));

    // Dag 364: a "long time no see" 365-day message one day after a visit.
    expect(row(364)).toMatchObject({ status: "dry_run", stepDay: 365 });
    expect(lastLog(364).booking_id).toBe(cohortBookingId(364));

    // And it repeats every day until some other write refreshes the column.
    await rpc("sandbox_advance_days", { p_days: 1 });
    const third = await runDaily();
    expect(third.rows.find((r) => r.patientId === patientId(6))).toMatchObject({
      status: "skipped",
      error: "Redan reserverad av parallell förfrågan"
    });
    const collisions = (await loadLogs()).filter(
      (log) => log.patient_id === patientId(6) && log.error === "Redan reserverad av parallell förfrågan"
    );
    expect(collisions).toHaveLength(2);
  });
});

describe("scheduled SMS through the real claim function", () => {
  it("claims a due row with Postgres now() and completes it as dry_run", async () => {
    const age = 60;
    // Built the way app/api/scheduled-sms/route.ts builds it.
    const store = await readStore();
    const patient = store.patients.find((p) => p.id === patientId(age))!;
    const settings = store.reminder_settings[0];
    const next = getNextSchedulableSequence(patient, settings, store.reminder_logs)!;
    const template = resolveSteps(settings).find((step) => step.id === next.stepId)!.template;
    const message = renderSmsTemplate(template, patient, settings);
    const booking = latestValidBooking(patient, store.bookings);
    const scheduled = await createScheduledSms({
      patient_id: patient.id,
      booking_id: booking?.id ?? null,
      patient_name: patient.full_name,
      recipient_phone: patient.normalized_phone,
      sequence_override: next.sequenceNumber,
      step_id: next.stepId,
      message_override: message,
      scheduled_for: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
    expect(next.stepId).toBe(STEP_BY_DAY.get(5));

    // Not due yet, and the daily cron leaves a patient with a pending row alone.
    expect((await processScheduledSms()).processed).toBe(0);
    const daily = await runDaily();
    expect(daily.rows.map((row) => row.patientId)).not.toContain(patient.id);

    await rpc("sandbox_advance_days", { p_days: 1 });
    const result = await processScheduledSms();
    expect(result).toMatchObject({ processed: 1, dry_run: 1 });

    const { data: row, error } = await supabase
      .from("scheduled_sms")
      .select("*")
      .eq("id", scheduled.id)
      .single();
    if (error) throw new Error(error.message);
    const done = row as ScheduledSms;
    expect(done).toMatchObject({ status: "dry_run", attempt_count: 1, error: null });
    expect(Date.parse(done.claimed_at!)).toBeGreaterThan(Date.parse(done.scheduled_for));
    expect(done.completed_at).not.toBeNull();

    const { data: log } = await supabase.from("reminder_logs").select("*").eq("id", done.reminder_log_id!).single();
    expect(log).toMatchObject({
      status: "dry_run",
      patient_id: patient.id,
      booking_id: cohortBookingId(age),
      step_id: STEP_BY_DAY.get(5),
      step_day: 5,
      message
    });
    expect(providerMock.sendSms).not.toHaveBeenCalled();
  });
});

describe("known gap R6: readStore() is capped by PostgREST max_rows", () => {
  it("returns only the newest 1000 bookings, dropping the cohort's real visits", async () => {
    const extra = Array.from({ length: 1100 }, (_, i) => {
      const age = COHORT_AGES[i % COHORT_AGES.length];
      return {
        external_booking_id: `sandbox-bulk-${i}`,
        patient_id: patientId(age),
        patient_name: `Sandbox Dag ${age}`,
        booking_at: new Date(Date.now() - (500 + i) * DAY_MS).toISOString(),
        treatment: "Sandbox-behandling",
        status: "Cancelled",
        // Cancelled and older than every cohort visit, so they cannot change
        // any patient's last_booking_at or future-booking status themselves.
        cancelled: true,
        source: "sandbox"
      };
    });
    const { error } = await supabase.from("bookings").insert(extra);
    if (error) throw new Error(error.message);

    const { count } = await supabase.from("bookings").select("*", { count: "exact", head: true });
    expect(count).toBe(1121);

    const store = await readStore();
    expect(store.bookings).toHaveLength(1000);
    // readStore orders by created_at desc, so the rows that fall off are the
    // OLDEST records -- here every one of the cohort's real visits.
    expect(store.bookings.filter((b) => b.source === "sandbox" && !b.cancelled)).toEqual([]);

    // Consequence for the engine: latestValidBooking finds no booking, so the
    // sends are filed with booking_id null and guarded by the null-booking
    // index instead of the booking-scoped one.
    const { rows } = await runDaily();
    expect(rows.length).toBeGreaterThan(0);
    const logs = await loadLogs();
    const dryRuns = logs.filter((log) => log.status === "dry_run");
    expect(dryRuns.length).toBe(rows.length);
    expect(dryRuns.every((log) => log.booking_id === null)).toBe(true);
  });

  it("drops the OLDEST patients once there are more than 1000, so the cron never sees them", async () => {
    // Newer sign-ups who are not due for anything (no visit, no phone): the
    // kind of rows a CSV import adds in bulk. Default created_at is now(), so
    // every one of them sorts ahead of the cohort in readStore's order.
    const filler = Array.from({ length: 1100 }, (_, i) => ({
      full_name: `Sandbox utfyllnad ${i}`,
      source: "sandbox"
    }));
    const { error } = await supabase.from("patients").insert(filler);
    if (error) throw new Error(error.message);

    const { count } = await supabase.from("patients").select("*", { count: "exact", head: true });
    expect(count).toBe(1100 + COHORT_AGES.length);

    const store = await readStore();
    expect(store.patients).toHaveLength(1000);
    expect(store.patients.filter((p) => p.source === "sandbox" && p.full_name.startsWith("Sandbox Dag"))).toEqual([]);

    // The cohort is exactly as due as in the first test, yet nobody is served:
    // the patients the clinic has known longest are the ones that go silent.
    const { result, rows } = await runDaily();
    expect(rows).toEqual([]);
    expect(result.dry_run).toBe(0);
    expect((await loadLogs()).filter((log) => log.status === "dry_run")).toEqual([]);
  });

  it("drops the oldest reminder_logs, so consumed steps look unsent and collide as 'Redan reserverad'", async () => {
    const first = await runDaily();
    const firstPick = new Map(first.rows.map((row) => [row.patientId, row.stepDay!]));
    expect(firstPick.size).toBeGreaterThan(0);

    // Unrelated audit rows written after the first run -- the daily skips a
    // real clinic accumulates. A patient without a phone owns them so no
    // cohort patient's cycle, status or unique index is touched.
    const { data: owner, error: ownerError } = await supabase
      .from("patients")
      .insert({ full_name: "Sandbox loggägare", source: "sandbox" })
      .select("id")
      .single();
    if (ownerError) throw new Error(ownerError.message);
    const noise = Array.from({ length: 1100 }, () => ({
      patient_id: owner.id,
      message: "",
      status: "skipped",
      skip_reason: "missing_phone",
      error: "Patient ej berättigad: Missing phone"
    }));
    const { error } = await supabase.from("reminder_logs").insert(noise);
    if (error) throw new Error(error.message);

    const store = await readStore();
    expect(store.reminder_logs).toHaveLength(1000);
    expect(store.reminder_logs.filter((log) => firstPick.has(log.patient_id!))).toEqual([]);

    // The next day's cron. With the history invisible every patient's cycle
    // looks empty, so the engine re-picks the highest crossed step. Where that
    // is the step already consumed, the booking-scoped unique index (025)
    // rejects it: a skip that takes one of the 25 daily slots.
    await rpc("sandbox_advance_days", { p_days: 1 });
    const patients = await loadPatients();
    const second = await runDaily();

    const expected = patients
      .filter((p) => p.full_name.startsWith("Sandbox Dag") && p.last_booking_at)
      .map((p) => ({ id: p.id, day: expectedStepDay(elapsedDays(p.last_booking_at!, second.startedAt)) }))
      .filter((e): e is { id: string; day: number } => e.day !== null);
    expect(second.rows.map((row) => row.patientId).sort()).toEqual(expected.map((e) => e.id).sort());

    let collisions = 0;
    for (const { id, day } of expected) {
      const row = second.rows.find((r) => r.patientId === id)!;
      if (firstPick.get(id) === day) {
        collisions += 1;
        expect(row, id).toMatchObject({
          status: "skipped",
          stepDay: null,
          error: "Redan reserverad av parallell förfrågan"
        });
      } else {
        // Crossed a new step overnight: indistinguishable from correct history.
        expect(row, id).toMatchObject({ status: "dry_run", stepDay: day });
      }
    }
    expect(collisions).toBeGreaterThan(0);
    expect(second.result.skipped).toBe(collisions);
    expect(providerMock.sendSms).not.toHaveBeenCalled();
  });
});
