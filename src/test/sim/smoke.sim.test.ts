import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_STEPS,
  activeResult,
  atSimDay,
  createClinic,
  restoreClock,
  setNow,
  stepId,
  supabaseMock,
  type FakeClinic
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

/** One patient seen at 07:00 UTC on day 0, recorded right after the visit. */
function patientSeenAtSeven(): string {
  setNow(atSimDay(0, 7));
  return clinic.addPatient({ name: "Anna Andersson", visitDay: 0, visitHourUtc: 7 });
}

describe("simulator smoke", () => {
  it("sends the 5-day and 14-day follow-ups on days 5 and 14 and nothing else in 20 days", async () => {
    const id = patientSeenAtSeven();

    const runs = await clinic.runDays(20);

    // Today still counts: the clock was at 07:00, before the 08:00 cron.
    expect(runs.map((run) => run.simDay)).toEqual([...Array(20).keys()]);
    expect(runs.every((run) => run.at.endsWith("T08:00:00.000Z"))).toBe(true);

    const calls = clinic.providerCallsFor(id);
    expect(calls.map((call) => call.simDay), clinic.formatTimeline()).toEqual([5, 14]);
    expect(calls.every((call) => call.to === "46700000001")).toBe(true);
    expect(calls[0].message.startsWith("Hej Anna,\nför att uppnå ett hållbart resultat")).toBe(true);
    expect(calls[1].message.startsWith("Hej Anna,\nuppföljning ger ofta bättre")).toBe(true);
    expect(clinic.sent).toHaveLength(2);

    const sends = clinic.sendsFor(id);
    expect(sends.map((entry) => [entry.simDay, entry.status, entry.stepDay, entry.stepId])).toEqual([
      [5, "sent", 5, stepId(5)],
      [14, "sent", 14, stepId(14)]
    ]);
    // Visit at 07:00 and cron at 08:00 on the same calendar day: elapsed days
    // and calendar days agree, so the step lands exactly on its day.
    expect(sends.map((entry) => entry.daysSinceVisitDate)).toEqual([5, 14]);
    expect(sends.every((entry) => entry.bookingId === clinic.tables.bookings[0].id)).toBe(true);

    // No other rows: Ready is the only status that reaches sendReminderToPatient.
    expect(clinic.timeline(id)).toHaveLength(2);
    expect(runs[5].result).toMatchObject({ processed: 1, sent: 1 });
    expect(runs[6].result).toMatchObject({ processed: 0, sent: 0 });
    expect(await clinic.statusOf(id)).toBe("Waiting");
    expect(clinic.tables.daily_snapshots).toHaveLength(20);
  });

  it("dry run writes dry_run logs on the same days and never calls the provider", async () => {
    clinic.configure({ dryRun: true });
    const id = patientSeenAtSeven();

    await clinic.runDays(20);

    expect(clinic.sent).toHaveLength(0);
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.status, entry.stepDay])).toEqual([
      [5, "dry_run", 5],
      [14, "dry_run", 14]
    ]);
    expect(clinic.firstMessageFor(id)?.message.startsWith("Hej Anna,")).toBe(true);
  });

  it("produces the identical timeline on a second run", async () => {
    patientSeenAtSeven();
    clinic.addPatient({ visitDay: -3, visitHourUtc: 15 });
    await clinic.runDays(20);
    const first = clinic.formatTimeline();

    restoreClock();
    clinic = createClinic();
    patientSeenAtSeven();
    clinic.addPatient({ visitDay: -3, visitHourUtc: 15 });
    await clinic.runDays(20);

    expect(clinic.formatTimeline()).toBe(first);
  });
});

describe("harness fidelity self-checks", () => {
  it("delivers a scheduled SMS through the worker with its frozen message", async () => {
    const id = patientSeenAtSeven();
    const scheduled = await clinic.scheduleSms({ patientId: id, stepDay: 5, day: 2, hourUtc: 9 });
    expect(scheduled).toMatchObject({ status: "pending", step_id: stepId(5), sequence_override: 1 });

    const runs = await clinic.runDays(3, { scheduledWorker: true });

    // Day 2 at 08:00 is before 09:00, so the row is only due on day 3's tick.
    expect(runs.map((run) => run.scheduled?.processed)).toEqual([0, 0, 0]);
    await clinic.runDays(1, { scheduledWorker: true });
    expect(clinic.tables.scheduled_sms[0]).toMatchObject({ status: "sent", attempt_count: 1 });
    expect(clinic.providerCallsFor(id).map((call) => call.message)).toEqual([scheduled.message_override]);
    // The 5-day step is consumed, so the daily cron moves on to the 14-day one.
    const later = await clinic.runDays(11);
    expect(later.at(-1)?.simDay).toBe(14);
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.stepDay])).toEqual([
      [3, 5],
      [14, 14]
    ]);
  });

  it("enforces the 025 duplicate guard through the supabase mock", async () => {
    const id = patientSeenAtSeven();
    const bookingId = clinic.tables.bookings[0].id;
    const row = {
      patient_id: id,
      booking_id: bookingId,
      phone: "46700000001",
      message: "x",
      status: "dry_run",
      sequence_number: 1,
      step_id: PRODUCTION_STEPS[0].id,
      step_day: 5,
      is_cycle_reset: false,
      provider_message_id: null,
      skip_reason: null,
      error: null,
      sent_at: null
    };
    const first = await supabaseMock.from("reminder_logs").insert(row).select().single();
    expect(first.error).toBeNull();
    const second = await supabaseMock.from("reminder_logs").insert(row).select().single();
    expect(second.data).toBeNull();
    expect(second.error?.code).toBe("23505");
    // A skipped row holds no slot, so it never collides.
    const skipped = await supabaseMock
      .from("reminder_logs")
      .insert({ ...row, status: "skipped", skip_reason: "waiting" })
      .select()
      .single();
    expect(skipped.error).toBeNull();
  });

  it("a BookingCancelled for a booking that was only staged resolves its review item and writes nothing else (023)", () => {
    setNow(atSimDay(0, 9));
    const reviewItemId = clinic.stageNewPatientBooking({ visitDay: 2 });
    const externalId = (clinic.tables.review_items[0].raw_data as { booking: { Id: string } }).booking.Id;

    // No booking row exists, so the RPC's booking branch is skipped, but its
    // review-item update runs regardless.
    expect(clinic.webhookCancel(externalId)).toBe(false);
    expect(clinic.tables.review_items).toMatchObject([{ id: reviewItemId, type: "pending_booking_match", status: "resolved" }]);
    expect(clinic.tables.patients).toEqual([]);
    expect(clinic.tables.bookings).toEqual([]);
    expect(clinic.tables.reminder_logs).toEqual([]);
    // The operator can no longer confirm it.
    expect(() => clinic.confirmNewPatient(reviewItemId)).toThrow(
      `confirm_booking_match: Review item ${reviewItemId} is already resolved`
    );
  });

  it("activeResult narrows an active cron result and refuses the inactive shape", async () => {
    patientSeenAtSeven();
    const [active] = await clinic.runDays(1);
    expect(activeResult(active).results).toEqual([]);
    expect(activeResult(active.result)).toBe(active.result);

    clinic.configure({ isActive: false });
    const [inactive] = await clinic.runDays(1);
    expect(() => activeResult(inactive)).toThrow(/cron did not evaluate patients/);
  });

  it("throws on anything the fake does not implement", async () => {
    expect(() => supabaseMock.from("incoming_sms")).toThrow(/fakeSupabase: unsupported table/);
    await expect(supabaseMock.rpc("apply_bokadirekt_booking", {})).rejects.toThrow(/fakeSupabase: unsupported rpc/);
    expect(() => (supabaseMock.from("patients") as unknown as { upsert: () => void }).upsert()).toThrow(
      /fakeSupabase: unsupported/
    );
  });
});
