import { describe, expect, it } from "vitest";
import type { ReminderSettings } from "@/types/clinic";
import {
  activeSteps,
  fallbackStepId,
  resolveSteps,
  stepById,
  stepPosition,
  stepsForEditing
} from "./steps";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

function makeSettings(overrides: Partial<ReminderSettings> = {}): ReminderSettings {
  return {
    id: "settings-1",
    days_after_booking: 30,
    send_time: "09:00",
    max_per_day: 25,
    sms_template: "legacy 1",
    sms_template_2: "legacy 2",
    sms_template_3: "legacy 3",
    sms_steps: [
      { id: ID_B, day: 90, template: "ninety", active: false },
      { id: ID_A, day: 5, template: "five" },
      { id: ID_C, day: 180, template: "one-eighty", active: true }
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

describe("resolveSteps", () => {
  it("sorts by day and defaults active to true", () => {
    const steps = resolveSteps(makeSettings());
    expect(steps.map((s) => s.day)).toEqual([5, 90, 180]);
    expect(steps.map((s) => s.active)).toEqual([true, false, true]);
  });

  it("keeps stored ids exactly and is stable across calls", () => {
    const settings = makeSettings();
    const first = resolveSteps(settings);
    const second = resolveSteps(settings);
    expect(first.map((s) => s.id)).toEqual([ID_A, ID_B, ID_C]);
    expect(second).toEqual(first);
  });

  it("breaks an equal-day tie by id so the order is deterministic", () => {
    const settings = makeSettings({
      sms_steps: [
        { id: ID_B, day: 30, template: "b" },
        { id: ID_A, day: 30, template: "a" }
      ]
    });
    expect(resolveSteps(settings).map((s) => s.id)).toEqual([ID_A, ID_B]);
  });

  it("gives a stored element without an id a deterministic positional id, never a random one", () => {
    // Pre-025 shape: no ids at rest.
    const settings = makeSettings({
      sms_steps: [
        { day: 90, template: "b" },
        { day: 5, template: "a" }
      ]
    });
    const steps = resolveSteps(settings);
    expect(steps.map((s) => s.id)).toEqual([fallbackStepId(1), fallbackStepId(2)]);
    expect(resolveSteps(settings)).toEqual(steps);
    expect(fallbackStepId(1)).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("falls back to the three legacy templates with fixed ids when sms_steps is null", () => {
    const steps = resolveSteps(makeSettings({ sms_steps: null }));
    expect(steps).toEqual([
      { id: fallbackStepId(1), day: 30, template: "legacy 1", active: true },
      { id: fallbackStepId(2), day: 60, template: "legacy 2", active: true },
      { id: fallbackStepId(3), day: 90, template: "legacy 3", active: true }
    ]);
  });
});

describe("stepsForEditing", () => {
  it("returns stored steps with ids exactly as stored — undefined stays undefined", () => {
    const settings = makeSettings({
      sms_steps: [
        { day: 90, template: "b" },
        { id: ID_A, day: 5, template: "a" }
      ]
    });
    const steps = stepsForEditing(settings);
    expect(steps.map((s) => s.day)).toEqual([5, 90]);
    expect(steps[0].id).toBe(ID_A);
    expect(steps[1].id).toBeUndefined();
    expect("id" in steps[1]).toBe(false);
  });

  it("does not hand back the stored objects themselves", () => {
    const settings = makeSettings();
    const steps = stepsForEditing(settings);
    steps[0].template = "mutated";
    expect(settings.sms_steps?.find((s) => s.id === ID_A)?.template).toBe("five");
  });

  it("falls back to the legacy steps with their fixed ids when sms_steps is null", () => {
    const steps = stepsForEditing(makeSettings({ sms_steps: null }));
    expect(steps.map((s) => s.id)).toEqual([fallbackStepId(1), fallbackStepId(2), fallbackStepId(3)]);
  });
});

describe("stepById / stepPosition / activeSteps", () => {
  const steps = resolveSteps(makeSettings());

  it("finds a step by id and returns undefined for unknown or missing ids", () => {
    expect(stepById(steps, ID_B)?.day).toBe(90);
    expect(stepById(steps, "nope")).toBeUndefined();
    expect(stepById(steps, null)).toBeUndefined();
    expect(stepById(steps, undefined)).toBeUndefined();
  });

  it("reports the 1-based position in the full list, inactive steps included", () => {
    expect(stepPosition(steps, ID_A)).toBe(1);
    expect(stepPosition(steps, ID_B)).toBe(2);
    expect(stepPosition(steps, ID_C)).toBe(3);
    expect(stepPosition(steps, "nope")).toBeNull();
  });

  it("filters to active steps only", () => {
    expect(activeSteps(steps).map((s) => s.id)).toEqual([ID_A, ID_C]);
  });
});
