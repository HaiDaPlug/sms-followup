import { describe, expect, it } from "vitest";
import { dueAt, overdueDays, prioritizeQueue, type QueueCandidate } from "./queue";

const STEP = "aaaaaaaa-0000-4000-8000-000000000005";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function candidate(
  patientId: string,
  daysSince: number,
  firstDueDay: number,
  sendDay = firstDueDay
): QueueCandidate {
  return {
    patientId,
    lastBookingAt: daysAgo(daysSince),
    daysSince,
    firstDueDay,
    next: { stepId: STEP, day: sendDay, sequenceNumber: 1 },
  };
}

describe("prioritizeQueue", () => {
  it("puts the patient who has been waiting longest first", () => {
    // Never contacted: 400 days out has been due since day 5 (395 days),
    // 179 days out since day 5 too (174 days). The older one goes first.
    const order = prioritizeQueue([candidate("b", 179, 5, 90), candidate("a", 400, 5, 365)]);
    expect(order.map((c) => c.patientId)).toEqual(["a", "b"]);
  });

  it("ranks by when the patient became due, not by raw days since booking", () => {
    // "far" is 200 days out but already received the 14-day step, so it has only
    // been owed the 90 since day 90 (110 days waiting). "near" is 100 days out
    // and never contacted, waiting since day 5 (95 days). "far" still wins.
    const far = candidate("far", 200, 90, 180);
    const near = candidate("near", 100, 5, 90);
    expect(prioritizeQueue([near, far]).map((c) => c.patientId)).toEqual(["far", "near"]);
  });

  it("does not drop a patient's rank when they cross a later threshold", () => {
    // The same patient one day before and one day after crossing day 365 must
    // keep the same position relative to a fixed peer — the property that makes
    // the ordering monotonic.
    const peer = candidate("peer", 200, 5, 180);
    const before = candidate("mover", 364, 5, 180);
    const after = candidate("mover", 365, 5, 365);

    expect(prioritizeQueue([peer, before]).map((c) => c.patientId)).toEqual(["mover", "peer"]);
    expect(prioritizeQueue([peer, after]).map((c) => c.patientId)).toEqual(["mover", "peer"]);
  });

  it("breaks ties on patient id so repeated runs pick the same batch", () => {
    const order = prioritizeQueue([candidate("c", 100, 5), candidate("a", 100, 5), candidate("b", 100, 5)]);
    expect(order.map((c) => c.patientId)).toEqual(["a", "b", "c"]);
  });

  it("is stable regardless of the input order", () => {
    const input = [candidate("c", 50, 5), candidate("a", 400, 5), candidate("b", 100, 5)];
    const first = prioritizeQueue(input).map((c) => c.patientId);
    const second = prioritizeQueue([...input].reverse()).map((c) => c.patientId);
    expect(first).toEqual(second);
    expect(first).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [candidate("c", 50, 5), candidate("a", 400, 5)];
    const snapshot = input.map((c) => c.patientId);
    prioritizeQueue(input);
    expect(input.map((c) => c.patientId)).toEqual(snapshot);
  });

  it("leaves the overflow for the next run when the cap is applied after sorting", () => {
    const queue = prioritizeQueue([
      candidate("newest", 10, 5),
      candidate("oldest", 400, 5),
      candidate("middle", 100, 5),
    ]);
    expect(queue.slice(0, 2).map((c) => c.patientId)).toEqual(["oldest", "middle"]);
  });

  it("returns an empty list unchanged", () => {
    expect(prioritizeQueue([])).toEqual([]);
  });
});

describe("overdueDays / dueAt", () => {
  it("counts days waited since becoming due", () => {
    expect(overdueDays(candidate("a", 400, 5))).toBe(395);
    expect(overdueDays(candidate("a", 5, 5))).toBe(0);
  });

  it("places dueAt firstDueDay after the last booking", () => {
    const c = candidate("a", 100, 90);
    expect(dueAt(c)).toBe(Date.parse(c.lastBookingAt) + 90 * 86_400_000);
  });
});
