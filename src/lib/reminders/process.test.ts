import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking, ClinicStore, Patient, ReminderSettings, ScheduledSms } from "@/types/clinic";
import type { VerifyDeliveryResult } from "@/lib/sms/provider";
import { makeSupabaseChain } from "@/test/mockSupabase";

const repo = vi.hoisted(() => ({
  addReminderLog: vi.fn(),
  addReviewItem: vi.fn(),
  bulkUpsertPatients: vi.fn(),
  claimDueScheduledSms: vi.fn(),
  completeScheduledSms: vi.fn(),
  getSettings: vi.fn(),
  insertDailySnapshot: vi.fn(),
  getActiveScheduledSmsPatientIds: vi.fn(),
  linkScheduledSmsReservation: vi.fn(),
  nowIso: vi.fn(() => "2026-01-01T00:00:00.000Z"),
  readStore: vi.fn(),
  updateReminderLog: vi.fn()
}));
vi.mock("@/lib/data/repository", () => repo);

const providerMock = vi.hoisted(() => ({
  sendSms: vi.fn(),
  // Typed against the real signature so a test can override the verdict; the
  // default is set in beforeEach.
  verifyDelivery: vi.fn<(id: string) => Promise<VerifyDeliveryResult>>()
}));
vi.mock("@/lib/sms/provider", () => providerMock);

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({ supabase: supabaseMock }));

import { processDailyReminders, processScheduledSms } from "./process";

const STEP_5 = "aaaaaaaa-0000-4000-8000-000000000005";
const STEP_90 = "aaaaaaaa-0000-4000-8000-000000000090";

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: "patient-1",
    full_name: "Anna Andersson",
    first_name: "Anna",
    last_name: "Andersson",
    phone: "0701234567",
    normalized_phone: "+46701234567",
    email: null,
    last_booking_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
    latest_treatment: null,
    has_future_booking: false,
    do_not_contact: false,
    source: "test",
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeSettings(overrides: Partial<ReminderSettings> = {}): ReminderSettings {
  return {
    id: "settings-1",
    days_after_booking: 30,
    send_time: "09:00",
    max_per_day: 25,
    sms_template: "Hej {{firstName}}!",
    sms_template_2: "Hej igen {{firstName}}!",
    sms_template_3: "Sista {{firstName}}!",
    sms_steps: null,
    booking_link: "https://book.example",
    clinic_name: "Test Clinic",
    is_active: true,
    dry_run_mode: false,
    allow_same_number_override: false,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeScheduledRow(overrides: Partial<ScheduledSms> = {}): ScheduledSms {
  return {
    id: "sched-1",
    patient_id: "patient-1",
    booking_id: null,
    patient_name: "Anna Andersson",
    recipient_phone: "+46701234567",
    sequence_override: 1,
    step_id: null,
    message_override: "Frozen message",
    scheduled_for: "2026-01-01T09:00:00.000Z",
    status: "processing",
    reminder_log_id: null,
    error: null,
    created_at: "2025-12-01T00:00:00.000Z",
    claimed_at: "2026-01-01T09:00:00.000Z",
    completed_at: null,
    attempt_count: 1,
    ...overrides
  };
}

function makeStore(
  patients: Patient[],
  settings: ReminderSettings,
  bookings: ClinicStore["bookings"] = []
): ClinicStore {
  return { patients, bookings, reminder_settings: [settings], reminder_logs: [], review_items: [] };
}

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  const past = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: "booking-1",
    external_booking_id: "ext-1",
    patient_id: "patient-1",
    patient_name: "Anna Andersson",
    phone: "0701234567",
    normalized_phone: "+46701234567",
    email: null,
    booking_at: past,
    treatment: null,
    status: "Booked",
    cancelled: false,
    source: "test",
    raw_data: {},
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...overrides
  } as Booking;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks drops implementations too, so re-establish the neutral
  // verification default after every reset.
  providerMock.verifyDelivery.mockResolvedValue({ status: "unsupported" });
});

describe("processScheduledSms", () => {
  it("marks a claimed row as skipped when the patient no longer exists, instead of failing or retrying", async () => {
    const settings = makeSettings();
    const claimedRow = makeScheduledRow({ patient_id: "missing-patient" });
    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([], settings));
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "skipped" });

    const result = await processScheduledSms();

    expect(repo.completeScheduledSms).toHaveBeenCalledWith(
      claimedRow.id,
      "skipped",
      null,
      "Patienten hittades inte"
    );
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("never marks a dry-run send as sent, so it stays deliverable once dry-run is disabled", async () => {
    const settings = makeSettings({ dry_run_mode: true });
    const patient = makePatient();
    const claimedRow = makeScheduledRow();
    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([patient], settings));

    const insertedLog = {
      id: "log-1",
      patient_id: patient.id,
      booking_id: null,
      phone: patient.normalized_phone,
      message: "Frozen message",
      status: "dry_run",
      sequence_number: 1,
      is_cycle_reset: false,
      provider_message_id: null,
      skip_reason: null,
      error: null,
      sent_at: null,
      created_at: "2026-01-01T00:00:00.000Z"
    };
    supabaseMock.from.mockReturnValue(makeSupabaseChain({ data: insertedLog, error: null }));
    repo.linkScheduledSmsReservation.mockResolvedValue(undefined);
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "dry_run" });

    const result = await processScheduledSms();

    expect(providerMock.sendSms).not.toHaveBeenCalled();
    expect(repo.completeScheduledSms).toHaveBeenCalledWith(claimedRow.id, "dry_run", "log-1", null);
    expect(result.dry_run).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("refuses a scheduled send whose booking cycle was reset, without contacting the provider", async () => {
    // The reported duplicate/out-of-order bug: the row was queued against
    // booking-old, the patient then rebooked via the webhook, and the frozen
    // day-180 message would otherwise send after the new appointment.
    const settings = makeSettings();
    const patient = makePatient();
    const claimedRow = makeScheduledRow({ booking_id: "booking-old", sequence_override: 4 });
    const oldBooking = makeBooking({ id: "booking-old" });
    // Recorded after the row was scheduled — that is what makes it newer.
    const newBooking = makeBooking({
      id: "booking-new",
      created_at: "2025-12-20T00:00:00.000Z",
      booking_at: "2025-12-28T10:00:00.000Z"
    });

    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([patient], settings, [oldBooking, newBooking]));
    repo.addReminderLog.mockResolvedValue({ id: "log-stale", status: "skipped" });
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "skipped" });

    const result = await processScheduledSms();

    expect(providerMock.sendSms).not.toHaveBeenCalled();
    expect(repo.addReminderLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", skip_reason: "stale_cycle" })
    );
    expect(repo.completeScheduledSms).toHaveBeenCalledWith(
      claimedRow.id,
      "skipped",
      "log-stale",
      expect.stringContaining("bokat en ny tid")
    );
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("refuses a CSV-imported rebooking after the appointment has passed", async () => {
    // The audit's critical case. A booking imported from CSV never goes through
    // the RPCs that cancel pending rows, and last_booking_at deliberately
    // excludes future bookings — so while the appointment was upcoming it kept
    // pointing at the PREVIOUS visit, which is the booking the row was created
    // against. Only the "Future booking" hard block stopped the send, and once
    // the appointment passed that block disappeared while last_booking_at
    // stayed stale until the next import.
    const settings = makeSettings();
    const attendedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    // The appointment happened 2 days ago; last_booking_at still lags behind it.
    const rebookedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const patient = makePatient({ last_booking_at: attendedAt, has_future_booking: false });

    const oldBooking = makeBooking({ id: "booking-old", booking_at: attendedAt });
    const importedBooking = makeBooking({
      id: "booking-imported",
      booking_at: rebookedAt,
      // Back-dated created_at, as a CSV import can produce.
      created_at: "2025-01-01T00:00:00.000Z"
    });
    const claimedRow = makeScheduledRow({ booking_id: "booking-old", sequence_override: 4 });

    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(
      makeStore([patient], settings, [oldBooking, importedBooking])
    );
    repo.addReminderLog.mockResolvedValue({ id: "log-stale", status: "skipped" });
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "skipped" });

    const result = await processScheduledSms();

    expect(providerMock.sendSms).not.toHaveBeenCalled();
    expect(repo.addReminderLog).toHaveBeenCalledWith(
      expect.objectContaining({ skip_reason: "stale_cycle" })
    );
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("still sends when the scheduled booking is the patient's current cycle", async () => {
    const settings = makeSettings();
    const patient = makePatient();
    const currentBooking = makeBooking({ id: "booking-1", booking_at: patient.last_booking_at! });
    const claimedRow = makeScheduledRow({ booking_id: "booking-1" });

    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([patient], settings, [currentBooking]));

    const reservation = {
      id: "log-1", patient_id: patient.id, booking_id: "booking-1",
      phone: patient.normalized_phone, message: "Frozen message", status: "pending",
      sequence_number: 1, is_cycle_reset: false, provider_message_id: null,
      skip_reason: null, error: null, sent_at: null, created_at: "2026-01-01T00:00:00.000Z"
    };
    supabaseMock.from.mockReturnValue(makeSupabaseChain({ data: reservation, error: null }));
    repo.linkScheduledSmsReservation.mockResolvedValue(undefined);
    providerMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "elks-1" });
    repo.updateReminderLog.mockResolvedValue({ ...reservation, status: "sent" });
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "sent" });

    const result = await processScheduledSms();

    expect(providerMock.sendSms).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("downgrades an accepted send to failed when the provider reports it undeliverable", async () => {
    const settings = makeSettings();
    const patient = makePatient();
    const claimedRow = makeScheduledRow();
    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([patient], settings));

    const reservation = {
      id: "log-1", patient_id: patient.id, booking_id: null,
      phone: patient.normalized_phone, message: "Frozen message", status: "pending",
      sequence_number: 1, is_cycle_reset: false, provider_message_id: null,
      skip_reason: null, error: null, sent_at: null, created_at: "2026-01-01T00:00:00.000Z"
    };
    supabaseMock.from.mockReturnValue(makeSupabaseChain({ data: reservation, error: null }));
    repo.linkScheduledSmsReservation.mockResolvedValue(undefined);
    // The send request was accepted...
    providerMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "elks-1" });
    // ...but asking the provider afterwards reveals it never arrived.
    providerMock.verifyDelivery.mockResolvedValue({
      status: "failed",
      error: "46elks rapporterar att meddelandet inte kunde levereras"
    });
    repo.updateReminderLog.mockResolvedValue({ ...reservation, status: "failed" });
    repo.addReviewItem.mockResolvedValue(undefined);
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "failed" });

    const result = await processScheduledSms();

    expect(repo.updateReminderLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ status: "failed", sent_at: null }),
      "pending"
    );
    // A verification-detected failure must still raise a review item, even
    // though sendSms itself reported success.
    expect(repo.addReviewItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: "failed_sms" })
    );
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("promotes a confirmed send to delivered", async () => {
    const settings = makeSettings();
    const patient = makePatient();
    const claimedRow = makeScheduledRow();
    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([patient], settings));

    const reservation = {
      id: "log-1", patient_id: patient.id, booking_id: null,
      phone: patient.normalized_phone, message: "Frozen message", status: "pending",
      sequence_number: 1, is_cycle_reset: false, provider_message_id: null,
      skip_reason: null, error: null, sent_at: null, created_at: "2026-01-01T00:00:00.000Z"
    };
    supabaseMock.from.mockReturnValue(makeSupabaseChain({ data: reservation, error: null }));
    repo.linkScheduledSmsReservation.mockResolvedValue(undefined);
    providerMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "elks-1" });
    providerMock.verifyDelivery.mockResolvedValue({ status: "delivered" });
    repo.updateReminderLog.mockResolvedValue({ ...reservation, status: "delivered" });
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "sent" });

    const result = await processScheduledSms();

    expect(repo.updateReminderLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ status: "delivered" }),
      "pending"
    );
    expect(result.sent).toBe(1);
  });

  it("keeps an accepted send as sent when the status API cannot be reached", async () => {
    // An unreachable status API is not evidence of failure -- downgrading here
    // would invite a duplicate re-send.
    const settings = makeSettings();
    const patient = makePatient();
    const claimedRow = makeScheduledRow();
    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([patient], settings));

    const reservation = {
      id: "log-1", patient_id: patient.id, booking_id: null,
      phone: patient.normalized_phone, message: "Frozen message", status: "pending",
      sequence_number: 1, is_cycle_reset: false, provider_message_id: null,
      skip_reason: null, error: null, sent_at: null, created_at: "2026-01-01T00:00:00.000Z"
    };
    supabaseMock.from.mockReturnValue(makeSupabaseChain({ data: reservation, error: null }));
    repo.linkScheduledSmsReservation.mockResolvedValue(undefined);
    providerMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "elks-1" });
    providerMock.verifyDelivery.mockResolvedValue({
      status: "unreachable",
      error: "timeout"
    });
    repo.updateReminderLog.mockResolvedValue({ ...reservation, status: "sent" });
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "sent" });

    const result = await processScheduledSms();

    expect(repo.updateReminderLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ status: "sent" }),
      "pending"
    );
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("skips a scheduled row whose follow-up was deleted, without contacting the provider", async () => {
    // A throw here would be recorded as "unknown" — a message that may have been
    // sent — even though the provider was never called. It must be a clean skip.
    const settings = makeSettings({
      sms_steps: [{ id: STEP_5, day: 5, template: "Hej", active: true }]
    });
    const patient = makePatient();
    const claimedRow = makeScheduledRow({ step_id: "deleted-step", sequence_override: null });
    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([patient], settings));
    repo.addReminderLog.mockResolvedValue({
      id: "log-removed",
      status: "skipped",
      error: "Uppföljningen finns inte längre"
    });
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "skipped" });

    const result = await processScheduledSms();

    expect(providerMock.sendSms).not.toHaveBeenCalled();
    expect(repo.addReminderLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", skip_reason: "step_removed" })
    );
    expect(repo.completeScheduledSms).toHaveBeenCalledWith(
      claimedRow.id, "skipped", "log-removed", expect.stringContaining("finns inte längre")
    );
    expect(result.skipped).toBe(1);
  });

  it("resolves the frozen step by id and snapshots it onto the reservation", async () => {
    const settings = makeSettings({
      sms_steps: [
        { id: STEP_5, day: 5, template: "Hej", active: true },
        { id: STEP_90, day: 90, template: "Hej igen", active: true }
      ]
    });
    const patient = makePatient();
    const claimedRow = makeScheduledRow({ step_id: STEP_90, sequence_override: 2 });
    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([patient], settings));

    const reservation = {
      id: "log-1", patient_id: patient.id, booking_id: null,
      phone: patient.normalized_phone, message: "Frozen message", status: "pending",
      sequence_number: 2, step_id: STEP_90, step_day: 90, is_cycle_reset: false,
      provider_message_id: null, skip_reason: null, error: null, sent_at: null,
      created_at: "2026-01-01T00:00:00.000Z"
    };
    const chain = makeSupabaseChain({ data: reservation, error: null });
    supabaseMock.from.mockReturnValue(chain);
    repo.linkScheduledSmsReservation.mockResolvedValue(undefined);
    providerMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "elks-1" });
    repo.updateReminderLog.mockResolvedValue({ ...reservation, status: "sent" });
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "sent" });

    const result = await processScheduledSms();

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: STEP_90, step_day: 90, sequence_number: 2 })
    );
    expect(result.sent).toBe(1);
  });

  it("classifies provider network uncertainty as unknown, never a definite failure", async () => {
    const settings = makeSettings({ dry_run_mode: false });
    const patient = makePatient();
    const claimedRow = makeScheduledRow();
    repo.claimDueScheduledSms.mockResolvedValue([claimedRow]);
    repo.readStore.mockResolvedValue(makeStore([patient], settings));

    const reservation = {
      id: "log-1",
      patient_id: patient.id,
      booking_id: null,
      phone: patient.normalized_phone,
      message: "Frozen message",
      status: "pending",
      sequence_number: 1,
      is_cycle_reset: false,
      provider_message_id: null,
      skip_reason: null,
      error: null,
      sent_at: null,
      created_at: "2026-01-01T00:00:00.000Z"
    };
    supabaseMock.from.mockReturnValue(makeSupabaseChain({ data: reservation, error: null }));
    repo.linkScheduledSmsReservation.mockResolvedValue(undefined);
    providerMock.sendSms.mockResolvedValue({ success: false, uncertain: true, error: "network timeout" });
    repo.updateReminderLog.mockResolvedValue({ ...reservation, status: "unknown", error: "network timeout" });
    repo.addReviewItem.mockResolvedValue(undefined);
    repo.completeScheduledSms.mockResolvedValue({ ...claimedRow, status: "unknown" });

    const result = await processScheduledSms();

    expect(repo.updateReminderLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ status: "unknown" }),
      "pending"
    );
    expect(repo.completeScheduledSms).toHaveBeenCalledWith(
      claimedRow.id,
      "unknown",
      "log-1",
      "network timeout"
    );
    expect(result.unknown).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe("processDailyReminders", () => {
  const steps = [
    { id: STEP_5, day: 5, template: "Hej {{firstName}}", active: true },
    { id: STEP_90, day: 90, template: "Hej igen {{firstName}}", active: true }
  ];

  function readyPatient(id: string, daysSinceBooking: number): Patient {
    return makePatient({
      id,
      full_name: `Patient ${id}`,
      last_booking_at: new Date(Date.now() - daysSinceBooking * 86_400_000).toISOString()
    });
  }

  /**
   * processDailyReminders reconciles stale pending deliveries before it sends,
   * which queries reminder_logs directly; that lookup must yield an empty list
   * so the run reaches the queue.
   */
  function mockNoStalePending(reservation: Record<string, unknown>) {
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "reminder_logs") {
        const chain = makeSupabaseChain({ data: reservation, error: null });
        // The reconcile path ends at .lt(); the send path ends at .single().
        chain.lt = vi.fn(async () => ({ data: [], error: null }));
        return chain;
      }
      return makeSupabaseChain({ data: reservation, error: null });
    });
  }

  it("sends to the patients who have waited longest, not the ones loaded first", async () => {
    // The cap used to fall on readStore()'s created_at desc ordering, handing
    // every slot to the newest records. Store order here is deliberately the
    // reverse of the correct queue order.
    const settings = makeSettings({ sms_steps: steps, max_per_day: 2, dry_run_mode: true });
    const patients = [
      readyPatient("newest", 6),
      readyPatient("middle", 100),
      readyPatient("oldest", 400)
    ];
    repo.getSettings.mockResolvedValue(settings);
    repo.readStore.mockResolvedValue(makeStore(patients, settings));
    repo.getActiveScheduledSmsPatientIds.mockResolvedValue(new Set<string>());
    repo.bulkUpsertPatients.mockResolvedValue(undefined);
    repo.insertDailySnapshot.mockResolvedValue(undefined);
    mockNoStalePending({ id: "log-x", status: "dry_run", sequence_number: 1, step_id: STEP_5, step_day: 5 });
    supabaseMock.rpc.mockResolvedValue({ data: null, error: null });

    const result = await processDailyReminders();

    expect(result.processed).toBe(2);
    expect(result.results?.map((r) => r.patientId)).toEqual(["oldest", "middle"]);
    // "newest" stays eligible for a later run rather than being dropped.
    expect(result.results?.some((r) => r.patientId === "newest")).toBe(false);
  });

  it("reports how overdue each sent patient was", async () => {
    const settings = makeSettings({ sms_steps: steps, max_per_day: 1, dry_run_mode: true });
    repo.getSettings.mockResolvedValue(settings);
    repo.readStore.mockResolvedValue(makeStore([readyPatient("p1", 400)], settings));
    repo.getActiveScheduledSmsPatientIds.mockResolvedValue(new Set<string>());
    repo.bulkUpsertPatients.mockResolvedValue(undefined);
    repo.insertDailySnapshot.mockResolvedValue(undefined);
    mockNoStalePending({ id: "log-x", status: "dry_run", sequence_number: 2, step_id: STEP_90, step_day: 90 });
    supabaseMock.rpc.mockResolvedValue({ data: null, error: null });

    const result = await processDailyReminders();

    // Due since day 5, contacted on day 400.
    expect(result.results?.[0].overdueDays).toBe(395);
    expect(result.results?.[0].stepId).toBe(STEP_90);
    expect(result.results?.[0].stepDay).toBe(90);
  });

  it("sends nothing when the automation is switched off", async () => {
    repo.getSettings.mockResolvedValue(makeSettings({ is_active: false }));
    mockNoStalePending({});
    const result = await processDailyReminders();
    expect(result.processed).toBe(0);
    expect(repo.readStore).not.toHaveBeenCalled();
  });
});
