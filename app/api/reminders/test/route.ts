import { NextResponse } from "next/server";
import { addReminderLog, getSettings } from "@/lib/data/repository";
import { sendSms } from "@/lib/sms/provider";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { to?: string };
  const settings = await getSettings();
  const to = body.to ?? process.env.TEST_SMS_TO;
  const message = settings.sms_template
    .replaceAll("{{firstName}}", "Test")
    .replaceAll("{{fullName}}", "Test Patient")
    .replaceAll("{{lastName}}", "Patient")
    .replaceAll("{{lastBookingDate}}", new Intl.DateTimeFormat("sv-SE").format(new Date()))
    .replaceAll("{{bookingLink}}", settings.booking_link)
    .replaceAll("{{clinicName}}", settings.clinic_name);

  if (!to) {
    return NextResponse.json({ error: "Provide body.to or TEST_SMS_TO" }, { status: 400 });
  }

  if (settings.dry_run_mode) {
    const log = await addReminderLog({
      patient_id: null,
      booking_id: null,
      phone: to,
      message,
      status: "dry_run",
      sequence_number: null,
      is_cycle_reset: false,
      provider_message_id: null,
      error: null,
      sent_at: null
    });
    return NextResponse.json({ status: "dry_run", log });
  }

  const result = await sendSms({ to, message });
  const log = await addReminderLog({
    patient_id: null,
    booking_id: null,
    phone: to,
    message,
    status: result.success ? "sent" : "failed",
    sequence_number: null,
    is_cycle_reset: false,
    provider_message_id: result.providerMessageId ?? null,
    error: result.error ?? null,
    sent_at: result.success ? new Date().toISOString() : null
  });

  return NextResponse.json({ status: log.status, log }, { status: result.success ? 200 : 502 });
}
