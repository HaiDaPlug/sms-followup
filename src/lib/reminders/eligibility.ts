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
import { isFutureBooking } from "@/lib/import/normalizers";
import { resolveSteps } from "./steps";
export { resolveSteps } from "./steps";

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
        !booking.cancelled &&
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

  if (force) {
    // Manual send: next sequential step in the sequence, date threshold ignored
    const nextStep = steps[maxSentSeq];
    if (!nextStep) return null;
    return { sequenceNumber: maxSentSeq + 1, daysThreshold: nextStep.day };
  } else {
    // Cron: jump to the highest threshold that has been crossed (and not yet sent)
    const eligible = steps.filter((s, i) => i >= maxSentSeq && days >= s.day);
    const nextStep = eligible[eligible.length - 1];
    if (!nextStep) return null;
    return { sequenceNumber: steps.indexOf(nextStep) + 1, daysThreshold: nextStep.day };
  }
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
  // Check live rather than trusting the stored flag which goes stale between imports
  const hasFutureBooking = bookings.some(
    (b) => b.patient_id === patient.id && !b.cancelled && isFutureBooking(b.booking_at)
  );
  if (hasFutureBooking) return "Future booking";
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
    // Check whether it's "waiting" (not yet reached first step) or "all sent"
    const days = daysBetween(patient.last_booking_at);
    const firstStepDay = resolveSteps(settings)[0]?.day ?? settings.days_after_booking;
    if (days < firstStepDay) return "Waiting";
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
