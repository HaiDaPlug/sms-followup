import { describe, expect, it } from "vitest";
import {
  buildStockholmDayKeys,
  stockholmDayKey,
  stockholmMidnightToUtc,
  windowStartIso,
} from "./dayKeys";

/** Stockholm local wall-clock rendering of a UTC instant, for assertions. */
const localOf = (d: Date) => d.toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });

describe("stockholmMidnightToUtc", () => {
  // The two-pass offset correction is the single most fragile piece of the
  // analytics date logic: if it ever stops converging it produces a silently
  // wrong window boundary rather than an error.
  it("resolves to exactly local midnight in winter (UTC+1)", () => {
    const utc = stockholmMidnightToUtc(2026, 1, 15);
    expect(utc.toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(localOf(utc)).toBe("2026-01-15 00:00:00");
  });

  it("resolves to exactly local midnight in summer (UTC+2)", () => {
    const utc = stockholmMidnightToUtc(2026, 7, 15);
    expect(utc.toISOString()).toBe("2026-07-14T22:00:00.000Z");
    expect(localOf(utc)).toBe("2026-07-15 00:00:00");
  });

  it("converges across the spring-forward transition", () => {
    // 2026-03-29 is the spring DST change; the day before/after bracket it.
    expect(stockholmMidnightToUtc(2026, 3, 28).toISOString()).toBe("2026-03-27T23:00:00.000Z");
    expect(stockholmMidnightToUtc(2026, 3, 29).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(stockholmMidnightToUtc(2026, 3, 30).toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("converges across the fall-back transition", () => {
    // 2026-10-25 is the autumn DST change.
    expect(stockholmMidnightToUtc(2026, 10, 24).toISOString()).toBe("2026-10-23T22:00:00.000Z");
    expect(stockholmMidnightToUtc(2026, 10, 25).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(stockholmMidnightToUtc(2026, 10, 26).toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("lands on local midnight for every day across both DST transitions", () => {
    for (const [m, d] of [[3, 28], [3, 29], [3, 30], [10, 24], [10, 25], [10, 26]] as const) {
      expect(localOf(stockholmMidnightToUtc(2026, m, d))).toMatch(/ 00:00:00$/);
    }
  });
});

describe("stockholmDayKey", () => {
  it("buckets a late-evening UTC instant into the next Stockholm day", () => {
    // 22:30Z in July is 00:30 the following day in Stockholm (UTC+2). An SMS
    // sent then must count toward the later day, not the earlier one.
    expect(stockholmDayKey(new Date("2026-07-14T22:30:00Z"))).toBe("2026-07-15");
  });

  it("keeps an early-evening UTC instant on the same Stockholm day", () => {
    expect(stockholmDayKey(new Date("2026-07-14T18:00:00Z"))).toBe("2026-07-14");
  });

  it("handles the winter offset", () => {
    expect(stockholmDayKey(new Date("2026-01-14T23:30:00Z"))).toBe("2026-01-15");
  });
});

describe("buildStockholmDayKeys", () => {
  it("returns the requested number of days, ending on today", () => {
    const now = new Date("2026-07-15T09:00:00Z");
    const keys = buildStockholmDayKeys(30, now);
    expect(keys).toHaveLength(30);
    expect(keys[keys.length - 1]).toBe(stockholmDayKey(now));
  });

  it("produces strictly consecutive days across a DST transition", () => {
    // The UTC-noon anchor exists so day arithmetic never crosses a local DST
    // edge; a regression here would duplicate or skip a day on the axis.
    const keys = buildStockholmDayKeys(5, new Date("2026-03-30T09:00:00Z"));
    expect(keys).toEqual([
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
    ]);
  });

  it("produces consecutive days across the autumn transition", () => {
    const keys = buildStockholmDayKeys(4, new Date("2026-10-26T09:00:00Z"));
    expect(keys).toEqual(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
  });

  it("has no duplicate keys over a long window", () => {
    const keys = buildStockholmDayKeys(365, new Date("2026-07-15T09:00:00Z"));
    expect(new Set(keys).size).toBe(365);
  });
});

describe("windowStartIso", () => {
  it("aligns the window start to Stockholm midnight of the oldest key", () => {
    const keys = buildStockholmDayKeys(30, new Date("2026-07-15T09:00:00Z"));
    expect(windowStartIso(keys)).toBe(stockholmMidnightToUtc(2026, 6, 16).toISOString());
    expect(localOf(new Date(windowStartIso(keys)))).toMatch(/ 00:00:00$/);
  });

  it("stays midnight-aligned when the window spans a DST change", () => {
    const keys = buildStockholmDayKeys(10, new Date("2026-03-30T09:00:00Z"));
    expect(localOf(new Date(windowStartIso(keys)))).toMatch(/ 00:00:00$/);
  });
});
