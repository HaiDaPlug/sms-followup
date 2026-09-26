import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRON_HOUR_UTC,
  DAY_MS,
  PRODUCTION_STEPS,
  STEPS_5_10,
  atSimDay,
  createClinic,
  restoreClock,
  setNow,
  type FakeClinic,
  type SimDayRun
} from "@/test/sim";
import type { StoredSmsStep } from "@/types/clinic";

vi.mock("@/lib/data/repository", async () => (await import("@/test/sim/fakeClinic")).repositoryMock);
vi.mock("@/lib/data/readStoreForUi", async () => (await import("@/test/sim/fakeClinic")).readStoreForUiMock);
vi.mock("@/lib/supabase/client", async () => ({ supabase: (await import("@/test/sim/fakeClinic")).supabaseMock }));
vi.mock("@/lib/sms/provider", async () => (await import("@/test/sim/fakeClinic")).providerMock);

/**
 * Backlog scenarios: what max_per_day and the oldest-due-first queue do to the
 * short follow-ups when many overdue patients compete for the same daily slots.
 *
 * Fresh patients are seen at 07:00 UTC, one hour before the 08:00 cron, so the
 * engine's elapsed days and the calendar days since the visit agree and every
 * "day N" below is simply visit day + N. Backlog visits are at the default
 * 11:00, which only matters for which long step they get (elapsed = calendar - 1).
 */

const CAP = 25;

/**
 * The R3 cases below run several full clinics of 100-450 patients each. Alone
 * they take 1-4 s, but under `npm test` with every file in parallel they have
 * been measured at 4.5-5.6 s, past vitest's 5 s default, so without this they
 * fail on the clock rather than on behaviour.
 */
const HEAVY_TIMEOUT_MS = 60_000;

let clinic: FakeClinic;

beforeEach(() => {
  clinic = createClinic();
});

afterEach(() => {
  restoreClock();
});

/** The per-patient rows of one cron run; empty when automation was inactive. */
function batch(run: SimDayRun) {
  return run.result.results ?? [];
}

/** Whole days the engine counts between a visit and the cron on `simDay`. */
function elapsedDaysAtCron(visitAt: string, simDay: number): number {
  return Math.floor((Date.parse(atSimDay(simDay, CRON_HOUR_UTC)) - Date.parse(visitAt)) / DAY_MS);
}

/** getNextSequence for a never-contacted patient: the highest step already crossed. */
function highestCrossedDay(steps: readonly StoredSmsStep[], elapsedDays: number): number | null {
  const crossed = steps.filter((step) => step.day <= elapsedDays).map((step) => step.day);
  return crossed.length ? Math.max(...crossed) : null;
}

/**
 * `n` never-contacted patients whose visits (11:00 UTC) lie `maxAge` down to
 * `minAge` calendar days before sim day 0, oldest inserted first. Deterministic
 * spread, no randomness, so every run builds the same queue.
 */
function seedBacklog(n: number, minAge: number, maxAge: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const age = maxAge - Math.floor((i * (maxAge - minAge + 1)) / n);
    ids.push(clinic.addPatient({ visitDay: -age }));
  }
  return ids;
}

/**
 * One fresh visit per day at 07:00 for `freshDays` days, the cron at 08:00 on
 * each of `totalDays` days. Returns the fresh patients by visit day and every run.
 */
async function runWithDailyFreshVisits(freshDays: number, totalDays: number) {
  const fresh: { id: string; visitDay: number }[] = [];
  const runs: SimDayRun[] = [];
  for (let day = 0; day < totalDays; day++) {
    setNow(atSimDay(day, 7));
    if (day < freshDays) fresh.push({ id: clinic.addPatient({ visitDay: day, visitHourUtc: 7 }), visitDay: day });
    runs.push(...(await clinic.runDays(1)));
  }
  return { fresh, runs };
}

describe("baseline: small backlog", () => {
  it("drains ten overdue patients on the first cron and still sends the fresh patient's 5- and 14-day SMS on time", async () => {
    // Shuffled insertion so the batch order cannot come from the table order.
    const ages = [233, 100, 400, 166, 300, 133, 366, 200, 333, 266];
    const backlog = ages.map((age) => ({ age, id: clinic.addPatient({ visitDay: -age }) }));
    setNow(atSimDay(0, 7));
    const fresh = clinic.addPatient({ name: "Frida Färsk", visitDay: 0, visitHourUtc: 7 });

    const runs = await clinic.runDays(15);
    const table = clinic.formatTimeline();

    // Never-contacted patients are all owed the 5-day step first, so their due
    // date is visit + 5 days and the oldest visit goes first.
    const expectedDayZero = [...backlog]
      .sort((a, b) => b.age - a.age)
      .map(({ id, age }) => [id, highestCrossedDay(PRODUCTION_STEPS, elapsedDaysAtCron(atSimDay(-age, 11), 0))]);
    expect(batch(runs[0]).map((row) => [row.patientId, row.stepDay]), table).toEqual(expectedDayZero);
    // A visit at 11:00 is one elapsed day short at an 08:00 cron: 400 and 366
    // days out get the 365-day step, 200 gets 180 and 100 gets 90.
    expect(expectedDayZero.map(([, step]) => step)).toEqual([365, 365, 180, 180, 180, 180, 180, 90, 90, 90]);
    expect(runs[0].result).toMatchObject({ processed: 10, sent: 10, skipped: 0 });
    expect(clinic.sent.slice(0, 10).map((call) => call.patientId), table).toEqual(expectedDayZero.map(([id]) => id));

    // Nothing is left over for later days: one message each in 15 days.
    for (const { id } of backlog) {
      expect(clinic.sendsFor(id).map((entry) => entry.simDay), table).toEqual([0]);
      expect(await clinic.statusOf(id)).not.toBe("Ready");
    }

    expect(clinic.sendsFor(fresh).map((entry) => [entry.stepDay, entry.simDay]), table).toEqual([
      [5, 5],
      [14, 14]
    ]);
    // Days 1-4 ran and found nobody Ready: the fresh patient was still Waiting.
    expect(runs.slice(1, 5).map((run) => run.result.processed)).toEqual([0, 0, 0, 0]);
    expect(clinic.tables.daily_snapshots.slice(1, 5).map((snapshot) => [snapshot.ready, snapshot.waiting])).toEqual([
      [0, 9],
      [0, 9],
      [0, 9],
      [0, 9]
    ]);
    expect(batch(runs[5]).map((row) => [row.patientId, row.stepDay])).toEqual([[fresh, 5]]);
  });
});

describe("baseline: queue order", () => {
  it("sends oldest-due first, where due = visit + the earliest step still owed, with patient id breaking ties", async () => {
    // A is set up to have received its 90-day SMS long ago.
    const a = clinic.addPatient({ name: "Albin A", visitDay: -91 });
    const [setup] = await clinic.runDays(1);
    expect(batch(setup).map((row) => [row.patientId, row.stepDay])).toEqual([[a, 90]]);

    setNow(atSimDay(90, 7));
    // Inserted out of order on purpose; the queue must not depend on it.
    const c = clinic.addPatient({ name: "Cecilia C", visitDay: 84, visitHourUtc: 12 });
    const tieB = clinic.addPatient({ id: "patient-tie-b", name: "Tove B", visitDay: 70 });
    const b = clinic.addPatient({ name: "Bengt B", visitDay: 84, visitHourUtc: 7 });
    const d = clinic.addPatient({ name: "Dora D", visitDay: -300 });
    const tieA = clinic.addPatient({ id: "patient-tie-a", name: "Tore A", visitDay: 70 });
    const callsBefore = clinic.sent.length;

    const [run] = await clinic.runDays(1);
    const table = clinic.formatTimeline();

    // Due instants (visit + earliest owed step):
    //   D    day -300 11:00 + 5   = day -295 11:00  -> sends 365 (389 elapsed days)
    //   tie  day   70 11:00 + 5   = day   75 11:00  -> sends 14 (19 elapsed), id order a < b
    //   B    day   84 07:00 + 5   = day   89 07:00  -> sends 5
    //   A    day  -91 11:00 + 180 = day   89 11:00  -> sends 180 (90 already sent)
    //   C    day   84 12:00 + 5   = day   89 12:00  -> sends 5
    // A's visit is 175 days older than B's and C's, yet it sits between them.
    expect(run.simDay).toBe(90);
    expect(batch(run).map((row) => [row.patientId, row.stepDay]), table).toEqual([
      [d, 365],
      [tieA, 14],
      [tieB, 14],
      [b, 5],
      [a, 180],
      [c, 5]
    ]);
    expect(clinic.sent.slice(callsBefore).map((call) => call.patientId), table).toEqual([d, tieA, tieB, b, a, c]);
    expect(batch(run).map((row) => row.overdueDays)).toEqual([384, 14, 14, 1, 0, 0]);
  });

  it("builds the same capped batch from identical inputs, and the tie-break ignores insertion order", async () => {
    // 40 patients on four visit instants, ten per instant, so the 25th slot
    // falls inside a tie that only the patient id can resolve.
    const specs = Array.from({ length: 40 }, (_, i) => ({
      id: `patient-bulk-${String(i).padStart(2, "0")}`,
      visitDay: -200 - (i % 4)
    }));
    const expectedBatch = [...specs]
      .sort((x, y) => x.visitDay - y.visitDay || x.id.localeCompare(y.id))
      .slice(0, CAP)
      .map((spec) => spec.id);

    async function dayZeroBatch(order: typeof specs) {
      restoreClock();
      clinic = createClinic();
      for (const spec of order) clinic.addPatient({ id: spec.id, visitDay: spec.visitDay });
      const [run] = await clinic.runDays(1);
      return {
        ids: batch(run).map((row) => row.patientId),
        steps: batch(run).map((row) => row.stepDay),
        calls: clinic.sent.map(({ to, message, at, result }) => ({ to, message, at, result })),
        timeline: clinic.formatTimeline()
      };
    }

    const first = await dayZeroBatch(specs);
    const second = await dayZeroBatch(specs);
    const reversed = await dayZeroBatch([...specs].reverse());

    expect(first.ids, first.timeline).toEqual(expectedBatch);
    // Visits 200-203 days back at 11:00: 199-202 elapsed days, so the 180-day step.
    expect(first.steps).toEqual(Array(CAP).fill(180));
    expect(second).toEqual(first);
    // Reversed insertion gives each id a different phone, so only who and which
    // step can match; they must.
    expect(reversed.ids, reversed.timeline).toEqual(expectedBatch);
    expect(reversed.steps).toEqual(first.steps);
  });
});

describe("baseline: overflow", () => {
  it("carries patients beyond max_per_day to the next crons without skipping or dropping them", async () => {
    // Ages 159 down to 100: all owed the 90-day step, and none reaches 180
    // within the four simulated days, so the step cannot change while waiting.
    const ids = seedBacklog(60, 100, 159);

    const runs = await clinic.runDays(4);
    const table = clinic.formatTimeline(ids.slice(20, 30));

    expect(runs.map((run) => batch(run).map((row) => row.patientId))).toEqual([
      ids.slice(0, 25),
      ids.slice(25, 50),
      ids.slice(50),
      []
    ]);
    // Day 0 evaluated all 60 as Ready but processed only the cap; the other 35
    // got no row at all (no skip, no reservation) and stayed Ready.
    expect(clinic.tables.daily_snapshots[0]).toMatchObject({ ready: 60, sms_sent: 25, sms_skipped: 0 });
    expect(clinic.tables.daily_snapshots[1]).toMatchObject({ ready: 35, sms_sent: 25 });
    expect(clinic.tables.daily_snapshots[2]).toMatchObject({ ready: 10, sms_sent: 10 });
    expect(clinic.tables.daily_snapshots[3]).toMatchObject({ ready: 0, sms_sent: 0 });
    expect(clinic.tables.reminder_logs.every((log) => log.status === "sent")).toBe(true);

    ids.forEach((id, rank) => {
      expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.stepDay]), table).toEqual([
        [Math.floor(rank / CAP), 90]
      ]);
    });
    expect(clinic.sent).toHaveLength(60);
  });
});

describe("known gap R3: a large backlog displaces the short follow-ups", () => {
  // Current: the queue serves the oldest due date first and the engine sends
  // the HIGHEST crossed step. A fresh patient therefore waits behind every
  // older overdue patient, and if the 14-day threshold passes before a slot
  // frees up, the 14-day SMS goes out instead and the 5-day one is gone for the
  // cycle. When they do get the 5-day SMS late, the 14-day one can follow two
  // days later.
  // Desired: a fresh patient's 5-day follow-up is not displaced by an old
  // backlog (the backlog drains without costing new patients a step).

  /**
   * One fresh patient (visit 07:00 on `freshVisitDay`) behind `backlogSize`
   * never-contacted patients 366-400 days out. Those get the 365-day step and
   * are finished, so nobody re-enters the queue and the backlog shrinks by
   * exactly the cap each day: the arithmetic below stays exact.
   */
  async function firstMessageBehindBacklog(
    backlogSize: number,
    steps: readonly StoredSmsStep[],
    freshVisitDay: number
  ) {
    restoreClock();
    clinic = createClinic();
    clinic.configure({ steps });
    seedBacklog(backlogSize, 366, 400);
    if (freshVisitDay >= 0) setNow(atSimDay(freshVisitDay, 7));
    const id = clinic.addPatient({ visitDay: freshVisitDay, visitHourUtc: 7 });
    for (let i = 0; i < 20 && !clinic.firstMessageFor(id); i++) await clinic.runDays(1);
    const first = clinic.firstMessageFor(id);
    expect(first, clinic.formatTimeline([id])).not.toBeNull();
    return { backlog: backlogSize, simDay: first!.simDay, stepDay: first!.stepDay };
  }

  /**
   * Crons run from day 0 and each removes `CAP` backlog patients, so on day d
   * `backlog - CAP*d` are still ahead and the fresh patient fits on the first
   * day that leaves a slot: floor(backlog / CAP), but never before his own
   * 5-day cron. He then gets whatever step is highest by then.
   */
  function expectedFirst(backlog: number, steps: readonly StoredSmsStep[], freshVisitDay: number) {
    const simDay = Math.max(freshVisitDay + 5, Math.floor(backlog / CAP));
    return { backlog, simDay, stepDay: highestCrossedDay(steps, simDay - freshVisitDay) };
  }

  async function boundaryTable(sizes: number[], steps: readonly StoredSmsStep[], freshVisitDay: number) {
    const outcomes = [];
    for (const size of sizes) outcomes.push(await firstMessageBehindBacklog(size, steps, freshVisitDay));
    expect(outcomes).toEqual(sizes.map((size) => expectedFirst(size, steps, freshVisitDay)));
    return {
      outcomes,
      lastOnFive: Math.max(...outcomes.filter((o) => o.stepDay === 5).map((o) => o.backlog)),
      firstSkippingFive: Math.min(...outcomes.filter((o) => o.stepDay !== 5).map((o) => o.backlog))
    };
  }

  it("5/14: with the backlog already due when the 5-day step comes due, 225 = 25 x 9 patients ahead cost the 5-day SMS", async () => {
    // Visit on day -5, so the patient is due at the day-0 cron with the whole
    // backlog ahead. Crons on days 0-8 are the 9 chances before 14 is crossed.
    const { outcomes, lastOnFive, firstSkippingFive } = await boundaryTable(
      [100, 200, 220, 224, 225, 230, 250, 300],
      PRODUCTION_STEPS,
      -5
    );
    expect([lastOnFive, firstSkippingFive]).toEqual([224, 225]);
    expect(outcomes.find((o) => o.backlog === 225)).toEqual({ backlog: 225, simDay: 9, stepDay: 14 });
    expect(outcomes.find((o) => o.backlog === 300)).toEqual({ backlog: 300, simDay: 12, stepDay: 14 });
  }, HEAVY_TIMEOUT_MS);

  it("5/10: the same boundary drops to 125 = 25 x 5 patients", async () => {
    const { lastOnFive, firstSkippingFive, outcomes } = await boundaryTable([100, 124, 125, 150], STEPS_5_10, -5);
    expect([lastOnFive, firstSkippingFive]).toEqual([124, 125]);
    expect(outcomes.find((o) => o.backlog === 125)).toEqual({ backlog: 125, simDay: 5, stepDay: 10 });
  }, HEAVY_TIMEOUT_MS);

  it("5/14: a backlog already there on the visit day drains 5 x 25 before the patient is due, so the boundary is 350 = 25 x 14", async () => {
    // Visit on day 0 with the backlog present from day 0: the crons on days 0-4
    // eat into it before the patient is even Ready, so 14 crons (days 0-13)
    // count, not 9.
    const { lastOnFive, firstSkippingFive, outcomes } = await boundaryTable([225, 300, 349, 350], PRODUCTION_STEPS, 0);
    expect([lastOnFive, firstSkippingFive]).toEqual([349, 350]);
    expect(outcomes.find((o) => o.backlog === 225)).toEqual({ backlog: 225, simDay: 9, stepDay: 5 });
    expect(outcomes.find((o) => o.backlog === 350)).toEqual({ backlog: 350, simDay: 14, stepDay: 14 });
  }, HEAVY_TIMEOUT_MS);

  it("5/10: likewise 250 = 25 x 10 when the backlog is there from the visit day", async () => {
    const { lastOnFive, firstSkippingFive } = await boundaryTable([225, 249, 250], STEPS_5_10, 0);
    expect([lastOnFive, firstSkippingFive]).toEqual([249, 250]);
  }, HEAVY_TIMEOUT_MS);

  it("a 300-patient backlog from day 0 only delays the 5-day SMS: fresh visits on days 0-7 all get it on day 12", async () => {
    // Below the 350 boundary above, so nobody loses a step, but the first eight
    // fresh patients get the 5-day SMS 5-12 days after their visit, bunched
    // with the 14-day one close behind.
    const backlog = seedBacklog(300, 100, 400);
    const { fresh, runs } = await runWithDailyFreshVisits(20, 25);
    const table = clinic.formatTimeline(fresh.map((f) => f.id));

    // 300 / 25 = 12 capped crons; day 12 is the first with a free slot. Backlog
    // patients who got the 90- or 180-day step and then cross 180 or 365 keep
    // re-entering ahead of the fresh ones (the 14 backlog rows on day 12).
    const clearedDay = runs.findIndex((run) => run.result.processed < CAP);
    expect(clearedDay).toBe(12);
    expect(batch(runs[12]).filter((row) => backlog.includes(row.patientId))).toHaveLength(14);

    const firsts = fresh.map((f) => ({ ...f, first: clinic.firstMessageFor(f.id) }));
    expect(firsts.every((f) => f.first?.stepDay === 5), table).toBe(true);
    for (const f of firsts) {
      const expectedDay = Math.max(f.visitDay + 5, clearedDay);
      expect([f.visitDay, f.first?.simDay], table).toEqual([f.visitDay, expectedDay]);
    }
    // Visit day 0: 5-day SMS on day 12, 14-day SMS on day 14.
    expect(clinic.sendsFor(fresh[0].id).map((entry) => [entry.stepDay, entry.simDay]), table).toEqual([
      [5, 12],
      [14, 14]
    ]);
  }, HEAVY_TIMEOUT_MS);

  it("450 never-contacted patients over 100-400 days plus a daily fresh visit: the first five fresh patients never get the 5-day SMS", async () => {
    // 450 rather than the 300 first proposed: 300 is below the 350 boundary for
    // a backlog present from day 0 (see above), so it only delays. 450 stays
    // above it with margin and still runs in about 2 s.
    const backlog = seedBacklog(450, 100, 400);
    const { fresh, runs } = await runWithDailyFreshVisits(30, 45);
    const table = clinic.formatTimeline(fresh.map((f) => f.id));

    // All 450 have had a first message by day 17, but the crons stay full until
    // day 20: backlog patients who got the 90- or 180-day step and have since
    // crossed 180 or 365 re-enter with a due date (visit + 180/365, around the
    // day they crossed) ahead of most fresh visits. They piled up while the cap
    // was full and share days 18-19 with the fresh patients, then keep taking
    // 2-3 slots a day.
    const clearedDay = runs.findIndex((run) => run.result.processed < CAP);
    expect(clearedDay).toBe(20);
    expect(runs.slice(0, clearedDay).every((run) => run.result.processed === CAP)).toBe(true);
    const lastBacklogFirstContact = Math.max(...backlog.map((id) => clinic.firstMessageFor(id)!.simDay));
    expect(lastBacklogFirstContact).toBe(17);
    const backlogIds = new Set(backlog);
    const backlogRowsPerDay = runs.map((run) => batch(run).filter((row) => backlogIds.has(row.patientId)).length);
    expect(backlogRowsPerDay.slice(16, 22)).toEqual([25, 25, 16, 18, 3, 3]);

    const firsts = fresh.map((f) => ({ ...f, first: clinic.firstMessageFor(f.id)! }));
    // Rule check for every fresh patient: the first step is the highest one
    // crossed on the day they were finally served.
    for (const f of firsts) {
      expect([f.visitDay, f.first.stepDay], table).toEqual([
        f.visitDay,
        highestCrossedDay(PRODUCTION_STEPS, f.first.simDay - f.visitDay)
      ]);
    }
    // No fresh patient got anything while more than a full batch of backlog
    // was still ahead of them.
    expect(Math.min(...firsts.map((f) => f.first.simDay))).toBe(18);

    const missedFive = firsts.filter((f) => !clinic.sendsFor(f.id).some((entry) => entry.stepDay === 5));
    const lateFive = firsts.filter((f) => f.first.stepDay === 5 && f.first.simDay > f.visitDay + 5);
    const onTimeFive = firsts.filter((f) => f.first.stepDay === 5 && f.first.simDay === f.visitDay + 5);
    const missedFourteen = firsts.filter((f) => !clinic.sendsFor(f.id).some((entry) => entry.stepDay === 14));

    expect(missedFive.map((f) => f.visitDay), table).toEqual([0, 1, 2, 3, 4]);
    expect(missedFive.every((f) => f.first.stepDay === 14 && f.first.simDay === 18), table).toBe(true);
    expect(lateFive.map((f) => f.visitDay), table).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(lateFive.map((f) => f.first.simDay), table).toEqual([18, 18, 18, 18, 19, 19, 19, 19, 19]);
    expect(onTimeFive.map((f) => f.visitDay), table).toEqual([...Array(16).keys()].map((i) => i + 14));
    expect(missedFourteen, table).toEqual([]);
    // Once served, the 14-day SMS follows on schedule for everyone who had not
    // already been handed it as their first message.
    for (const f of [...lateFive, ...onTimeFive]) {
      expect(clinic.sendsFor(f.id).map((entry) => [entry.stepDay, entry.simDay]), table).toEqual([
        [5, f.first.simDay],
        [14, f.visitDay + 14]
      ]);
    }
  }, HEAVY_TIMEOUT_MS);

  it.todo("desired: a fresh patient still gets the 5-day follow-up while an old backlog is draining");
  it.todo("desired: a patient served after the 14-day threshold is not silently denied the 5-day step without a trace");
});
