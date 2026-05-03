import { NextResponse } from "next/server";
import { readStore, addReminderLog, updateReviewItem } from "@/lib/data/repository";
import { sendSms } from "@/lib/sms/provider";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const patientId = String(body.patient_id ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const message = String(body.message ?? "").trim();
  const reviewId = String(body.review_id ?? "").trim();
  const sequenceNumber = typeof body.sequence_number === "number" ? body.sequence_number : null;

  if (!patientId || !phone || !message) {
    return NextResponse.json({ error: "patient_id, phone och message krävs" }, { status: 400 });
  }

  const store = await readStore();
  const settings = store.reminder_settings[0];

  if (settings.dry_run_mode) {
    await addReminderLog({
      patient_id: patientId,
      booking_id: null,
      phone,
      message,
      status: "dry_run",
      sequence_number: sequenceNumber,
      is_cycle_reset: false,
      provider_message_id: null,
      error: null,
      sent_at: null,
    });
    if (reviewId) await updateReviewItem(reviewId, { status: "resolved" });
    return NextResponse.json({ status: "dry_run" });
  }

  const result = await sendSms({ to: phone, message });

  await addReminderLog({
    patient_id: patientId,
    booking_id: null,
    phone,
    message,
    status: result.success ? "sent" : "failed",
    sequence_number: result.success ? sequenceNumber : null,
    is_cycle_reset: false,
    provider_message_id: result.providerMessageId ?? null,
    error: result.error ?? null,
    sent_at: result.success ? new Date().toISOString() : null,
  });

  if (result.success && reviewId) {
    await updateReviewItem(reviewId, { status: "resolved" });
  }

  return NextResponse.json(
    result.success ? { status: "sent" } : { status: "failed", error: result.error },
    { status: result.success ? 200 : 502 }
  );
}
