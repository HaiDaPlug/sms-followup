import { describe, expect, it } from "vitest";
import { normalizeAndValidateSmsSteps, STALE_STEPS_ERROR } from "./validateSteps";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const MINTED = "99999999-9999-4999-8999-999999999999";
const mint = () => MINTED;

describe("normalizeAndValidateSmsSteps", () => {
  it("mints ids for id-less elements while the stored steps have none", () => {
    const result = normalizeAndValidateSmsSteps(
      [{ day: 5, template: "a" }],
      [{ day: 5, template: "a" }],
      mint
    );
    expect(result).toEqual({ ok: true, steps: [{ id: MINTED, day: 5, template: "a", active: true }] });
  });

  it("also mints when nothing is stored yet", () => {
    const result = normalizeAndValidateSmsSteps([{ day: 5, template: "a" }], null, mint);
    expect(result.ok).toBe(true);
  });

  it("rejects an id-less element once the stored steps carry ids — the stale-tab case", () => {
    const result = normalizeAndValidateSmsSteps(
      [{ day: 5, template: "a" }, { day: 14, template: "b" }],
      [{ id: ID_A, day: 5, template: "a" }, { id: ID_B, day: 14, template: "b" }],
      mint
    );
    expect(result).toEqual({ ok: false, error: STALE_STEPS_ERROR });
  });

  it("accepts an all-id post that adds a new step and drops another", () => {
    const result = normalizeAndValidateSmsSteps(
      [{ id: ID_A, day: 5, template: "a" }, { id: MINTED, day: 60, template: "new", active: false }],
      [{ id: ID_A, day: 5, template: "a" }, { id: ID_B, day: 14, template: "b" }],
      mint
    );
    expect(result).toEqual({
      ok: true,
      steps: [
        { id: ID_A, day: 5, template: "a", active: true },
        { id: MINTED, day: 60, template: "new", active: false }
      ]
    });
  });

  it("sorts by day and strips unknown keys", () => {
    const result = normalizeAndValidateSmsSteps(
      [{ id: ID_B, day: 90, template: "b", junk: 1 }, { id: ID_A, day: 5, template: "a" }],
      null,
      mint
    );
    expect(result).toEqual({
      ok: true,
      steps: [
        { id: ID_A, day: 5, template: "a", active: true },
        { id: ID_B, day: 90, template: "b", active: true }
      ]
    });
  });

  it("rejects duplicate ids", () => {
    const result = normalizeAndValidateSmsSteps(
      [{ id: ID_A, day: 5, template: "a" }, { id: ID_A, day: 14, template: "b" }],
      null,
      mint
    );
    expect(result).toEqual({ ok: false, error: "Två uppföljningar har samma id" });
  });

  it("rejects duplicate days, which would make ordering ambiguous", () => {
    const result = normalizeAndValidateSmsSteps(
      [{ id: ID_A, day: 5, template: "a" }, { id: ID_B, day: 5, template: "b" }],
      null,
      mint
    );
    expect(result).toEqual({ ok: false, error: "Två uppföljningar har samma dag (5)" });
  });

  it("rejects a non-positive or fractional day", () => {
    expect(normalizeAndValidateSmsSteps([{ id: ID_A, day: 0, template: "a" }], null, mint).ok).toBe(false);
    expect(normalizeAndValidateSmsSteps([{ id: ID_A, day: 1.5, template: "a" }], null, mint).ok).toBe(false);
  });

  it("rejects a non-boolean active flag", () => {
    const result = normalizeAndValidateSmsSteps([{ id: ID_A, day: 5, template: "a", active: "yes" }], null, mint);
    expect(result).toEqual({ ok: false, error: "Ogiltigt värde för aktiv" });
  });

  it("rejects an id that is not uuid-shaped", () => {
    const result = normalizeAndValidateSmsSteps([{ id: "step-1", day: 5, template: "a" }], null, mint);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Ogiltigt id");
  });

  it("rejects non-arrays and malformed elements with the original shape error", () => {
    expect(normalizeAndValidateSmsSteps("nope", null, mint)).toEqual({ ok: false, error: "Ogiltigt format för sms_steps" });
    expect(normalizeAndValidateSmsSteps([{ day: "5", template: "a" }], null, mint)).toEqual({ ok: false, error: "Ogiltigt format för sms_steps" });
    expect(normalizeAndValidateSmsSteps([null], null, mint)).toEqual({ ok: false, error: "Ogiltigt format för sms_steps" });
  });

  it("accepts an empty array", () => {
    expect(normalizeAndValidateSmsSteps([], null, mint)).toEqual({ ok: true, steps: [] });
  });
});
