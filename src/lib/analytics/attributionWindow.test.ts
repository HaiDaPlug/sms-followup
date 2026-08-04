import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_WINDOWS,
  DEFAULT_ATTRIBUTION_DAYS,
  filterByAttributionWindow,
  isWithinAttributionWindow,
  parseAttributionDays,
} from "./attributionWindow";

describe("parseAttributionDays", () => {
  it("accepts each supported window", () => {
    for (const w of ATTRIBUTION_WINDOWS) {
      expect(parseAttributionDays(String(w))).toBe(w);
    }
  });

  it("falls back to the default for unsupported or hostile input", () => {
    // The value reaches this from a query string, so it is untrusted.
    for (const bad of [null, "", "45", "0", "-30", "abc", "90; drop table", "Infinity", "1e3"]) {
      expect(parseAttributionDays(bad)).toBe(DEFAULT_ATTRIBUTION_DAYS);
    }
  });
});

describe("isWithinAttributionWindow", () => {
  it("counts a same-day rebooking", () => {
    // days_since_sms floors to 0 for anything under 24h.
    expect(isWithinAttributionWindow(0, 30)).toBe(true);
  });

  it("is exclusive at the upper bound", () => {
    // Day 29 counts at a 30-day window; day 30 does not.
    expect(isWithinAttributionWindow(29, 30)).toBe(true);
    expect(isWithinAttributionWindow(30, 30)).toBe(false);
    expect(isWithinAttributionWindow(31, 30)).toBe(false);
  });

  it("rejects negative gaps", () => {
    // Should not occur -- the RPC only matches sent_at < effective_at -- but a
    // negative value must never be counted as a conversion if data drifts.
    expect(isWithinAttributionWindow(-1, 30)).toBe(false);
  });

  it("widens correctly across the supported windows", () => {
    expect(isWithinAttributionWindow(45, 30)).toBe(false);
    expect(isWithinAttributionWindow(45, 60)).toBe(true);
    expect(isWithinAttributionWindow(45, 90)).toBe(true);
  });
});

describe("filterByAttributionWindow", () => {
  const rows = [0, 15, 29, 30, 59, 60, 89, 90, 200, 364].map((d, i) => ({
    id: `c${i}`,
    days_since_sms: d,
  }));

  it("narrows to 30 days", () => {
    expect(filterByAttributionWindow(rows, 30).map((r) => r.days_since_sms)).toEqual([0, 15, 29]);
  });

  it("narrows to 60 days", () => {
    expect(filterByAttributionWindow(rows, 60).map((r) => r.days_since_sms)).toEqual([
      0, 15, 29, 30, 59,
    ]);
  });

  it("narrows to 90 days", () => {
    expect(filterByAttributionWindow(rows, 90).map((r) => r.days_since_sms)).toEqual([
      0, 15, 29, 30, 59, 60, 89,
    ]);
  });

  it("is monotonic — a wider window never drops a row a narrower one kept", () => {
    // This is the property that makes the window safe to change retroactively.
    const at30 = new Set(filterByAttributionWindow(rows, 30).map((r) => r.id));
    const at60 = new Set(filterByAttributionWindow(rows, 60).map((r) => r.id));
    const at90 = new Set(filterByAttributionWindow(rows, 90).map((r) => r.id));
    for (const id of at30) expect(at60.has(id)).toBe(true);
    for (const id of at60) expect(at90.has(id)).toBe(true);
  });

  it("preserves the stored rows rather than mutating them", () => {
    // Recording keeps every candidate; the filter is a view over that history.
    const before = rows.length;
    filterByAttributionWindow(rows, 30);
    expect(rows).toHaveLength(before);
  });

  it("returns an empty list without throwing when nothing qualifies", () => {
    expect(filterByAttributionWindow([{ days_since_sms: 300 }], 30)).toEqual([]);
  });
});
