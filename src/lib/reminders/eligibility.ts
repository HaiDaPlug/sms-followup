import type {
  Booking,
  DashboardStats,
  NextSequenceInfo,
  Patient,
  PatientReminderStatus,
  ReminderLog,
  ReminderSettings,
  ReviewItem
} from "@/types/clinic";
import { readStore, readStoreForUi } from "@/lib/data/repository";
import { isFutureBooking } from "@/lib/import/normalizers";
import { resolveSteps } from "./steps";
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
 * Returns the next step that should be sent, or null if nothing is due yet / all sent.
 * sequenceNumber is 1-based (1 = first step, 2 = second, etc.).
 */
export function getNextSequence(
  patient: Patient,
  settings: ReminderSettings,
  logs: ReminderLog[],
  force = false
): NextSequenceInfo {
  if (!patient.last_booking_at) return null;

  const days = daysBetween(patient.last_booking_at);
  const steps = resolveSteps(settings);

  const cycleLogs = logsInCurrentCycle(patient.id, logs);
  const sentInCycle = cycleLogs.filter(
    (l) => l.status === "sent" || l.status === "dry_run" || l.status === "delivered"
  );
  const maxSentSeq = sentInCycle.reduce(
    (max, l) => Math.max(max, l.sequence_number ?? 0),
    0
  );

  if (maxSentSeq >= steps.length) return null; // full sequence complete

  // Jump to the highest threshold crossed (and not yet sent).
  // For cron: only steps where days >= threshold are eligible.
  // For manual/force: all remaining steps are eligible (skip the "not due yet" gate),
  // but still pick the highest crossed threshold so a patient 212 days out gets SMS 4,
  // not SMS 1.
  const eligible = force
    ? steps.filter((_s, i) => i >= maxSentSeq)
    : steps.filter((s, i) => i >= maxSentSeq && days >= s.day);

  // Among eligible, prefer the highest crossed threshold.
  const crossed = eligible.filter((s) => days >= s.day);
  if (crossed.length > 0) {
    const nextStep = crossed[crossed.length - 1];
    return { sequenceNumber: steps.indexOf(nextStep) + 1, daysThreshold: nextStep.day };
  }

  // Nothing new has crossed yet. For force/manual: re-send the last sent step so the
  // operator can test without advancing the sequence (e.g. re-send SMS 4 while still
  // at 212 days rather than jumping ahead to SMS 5).
  if (force && maxSentSeq > 0) {
    const lastStep = steps[maxSentSeq - 1];
    return { sequenceNumber: maxSentSeq, daysThreshold: lastStep.day };
  }

  // For force with nothing sent yet and nothing crossed, send step 1.
  if (force) return { sequenceNumber: 1, daysThreshold: steps[0].day };

  return null;
}

/** Resolve the step a future scheduled send should own without re-sending an
 * already completed step merely because the next threshold has not been met. */
export function getNextSchedulableSequence(
  patient: Patient,
  settings: ReminderSettings,
  logs: ReminderLog[]
): NextSequenceInfo {
  const due = getNextSequence(patient, settings, logs);
  if (due) return due;
  if (!patient.last_booking_at) return null;

  const steps = resolveSteps(settings);
  const maxSentSeq = logsInCurrentCycle(patient.id, logs)
    .filter((log) => log.status === "sent" || log.status === "dry_run" || log.status === "delivered")
    .reduce((max, log) => Math.max(max, log.sequence_number ?? 0), 0);

  const nextIndex = maxSentSeq;
  const nextStep = steps[nextIndex];
  if (!nextStep) return null;
  return {
    sequenceNumber: nextIndex + 1,
    daysThreshold: nextStep.day
  };
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

  const next = getNextSequence(patient, settings, logs);

  if (next === null) {
    // Check whether it's "waiting" (not yet reached first step) or "all sent"
    const days = daysBetween(patient.last_booking_at);
    const firstStepDay = resolveSteps(settings)[0]?.day ?? settings.days_after_booking;
    if (days < firstStepDay) return "Waiting";
    return "Sent"; // completed all applicable steps
  }

  return "Ready";
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
      (log) => log.status === "sent" && new Date(log.created_at) >= monthStart
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
