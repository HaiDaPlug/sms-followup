import { describe, expect, it, vi } from "vitest";
import type { Patient, ReminderLog, ReminderSettings, StoredSmsStep } from "@/types/clinic";

// The functions under test are pure, but eligibility.ts also exports
// getEligiblePatients, which pulls in the server-only Supabase client. Stub the
// data layer so this stays a unit test.
vi.mock("@/lib/data/repository", () => ({ readStore: vi.fn() }));
vi.mock("@/lib/data/readStoreForUi", () => ({ readStoreForUi: vi.fn() }));

import {
  calculatePatientReminderStatus,
  evaluateNextStep,
  getNextSchedulableSequence,
  getNextSequence,
  validateSequenceOrder
} from "./eligibility";

const STEP_5 = "aaaaaaaa-0000-4000-8000-000000000005";
const STEP_14 = "aaaaaaaa-0000-4000-8000-000000000014";
const STEP_90 = "aaaaaaaa-0000-4000-8000-000000000090";
const STEP_180 = "aaaaaaaa-0000-4000-8000-000000000180";
const STEP_365 = "aaaaaaaa-0000-4000-8000-000000000365";

const DEFAULT_STEPS: StoredSmsStep[] = [
  { id: STEP_5, day: 5, template: "SMS 1", active: true },
  { id: STEP_14, day: 14, template: "SMS 2", active: true },
  { id: STEP_90, day: 90, template: "SMS 3", active: true },
  { id: STEP_180, day: 180, template: "SMS 4", active: true },
  { id: STEP_365, day: 365, template: "SMS 5", active: true }
];

function makeSettings(steps: StoredSmsStep[] = DEFAULT_STEPS): ReminderSettings {
  return {
    id: "settings-1",
    days_after_booking: 30,
    send_time: "09:00",
    max_per_day: 25,
    sms_template: "1",
    sms_template_2: "2",
    sms_template_3: "3",
    sms_steps: steps,
    booking_link: "https://book.example",
    clinic_name: "Test Clinic",
    is_active: true,
    dry_run_mode: false,
    allow_same_number_override: false,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z"
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function makePatient(daysSinceBooking: number): Patient {
  return {
    id: "patient-1",
    full_name: "Anna Andersson",
    first_name: "Anna",
    last_name: "Andersson",
    phone: "0701234567",
    normalized_phone: "+46701234567",
    email: null,
    last_booking_at: daysAgo(daysSinceBooking),
    latest_treatment: null,
    has_future_booking: false,
    do_not_contact: false,
    source: "test",
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z"
  };
}

function makeLog(overrides: Partial<ReminderLog> = {}): ReminderLog {
  return {
    id: `log-${Math.random()}`,
    patient_id: "patient-1",
    booking_id: "booking-1",
    phone: "+46701234567",
    message: "",
    status: "sent",
    sequence_number: 1,
    step_id: STEP_5,
    step_day: 5,
    is_cycle_reset: false,
    provider_message_id: null,
    skip_reason: null,
    error: null,
    sent_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("getNextSequence", () => {
  it("picks the highest crossed threshold, not the first one", () => {
    // A patient 212 days out gets the 180-day follow-up, not a restart at day 5.
    const next = getNextSequence(makePatient(212), makeSettings(), []);
    expect(next?.stepId).toBe(STEP_180);
    expect(next?.day).toBe(180);
    expect(next?.sequenceNumber).toBe(4);
  });

  it("returns null when nothing has been crossed yet", () => {
    expect(getNextSequence(makePatient(3), makeSettings(), [])).toBeNull();
  });

  it("skips an inactive step without blocking the ones after it", () => {
    // 90 active, 180 inactive, 365 active: the 180 must not stall the sequence.
    const settings = makeSettings([
      { id: STEP_90, day: 90, template: "c", active: true },
      { id: STEP_180, day: 180, template: "d", active: false },
      { id: STEP_365, day: 365, template: "e", active: true }
    ]);
    const logs = [makeLog({ step_id: STEP_90, step_day: 90, sequence_number: 1 })];

    expect(getNextSequence(makePatient(200), settings, logs)).toBeNull();
    expect(getNextSequence(makePatient(400), settings, logs)?.stepId).toBe(STEP_365);
  });

  it("never selects an inactive step even when it is the only one crossed", () => {
    const settings = makeSettings([{ id: STEP_90, day: 90, template: "c", active: false }]);
    expect(getNextSequence(makePatient(400), settings, [])).toBeNull();
  });

  it("bounds the cycle by the day the step had when it was SENT, not its current day", () => {
    // The 90-day follow-up went out, then the clinic re-timed that same step to
    // 180. History says a 90-day message was sent, so a new 120-day step is
    // still ahead of it.
    const settings = makeSettings([
      { id: STEP_90, day: 180, template: "was 90", active: true },
      { id: STEP_180, day: 120, template: "new middle", active: true }
    ]);
    const logs = [makeLog({ step_id: STEP_90, step_day: 90, sequence_number: 1 })];

    const next = getNextSequence(makePatient(150), settings, logs);
    expect(next?.stepId).toBe(STEP_180);
    expect(next?.day).toBe(120);
  });

  it("excludes an already-sent step by id even after its day was edited upward", () => {
    const settings = makeSettings([
      { id: STEP_90, day: 300, template: "moved up", active: true }
    ]);
    const logs = [makeLog({ step_id: STEP_90, step_day: 90, sequence_number: 1 })];
    expect(getNextSequence(makePatient(400), settings, logs)).toBeNull();
  });

  it("still bounds ordering from step_day when the step itself was deleted", () => {
    const settings = makeSettings([
      { id: STEP_90, day: 90, template: "c", active: true },
      { id: STEP_365, day: 365, template: "e", active: true }
    ]);
    // The log points at a step no longer in settings, but remembers it was 180.
    const logs = [makeLog({ step_id: "deleted-step", step_day: 180, sequence_number: 4 })];

    expect(getNextSequence(makePatient(200), settings, logs)).toBeNull();
    expect(getNextSequence(makePatient(400), settings, logs)?.stepId).toBe(STEP_365);
  });

  it("falls back to the positional sequence_number for logs written before the snapshot", () => {
    const logs = [makeLog({ step_id: null, step_day: null, sequence_number: 4 })];
    // Position 4 is the 180-day step, so only the 365 remains.
    expect(getNextSequence(makePatient(200), makeSettings(), logs)).toBeNull();
    expect(getNextSequence(makePatient(400), makeSettings(), logs)?.stepId).toBe(STEP_365);
  });

  it("starts a fresh cycle after a cycle reset", () => {
    const logs = [
      makeLog({ is_cycle_reset: true, status: "cycle_reset", sequence_number: null, step_id: null, step_day: null }),
      makeLog({ step_id: STEP_180, step_day: 180, sequence_number: 4 })
    ];
    expect(getNextSequence(makePatient(20), makeSettings(), logs)?.stepId).toBe(STEP_14);
  });

  it("ignores skipped and failed steps", () => {
    const logs = [
      makeLog({ status: "failed", step_id: STEP_90, step_day: 90 }),
      makeLog({ status: "skipped", step_id: STEP_14, step_day: 14 })
    ];
    expect(getNextSequence(makePatient(100), makeSettings(), logs)?.stepId).toBe(STEP_90);
  });

  it("returns null without a last booking", () => {
    const patient = { ...makePatient(400), last_booking_at: null };
    expect(getNextSequence(patient, makeSettings(), [])).toBeNull();
  });
});

describe("evaluateNextStep", () => {
  it("reports the earliest owed threshold, not the one being sent", () => {
    // Never contacted at day 400: the send is the 365 step, but the patient has
    // been waiting since day 5 — that is what the queue orders on.
    const { next, firstDueDay } = evaluateNextStep(makePatient(400), makeSettings(), []);
    expect(next?.stepId).toBe(STEP_365);
    expect(firstDueDay).toBe(5);
  });

  it("advances firstDueDay past steps already sent", () => {
    const logs = [makeLog({ step_id: STEP_14, step_day: 14, sequence_number: 2 })];
    const { next, firstDueDay } = evaluateNextStep(makePatient(200), makeSettings(), logs);
    expect(next?.stepId).toBe(STEP_180);
    expect(firstDueDay).toBe(90);
  });

  it("returns nulls when nothing is due", () => {
    expect(evaluateNextStep(makePatient(3), makeSettings(), [])).toEqual({ next: null, firstDueDay: null });
  });
});

describe("validateSequenceOrder", () => {
  const settings = makeSettings();

  it("allows any step when nothing has been sent in this cycle", () => {
    expect(validateSequenceOrder("patient-1", STEP_180, settings, [])).toBeNull();
  });

  it("rejects a step behind one already sent — the reported out-of-order bug", () => {
    const logs = [makeLog({ step_id: STEP_90, step_day: 90, sequence_number: 3 })];
    const error = validateSequenceOrder("patient-1", STEP_14, settings, logs);
    expect(error).toContain("14-dagars");
    expect(error).toContain("90-dagars");
  });

  it("rejects re-sending the step that was just sent", () => {
    const logs = [makeLog({ step_id: STEP_90, step_day: 90, sequence_number: 3 })];
    expect(validateSequenceOrder("patient-1", STEP_90, settings, logs)).toContain("redan skickats");
  });

  it("allows the next step forward", () => {
    const logs = [makeLog({ step_id: STEP_90, step_day: 90, sequence_number: 3 })];
    expect(validateSequenceOrder("patient-1", STEP_180, settings, logs)).toBeNull();
  });

  it("allows the first step again after a cycle reset, which is the rebooking case", () => {
    const logs = [
      makeLog({ is_cycle_reset: true, status: "cycle_reset", sequence_number: null, step_id: null, step_day: null }),
      makeLog({ step_id: STEP_180, step_day: 180, sequence_number: 4 })
    ];
    expect(validateSequenceOrder("patient-1", STEP_5, settings, logs)).toBeNull();
  });

  it("rejects a step that no longer exists", () => {
    expect(validateSequenceOrder("patient-1", "gone", settings, [])).toContain("finns inte längre");
  });

  it("allows an inactive step, since an operator picked it deliberately", () => {
    const withInactive = makeSettings([
      { id: STEP_90, day: 90, template: "c", active: false }
    ]);
    expect(validateSequenceOrder("patient-1", STEP_90, withInactive, [])).toBeNull();
  });

  it("counts dry-run sends, so testing does not open an out-of-order hole", () => {
    const logs = [makeLog({ status: "dry_run", step_id: STEP_14, step_day: 14, sequence_number: 2 })];
    expect(validateSequenceOrder("patient-1", STEP_5, settings, logs)).toContain("kan inte skickas");
  });
});

describe("getNextSchedulableSequence", () => {
  it("returns the earliest unsent active step even when its day has not been reached", () => {
    const next = getNextSchedulableSequence(makePatient(3), makeSettings(), []);
    expect(next?.stepId).toBe(STEP_5);
  });

  it("skips inactive steps", () => {
    const settings = makeSettings([
      { id: STEP_5, day: 5, template: "a", active: false },
      { id: STEP_14, day: 14, template: "b", active: true }
    ]);
    expect(getNextSchedulableSequence(makePatient(1), settings, [])?.stepId).toBe(STEP_14);
  });

  it("returns null when every step has been sent", () => {
    const settings = makeSettings([{ id: STEP_5, day: 5, template: "a", active: true }]);
    const logs = [makeLog({ step_id: STEP_5, step_day: 5, sequence_number: 1 })];
    expect(getNextSchedulableSequence(makePatient(400), settings, logs)).toBeNull();
  });
});

describe("status when no follow-ups are active", () => {
  const noneActive = makeSettings([
    { id: STEP_5, day: 5, template: "a", active: false },
    { id: STEP_90, day: 90, template: "c", active: false }
  ]);

  it("reports an untouched patient as Waiting, never as Sent", () => {
    // Disabling every follow-up must not make the whole patient list look like
    // a completed sequence.
    const status = calculatePatientReminderStatus(makePatient(400), noneActive, [], [], []);
    expect(status).toBe("Waiting");
  });

  it("still reports Sent for a patient whose cycle actually produced a send", () => {
    const logs = [makeLog({ step_id: STEP_5, step_day: 5, sequence_number: 1 })];
    const status = calculatePatientReminderStatus(makePatient(400), noneActive, [], logs, []);
    expect(status).toBe("Sent");
  });

  it("reports Ready when a step is active and crossed", () => {
    expect(calculatePatientReminderStatus(makePatient(400), makeSettings(), [], [], [])).toBe("Ready");
  });

  it("reports Waiting before the first threshold", () => {
    expect(calculatePatientReminderStatus(makePatient(2), makeSettings(), [], [], [])).toBe("Waiting");
  });
});
