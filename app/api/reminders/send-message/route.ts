import { NextResponse } from "next/server";
import {
  readStore,
  updateReminderLog,
  updateReviewItem,
} from "@/lib/data/repository";
import {
  calculatePatientReminderStatus,
  latestValidBooking,
} from "@/lib/reminders/eligibility";
import { sendSms } from "@/lib/sms/provider";
import { supabase } from "@/lib/supabase/client";
import type { ReminderLog } from "@/types/clinic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const reviewId = typeof body.review_id === "string" ? body.review_id.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!reviewId || !message) {
    return NextResponse.json(
      { error: "review_id och message krävs" },
      { status: 400 }
    );
  }

  const { data: reviewItem, error: reviewError } = await supabase
    .from("review_items")
    .select("id, type, status, raw_data")
    .eq("id", reviewId)
    .single();

  if (reviewError || !reviewItem) {
    return NextResponse.json({ error: "Review item not found" }, { status: 404 });
  }
  if (reviewItem.status !== "open" || reviewItem.type !== "failed_sms") {
    return NextResponse.json(
      { error: "Review item is not an open failed SMS" },
      { status: 409 }
    );
  }

  const rawData = reviewItem.raw_data as Record<string, unknown>;
  const patientId = typeof rawData.patient_id === "string" ? rawData.patient_id : "";
  const sequenceNumber = typeof rawData.sequence_number === "number"
    ? rawData.sequence_number
    : null;
  const reviewBookingId = typeof rawData.booking_id === "string"
    ? rawData.booking_id
    : null;

  if (!patientId || sequenceNumber === null) {
    return NextResponse.json(
      { error: "Review item saknar patient eller sekvensnummer" },
      { status: 400 }
    );
  }

  const store = await readStore();
  const patient = store.patients.find((candidate) => candidate.id === patientId);
  const settings = store.reminder_settings[0];
  if (!patient || !settings) {
    return NextResponse.json({ error: "Patient eller inställningar saknas" }, { status: 404 });
  }

  const currentBookingId = latestValidBooking(patient, store.bookings)?.id ?? null;
  if (reviewBookingId !== currentBookingId) {
    return NextResponse.json(
      { error: "Stale review: patient has a newer booking cycle" },
      { status: 409 }
    );
  }

  const filteredReviews = store.review_items.filter((item) => item.id !== reviewId);
  const status = calculatePatientReminderStatus(
    patient,
    settings,
    store.bookings,
    store.reminder_logs,
    filteredReviews
  );
  if (status !== "Ready") {
    return NextResponse.json(
      { error: `Patient not ready: ${status}` },
      { status: 409 }
    );
  }

  const phone = patient.normalized_phone;
  if (!phone || !/^\+?[0-9\s\-()]{6,20}$/.test(phone)) {
    return NextResponse.json(
      { error: `Ogiltigt telefonnummer: ${phone ?? ""}` },
      { status: 400 }
    );
  }

  if (settings.dry_run_mode) {
    const { data: dryRunLog, error: dryRunError } = await supabase
      .from("reminder_logs")
      .insert({
        patient_id: patient.id,
        booking_id: reviewBookingId,
        phone,
        message,
        status: "dry_run",
        sequence_number: sequenceNumber,
        is_cycle_reset: false,
        provider_message_id: null,
        skip_reason: null,
        error: null,
        sent_at: null,
      })
      .select()
      .single();

    if (dryRunError) {
      if (dryRunError.code === "23505") {
        return NextResponse.json(
          { status: "duplicate", error: "SMS-steget är redan reserverat" },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: dryRunError.message }, { status: 500 });
    }

    await updateReviewItem(reviewId, { status: "resolved" });
    return NextResponse.json({
      status: "dry_run",
      log: dryRunLog as ReminderLog,
    });
  }

  const { data: reservation, error: reserveError } = await supabase
    .from("reminder_logs")
    .insert({
      patient_id: patient.id,
      booking_id: reviewBookingId,
      phone,
      message,
      status: "pending",
      sequence_number: sequenceNumber,
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
      return NextResponse.json(
        { status: "duplicate", error: "SMS-steget är redan reserverat" },
        { status: 409 }
      );
    }
    console.error("[send-message] reserve insert failed", { code: reserveError.code, message: reserveError.message, patientId: patient.id, sequenceNumber });
    return NextResponse.json({ error: "Kunde inte reservera SMS-slot, försök igen" }, { status: 500 });
  }

  let result;
  try {
    result = await sendSms({ to: phone, message });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Oväntat SMS-leverantörsfel";
    return NextResponse.json(
      { status: "unknown", error: detail },
      { status: 502 }
    );
  }

  const finalLog = await updateReminderLog(reservation.id, {
    status: result.success ? "sent" : "failed",
    provider_message_id: result.providerMessageId ?? null,
    error: result.error ?? null,
    sent_at: result.success ? new Date().toISOString() : null,
  }, "pending");

  if (result.success) {
    await updateReviewItem(reviewId, { status: "resolved" });
  }

  return NextResponse.json(
    result.success
      ? { status: "sent", log: finalLog }
      : { status: "failed", error: result.error, log: finalLog },
    { status: result.success ? 200 : 502 }
  );
}
