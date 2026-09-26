import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STEPS_5_10,
  ScheduleSmsRejected,
  activeResult,
  atSimDay,
  createClinic,
  restoreClock,
  setNow,
  simDayOf,
  stepId,
  supabaseMock,
  type FakeClinic
} from "@/test/sim";

vi.mock("@/lib/data/repository", async () => (await import("@/test/sim/fakeClinic")).repositoryMock);
vi.mock("@/lib/data/readStoreForUi", async () => (await import("@/test/sim/fakeClinic")).readStoreForUiMock);
vi.mock("@/lib/supabase/client", async () => ({ supabase: (await import("@/test/sim/fakeClinic")).supabaseMock }));
vi.mock("@/lib/sms/provider", async () => (await import("@/test/sim/fakeClinic")).providerMock);

let clinic: FakeClinic;

beforeEach(() => {
  clinic = createClinic();
});

afterEach(() => {
  restoreClock();
});

/**
 * One patient seen at 07:00 UTC on day 0 and recorded right after the visit.
 * With the cron at 08:00 every run sits exactly N days + 1 hour after the
 * visit, so the engine's floored day count is the sim day and a step with
 * trigger day N is first due on sim day N.
 */
function patientSeenAtSeven(name = "Anna Andersson"): string {
  setNow(atSimDay(0, 7));
  return clinic.addPatient({ name, visitDay: 0, visitHourUtc: 7 });
}

/** The daily snapshot(s) the cron wrote on a sim day. */
function snapshotsOn(day: number) {
  return clinic.tables.daily_snapshots.filter((row) => simDayOf(row.snapped_at) === day);
}

describe("known gap R5: dry run consumes the step", () => {
  // Current: a dry_run log counts as "sent" in cycleProgress, so the step it
  // rehearsed is used up. Switching dry run off does not give it back: the
  // patient silently skips the 5-day SMS and first hears from the clinic on the
  // next step's day. Desired: a rehearsal should not consume a real follow-up
  // (dry_run logs ignored by cycleProgress once dry run is off, or cleared when
  // the setting flips), so the owed 5-day SMS goes out on the next cron.
  it.each([
    { label: "5/14/90/180/365 (production)", steps: undefined, secondDay: 14 },
    { label: "5/10/90/180/365", steps: STEPS_5_10, secondDay: 10 }
  ])("$label: the 5-day step is rehearsed on day 5, then never sent for real", async ({ steps, secondDay }) => {
    clinic.configure({ dryRun: true, ...(steps ? { steps } : {}) });
    const id = patientSeenAtSeven();

    const dryDays = await clinic.runDays(7); // days 0..6
    expect(dryDays.map((run) => run.simDay)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(activeResult(dryDays[5])).toMatchObject({ processed: 1, dry_run: 1, sent: 0 });
    expect(clinic.sent, clinic.formatTimeline()).toHaveLength(0);

    clinic.configure({ dryRun: false });
    // Day 6 is past the 5-day threshold and before the second one, yet the
    // step is already consumed, so nothing is owed.
    expect(await clinic.statusOf(id)).toBe("Waiting");

    const liveDays = await clinic.runDays(secondDay + 3 - 7); // days 7..secondDay+2
    expect(liveDays[0].simDay).toBe(7);
    expect(liveDays.at(-1)?.simDay).toBe(secondDay + 2);

    // Days 7 .. secondDay-1: the cron ran with dry run off and processed nobody.
    const quietDays = liveDays.filter((run) => run.simDay < secondDay);
    expect(quietDays).toHaveLength(secondDay - 7);
    expect(quietDays.every((run) => activeResult(run).processed === 0)).toBe(true);
    expect(quietDays.every((run) => snapshotsOn(run.simDay)[0]?.dry_run_mode === false)).toBe(true);
    expect(quietDays.every((run) => snapshotsOn(run.simDay)[0]?.waiting === 1)).toBe(true);

    const calls = clinic.providerCallsFor(id);
    expect(calls.map((call) => call.simDay), clinic.formatTimeline()).toEqual([secondDay]);
    expect(calls[0].message.startsWith("Hej Anna,\nuppföljning ger ofta bättre")).toBe(true);
    expect(clinic.sent).toHaveLength(1);

    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.status, entry.stepDay, entry.stepId])).toEqual([
      [5, "dry_run", 5, stepId(5)],
      [secondDay, "sent", secondDay, clinic.stepId(secondDay)]
    ]);
  });

  it("a scheduled SMS fired during dry run consumes its step the same way", async () => {
    clinic.configure({ dryRun: true });
    const id = patientSeenAtSeven();
    const scheduled = await clinic.scheduleSms({ patientId: id, stepDay: 5, day: 2, hourUtc: 9 });

    const ticks = await clinic.runWorkerTicksUntil(atSimDay(2, 10));
    expect(ticks.map((tick) => [tick.at, tick.result.dry_run])).toEqual([[atSimDay(2, 9), 1]]);
    expect(clinic.scheduledFor(id)).toMatchObject([{ id: scheduled.id, status: "dry_run" }]);

    clinic.configure({ dryRun: false });
    await clinic.runDays(13); // days 3..15

    expect(clinic.providerCallsFor(id).map((call) => call.simDay), clinic.formatTimeline()).toEqual([14]);
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.status, entry.stepDay])).toEqual([
      [2, "dry_run", 5],
      [14, "sent", 14]
    ]);
  });

  it.todo("desired: switching dry run off sends the rehearsed 5-day SMS for real on the next cron (day 7), before the 14-day one");
});

describe("dry run remedy: deleting the rehearsal logs", () => {
  it("frees the 5-day step, which then goes out for real on the next cron", async () => {
    clinic.configure({ dryRun: true });
    const id = patientSeenAtSeven();
    await clinic.runDays(7); // days 0..6
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.status, entry.stepDay])).toEqual([[5, "dry_run", 5]]);

    // What an operator would do in SQL: delete from reminder_logs where status = 'dry_run'.
    const removed = clinic.deleteRows("reminder_logs", (row) => row.patient_id === id && row.status === "dry_run");
    expect(removed).toHaveLength(1);
    clinic.configure({ dryRun: false });
    expect(await clinic.statusOf(id)).toBe("Ready");

    const runs = await clinic.runDays(9); // days 7..15

    // Day 7: elapsed 7 days crosses only the 5-day threshold, so the highest
    // crossed step is the 5-day one. The 14-day step follows on its own day.
    expect(activeResult(runs[0])).toMatchObject({ processed: 1, sent: 1 });
    const calls = clinic.providerCallsFor(id);
    expect(calls.map((call) => call.simDay), clinic.formatTimeline()).toEqual([7, 14]);
    expect(calls[0].message.startsWith("Hej Anna,\nför att uppnå ett hållbart resultat")).toBe(true);
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.status, entry.stepDay])).toEqual([
      [7, "sent", 5],
      [14, "sent", 14]
    ]);
  });
});

describe("scheduled SMS ahead of the cadence", () => {
  it("the 14-day step scheduled for day 3 goes out then; the 5-day step is never sent and the next automatic SMS is the 90-day one", async () => {
    const id = patientSeenAtSeven();
    const scheduled = await clinic.scheduleSms({ patientId: id, stepDay: 14, day: 3, hourUtc: 10 });
    expect(scheduled).toMatchObject({ status: "pending", step_id: stepId(14), sequence_override: 2 });

    const beforeDue = await clinic.runDays(4); // crons on days 0..3 at 08:00, row due 10:00 on day 3
    expect(beforeDue.every((run) => activeResult(run).processed === 0)).toBe(true);
    expect(clinic.scheduledFor(id)[0].status).toBe("pending");

    const ticks = await clinic.runWorkerTicksUntil(atSimDay(3, 12));
    // pg_cron fires the worker on the first tick at or after scheduled_for.
    expect(ticks.map((tick) => [tick.at, tick.result.sent])).toEqual([[atSimDay(3, 10), 1]]);
    expect(clinic.scheduledFor(id)[0]).toMatchObject({ status: "sent", attempt_count: 1 });
    expect(clinic.providerCallsFor(id).map((call) => call.message)).toEqual([scheduled.message_override]);

    // Day 5: elapsed 5 days crosses the 5-day threshold, but the 5-day step is
    // behind the 14-day one already sent in this cycle, so it is never a candidate.
    const days4to5 = await clinic.runDays(2);
    expect(days4to5.map((run) => run.simDay)).toEqual([4, 5]);
    expect(activeResult(days4to5[1]).processed).toBe(0);
    expect(await clinic.statusOf(id)).toBe("Waiting");

    const rest = await clinic.runDays(85); // days 6..90
    expect(rest.at(-1)?.simDay).toBe(90);

    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.status, entry.stepDay, entry.stepId]), clinic.formatTimeline()).toEqual([
      [3, "sent", 14, stepId(14)],
      [90, "sent", 90, stepId(90)]
    ]);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([3, 90]);
    // Nothing else was logged: a Waiting patient never reaches sendReminderToPatient.
    expect(clinic.timeline(id)).toHaveLength(2);
  });

  it("a pending scheduled row keeps a Ready patient out of the daily cron until the worker sends it", async () => {
    const id = patientSeenAtSeven();
    await clinic.scheduleSms({ patientId: id, stepDay: 14, day: 7, hourUtc: 8 });

    const runs = await clinic.runDays(8, { scheduledWorker: true }); // days 0..7, worker after each cron

    // Days 5..7 the patient is Ready (the cohort snapshot counts them), yet the
    // cron evaluates nobody because the pending row excludes them.
    for (const day of [5, 6, 7]) {
      expect(activeResult(runs[day]).processed, `day ${day}\n${clinic.formatTimeline()}`).toBe(0);
      expect(snapshotsOn(day)[0]).toMatchObject({ ready: 1, sms_sent: 0 });
    }
    expect(runs[7].scheduled).toMatchObject({ processed: 1, sent: 1 });

    await clinic.runDays(10); // days 8..17
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.stepDay]), clinic.formatTimeline()).toEqual([[7, 14]]);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([7]);
    expect(await clinic.statusOf(id)).toBe("Waiting");
  });
});

describe("scheduled SMS behind the cadence", () => {
  it("the route refuses step 5 once 14 is sent, and a step-5 row created earlier is skipped as out_of_order by the worker", async () => {
    const id = patientSeenAtSeven();
    // Both rows are in order when created: nothing has been sent yet.
    await clinic.scheduleSms({ patientId: id, stepDay: 14, day: 3, hourUtc: 10 });
    const behind = await clinic.scheduleSms({ patientId: id, stepDay: 5, day: 4, hourUtc: 10 });
    expect(behind).toMatchObject({ status: "pending", step_id: stepId(5), sequence_override: 1 });

    const ticks = await clinic.runWorkerTicksUntil(atSimDay(4, 11));
    expect(ticks.map((tick) => [tick.at, tick.result.sent, tick.result.skipped])).toEqual([
      [atSimDay(3, 10), 1, 0],
      [atSimDay(4, 10), 0, 1]
    ]);

    const orderError = "5-dagars uppföljningen kan inte skickas — 14-dagars uppföljningen har redan skickats i den här cykeln";
    expect(clinic.scheduledFor(id).map((row) => [row.step_id, row.status, row.error])).toEqual([
      [stepId(14), "sent", null],
      [stepId(5), "skipped", orderError]
    ]);
    expect(clinic.timeline(id).map((entry) => [entry.simDay, entry.status, entry.stepDay, entry.skipReason, entry.error])).toEqual([
      [3, "sent", 14, null, null],
      [4, "skipped", 5, "out_of_order", orderError]
    ]);
    // The skipped row is linked to its log, and the provider only ever saw the 14-day SMS.
    expect(clinic.scheduledFor(id)[1].reminder_log_id).toBe(clinic.timeline(id)[1].logId);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay), clinic.formatTimeline()).toEqual([3]);

    // POST /api/scheduled-sms runs the same order check up front.
    const attempt = clinic.scheduleSms({ patientId: id, stepDay: 5, day: 6 });
    await expect(attempt).rejects.toBeInstanceOf(ScheduleSmsRejected);
    await expect(attempt).rejects.toMatchObject({ status: 409, message: `scheduleSms rejected (409): ${orderError}` });
    expect(clinic.scheduledFor(id)).toHaveLength(2);
  });
});

describe("delivery uncertainty on the 5-day send", () => {
  it("logs unknown, opens a delivery_unknown item and hard-blocks the patient until resolved, then the sequence continues", async () => {
    const id = patientSeenAtSeven();
    clinic.provider.queue({ success: false, uncertain: true, error: "timeout" });

    const runs = await clinic.runDays(16); // days 0..15
    expect(activeResult(runs[5])).toMatchObject({ processed: 1, sent: 0, failed: 0 });
    expect(activeResult(runs[5]).results[0]).toMatchObject({ status: "unknown", error: "timeout", stepDay: 5 });

    const [log] = clinic.logsFor(id);
    expect(log).toMatchObject({ status: "unknown", step_day: 5, error: "timeout", sent_at: null });
    const [review] = clinic.tables.review_items;
    expect(review).toMatchObject({
      type: "delivery_unknown",
      status: "open",
      title: "Okänd SMS-leverans — Anna Andersson",
      description: "timeout",
      content_hash: `delivery_unknown:${log.id}`,
      raw_data: { reminder_log_id: log.id, patient_id: id, phone: "46700000001", step_day: 5 }
    });

    // Day 14 and 15: the 14-day step is due, but "Delivery pending" keeps the
    // patient out of the queue. The snapshot shows the cron saw them.
    for (const day of [14, 15]) {
      expect(activeResult(runs[day]).processed, clinic.formatTimeline()).toBe(0);
      expect(snapshotsOn(day)[0]).toMatchObject({ ready: 0, needs_review: 1 });
    }
    expect(clinic.providerCallsFor(id).map((call) => call.simDay), clinic.formatTimeline()).toEqual([5]);
    expect(await clinic.statusOf(id)).toBe("Delivery pending");

    // The operator confirms it arrived: resolve_delivery_unknown (013) sets the
    // log to sent and resolves the item in one transaction.
    setNow(atSimDay(15, 12));
    expect(clinic.resolveDeliveryUnknown(review.id, log.id, "sent")).toMatchObject({
      id: log.id,
      status: "sent",
      sent_at: atSimDay(15, 12),
      error: "timeout"
    });
    expect(clinic.tables.review_items).toMatchObject([{ id: review.id, status: "resolved", updated_at: atSimDay(15, 12) }]);
    expect(await clinic.statusOf(id)).toBe("Ready");

    const after = await clinic.runDays(1); // day 16
    expect(after[0].simDay).toBe(16);
    expect(activeResult(after[0])).toMatchObject({ processed: 1, sent: 1 });
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.status, entry.stepDay])).toEqual([
      [5, "sent", 5],
      [16, "sent", 14]
    ]);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay), clinic.formatTimeline()).toEqual([5, 16]);
  });

  // "Did not arrive" turns the log into failed, which holds no step slot, so
  // the step is owed again. What goes out next is still the highest crossed
  // step: resolved before day 14 the 5-day SMS is retried; resolved after it
  // the 5-day SMS is dropped in favour of the 14-day one.
  it.each([
    {
      resolvedOn: 6,
      expected: [
        [5, "failed", 5],
        [7, "sent", 5],
        [14, "sent", 14]
      ]
    },
    {
      resolvedOn: 15,
      expected: [
        [5, "failed", 5],
        [16, "sent", 14]
      ]
    }
  ])("resolved as not delivered on day $resolvedOn: the next cron sends the highest crossed step", async ({ resolvedOn, expected }) => {
    const id = patientSeenAtSeven();
    clinic.provider.queue({ success: false, uncertain: true, error: "timeout" });
    await clinic.runDays(resolvedOn + 1); // days 0..resolvedOn

    const [log] = clinic.logsFor(id);
    const [review] = clinic.tables.review_items;
    expect(await clinic.statusOf(id)).toBe("Delivery pending");

    setNow(atSimDay(resolvedOn, 12));
    expect(clinic.resolveDeliveryUnknown(review.id, log.id, "failed")).toMatchObject({ status: "failed", sent_at: null });
    expect(clinic.tables.review_items[0].status).toBe("resolved");
    expect(await clinic.statusOf(id)).toBe("Ready");

    await clinic.runDays(16 - resolvedOn); // through day 16
    expect(clinic.timeline(id).map((entry) => [entry.simDay, entry.status, entry.stepDay]), clinic.formatTimeline()).toEqual(expected);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual(expected.map(([day]) => day));
  });

  it("resolve_delivery_unknown refuses a mismatched, mistyped or already settled request and writes nothing", async () => {
    const id = patientSeenAtSeven();
    clinic.provider.queue({ success: false, uncertain: true, error: "timeout" });
    await clinic.runDays(6); // days 0..5
    const [log] = clinic.logsFor(id);
    const [review] = clinic.tables.review_items;
    expect(review).toMatchObject({ type: "delivery_unknown", raw_data: { reminder_log_id: log.id } });

    setNow(atSimDay(5, 12));
    const failedSms = clinic.addReviewItem({
      type: "failed_sms", severity: "high", title: "SMS misslyckades", description: "x",
      suggested_action: null, status: "open", raw_data: { reminder_log_id: log.id }
    });
    // An item pointing at a log that is not unknown: the log check comes last,
    // after nothing has been written yet.
    const dangling = clinic.addReviewItem({
      type: "delivery_unknown", severity: "high", title: "Okänd SMS-leverans", description: "x",
      suggested_action: null, status: "open", raw_data: { reminder_log_id: "log-0404" }
    });
    const before = structuredClone(clinic.tables);

    const refusals: [string, string, string, string][] = [
      [review.id, log.id, "delivered", "Invalid outcome: delivered"],
      ["review-0404", log.id, "sent", "Review item review-0404 not found"],
      [failedSms.id, log.id, "sent", `Review item ${failedSms.id} has wrong type: failed_sms`],
      [review.id, "log-0404", "sent", `Log ID mismatch: review item references ${log.id}, got log-0404`],
      [dangling.id, "log-0404", "sent", "Log log-0404 not found or not in unknown status"]
    ];
    for (const [reviewId, logId, outcome, message] of refusals) {
      // The route passes the RPC error through as a 409 body.
      await expect(
        supabaseMock.rpc("resolve_delivery_unknown", { p_review_item_id: reviewId, p_log_id: logId, p_outcome: outcome })
      ).resolves.toEqual({ data: null, error: { code: "P0001", message, details: null, hint: null } });
    }
    expect(clinic.tables).toEqual(before);
    expect(await clinic.statusOf(id)).toBe("Delivery pending");

    clinic.resolveDeliveryUnknown(review.id, log.id, "sent");
    expect(() => clinic.resolveDeliveryUnknown(review.id, log.id, "sent")).toThrow(
      `resolve_delivery_unknown: Review item ${review.id} is already resolved`
    );
    expect(clinic.logsFor(id)).toMatchObject([{ id: log.id, status: "sent", sent_at: atSimDay(5, 12) }]);
  });
});

describe("provider failure on the 5-day send", () => {
  it("opens a failed_sms item that blocks the patient as Needs review (no automatic retry) until it is resolved", async () => {
    const id = patientSeenAtSeven();
    clinic.provider.queue({ success: false, error: "Invalid number" });

    const runs = await clinic.runDays(9); // days 0..8
    expect(activeResult(runs[5])).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(clinic.logsFor(id)).toMatchObject([{ status: "failed", step_day: 5, error: "Invalid number" }]);
    const [review] = clinic.tables.review_items;
    expect(review).toMatchObject({
      type: "failed_sms",
      status: "open",
      title: "SMS misslyckades — Anna Andersson",
      description: "Invalid number",
      raw_data: { patient_id: id, phone: "46700000001", step_day: 5 }
    });

    // A failed log consumes nothing, so the 5-day step is still owed. The open
    // review item containing the phone is what blocks the retry.
    for (const day of [6, 7, 8]) {
      expect(activeResult(runs[day]).processed, clinic.formatTimeline()).toBe(0);
      expect(snapshotsOn(day)[0]).toMatchObject({ ready: 0, needs_review: 1 });
    }
    expect(await clinic.statusOf(id)).toBe("Needs review");
    expect(clinic.providerCallsFor(id).map((call) => [call.simDay, call.result.success])).toEqual([[5, false]]);

    // Resolved via POST /api/review/[id] without a manual resend.
    setNow(atSimDay(8, 12));
    clinic.updateReviewItem(review.id, { status: "resolved" });
    expect(await clinic.statusOf(id)).toBe("Ready");

    await clinic.runDays(7); // days 9..15
    // Day 9 retries the 5-day step (still the highest crossed); 14 follows on day 14.
    expect(clinic.providerCallsFor(id).map((call) => [call.simDay, call.result.success]), clinic.formatTimeline()).toEqual([
      [5, false],
      [9, true],
      [14, true]
    ]);
    expect(clinic.timeline(id).map((entry) => [entry.simDay, entry.status, entry.stepDay])).toEqual([
      [5, "failed", 5],
      [9, "sent", 5],
      [14, "sent", 14]
    ]);
  });
});

describe("stale pending reservation", () => {
  it("is left alone for 5 minutes, then the next cron reconciles it to unknown via mark_pending_unknown", async () => {
    const id = patientSeenAtSeven();
    // The real sendSms never throws (it maps exceptions to uncertain). A throw
    // here stands for the function dying between the reservation insert and
    // the provider result, e.g. a Vercel timeout: the log stays "pending".
    clinic.provider.queue(() => {
      throw new Error("Function timed out");
    });

    const runs = await clinic.runDays(6); // days 0..5
    expect(activeResult(runs[5])).toMatchObject({ processed: 1, failed: 1, sent: 0 });
    expect(activeResult(runs[5]).results[0]).toMatchObject({ status: "failed", error: "Function timed out" });
    // The provider was reached, but no result came back to the engine.
    expect(clinic.providerCallsFor(id)).toMatchObject([
      { simDay: 5, at: atSimDay(5, 8), threw: "Function timed out", result: { success: false, error: "Function timed out" } }
    ]);
    const [log] = clinic.logsFor(id);
    expect(log).toMatchObject({ status: "pending", step_day: 5, created_at: atSimDay(5, 8) });

    // 4 minutes later: not yet stale (created_at < now - 5 min is strict), and
    // the pending log already blocks the patient as "Delivery pending".
    setNow(atSimDay(5, 8, 4));
    expect(activeResult(await clinic.runDailyCron()).processed).toBe(0);
    expect(clinic.logsFor(id)[0].status).toBe("pending");
    expect(clinic.tables.review_items).toHaveLength(0);
    expect(await clinic.statusOf(id)).toBe("Delivery pending");

    const next = await clinic.runDays(1); // day 6
    expect(next[0].simDay).toBe(6);
    expect(clinic.logsFor(id)).toMatchObject([
      { id: log.id, status: "unknown", error: "Leveransstatus okänd - kontrollera SMS-leverantören", step_day: 5 }
    ]);
    expect(clinic.tables.review_items).toMatchObject([
      {
        type: "delivery_unknown",
        status: "open",
        title: "Okänd SMS-leverans - SMS 1",
        content_hash: `delivery_unknown:${log.id}`,
        raw_data: { reminder_log_id: log.id, patient_id: id, sequence_number: 1, phone: "46700000001" }
      }
    ]);
    expect(activeResult(next[0]).processed).toBe(0);

    // Still blocked when the 14-day step comes due, and the provider was not
    // called again after the crashed day-5 call.
    await clinic.runDays(9); // days 7..15
    expect(await clinic.statusOf(id)).toBe("Delivery pending");
    expect(snapshotsOn(14)[0]).toMatchObject({ ready: 0, needs_review: 1 });
    expect(clinic.sent.map((call) => [call.simDay, call.threw]), clinic.formatTimeline()).toEqual([[5, "Function timed out"]]);
    expect(clinic.timeline(id)).toHaveLength(1);

    // The mark_pending_unknown item carries reminder_log_id, so the operator
    // settles it through the same RPC as a provider-reported unknown.
    setNow(atSimDay(15, 12));
    const [review] = clinic.tables.review_items;
    clinic.resolveDeliveryUnknown(review.id, log.id, "sent");
    expect(await clinic.statusOf(id)).toBe("Ready");
    await clinic.runDays(1); // day 16
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.status, entry.stepDay]), clinic.formatTimeline()).toEqual([
      [5, "sent", 5],
      [16, "sent", 14]
    ]);
  });
});

describe("automation off (is_active = false)", () => {
  it("the daily cron sends nothing and logs nothing; re-enabling on day 20 sends the 14-day step, never the 5-day one", async () => {
    const id = patientSeenAtSeven();
    clinic.configure({ isActive: false });

    const runs = await clinic.runDays(20); // days 0..19
    expect(runs.map((run) => run.simDay)).toEqual([...Array(20).keys()]);
    for (const run of runs) {
      expect(run.result).toEqual({ processed: 0, logs: [], skipped: "Påminnelseautomation är inaktiv" });
    }
    // The patient was owed messages the whole time: this is the switch, not the cadence.
    expect(await clinic.statusOf(id)).toBe("Ready");
    expect(clinic.tables.reminder_logs).toHaveLength(0);
    expect(clinic.tables.daily_snapshots).toHaveLength(0);
    expect(clinic.sent).toHaveLength(0);

    clinic.configure({ isActive: true });
    const resumed = await clinic.runDays(1); // day 20
    // Catch-up picks the highest crossed step: 5 and 14 are both crossed, so
    // only the 14-day SMS goes out and the 5-day one is skipped for good.
    expect(activeResult(resumed[0])).toMatchObject({ processed: 1, sent: 1 });
    expect(clinic.sendsFor(id).map((entry) => [entry.simDay, entry.stepDay]), clinic.formatTimeline()).toEqual([[20, 14]]);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay)).toEqual([20]);
  });

  it("does not stop the scheduled worker: a scheduled SMS still goes out while automation is off", async () => {
    const id = patientSeenAtSeven();
    clinic.configure({ isActive: false });
    await clinic.scheduleSms({ patientId: id, stepDay: 5, day: 2, hourUtc: 9 });

    const ticks = await clinic.runWorkerTicksUntil(atSimDay(2, 10));

    // processScheduledSms never reads is_active; only dry_run_mode applies to it.
    expect(ticks.map((tick) => [tick.at, tick.result.sent])).toEqual([[atSimDay(2, 9), 1]]);
    expect(clinic.providerCallsFor(id).map((call) => call.simDay), clinic.formatTimeline()).toEqual([2]);
    expect(clinic.sendsFor(id).map((entry) => [entry.status, entry.stepDay])).toEqual([["sent", 5]]);
  });
});
