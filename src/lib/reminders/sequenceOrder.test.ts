import { describe, expect, it, vi } from "vitest";
import type { ReminderLog, ReminderSettings } from "@/types/clinic";

// The functions under test are pure, but eligibility.ts also exports
// getEligiblePatients, which pulls in the server-only Supabase client. Stub the
// data layer so this stays a unit test.
vi.mock("@/lib/data/repository", () => ({ readStore: vi.fn() }));
vi.mock("@/lib/data/readStoreForUi", () => ({ readStoreForUi: vi.fn() }));

import { maxSentSequenceInCycle, validateSequenceOrder } from "./eligibility";

function makeSettings(overrides: Partial<ReminderSettings> = {}): ReminderSettings {
  return {
    id: "settings-1",
    days_after_booking: 30,
    send_time: "09:00",
    max_per_day: 25,
    sms_template: "1",
    sms_template_2: "2",
    sms_template_3: "3",
    sms_steps: [
      { day: 5,   template: "SMS 1" },
      { day: 60,  template: "SMS 2" },
      { day: 120, template: "SMS 3" },
      { day: 180, template: "SMS 4" },
      { day: 240, template: "SMS 5" }
    ],
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

function makeLog(overrides: Partial<ReminderLog> = {}): ReminderLog {
  return {
    id: `log-${Math.random()}`,
    patient_id: "patient-1",
    booking_id: "booking-1",
    phone: "+46701234567",
    message: "",
    status: "sent",
    sequence_number: 1,
    is_cycle_reset: false,
    provider_message_id: null,
    skip_reason: null,
    error: null,
    sent_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("maxSentSequenceInCycle", () => {
  it("ignores logs from before a cycle reset", () => {
    // Logs are newest-first; everything before the reset marker is the new cycle.
    const logs = [
      makeLog({ sequence_number: 1, status: "sent" }),
      makeLog({ is_cycle_reset: true, status: "cycle_reset", sequence_number: null }),
      makeLog({ sequence_number: 4, status: "sent" })
    ];
    expect(maxSentSequenceInCycle("patient-1", logs)).toBe(1);
  });

  it("does not count skipped or failed steps as sent", () => {
    const logs = [
      makeLog({ sequence_number: 3, status: "failed" }),
      makeLog({ sequence_number: 2, status: "skipped" }),
      makeLog({ sequence_number: 1, status: "sent" })
    ];
    expect(maxSentSequenceInCycle("patient-1", logs)).toBe(1);
  });
});

describe("validateSequenceOrder", () => {
  const settings = makeSettings();

  it("allows any step when nothing has been sent in this cycle", () => {
    expect(validateSequenceOrder("patient-1", 4, settings, [])).toBeNull();
  });

  it("rejects a step behind one already sent — the reported out-of-order bug", () => {
    const logs = [makeLog({ sequence_number: 3, status: "sent" })];
    const error = validateSequenceOrder("patient-1", 2, settings, logs);
    expect(error).toContain("SMS 2");
    expect(error).toContain("SMS 3");
  });

  it("rejects re-sending the step that was just sent", () => {
    const logs = [makeLog({ sequence_number: 3, status: "sent" })];
    expect(validateSequenceOrder("patient-1", 3, settings, logs)).toContain("redan skickats");
  });

  it("allows the next step forward", () => {
    const logs = [makeLog({ sequence_number: 3, status: "sent" })];
    expect(validateSequenceOrder("patient-1", 4, settings, logs)).toBeNull();
  });

  it("allows step 1 again after a cycle reset, which is the rebooking case", () => {
    // Patient was on SMS 4, rebooked (reset), so SMS 1 is legitimate again.
    const logs = [
      makeLog({ is_cycle_reset: true, status: "cycle_reset", sequence_number: null }),
      makeLog({ sequence_number: 4, status: "sent" })
    ];
    expect(validateSequenceOrder("patient-1", 1, settings, logs)).toBeNull();
  });

  it("rejects a step outside the configured sequence", () => {
    expect(validateSequenceOrder("patient-1", 9, settings, [])).toContain("Ogiltigt");
    expect(validateSequenceOrder("patient-1", 0, settings, [])).toContain("Ogiltigt");
  });

  it("counts dry-run sends, so testing does not open an out-of-order hole", () => {
    const logs = [makeLog({ sequence_number: 2, status: "dry_run" })];
    expect(validateSequenceOrder("patient-1", 1, settings, logs)).toContain("redan skickats");
  });
});
