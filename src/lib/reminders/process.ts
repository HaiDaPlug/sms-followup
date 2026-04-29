import type { Patient, ReminderSettings } from "@/types/clinic";
import { addReminderLog, getSettings, readStore } from "@/lib/data/repository";
import { sendSms } from "@/lib/sms/provider";
import {
  calculatePatientReminderStatus,
  getNextSequence,
  latestValidBooking,
  renderSmsTemplate
} from "./eligibility";

function templateForSequence(settings: ReminderSettings, seq: 1 | 2 | 3): string {
  if (seq === 2) return settings.sms_template_2;
  if (seq === 3) return settings.sms_template_3;
  return settings.sms_template;
}

export async function sendReminderToPatient(patient: Patient, forceDryRun = false) {
  const store = await readStore();
  const settings = store.reminder_settings[0];
  const status = calculatePatientReminderStatus(
    patient,
    settings,
    store.bookings,
    store.reminder_logs,
    store.review_items
  );
  const latest = latestValidBooking(patient, store.bookings);

  if (status !== "Ready") {
    return addReminderLog({
      patient_id: patient.id,
      booking_id: latest?.id ?? null,
      phone: patient.normalized_phone,
      message: "",
      status: "skipped",
      sequence_number: null,
      is_cycle_reset: false,
      provider_message_id: null,
      error: `Patient ej berättigad: ${status}`,
      sent_at: null
    });
  }

  const next = getNextSequence(patient, settings, store.reminder_logs)!;
  const template = templateForSequence(settings, next.sequenceNumber);
  const message = renderSmsTemplate(template, patient, settings);

  if (settings.dry_run_mode || forceDryRun) {
    return addReminderLog({
      patient_id: patient.id,
      booking_id: latest?.id ?? null,
      phone: patient.normalized_phone,
      message,
      status: "dry_run",
      sequence_number: next.sequenceNumber,
      is_cycle_reset: false,
      provider_message_id: null,
      error: null,
      sent_at: null
    });
  }

  const result = await sendSms({ to: patient.normalized_phone!, message });
  return addReminderLog({
    patient_id: patient.id,
    booking_id: latest?.id ?? null,
    phone: patient.normalized_phone,
    message,
    status: result.success ? "sent" : "failed",
    sequence_number: result.success ? next.sequenceNumber : null,
    is_cycle_reset: false,
    provider_message_id: result.providerMessageId ?? null,
    error: result.error ?? null,
    sent_at: result.success ? new Date().toISOString() : null
  });
}

export async function processDailyReminders() {
  const settings = await getSettings();
  const store = await readStore();

  if (!settings.is_active) {
    return { processed: 0, logs: [], skipped: "Påminnelseautomation är inaktiv" };
  }

  const eligible = store.patients
    .filter(
      (patient) =>
        calculatePatientReminderStatus(
          patient,
          settings,
          store.bookings,
          store.reminder_logs,
          store.review_items
        ) === "Ready"
    )
    .slice(0, settings.max_per_day);

  const logs = [];
  for (const patient of eligible) {
    logs.push(await sendReminderToPatient(patient));
  }

  return { processed: logs.length, logs };
}
