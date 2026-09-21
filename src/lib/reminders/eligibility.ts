import type {
  Booking,
  DashboardStats,
  NextSequenceInfo,
  Patient,
  PatientReminderStatus,
  ReminderLog,
  ReminderSettings,
  ReviewItem,
  SmsStep
} from "@/types/clinic";
import { isSentLogStatus } from "@/lib/sms/outcome";
import { readStore } from "@/lib/data/repository";
import { readStoreForUi } from "@/lib/data/readStoreForUi";
import { isFutureBooking } from "@/lib/import/normalizers";
import { resolveSteps, stepById, stepPosition } from "./steps";
export { resolveSteps } from "./steps";

function daysBetween(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export interface EligibilityContext {
  bookingsByPatient: Map<string, Booking[]>;
  logsByPatient: Map<string, ReminderLog[]>;
  openReviewData: string[];
}

/** Build patient-scoped lookup tables once for list and dashboard views. */
export function buildEligibilityContext(
  bookings: Booking[],
  logs: ReminderLog[],
  reviewItems: ReviewItem[]
): EligibilityContext {
  const bookingsByPatient = new Map<string, Booking[]>();
  const logsByPatient = new Map<string, ReminderLog[]>();

  for (const booking of bookings) {
    if (!booking.patient_id) continue;
    const patientBookings = bookingsByPatient.get(booking.patient_id) ?? [];
    patientBookings.push(booking);
    bookingsByPatient.set(booking.patient_id, patientBookings);
  }

  for (const log of logs) {
    if (!log.patient_id) continue;
    const patientLogs = logsByPatient.get(log.patient_id) ?? [];
    patientLogs.push(log);
    logsByPatient.set(log.patient_id, patientLogs);
  }

  return {
    bookingsByPatient,
    logsByPatient,
    openReviewData: reviewItems
      .filter((item) => item.status === "open")
      .map((item) => JSON.stringify(item.raw_data))
  };
}

export function latestValidBooking(patient: Patient, bookings: Booking[]) {
  return bookings
    .filter(
      (booking) =>
        booking.patient_id === patient.id &&
        booking.booking_at === patient.last_booking_at &&
        !booking.cancelled &&
        !/cancelled|avbokad/i.test(booking.status)
    )
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
}

/**
 * Returns logs for this patient since the most recent cycle_reset (or all logs
 * if there has never been a reset). Logs are assumed to be sorted newest-first.
 */
export function logsInCurrentCycle(patientId: string, logs: ReminderLog[]): ReminderLog[] {
  const patientLogs = logs.filter((l) => l.patient_id === patientId);
  const resetIdx = patientLogs.findIndex((l) => l.is_cycle_reset);
  // Everything before the reset index is in the current cycle
  return resetIdx === -1 ? patientLogs : patientLogs.slice(0, resetIdx);
}

/**
 * What the patient's current cycle has already consumed, expressed in the two
 * terms the engine orders by: which steps were sent (by id) and how far the
 * sequence has advanced (by day).
 *
 * The day of a sent step comes from the log's own `step_day` snapshot FIRST.
 * Ids preserve identity, the snapshot preserves historical meaning: a message
 * sent as the 90-day follow-up stays a 90-day fact even if that step is later
 * re-timed to 180, so it keeps bounding the cycle at 90. Only rows written
 * before the snapshot existed fall back to the step's current day, then to the
 * positional `sequence_number`.
 */
function cycleProgress(
  patientId: string,
  steps: SmsStep[],
  logs: ReminderLog[]
): { sentIds: Set<string>; maxSentDay: number } {
  const sentLogs = logsInCurrentCycle(patientId, logs).filter(
    (l) => l.status === "sent" || l.status === "dry_run" || l.status === "delivered"
  );

  const sentIds = new Set<string>();
  let maxSentDay = -Infinity;
  for (const log of sentLogs) {
    if (log.step_id) sentIds.add(log.step_id);
    const day =
      log.step_day ??
      stepById(steps, log.step_id)?.day ??
      (log.sequence_number ? steps[log.sequence_number - 1]?.day : undefined);
    if (day !== undefined && day > maxSentDay) maxSentDay = day;
  }
  return { sentIds, maxSentDay };
}

/** The active, unsent steps still ahead of the patient in this cycle. */
function remainingSteps(
  patient: Patient,
  settings: ReminderSettings,
  logs: ReminderLog[]
): { steps: SmsStep[]; candidates: SmsStep[]; crossed: SmsStep[]; hasSent: boolean } {
  const steps = resolveSteps(settings);
  const { sentIds, maxSentDay } = cycleProgress(patient.id, steps, logs);
  const days = patient.last_booking_at ? daysBetween(patient.last_booking_at) : -Infinity;

  // Excluded by id as well as by day: a step that was already sent never
  // qualifies again, even if its trigger day was later edited upward.
  const candidates = steps.filter(
    (step) => step.active && !sentIds.has(step.id) && step.day > maxSentDay
  );
  return {
    steps,
    candidates,
    crossed: candidates.filter((step) => days >= step.day),
    hasSent: maxSentDay > -Infinity,
  };
}

function toNextSequence(steps: SmsStep[], step: SmsStep): NextSequenceInfo {
  return {
    stepId: step.id,
    day: step.day,
    // Position in the FULL sorted list, inactive steps included: this is what
    // sequence_number has always meant and what the 013 indexes key on.
    sequenceNumber: stepPosition(steps, step.id) ?? 1,
  };
}

/**
 * Returns the next step that should be sent, or null if nothing is due yet /
 * all sent. Picks the highest crossed threshold, so a patient 212 days out gets
 * the 180-day follow-up rather than restarting at day 5.
 *
 * Inactive steps are skipped, never blocking: with 90 active, 180 inactive and
 * 365 active, a patient who received the 90 goes on to the 365.
 */
export function getNextSequence(
  patient: Patient,
  settings: ReminderSettings,
  logs: ReminderLog[],
  _force = false
): NextSequenceInfo {
  if (!patient.last_booking_at) return null;

  const { steps, crossed } = remainingSteps(patient, settings, logs);
  if (crossed.length === 0) return null;
  return toNextSequence(steps, crossed[crossed.length - 1]);
}

/**
 * The next step plus the day the patient first became due for it — the daily
 * queue's sort key. Computed together so the caller resolves eligibility once
 * per patient instead of twice.
 */
export function evaluateNextStep(
  patient: Patient,
  settings: ReminderSettings,
  logs: ReminderLog[]
): { next: NextSequenceInfo; firstDueDay: number | null } {
  if (!patient.last_booking_at) return { next: null, firstDueDay: null };

  const { steps, crossed } = remainingSteps(patient, settings, logs);
  if (crossed.length === 0) return { next: null, firstDueDay: null };
  return {
    next: toNextSequence(steps, crossed[crossed.length - 1]),
    // The EARLIEST threshold still owed, not the one being sent: it is when this
    // patient joined the queue, which is what keeps the ordering fair.
    firstDueDay: crossed[0].day,
  };
}

/**
 * Guards an explicit step against being sent out of chronological order. An
 * explicit `stepId` bypasses getNextSequence() entirely, so without this check
 * nothing stops the 14-day message going out after the 90-day one.
 *
 * Inactive steps pass: deactivating a follow-up stops the automation from
 * choosing it, but an operator may still send it deliberately.
 *
 * Returns null when the step is acceptable, or a Swedish reason when it is not.
 */
export function validateSequenceOrder(
  patientId: string,
  stepId: string,
  settings: ReminderSettings,
  logs: ReminderLog[]
): string | null {
  const steps = resolveSteps(settings);
  const step = stepById(steps, stepId);
  if (!step) return "Uppföljningen finns inte längre";

  const { sentIds, maxSentDay } = cycleProgress(patientId, steps, logs);
  if (sentIds.has(step.id)) {
    return `${step.day}-dagars uppföljningen har redan skickats i den här cykeln`;
  }
  if (maxSentDay === -Infinity) return null;

  if (step.day < maxSentDay) {
    return `${step.day}-dagars uppföljningen kan inte skickas — ${maxSentDay}-dagars uppföljningen har redan skickats i den här cykeln`;
  }
  if (step.day === maxSentDay) {
    return `${step.day}-dagars uppföljningen har redan skickats i den här cykeln`;
  }
  return null;
}

/** Resolve the step a future scheduled send should own without re-sending an
 * already completed step merely because the next threshold has not been met. */
export function getNextSchedulableSequence(
  patient: Patient,
  settings: ReminderSettings,
  logs: ReminderLog[]
): NextSequenceInfo {
  if (!patient.last_booking_at) return null;

  const { steps, candidates } = remainingSteps(patient, settings, logs);
  if (candidates.length === 0) return null;
  // The earliest step still owed, whether or not its day has been reached —
  // scheduling deliberately runs ahead of the cadence.
  return toNextSequence(steps, candidates[0]);
}

function calculatePatientReminderStatusFromSlices(
  patient: Patient,
  settings: ReminderSettings,
  bookings: Booking[],
  logs: ReminderLog[],
  hasOpenReview: boolean
): PatientReminderStatus {
  if (patient.do_not_contact) return "Do not contact";
  if (!patient.normalized_phone) return "Missing phone";
  // Check live rather than trusting the stored flag which goes stale between imports
  const hasFutureBooking = bookings.some(
    (b) => b.patient_id === patient.id && !b.cancelled && isFutureBooking(b.booking_at)
  );
  if (hasFutureBooking) return "Future booking";
  const hasPendingDelivery = logsInCurrentCycle(patient.id, logs).some(
    (log) => log.status === "pending" || log.status === "unknown"
  );
  if (hasPendingDelivery) return "Delivery pending";
  if (hasOpenReview) {
    return "Needs review";
  }
  if (!patient.last_booking_at) return "No valid booking";

  const { candidates, crossed, hasSent } = remainingSteps(patient, settings, logs);

  if (crossed.length > 0) return "Ready";

  // Nothing is due. "Sent" means the automation finished this patient's cycle,
  // so it requires that something actually went out. With no active follow-ups
  // at all, an untouched patient is Waiting — reporting them as Sent would
  // inflate the completed count merely because the clinic disabled everything.
  if (candidates.length === 0) return hasSent ? "Sent" : "Waiting";
  return "Waiting";
}

export function calculatePatientReminderStatus(
  patient: Patient,
  settings: ReminderSettings,
  bookings: Booking[],
  logs: ReminderLog[],
  reviewItems: ReviewItem[]
): PatientReminderStatus {
  return calculatePatientReminderStatusFromSlices(
    patient,
    settings,
    bookings,
    logs,
    reviewItems.some(
      (item) =>
        item.status === "open" &&
        JSON.stringify(item.raw_data).includes(
          patient.normalized_phone ?? patient.email ?? patient.full_name
        )
    )
  );
}

export function calculatePatientReminderStatusFromContext(
  patient: Patient,
  settings: ReminderSettings,
  context: EligibilityContext
): PatientReminderStatus {
  return calculatePatientReminderStatusFromSlices(
    patient,
    settings,
    context.bookingsByPatient.get(patient.id) ?? [],
    context.logsByPatient.get(patient.id) ?? [],
    context.openReviewData.some((rawData) =>
      rawData.includes(patient.normalized_phone ?? patient.email ?? patient.full_name)
    )
  );
}

export async function getEligiblePatients(settings: ReminderSettings) {
  const store = await readStore();
  return store.patients.filter(
    (patient) =>
      calculatePatientReminderStatus(
        patient,
        settings,
        store.bookings,
        store.reminder_logs,
        store.review_items
      ) === "Ready"
  );
}

export function renderSmsTemplate(
  template: string,
  patient: Patient,
  settings: ReminderSettings
) {
  const lastBookingDate = patient.last_booking_at
    ? new Intl.DateTimeFormat("sv-SE").format(new Date(patient.last_booking_at))
    : "";

  const firstName = patient.first_name ?? patient.full_name.split(" ")[0] ?? "";
  return template
    .replaceAll("{{firstName}}", firstName)
    .replaceAll("{{förnamn}}", firstName)
    .replaceAll("{{fullName}}", patient.full_name)
    .replaceAll("{{fullständigtNamn}}", patient.full_name)
    .replaceAll("{{lastName}}", patient.last_name ?? "")
    .replaceAll("{{efternamn}}", patient.last_name ?? "")
    .replaceAll("{{lastBookingDate}}", lastBookingDate)
    .replaceAll("{{senasteBesök}}", lastBookingDate)
    .replaceAll("{{bookingLink}}", settings.booking_link)
    .replaceAll("{{bokningsLänk}}", settings.booking_link)
    .replaceAll("{{clinicName}}", settings.clinic_name)
    .replaceAll("{{klinikNamn}}", settings.clinic_name);
}

/** Returns any unresolved {{placeholder}} tokens left in the rendered message. */
export function unresolvedPlaceholders(message: string): string[] {
  return [...message.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]);
}

export function calculateDryRunSummary(
  patients: Patient[],
  settings: ReminderSettings,
  bookings: Booking[],
  logs: ReminderLog[],
  reviewItems: ReviewItem[]
) {
  const context = buildEligibilityContext(bookings, logs, reviewItems);
  const counts = {
    eligible_count: 0,
    would_send_today: 0,
    excluded_missing_phone: 0,
    excluded_future_booking: 0,
    excluded_do_not_contact: 0,
    needs_review: 0,
    estimated_sms_count: 0
  };

  for (const patient of patients) {
    const status = calculatePatientReminderStatusFromContext(patient, settings, context);
    if (status === "Ready") counts.eligible_count += 1;
    if (status === "Missing phone") counts.excluded_missing_phone += 1;
    if (status === "Future booking") counts.excluded_future_booking += 1;
    if (status === "Do not contact") counts.excluded_do_not_contact += 1;
    if (status === "Needs review" || status === "Delivery pending") counts.needs_review += 1;
  }

  counts.would_send_today = Math.min(counts.eligible_count, settings.max_per_day);
  counts.estimated_sms_count = counts.would_send_today;
  return counts;
}

export async function calculateDashboardStats(): Promise<DashboardStats> {
  const store = await readStoreForUi();
  const settings = store.reminder_settings[0];
  const dryRun = calculateDryRunSummary(
    store.patients,
    settings,
    store.bookings,
    store.reminder_logs,
    store.review_items
  );
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const failedSms = store.reminder_logs.filter((log) => log.status === "failed").length;
  const missingPhone = store.patients.filter((patient) => !patient.normalized_phone).length;
  const seenPhones = new Set<string>();
  const duplicatePhoneSet = new Set<string>();
  for (const patient of store.patients) {
    const phone = patient.normalized_phone;
    if (!phone) continue;
    if (seenPhones.has(phone)) duplicatePhoneSet.add(phone);
    seenPhones.add(phone);
  }
  const duplicatePhones = duplicatePhoneSet.size;

  return {
    totalPatients: store.patients.length,
    readyForReminder: dryRun.eligible_count,
    smsSentThisMonth: store.reminder_logs.filter(
      (log) => isSentLogStatus(log.status) && new Date(log.created_at) >= monthStart
    ).length,
    needsReviewCount: store.review_items.filter((item) => item.status === "open").length,
    dryRun,
    recentReminderActivity: (() => {
      const patientMap = new Map(store.patients.map((p) => [p.id, p]));
      return store.reminder_logs
        .filter((l) => !l.is_cycle_reset)
        .slice(0, 8)
        .map((l) => ({
          ...l,
          full_name: l.patient_id ? (patientMap.get(l.patient_id)?.full_name ?? null) : null,
        }));
    })(),
    nudges: [
      missingPhone > 0
        ? {
            title: "Saknar telefonnummer",
            description: `${missingPhone} patienter kan inte nås via SMS förrän telefonnummer läggs till.`,
            severity: "high" as const
          }
        : null,
      duplicatePhones > 0
        ? {
            title: "Dubbla telefonnummer",
            description: `${duplicatePhones} normaliserade telefonnummer förekommer på flera patienter.`,
            severity: "medium" as const
          }
        : null,
      failedSms > 0
        ? {
            title: "SMS-fel",
            description: `${failedSms} SMS misslyckades. Kontrollera leverantörsinställningar och nummerformat.`,
            severity: "high" as const
          }
        : null,
      dryRun.excluded_future_booking > 0
        ? {
            title: "Har bokat en tid",
            description: `${dryRun.excluded_future_booking} patienter har redan en kommande bokning och hoppas över.`,
            severity: "low" as const
          }
        : null
    ].filter(Boolean) as DashboardStats["nudges"]
  };
}
