import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicStore, Patient, ReminderSettings, ScheduledSms } from "@/types/clinic";
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

const providerMock = vi.hoisted(() => ({ sendSms: vi.fn() }));
vi.mock("@/lib/sms/provider", () => providerMock);

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({ supabase: supabaseMock }));

import { processScheduledSms } from "./process";

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

function makeStore(patients: Patient[], settings: ReminderSettings): ClinicStore {
  return { patients, bookings: [], reminder_settings: [settings], reminder_logs: [], review_items: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
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
