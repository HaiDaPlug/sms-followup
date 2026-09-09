import type { Booking, ClinicStore, NextSequenceInfo, Patient, ReminderLog, ReminderSettings, ScheduledSms, SkipReason } from "@/types/clinic";
import {
  addReminderLog,
  addReviewItem,
  bulkUpsertPatients,
  claimDueScheduledSms,
  completeScheduledSms,
  getSettings,
  insertDailySnapshot,
  getActiveScheduledSmsPatientIds,
  linkScheduledSmsReservation,
  nowIso,
  readStore,
  updateReminderLog
} from "@/lib/data/repository";
import { supabase } from "@/lib/supabase/client";
import { sendSms } from "@/lib/sms/provider";
import { resolveDelivery } from "@/lib/sms/resolveDelivery";
import {
  calculatePatientReminderStatus,
  evaluateNextStep,
  getNextSequence,
  latestValidBooking,
  renderSmsTemplate,
  resolveSteps,
  unresolvedPlaceholders,
  validateSequenceOrder
} from "./eligibility";
import { stepById, stepPosition } from "./steps";
import { prioritizeQueue, overdueDays, type QueueCandidate } from "./queue";
import { isFutureBooking } from "@/lib/import/normalizers";

/**
 * The step a 1-based sequence position refers to, or null when the position no
 * longer exists. Every log row snapshots the id and the day so history keeps
 * its meaning after the step list is re-ordered, re-timed, or trimmed.
 */
function stepSnapshot(
  settings: ReminderSettings,
  seq: number | null
): { step_id: string | null; step_day: number | null } {
  if (seq === null) return { step_id: null, step_day: null };
  const step = resolveSteps(settings)[seq - 1];
  return { step_id: step?.id ?? null, step_day: step?.day ?? null };
}

/** Resolve an explicitly requested step, or null when it no longer exists. */
function resolveStepForSend(settings: ReminderSettings, stepId: string) {
  return stepById(resolveSteps(settings), stepId) ?? null;
}

function toSkipReason(status: string): SkipReason {
  switch (status) {
    case "Future booking":    return "future_booking";
    case "Missing phone":     return "missing_phone";
    case "Do not contact":    return "do_not_contact";
    case "Needs review":      return "needs_review";
    case "Delivery pending":  return "delivery_pending";
    case "No valid booking":  return "no_valid_booking";
    case "Waiting":           return "waiting";
    case "Sent":              return "sequence_complete";
    default:                  return "no_valid_booking";
  }
}

async function addDuplicateReservationLog(
  patient: Patient,
  bookingId: string | null
): Promise<ReminderLog> {
  return addReminderLog({
    patient_id: patient.id,
    booking_id: bookingId,
    phone: patient.normalized_phone,
    message: "",
    status: "skipped",
    sequence_number: null,
    step_id: null,
    step_day: null,
    is_cycle_reset: false,
    provider_message_id: null,
    skip_reason: "sequence_complete",
    error: "Redan reserverad av parallell förfrågan",
    sent_at: null,
  });
}

/**
 * A scheduled send freezes its booking_id and rendered message at creation
 * time, which can be months before it fires. Migration 023 cancels pending rows
 * when a booking RPC resets the cycle, but bookings also arrive through the CSV
 * import, which does not go through those RPCs — so this is the backstop.
 *
 * Deliberately NOT keyed on patient.last_booking_at: that column excludes future
 * bookings by definition (migration 022), so while the new appointment is still
 * upcoming it keeps pointing at the PREVIOUS attended visit — exactly the
 * booking the scheduled row was created against. Comparing the two would call
 * the row current. The `Future booking` hard block masks that until the
 * appointment passes, and then the block disappears while last_booking_at stays
 * stale until the next import, letting the old-cycle message through.
 *
 * Instead: any non-cancelled booking created or made after this row was
 * scheduled means the patient has re-engaged, and the frozen message belongs to
 * a cycle they have moved on from.
 */
function isStaleScheduledSend(
  scheduled: ScheduledSms,
  patient: Patient,
  bookings: Booking[]
): boolean {
  const scheduledAt = new Date(scheduled.created_at).getTime();
  if (Number.isNaN(scheduledAt)) return false;

  return bookings.some((booking) => {
    if (booking.patient_id !== patient.id) return false;
    if (booking.cancelled) return false;
    // The row's own booking is the cycle it belongs to, never evidence against it.
    if (scheduled.booking_id && booking.id === scheduled.booking_id) return false;

    // A booking is newer either because the record appeared after scheduling
    // (webhook or import) or because the appointment itself falls after it.
    // created_at covers the import case, where a visit can be back-dated.
    const createdAt = new Date(booking.created_at).getTime();
    if (!Number.isNaN(createdAt) && createdAt > scheduledAt) return true;

    const bookingAt = booking.booking_at ? new Date(booking.booking_at).getTime() : NaN;
    return !Number.isNaN(bookingAt) && bookingAt > scheduledAt;
  });
}

async function reconcileStalePendingDeliveries(): Promise<void> {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: staleRows, error: staleError } = await supabase
    .from("reminder_logs")
    .select("id")
    .eq("status", "pending")
    .lt("created_at", staleThreshold);

  if (staleError) {
    throw new Error(`Stale-pending query failed: ${staleError.message}`);
  }
  if (!staleRows || staleRows.length === 0) return;

  const { error } = await supabase.rpc("mark_pending_unknown", {
    p_log_ids: staleRows.map((row) => row.id),
  });
  if (error) {
    throw new Error(`mark_pending_unknown failed: ${error.message}`);
  }
}

/**
 * Sends a reminder to a single patient. Accepts the pre-loaded store so the
 * daily batch doesn't re-fetch from the DB for every patient.
 *
 * Pass `stepOverride` (a follow-up id) to force a specific step instead of the
 * automatically calculated next one.
 */
export async function sendReminderToPatient(
  patient: Patient,
  store: ClinicStore,
  forceDryRun = false,
  stepOverride?: string,
  forceNext = false,
  frozenMessage?: string,
  scheduledSmsId?: string
): Promise<ReminderLog> {
  const settings = store.reminder_settings[0];
  const status = calculatePatientReminderStatus(
    patient,
    settings,
    store.bookings,
    store.reminder_logs,
    store.review_items
  );
  const latest = latestValidBooking(patient, store.bookings);

  const override = settings.allow_same_number_override ?? false;

  const HARD_BLOCK = [
    "Do not contact",
    "Missing phone",
    "Future booking",
    "Needs review",
    "Delivery pending",
    "No valid booking",
  ] as const;

  if (status !== "Ready") {
    const isHardBlock = (HARD_BLOCK as readonly string[]).includes(status);

    if (isHardBlock) {
      return addReminderLog({
        patient_id: patient.id,
        booking_id: latest?.id ?? null,
        phone: patient.normalized_phone,
        message: "",
        status: "skipped",
        sequence_number: null,
        step_id: null,
        step_day: null,
        is_cycle_reset: false,
        provider_message_id: null,
        skip_reason: toSkipReason(status),
        error: `Patient ej berättigad: ${status}`,
        sent_at: null
      });
    }

    // Soft blocks (Waiting, Sent): allow through for forceNext, an explicit step, or allow_same_number_override
    if (!forceNext && stepOverride === undefined && !(override && status === "Sent")) {
      return addReminderLog({
        patient_id: patient.id,
        booking_id: latest?.id ?? null,
        phone: patient.normalized_phone,
        message: "",
        status: "skipped",
        sequence_number: null,
        step_id: null,
        step_day: null,
        is_cycle_reset: false,
        provider_message_id: null,
        skip_reason: toSkipReason(status),
        error: `Patient ej berättigad: ${status}`,
        sent_at: null
      });
    }
  }

  const steps = resolveSteps(settings);

  // Resolved before any reservation: a step that has since been deleted must
  // never reach the provider, and must not throw either — in the scheduled
  // worker a throw becomes a false "unknown" on a message never sent.
  const overrideStep = stepOverride !== undefined ? resolveStepForSend(settings, stepOverride) : null;
  if (stepOverride !== undefined && !overrideStep) {
    return addReminderLog({
      patient_id: patient.id,
      booking_id: latest?.id ?? null,
      phone: patient.normalized_phone,
      message: "",
      status: "skipped",
      sequence_number: null,
      step_id: null,
      step_day: null,
      is_cycle_reset: false,
      provider_message_id: null,
      skip_reason: "step_removed",
      error: "Uppföljningen finns inte längre",
      sent_at: null
    });
  }

  const next: NextSequenceInfo = overrideStep
    ? {
        stepId: overrideStep.id,
        day: overrideStep.day,
        sequenceNumber: stepPosition(steps, overrideStep.id) ?? 1,
        daysThreshold: overrideStep.day,
      }
    : override && status === "Sent" && steps[0]
      ? {
          stepId: steps[0].id,
          day: steps[0].day,
          sequenceNumber: 1,
          daysThreshold: steps[0].day,
        }
      : getNextSequence(patient, settings, store.reminder_logs, forceNext);

  if (!next) {
    return addReminderLog({
      patient_id: patient.id,
      booking_id: latest?.id ?? null,
      phone: patient.normalized_phone,
      message: "",
      status: "skipped",
      sequence_number: null,
      step_id: null,
      step_day: null,
      is_cycle_reset: false,
      provider_message_id: null,
      skip_reason: "sequence_complete",
      error: "Sekvensen är slutförd",
      sent_at: null
    });
  };

  // An explicit step skips getNextSequence() above, so the ordering logic never
  // runs for scheduled or manually-picked steps. Without this check a step
  // behind one already sent in this cycle would be accepted, sent to the
  // provider, and then blocked only by the unique index — which reports back as
  // a bare duplicate rather than saying the step was out of order.
  if (stepOverride !== undefined) {
    const orderError = validateSequenceOrder(
      patient.id,
      stepOverride,
      settings,
      store.reminder_logs
    );
    if (orderError) {
      return addReminderLog({
        patient_id: patient.id,
        booking_id: latest?.id ?? null,
        phone: patient.normalized_phone,
        message: "",
        status: "skipped",
        sequence_number: next.sequenceNumber,
        step_id: next.stepId,
        step_day: next.day,
        is_cycle_reset: false,
        provider_message_id: null,
        skip_reason: "out_of_order",
        error: orderError,
        sent_at: null
      });
    }
  }

  const template = stepById(steps, next.stepId)?.template ?? settings.sms_template;
  const message = frozenMessage ?? renderSmsTemplate(template, patient, settings);

  const unresolved = unresolvedPlaceholders(message);
  if (unresolved.length > 0) {
    await addReviewItem({
      type: "failed_sms",
      severity: "high",
      title: `Ej lösta platshållare — ${patient.full_name}`,
      description: `Mallen innehåller okända platshållare: ${unresolved.join(", ")}. Justera meddelandet och skicka igen.`,
      suggested_action: "Redigera meddelandet nedan och skicka igen.",
      status: "open",
      raw_data: {
        patient_id: patient.id,
        phone: patient.normalized_phone,
        sequence_number: next.sequenceNumber,
        step_id: next.stepId,
        step_day: next.day,
        rendered_message: message,
        booking_id: latest?.id ?? null,
      },
    });
    return addReminderLog({
      patient_id: patient.id,
      booking_id: latest?.id ?? null,
      phone: patient.normalized_phone,
      message,
      status: "skipped",
      sequence_number: null,
      step_id: null,
      step_day: null,
      is_cycle_reset: false,
      provider_message_id: null,
      skip_reason: "unresolved_placeholder",
      error: `Mall innehåller ej lösta platshållare: ${unresolved.join(", ")}`,
      sent_at: null
    });
  }

  if (settings.dry_run_mode || forceDryRun) {
    const bookingId = latest?.id ?? null;
    const { data, error } = await supabase
      .from("reminder_logs")
      .insert({
        patient_id: patient.id,
        booking_id: bookingId,
        phone: patient.normalized_phone,
        message,
        status: "dry_run",
        sequence_number: next.sequenceNumber,
        step_id: next.stepId,
        step_day: next.day,
        is_cycle_reset: false,
        provider_message_id: null,
        skip_reason: null,
        error: null,
        sent_at: null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return addDuplicateReservationLog(patient, bookingId);
      }
      throw new Error(`Failed to write dry-run log: ${error.message}`);
    }
    const log = data as ReminderLog;
    if (scheduledSmsId) await linkScheduledSmsReservation(scheduledSmsId, log.id);
    return log;
  }

  const bookingId = latest?.id ?? null;
  const { data: reservation, error: reserveError } = await supabase
    .from("reminder_logs")
    .insert({
      patient_id: patient.id,
      booking_id: bookingId,
      phone: patient.normalized_phone,
      message,
      status: "pending",
      sequence_number: next.sequenceNumber,
      step_id: next.stepId,
      step_day: next.day,
      is_cycle_reset: false,
      provider_message_id: null,
      skip_reason: null,
      error: null,
      sent_at: null,
    })
    .select()
    .single();

  if (reserveError) {
    if (reserveError.code === "23505") {
      return addDuplicateReservationLog(patient, bookingId);
    }
    throw new Error(`Failed to reserve log slot: ${reserveError.message}`);
  }

  if (scheduledSmsId) await linkScheduledSmsReservation(scheduledSmsId, reservation.id);
  const result = await sendSms({ to: patient.normalized_phone!, message });

  // Confirm with the provider rather than trusting that an accepted request
  // means a delivered message. Shared with the failed-SMS retry route so both
  // paths classify provider behaviour identically.
  const resolved = await resolveDelivery(result);
  const deliveryStatus = resolved.status;
  const log = await updateReminderLog(reservation.id, {
    status: deliveryStatus,
    provider_message_id: result.providerMessageId ?? null,
    error: resolved.error,
    sent_at: resolved.succeeded ? nowIso() : null,
  }, "pending");

  if (result.uncertain) {
    await addReviewItem({
      type: "delivery_unknown",
      severity: "high",
      title: `Okänd SMS-leverans — ${patient.full_name}`,
      description: result.error ?? "Leverantörens svar kunde inte bekräftas.",
      suggested_action: "Kontrollera leverantören innan meddelandet skickas igen.",
      status: "open",
      raw_data: {
        reminder_log_id: reservation.id,
        patient_id: patient.id,
        phone: patient.normalized_phone,
        sequence_number: next.sequenceNumber,
        step_id: next.stepId,
        step_day: next.day,
        rendered_message: message,
        booking_id: bookingId,
      },
      content_hash: `delivery_unknown:${reservation.id}`,
    });
  } else if (deliveryStatus === "failed") {
    // Covers both a rejected send and one the provider later reported as
    // undeliverable during verification — result.success is true in that second
    // case, so this must key off the resolved status, not the send result.
    await addReviewItem({
      type: "failed_sms",
      severity: "high",
      title: `SMS misslyckades — ${patient.full_name}`,
      description: resolved.error ?? "Okänt leverantörsfel.",
      suggested_action: "Granska meddelandet nedan, justera vid behov och skicka igen.",
      status: "open",
      raw_data: {
        patient_id: patient.id,
        phone: patient.normalized_phone,
        sequence_number: next.sequenceNumber,
        step_id: next.stepId,
        step_day: next.day,
        rendered_message: message,
        booking_id: bookingId,
      },
    });
  }

  return log;
}

export function buildCohortCounts(store: ClinicStore) {
  const settings = store.reminder_settings[0];
  const counts = {
    total_patients: store.patients.length,
    ready: 0,
    waiting: 0,
    sent_complete: 0,
    future_booking: 0,
    missing_phone: 0,
    do_not_contact: 0,
    needs_review: 0,
    no_valid_booking: 0,
  };

  for (const patient of store.patients) {
    const status = calculatePatientReminderStatus(
      patient, settings, store.bookings, store.reminder_logs, store.review_items
    );
    if (status === "Ready")            counts.ready += 1;
    else if (status === "Waiting")     counts.waiting += 1;
    else if (status === "Sent")        counts.sent_complete += 1;
    else if (status === "Future booking")   counts.future_booking += 1;
    else if (status === "Missing phone")    counts.missing_phone += 1;
    else if (status === "Do not contact")   counts.do_not_contact += 1;
    else if (status === "Needs review" || status === "Delivery pending") counts.needs_review += 1;
    else if (status === "No valid booking") counts.no_valid_booking += 1;
  }

  return counts;
}

export async function processDailyReminders() {
  await reconcileStalePendingDeliveries();

  const settings = await getSettings();

  if (!settings.is_active) {
    return { processed: 0, logs: [], skipped: "Påminnelseautomation är inaktiv" };
  }

  // Load everything once — no per-patient re-fetch
  const store = await readStore();
  const activeScheduledPatientIds = await getActiveScheduledSmsPatientIds();

  // Refresh has_future_booking on all patients against live booking data.
  // The stored flag goes stale between imports; correcting it here ensures the
  // dashboard and any future reads reflect reality before the cron sends anything.
  const stalePatients: Patient[] = [];
  for (const patient of store.patients) {
    const hasFuture = store.bookings.some(
      (b: Booking) => b.patient_id === patient.id && !b.cancelled && isFutureBooking(b.booking_at)
    );
    if (patient.has_future_booking !== hasFuture) {
      stalePatients.push({ ...patient, has_future_booking: hasFuture, updated_at: nowIso() });
    }
  }
  if (stalePatients.length > 0) {
    await bulkUpsertPatients(stalePatients);
    for (const p of stalePatients) {
      const idx = store.patients.findIndex((sp) => sp.id === p.id);
      if (idx >= 0) store.patients[idx] = p;
    }
  }

  const cohort = buildCohortCounts(store);

  // Build the whole eligible queue first, then order it, then apply the cap:
  // max_per_day is a rate limit and must not double as targeting logic. The
  // step is resolved once per patient here rather than again inside the send.
  const candidates: { patient: Patient; queue: QueueCandidate }[] = [];
  for (const patient of store.patients) {
    if (activeScheduledPatientIds.has(patient.id)) continue;
    const status = calculatePatientReminderStatus(
      patient, settings, store.bookings, store.reminder_logs, store.review_items
    );
    if (status !== "Ready") continue;

    const { next, firstDueDay } = evaluateNextStep(patient, settings, store.reminder_logs);
    if (!next || firstDueDay === null || !patient.last_booking_at) continue;

    candidates.push({
      patient,
      queue: {
        patientId: patient.id,
        lastBookingAt: patient.last_booking_at,
        daysSince: Math.floor((Date.now() - new Date(patient.last_booking_at).getTime()) / 86_400_000),
        firstDueDay,
        next,
      },
    });
  }

  const queueOrder = new Map(candidates.map((c) => [c.patient.id, c.queue]));
  // Sort a copy of the queue only — store.reminder_logs must stay newest-first,
  // which is what logsInCurrentCycle relies on to find the cycle boundary.
  const eligible = prioritizeQueue(candidates.map((c) => c.queue))
    .slice(0, settings.max_per_day)
    .map((q) => candidates.find((c) => c.patient.id === q.patientId)!.patient);

  const results: {
    patientId: string;
    name: string;
    status: string;
    error: string | null;
    sequenceNumber: number | null;
    stepId: string | null;
    stepDay: number | null;
    overdueDays: number | null;
  }[] = [];

  for (const patient of eligible) {
    const queued = queueOrder.get(patient.id);
    try {
      const log = await sendReminderToPatient(patient, store);
      results.push({
        patientId: patient.id,
        name: patient.full_name,
        status: log.status,
        error: log.error ?? null,
        sequenceNumber: log.sequence_number ?? null,
        stepId: log.step_id ?? null,
        stepDay: log.step_day ?? null,
        overdueDays: queued ? overdueDays(queued) : null,
      });
    } catch (err) {
      results.push({
        patientId: patient.id,
        name: patient.full_name,
        status: "failed",
        error: err instanceof Error ? err.message : "Oväntat fel",
        sequenceNumber: null,
        stepId: null,
        stepDay: null,
        overdueDays: queued ? overdueDays(queued) : null,
      });
    }
  }

  // "delivered" counts as sent: verification can confirm delivery before the
  // log is written, and a confirmed message is the strongest form of sent —
  // counting only the literal "sent" status would under-report exactly the
  // sends that went best.
  const sent    = results.filter((r) => r.status === "sent" || r.status === "delivered").length;
  const dryRun  = results.filter((r) => r.status === "dry_run").length;
  const failed  = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  // Persist snapshot — non-fatal so a write failure never blocks sends
  try {
    await insertDailySnapshot({
      ...cohort,
      sms_sent: sent,
      sms_dry_run: dryRun,
      sms_failed: failed,
      sms_skipped: skipped,
      dry_run_mode: settings.dry_run_mode,
      is_active: settings.is_active,
    });
  } catch {
    // non-fatal
  }

  return { processed: results.length, sent, dry_run: dryRun, failed, skipped, results };
}

export async function processScheduledSms() {
  const claimed = await claimDueScheduledSms(25);
  if (claimed.length === 0) {
    return { processed: 0, sent: 0, failed: 0, unknown: 0, skipped: 0, dry_run: 0, results: [] };
  }

  const store = await readStore();
  const results: { scheduledSmsId: string; patientId: string | null; status: string; error: string | null }[] = [];

  for (const scheduled of claimed) {
    try {
      const patient = store.patients.find((candidate) => candidate.id === scheduled.patient_id);
      if (!patient) {
        const error = "Patienten hittades inte";
        await completeScheduledSms(scheduled.id, "skipped", null, error);
        results.push({ scheduledSmsId: scheduled.id, patientId: scheduled.patient_id, status: "skipped", error });
        continue;
      }

      // Refuse before contacting the provider, not after: the frozen message
      // belongs to a booking cycle the patient has since moved on from.
      if (isStaleScheduledSend(scheduled, patient, store.bookings)) {
        const error = "Avbruten: patienten har bokat en ny tid sedan SMS:et schemalades";
        // The row's own frozen step, not a re-resolution: it is the step this
        // schedule was created for, even if the list has moved on since.
        const scheduledStep = stepSnapshot(store.reminder_settings[0], scheduled.sequence_override);
        const log = await addReminderLog({
          patient_id: patient.id,
          booking_id: scheduled.booking_id,
          phone: patient.normalized_phone,
          message: "",
          status: "skipped",
          sequence_number: scheduled.sequence_override,
          step_id: scheduled.step_id ?? scheduledStep.step_id,
          step_day: scheduledStep.step_day,
          is_cycle_reset: false,
          provider_message_id: null,
          skip_reason: "stale_cycle",
          error,
          sent_at: null,
        });
        await completeScheduledSms(scheduled.id, "skipped", log.id, error);
        results.push({ scheduledSmsId: scheduled.id, patientId: patient.id, status: "skipped", error });
        continue;
      }

      // The id the row was created with wins; the frozen position is only a
      // fallback for rows scheduled before ids existed.
      const scheduledStepId =
        scheduled.step_id ??
        stepSnapshot(store.reminder_settings[0], scheduled.sequence_override).step_id ??
        undefined;

      const log = await sendReminderToPatient(
        patient,
        store,
        false,
        scheduledStepId,
        true,
        scheduled.message_override ?? undefined,
        scheduled.id
      );
      store.reminder_logs.push(log);

      const outcome =
        log.status === "sent" || log.status === "delivered" ? "sent"
        : log.status === "dry_run" ? "dry_run"
        : log.status === "unknown" ? "unknown"
        : log.status === "skipped" ? "skipped"
        : "failed";

      await completeScheduledSms(scheduled.id, outcome, log.id, log.error ?? null);
      results.push({ scheduledSmsId: scheduled.id, patientId: patient.id, status: outcome, error: log.error ?? null });
    } catch (err) {
      // Once claimed, an exception may have happened after the provider accepted
      // the request. Unknown is safer than a retryable failure.
      const error = err instanceof Error ? err.message : "Oväntat fel";
      try {
        await completeScheduledSms(scheduled.id, "unknown", null, error);
      } catch {
        // Preserve the original failure in the response if completion also fails.
      }
      results.push({ scheduledSmsId: scheduled.id, patientId: scheduled.patient_id, status: "unknown", error });
    }
  }

  const count = (status: string) => results.filter((result) => result.status === status).length;
  return {
    processed: results.length,
    sent: count("sent"),
    failed: count("failed"),
    unknown: count("unknown"),
    skipped: count("skipped"),
    dry_run: count("dry_run"),
    results
  };
}
