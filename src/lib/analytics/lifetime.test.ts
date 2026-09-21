import { describe, expect, it } from "vitest";
import {
  calculateLifetimeStats,
  type LifetimeBooking,
  type LifetimeLog,
  type LifetimeStep
} from "./lifetime";

const STEP_90 = "aaaaaaaa-0000-4000-8000-000000000090";
const STEP_180 = "aaaaaaaa-0000-4000-8000-000000000180";

const STEPS: LifetimeStep[] = [
  { id: STEP_90, day: 90, active: true },
  { id: STEP_180, day: 180, active: true }
];

let seq = 0;
function log(overrides: Partial<LifetimeLog> = {}): LifetimeLog {
  return {
    id: `log-${seq++}`,
    patient_id: "p1",
    sent_at: "2026-01-01T00:00:00.000Z",
    step_id: STEP_90,
    step_day: 90,
    sequence_number: 1,
    ...overrides
  };
}

function booking(overrides: Partial<LifetimeBooking> = {}): LifetimeBooking {
  return {
    id: `booking-${seq++}`,
    patient_id: "p1",
    recorded_at: "2026-01-11T00:00:00.000Z",
    booking_at: "2026-02-01T00:00:00.000Z",
    cancelled: false,
    ...overrides
  };
}

describe("crediting", () => {
  it("credits a booking that follows an SMS", () => {
    const stats = calculateLifetimeStats([log()], [booking()], STEPS, 90);
    expect(stats.patientsContacted).toBe(1);
    expect(stats.patientsRebooked).toBe(1);
    expect(stats.eventualRate).toBe(1);
  });

  it("does not credit a booking made before the SMS", () => {
    const stats = calculateLifetimeStats(
      [log({ sent_at: "2026-03-01T00:00:00.000Z" })],
      [booking({ recorded_at: "2026-01-01T00:00:00.000Z", booking_at: "2026-01-05T00:00:00.000Z" })],
      STEPS,
      90
    );
    expect(stats.patientsRebooked).toBe(0);
    expect(stats.eventualRate).toBe(0);
  });

  it("does not credit a historical appointment imported after the SMS", () => {
    // A CSV import recorded today for a visit that happened years ago: the
    // appointment date is the upper bound on when it was booked.
    const stats = calculateLifetimeStats(
      [log({ sent_at: "2026-01-01T00:00:00.000Z" })],
      [booking({ recorded_at: "2026-05-07T00:00:00.000Z", booking_at: "2022-11-10T00:00:00.000Z" })],
      STEPS,
      90
    );
    expect(stats.patientsRebooked).toBe(0);
  });

  it("uses the appointment date when the import timestamp is later", () => {
    // Booked 10 days after the SMS, imported months later. Using the import
    // time would inflate days-to-rebooking to the wrong bucket.
    const stats = calculateLifetimeStats(
      [log({ sent_at: "2026-01-01T00:00:00.000Z" })],
      [booking({ recorded_at: "2026-06-01T00:00:00.000Z", booking_at: "2026-01-11T00:00:00.000Z" })],
      STEPS,
      90
    );
    expect(stats.distribution.find((d) => d.label === "8–30 dagar")?.count).toBe(1);
  });

  it("counts one rebooking when a patient returns repeatedly with no new SMS", () => {
    // The reported over-crediting case: SMS, then three visits. Only the first
    // ends the follow-up cycle; the rest were not prompted by us.
    const stats = calculateLifetimeStats(
      [log({ sent_at: "2026-01-01T00:00:00.000Z" })],
      [
        booking({ recorded_at: "2026-01-10T00:00:00.000Z", booking_at: "2026-01-20T00:00:00.000Z" }),
        booking({ recorded_at: "2026-02-10T00:00:00.000Z", booking_at: "2026-02-20T00:00:00.000Z" }),
        booking({ recorded_at: "2026-03-10T00:00:00.000Z", booking_at: "2026-03-20T00:00:00.000Z" })
      ],
      STEPS,
      90
    );
    expect(stats.patientsRebooked).toBe(1);
    expect(stats.distribution.reduce((n, d) => n + d.count, 0)).toBe(1);
  });

  it("credits each cycle separately when a new SMS follows a booking", () => {
    const stats = calculateLifetimeStats(
      [
        log({ sent_at: "2026-01-01T00:00:00.000Z" }),
        log({ sent_at: "2026-03-01T00:00:00.000Z" })
      ],
      [
        booking({ recorded_at: "2026-01-10T00:00:00.000Z", booking_at: "2026-01-20T00:00:00.000Z" }),
        booking({ recorded_at: "2026-03-10T00:00:00.000Z", booking_at: "2026-03-20T00:00:00.000Z" })
      ],
      STEPS,
      90
    );
    expect(stats.distribution.reduce((n, d) => n + d.count, 0)).toBe(2);
    // Still one patient, however many cycles they went through.
    expect(stats.patientsRebooked).toBe(1);
  });

  it("credits the most recent follow-up when several precede the booking", () => {
    const stats = calculateLifetimeStats(
      [
        log({ sent_at: "2026-01-01T00:00:00.000Z", step_id: STEP_90, step_day: 90 }),
        log({ sent_at: "2026-02-01T00:00:00.000Z", step_id: STEP_180, step_day: 180 })
      ],
      [booking({ recorded_at: "2026-02-10T00:00:00.000Z", booking_at: "2026-03-01T00:00:00.000Z" })],
      STEPS,
      90
    );
    const ninety = stats.perStep.find((s) => s.key === STEP_90)!;
    const oneEighty = stats.perStep.find((s) => s.key === STEP_180)!;
    expect(oneEighty.rebookings).toBe(1);
    expect(ninety.rebookings).toBe(0);
  });

  it("ignores cancelled bookings entirely — they neither credit nor close a cycle", () => {
    const stats = calculateLifetimeStats(
      [log({ sent_at: "2026-01-01T00:00:00.000Z" })],
      [
        booking({ recorded_at: "2026-01-05T00:00:00.000Z", booking_at: "2026-01-15T00:00:00.000Z", cancelled: true }),
        booking({ recorded_at: "2026-01-20T00:00:00.000Z", booking_at: "2026-02-01T00:00:00.000Z" })
      ],
      STEPS,
      90
    );
    expect(stats.patientsRebooked).toBe(1);
    expect(stats.distribution.find((d) => d.label === "8–30 dagar")?.count).toBe(1);
  });

  it("does not credit an SMS sent at the same instant as the booking", () => {
    const stats = calculateLifetimeStats(
      [log({ sent_at: "2026-01-10T00:00:00.000Z" })],
      [booking({ recorded_at: "2026-01-10T00:00:00.000Z", booking_at: "2026-02-01T00:00:00.000Z" })],
      STEPS,
      90
    );
    expect(stats.patientsRebooked).toBe(0);
  });

  it("ignores bookings for patients who were never contacted", () => {
    const stats = calculateLifetimeStats(
      [log({ patient_id: "p1" })],
      [booking({ patient_id: "p2" })],
      STEPS,
      90
    );
    expect(stats.patientsRebooked).toBe(0);
    expect(stats.patientsContacted).toBe(1);
  });
});

describe("attribution", () => {
  it("keeps attributed a subset of eventual", () => {
    const stats = calculateLifetimeStats(
      [
        log({ patient_id: "near", sent_at: "2026-01-01T00:00:00.000Z" }),
        log({ patient_id: "far", sent_at: "2026-01-01T00:00:00.000Z" })
      ],
      [
        booking({ patient_id: "near", recorded_at: "2026-01-20T00:00:00.000Z", booking_at: "2026-02-01T00:00:00.000Z" }),
        booking({ patient_id: "far", recorded_at: "2026-06-01T00:00:00.000Z", booking_at: "2026-07-01T00:00:00.000Z" })
      ],
      STEPS,
      90
    );
    expect(stats.patientsRebooked).toBe(2);
    expect(stats.attributedPatients).toBe(1);
    expect(stats.attributedBookings).toBe(1);
    expect(stats.eventualRate).toBe(1);
    expect(stats.attributedRate).toBe(0.5);
  });

  it("applies the window that was asked for", () => {
    const logs = [log({ sent_at: "2026-01-01T00:00:00.000Z" })];
    const bookings = [booking({ recorded_at: "2026-02-15T00:00:00.000Z", booking_at: "2026-03-01T00:00:00.000Z" })];
    expect(calculateLifetimeStats(logs, bookings, STEPS, 30).attributedBookings).toBe(0);
    expect(calculateLifetimeStats(logs, bookings, STEPS, 90).attributedBookings).toBe(1);
  });
});

describe("distribution buckets", () => {
  // One hour past the day boundary, so a "0 day" gap is a same-day rebooking
  // rather than the same instant as the send (which credits nothing).
  function daysLater(days: number) {
    return new Date(Date.parse("2026-01-01T01:00:00.000Z") + days * 86_400_000).toISOString();
  }

  it("places each boundary in the expected bucket", () => {
    const cases: [number, string][] = [
      [0, "0–7 dagar"],
      [7, "0–7 dagar"],
      [8, "8–30 dagar"],
      [30, "8–30 dagar"],
      [31, "31–60 dagar"],
      [60, "31–60 dagar"],
      [61, "61–90 dagar"],
      [90, "61–90 dagar"],
      [91, "90+ dagar"]
    ];
    for (const [days, label] of cases) {
      const stats = calculateLifetimeStats(
        [log({ patient_id: `p${days}`, sent_at: "2026-01-01T00:00:00.000Z" })],
        [booking({ patient_id: `p${days}`, recorded_at: daysLater(days), booking_at: daysLater(days + 30) })],
        STEPS,
        365
      );
      expect(stats.distribution.find((d) => d.count === 1)?.label, `${days} days`).toBe(label);
    }
  });
});

describe("per-follow-up performance", () => {
  it("lists a configured step that has never been sent", () => {
    const stats = calculateLifetimeStats([], [], STEPS, 90);
    expect(stats.perStep.map((s) => s.label)).toEqual(["90 dagar", "180 dagar"]);
    expect(stats.perStep[0].smsSent).toBe(0);
    expect(stats.perStep[0].eventualRate).toBeNull();
  });

  it("marks a step that no longer exists as removed, using its snapshot day", () => {
    const stats = calculateLifetimeStats(
      [log({ step_id: "gone", step_day: 270 })],
      [],
      STEPS,
      90
    );
    expect(stats.perStep.find((s) => s.key === "gone")?.label).toBe("270 dagar (borttagen)");
  });

  it("notes when a step's trigger day was changed after messages went out", () => {
    const stats = calculateLifetimeStats(
      [log({ step_id: STEP_90, step_day: 60 })],
      [],
      [{ id: STEP_90, day: 90, active: true }],
      90
    );
    expect(stats.perStep[0].label).toBe("90 dagar (tidigare 60)");
  });

  it("buckets a log with no step identity at all as unknown", () => {
    const stats = calculateLifetimeStats(
      [log({ step_id: null, step_day: null, sequence_number: null })],
      [],
      [],
      90
    );
    expect(stats.perStep[0].label).toBe("Okänt steg");
  });

  it("reports the median days to rebooking", () => {
    const stats = calculateLifetimeStats(
      [
        log({ patient_id: "a", sent_at: "2026-01-01T00:00:00.000Z" }),
        log({ patient_id: "b", sent_at: "2026-01-01T00:00:00.000Z" }),
        log({ patient_id: "c", sent_at: "2026-01-01T00:00:00.000Z" }),
        log({ patient_id: "d", sent_at: "2026-01-01T00:00:00.000Z" })
      ],
      [
        booking({ patient_id: "a", recorded_at: "2026-01-03T00:00:00.000Z", booking_at: "2026-02-01T00:00:00.000Z" }),
        booking({ patient_id: "b", recorded_at: "2026-01-05T00:00:00.000Z", booking_at: "2026-02-01T00:00:00.000Z" }),
        booking({ patient_id: "c", recorded_at: "2026-01-11T00:00:00.000Z", booking_at: "2026-02-01T00:00:00.000Z" }),
        booking({ patient_id: "d", recorded_at: "2026-01-21T00:00:00.000Z", booking_at: "2026-02-01T00:00:00.000Z" })
      ],
      STEPS,
      365
    );
    // Gaps of 2, 4, 10 and 20 days — the even-count median is 7.
    expect(stats.perStep.find((s) => s.key === STEP_90)?.medianDays).toBe(7);
  });

  it("carries the active flag through so a paused follow-up can be labelled", () => {
    const stats = calculateLifetimeStats([], [], [{ id: STEP_90, day: 90, active: false }], 90);
    expect(stats.perStep[0].active).toBe(false);
    expect(stats.perStep[0].exists).toBe(true);
  });
});

describe("empty state", () => {
  it("returns null rates rather than zeros when nobody was contacted", () => {
    const stats = calculateLifetimeStats([], [], STEPS, 90);
    expect(stats.smsSent).toBe(0);
    expect(stats.patientsContacted).toBe(0);
    expect(stats.eventualRate).toBeNull();
    expect(stats.attributedRate).toBeNull();
    expect(stats.firstSmsAt).toBeNull();
  });

  it("reports the earliest send date", () => {
    const stats = calculateLifetimeStats(
      [
        log({ sent_at: "2026-05-08T00:00:00.000Z" }),
        log({ sent_at: "2026-01-02T00:00:00.000Z" })
      ],
      [],
      STEPS,
      90
    );
    expect(stats.firstSmsAt).toBe("2026-01-02T00:00:00.000Z");
  });
});
