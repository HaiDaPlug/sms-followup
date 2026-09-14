import { describe, expect, it } from "vitest";
import type { ReminderLog } from "@/types/clinic";
import { isRealSend, kindFromLogStatus, needsAttention, outcomeFromLog } from "./outcome";

function makeLog(overrides: Partial<ReminderLog> = {}): ReminderLog {
  return {
    id: "log-1",
    patient_id: "patient-1",
    booking_id: "booking-1",
    phone: "+46701234567",
    message: "Hej",
    status: "sent",
    sequence_number: 2,
    is_cycle_reset: false,
    provider_message_id: "elks-1",
    skip_reason: null,
    error: null,
    sent_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("isRealSend", () => {
  it("counts only sent and delivered as an SMS that actually went out", () => {
    expect(isRealSend("sent")).toBe(true);
    expect(isRealSend("delivered")).toBe(true);
    // The original bug: these three were treated as success by the UI.
    expect(isRealSend("dry_run")).toBe(false);
    expect(isRealSend("skipped")).toBe(false);
    expect(isRealSend("unknown")).toBe(false);
    expect(isRealSend("failed")).toBe(false);
  });
});

describe("needsAttention", () => {
  it("flags failed and unknown for operator follow-up", () => {
    expect(needsAttention("failed")).toBe(true);
    expect(needsAttention("unknown")).toBe(true);
    expect(needsAttention("sent")).toBe(false);
    expect(needsAttention("skipped")).toBe(false);
  });
});

describe("kindFromLogStatus", () => {
  it("maps a still-pending reservation to unknown, never to sent", () => {
    expect(kindFromLogStatus("pending")).toBe("unknown");
  });

  it("maps each terminal status to its own kind", () => {
    expect(kindFromLogStatus("sent")).toBe("sent");
    expect(kindFromLogStatus("delivered")).toBe("delivered");
    expect(kindFromLogStatus("dry_run")).toBe("dry_run");
    expect(kindFromLogStatus("skipped")).toBe("skipped");
    expect(kindFromLogStatus("failed")).toBe("failed");
    expect(kindFromLogStatus("unknown")).toBe("unknown");
  });
});

describe("outcomeFromLog", () => {
  it("explains WHY a send was skipped instead of reporting a bare status", () => {
    const outcome = outcomeFromLog(
      makeLog({ status: "skipped", skip_reason: "out_of_order", error: "SMS 2 kan inte skickas" })
    );
    expect(outcome.kind).toBe("skipped");
    expect(outcome.message).toContain("kommer före ett som redan skickats");
  });

  it("names the stale-cycle skip, which is the rebooking case", () => {
    const outcome = outcomeFromLog(makeLog({ status: "skipped", skip_reason: "stale_cycle" }));
    expect(outcome.message).toContain("bokat en ny tid");
  });

  it("never describes a dry run as sent", () => {
    const outcome = outcomeFromLog(makeLog({ status: "dry_run" }));
    expect(outcome.kind).toBe("dry_run");
    expect(outcome.message).toContain("testläge");
    expect(isRealSend(outcome.kind)).toBe(false);
  });

  it("carries the sequence number into the operator-facing message", () => {
    expect(outcomeFromLog(makeLog({ status: "sent", sequence_number: 3 })).message)
      .toContain("SMS 3");
  });

  it("surfaces the provider error as detail on a failure", () => {
    const outcome = outcomeFromLog(makeLog({ status: "failed", error: "46elks 400: bad number" }));
    expect(outcome.kind).toBe("failed");
    expect(outcome.detail).toBe("46elks 400: bad number");
  });

  it("does not repeat an identical message as detail", () => {
    const outcome = outcomeFromLog(makeLog({ status: "skipped", skip_reason: "missing_phone" }));
    expect(outcome.message).toContain("Telefonnummer saknas");
    // detail equals the skip label; the UI drops it rather than printing twice.
    expect(outcome.detail).toBe("Telefonnummer saknas");
  });
});
