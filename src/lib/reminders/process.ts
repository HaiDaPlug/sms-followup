import type { Booking, ClinicStore, Patient, ReminderLog, ReminderSettings, SkipReason } from "@/types/clinic";
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
import {
  calculatePatientReminderStatus,
  getNextSequence,
  latestValidBooking,
  renderSmsTemplate,
  resolveSteps,
  unresolvedPlaceholders
} from "./eligibility";
import { isFutureBooking } from "@/lib/import/normalizers";

function templateForSequence(settings: ReminderSettings, seq: number): string {
  const steps = resolveSteps(settings);
  return steps[seq - 1]?.template ?? settings.sms_template;
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
    is_cycle_reset: false,
    provider_message_id: null,
    skip_reason: "sequence_complete",
    error: "Redan reserverad av parallell förfrågan",
    sent_at: null,
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
 * Pass `sequenceOverride` (1-based) to force a specific template instead of
 * the automatically calculated next step.
 */
export async function sendReminderToPatient(
  patient: Patient,
  store: ClinicStore,
  forceDryRun = false,
  sequenceOverride?: number,
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
        is_cycle_reset: false,
        provider_message_id: null,
        skip_reason: toSkipReason(status),
        error: `Patient ej berättigad: ${status}`,
        sent_at: null
      });
    }

    // Soft blocks (Waiting, Sent): allow through for forceNext, sequenceOverride, or allow_same_number_override
    if (!forceNext && !sequenceOverride && !(override && status === "Sent")) {
      return addReminderLog({
        patient_id: patient.id,
        booking_id: latest?.id ?? null,
        phone: patient.normalized_phone,
        message: "",
        status: "skipped",
        sequence_number: null,
        is_cycle_reset: false,
        provider_message_id: null,
        skip_reason: toSkipReason(status),
        error: `Patient ej berättigad: ${status}`,
        sent_at: null
      });
    }
  }

  const next = sequenceOverride
    ? { sequenceNumber: sequenceOverride, daysThreshold: 0 }
    : override && status === "Sent"
      ? { sequenceNumber: 1, daysThreshold: 0 }
      : getNextSequence(patient, settings, store.reminder_logs, forceNext);

  if (!next) {
    return addReminderLog({
      patient_id: patient.id,
      booking_id: latest?.id ?? null,
      phone: patient.normalized_phone,
      message: "",
      status: "skipped",
      sequence_number: null,
      is_cycle_reset: false,
      provider_message_id: null,
      skip_reason: "sequence_complete",
      error: "Sekvensen är slutförd",
      sent_at: null
    });
  };
  const template = templateForSequence(settings, next.sequenceNumber);
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
  const deliveryStatus = result.success ? "sent" : result.uncertain ? "unknown" : "failed";
  const log = await updateReminderLog(reservation.id, {
    status: deliveryStatus,
    provider_message_id: result.providerMessageId ?? null,
    error: result.error ?? null,
    sent_at: result.success ? nowIso() : null,
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
        rendered_message: message,
        booking_id: bookingId,
      },
      content_hash: `delivery_unknown:${reservation.id}`,
    });
  } else if (!result.success) {
    await addReviewItem({
      type: "failed_sms",
      severity: "high",
      title: `SMS misslyckades — ${patient.full_name}`,
      description: result.error ?? "Okänt leverantörsfel.",
      suggested_action: "Granska meddelandet nedan, justera vid behov och skicka igen.",
      status: "open",
      raw_data: {
        patient_id: patient.id,
        phone: patient.normalized_phone,
        sequence_number: next.sequenceNumber,
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

  const eligible = store.patients
    .filter(
      (patient) =>
        !activeScheduledPatientIds.has(patient.id) &&
        calculatePatientReminderStatus(
          patient, settings, store.bookings, store.reminder_logs, store.review_items
        ) === "Ready"
    )
    .slice(0, settings.max_per_day);

  const results: {
    patientId: string;
    name: string;
    status: string;
    error: string | null;
    sequenceNumber: number | null;
  }[] = [];

  for (const patient of eligible) {
    try {
      const log = await sendReminderToPatient(patient, store);
      results.push({
        patientId: patient.id,
        name: patient.full_name,
        status: log.status,
        error: log.error ?? null,
        sequenceNumber: log.sequence_number ?? null,
      });
    } catch (err) {
      results.push({
        patientId: patient.id,
        name: patient.full_name,
        status: "failed",
        error: err instanceof Error ? err.message : "Oväntat fel",
        sequenceNumber: null,
      });
    }
  }

  const sent    = results.filter((r) => r.status === "sent").length;
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

      const log = await sendReminderToPatient(
        patient,
        store,
        false,
        scheduled.sequence_override ?? undefined,
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
