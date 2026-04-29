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
import { readStore } from "@/lib/data/repository";

function daysBetween(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export function latestValidBooking(patient: Patient, bookings: Booking[]) {
  return bookings
    .filter(
      (booking) =>
        booking.patient_id === patient.id &&
        booking.booking_at === patient.last_booking_at &&
        !/cancelled|avbokad/i.test(booking.status)
    )
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
}

/**
 * Returns logs for this patient since the most recent cycle_reset (or all logs
 * if there has never been a reset). Logs are assumed to be sorted newest-first.
 */
function logsInCurrentCycle(patientId: string, logs: ReminderLog[]): ReminderLog[] {
  const patientLogs = logs.filter((l) => l.patient_id === patientId);
  const resetIdx = patientLogs.findIndex((l) => l.is_cycle_reset);
  // Everything before the reset index is in the current cycle
  return resetIdx === -1 ? patientLogs : patientLogs.slice(0, resetIdx);
}

/**
 * How many successful SMS (sent or dry_run) have been sent in the current cycle,
 * and what sequence number should be sent next.
 *
 * Thresholds: SMS 1 → day 30, SMS 2 → day 60, SMS 3 → day 90
 * (each step is `days_after_booking` apart)
 */
export function getNextSequence(
  patient: Patient,
  settings: ReminderSettings,
  logs: ReminderLog[]
): NextSequenceInfo {
  if (!patient.last_booking_at) return null;

  const days = daysBetween(patient.last_booking_at);
  const step = settings.days_after_booking; // e.g. 30

  const cycleLogs = logsInCurrentCycle(patient.id, logs);
  const sentInCycle = cycleLogs.filter(
    (l) => l.status === "sent" || l.status === "dry_run"
  );

  // Highest sequence number already sent this cycle
  const maxSentSeq = sentInCycle.reduce(
    (max, l) => Math.max(max, l.sequence_number ?? 0),
    0
  );

  // Work out which step we're in based on days elapsed
  const currentStep = days >= step * 3 ? 3 : days >= step * 2 ? 2 : days >= step ? 1 : 0;

  if (currentStep === 0) return null; // not yet time for SMS 1
  if (maxSentSeq >= currentStep) return null; // already sent for this step
  if (maxSentSeq >= 3) return null; // full sequence complete

  const next = (maxSentSeq + 1) as 1 | 2 | 3;
  return { sequenceNumber: next, daysThreshold: step * next };
}

export function calculatePatientReminderStatus(
  patient: Patient,
  settings: ReminderSettings,
  bookings: Booking[],
  logs: ReminderLog[],
  reviewItems: ReviewItem[]
): PatientReminderStatus {
  if (patient.do_not_contact) return "Do not contact";
  if (!patient.normalized_phone) return "Missing phone";
  if (patient.has_future_booking) return "Future booking";
  if (
    reviewItems.some(
      (item) =>
        item.status === "open" &&
        JSON.stringify(item.raw_data).includes(
          patient.normalized_phone ?? patient.email ?? patient.full_name
        )
    )
  ) {
    return "Needs review";
  }
  if (!patient.last_booking_at) return "No valid booking";

  const next = getNextSequence(patient, settings, logs);

  if (next === null) {
    // Check whether it's "waiting" (not enough days) or "all sent"
    const days = daysBetween(patient.last_booking_at);
    if (days < settings.days_after_booking) return "Waiting";
    return "Sent"; // completed all applicable steps
  }

  return "Ready";
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

  return template
    .replaceAll("{{firstName}}", patient.first_name ?? patient.full_name.split(" ")[0] ?? "")
    .replaceAll("{{fullName}}", patient.full_name)
    .replaceAll("{{lastName}}", patient.last_name ?? "")
    .replaceAll("{{lastBookingDate}}", lastBookingDate)
    .replaceAll("{{bookingLink}}", settings.booking_link)
    .replaceAll("{{clinicName}}", settings.clinic_name);
}

export function calculateDryRunSummary(
  patients: Patient[],
  settings: ReminderSettings,
  bookings: Booking[],
  logs: ReminderLog[],
  reviewItems: ReviewItem[]
) {
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
    const status = calculatePatientReminderStatus(patient, settings, bookings, logs, reviewItems);
    if (status === "Ready") counts.eligible_count += 1;
    if (status === "Missing phone") counts.excluded_missing_phone += 1;
    if (status === "Future booking") counts.excluded_future_booking += 1;
    if (status === "Do not contact") counts.excluded_do_not_contact += 1;
    if (status === "Needs review") counts.needs_review += 1;
  }

  counts.would_send_today = Math.min(counts.eligible_count, settings.max_per_day);
  counts.estimated_sms_count = counts.would_send_today;
  return counts;
}

export async function calculateDashboardStats(): Promise<DashboardStats> {
  const store = await readStore();
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
  const duplicatePhones = new Set(
    store.patients
      .map((patient) => patient.normalized_phone)
      .filter((phone, index, list) => phone && list.indexOf(phone) !== index)
  ).size;

  return {
    totalPatients: store.patients.length,
    readyForReminder: dryRun.eligible_count,
    smsSentThisMonth: store.reminder_logs.filter(
      (log) => log.status === "sent" && new Date(log.created_at) >= monthStart
    ).length,
    needsReviewCount: store.review_items.filter((item) => item.status === "open").length,
    dryRun,
    recentReminderActivity: store.reminder_logs
      .filter((l) => !l.is_cycle_reset)
      .slice(0, 8),
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
