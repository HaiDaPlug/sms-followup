import { describe, expect, it } from "vitest";
import { calculateConversionRate } from "./conversionRate";

describe("calculateConversionRate", () => {
  it("counts distinct patients, not messages", () => {
    // One patient who got three sequence steps and rebooked once is one
    // converted patient out of one — not one out of three.
    const { smsPatientCount, conversionRate } = calculateConversionRate(
      ["p1", "p1", "p1"],
      ["p1"]
    );
    expect(smsPatientCount).toBe(1);
    expect(conversionRate).toBe(1);
  });

  it("computes a partial rate", () => {
    const { smsPatientCount, conversionRate } = calculateConversionRate(
      ["p1", "p2", "p3", "p4"],
      ["p1", "p3"]
    );
    expect(smsPatientCount).toBe(4);
    expect(conversionRate).toBe(0.5);
  });

  it("returns null when nobody was messaged", () => {
    // Distinguishes "no data" from a genuine 0% so the UI can show a dash.
    expect(calculateConversionRate([], []).conversionRate).toBeNull();
    expect(calculateConversionRate([], []).smsPatientCount).toBe(0);
  });

  it("reports 0 when messages went out but nobody converted", () => {
    const { conversionRate } = calculateConversionRate(["p1", "p2"], []);
    expect(conversionRate).toBe(0);
  });

  it("never exceeds 1 when a conversion's SMS predates the window", () => {
    // The conversions query and the SMS query use the same window, but a
    // conversion can reference an SMS sent earlier. Intersecting with the
    // SMS'd set keeps the rate a true subset ratio.
    const { smsPatientCount, conversionRate } = calculateConversionRate(
      ["p1"],
      ["p1", "p_outside_window", "p_another"]
    );
    expect(smsPatientCount).toBe(1);
    expect(conversionRate).toBe(1);
  });

  it("ignores null patient ids on both sides", () => {
    const { smsPatientCount, conversionRate } = calculateConversionRate(
      ["p1", null, "p2"],
      ["p1", null]
    );
    expect(smsPatientCount).toBe(2);
    expect(conversionRate).toBe(0.5);
  });

  it("deduplicates repeated conversions for the same patient", () => {
    // A patient who rebooked twice in the window is still one converted patient.
    const { conversionRate } = calculateConversionRate(["p1", "p2"], ["p1", "p1"]);
    expect(conversionRate).toBe(0.5);
  });
});
