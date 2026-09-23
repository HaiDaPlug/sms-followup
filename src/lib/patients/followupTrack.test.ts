import { describe, expect, it } from "vitest";
import { followUpTrack } from "./followupTrack";
import type { ReminderLog, SmsStep } from "@/types/clinic";

const steps: SmsStep[] = [
  { id: "s30", day: 30, template: "", active: true },
  { id: "s60", day: 60, template: "", active: false },
  { id: "s90", day: 90, template: "", active: true },
];

function log(partial: Partial<ReminderLog>): ReminderLog {
  return {
    id: Math.random().toString(36).slice(2),
    patient_id: "p1",
    booking_id: null,
    phone: null,
    message: "",
    status: "sent",
    sequence_number: null,
    step_id: null,
    step_day: null,
    is_cycle_reset: false,
    provider_message_id: null,
    skip_reason: null,
    error: null,
    sent_at: "2026-09-01T08:00:00Z",
    created_at: "2026-09-01T08:00:00Z",
    ...partial,
  };
}

const states = (track: ReturnType<typeof followUpTrack>) => track.map((t) => t.state);

describe("followUpTrack", () => {
  it("marks steps upcoming, due and inactive from the visit age alone", () => {
    expect(states(followUpTrack(steps, [], 10))).toEqual(["upcoming", "inactive", "upcoming"]);
    expect(states(followUpTrack(steps, [], 45))).toEqual(["due", "inactive", "upcoming"]);
  });

  it("marks only the latest crossed step due; earlier ones are passed over", () => {
    // Mirrors getNextSequence: a patient 120 days out gets the 90-day
    // follow-up, not the 30-day one first.
    expect(states(followUpTrack(steps, [], 120))).toEqual(["passed", "inactive", "due"]);
  });

  it("matches a log by step id before day snapshot or position", () => {
    // Sent as s30 while that step was timed at day 90: the id decides which
    // step it was, the snapshot decides how far the cycle got — so s90 is
    // passed over, not sent (same reading as eligibility.ts cycleProgress).
    const track = followUpTrack(steps, [log({ step_id: "s30", step_day: 90, sequence_number: 3 })], 45);
    expect(states(track)).toEqual(["sent", "inactive", "passed"]);
    expect(track[0].at).toBe("2026-09-01T08:00:00Z");
  });

  it("falls back to the day snapshot, then to the legacy position", () => {
    expect(states(followUpTrack(steps, [log({ step_day: 90 })], 120))).toEqual(["passed", "inactive", "sent"]);
    expect(states(followUpTrack(steps, [log({ sequence_number: 1 })], 45))).toEqual(["sent", "inactive", "upcoming"]);
  });

  it("passes over an earlier unsent step once a later one went out", () => {
    const track = followUpTrack(steps, [log({ step_id: "s90" })], 120);
    expect(states(track)).toEqual(["passed", "inactive", "sent"]);
  });

  it("distinguishes dry runs, pending receipts and failures from real sends", () => {
    expect(states(followUpTrack(steps, [log({ step_id: "s30", status: "dry_run" })], 45))[0]).toBe("dry_run");
    expect(states(followUpTrack(steps, [log({ step_id: "s30", status: "unknown" })], 45))[0]).toBe("pending");
    expect(states(followUpTrack(steps, [log({ step_id: "s30", status: "failed" })], 45))[0]).toBe("failed");
  });

  it("lets a later successful send win over an earlier failure", () => {
    const track = followUpTrack(
      steps,
      [log({ step_id: "s30", status: "sent" }), log({ step_id: "s30", status: "failed" })],
      45
    );
    expect(states(track)[0]).toBe("sent");
  });

  it("ignores skipped logs", () => {
    expect(states(followUpTrack(steps, [log({ step_id: "s30", status: "skipped" })], 45))[0]).toBe("due");
  });

  it("treats a patient without a visit as nothing due", () => {
    expect(states(followUpTrack(steps, [], null))).toEqual(["upcoming", "inactive", "upcoming"]);
  });
});
