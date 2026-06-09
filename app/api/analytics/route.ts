import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";

function weekKey(dateStr: string): string {
  const d = new Date(dateStr);
  // ISO week start = Monday
  const day = d.getDay() === 0 ? 6 : d.getDay() - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  return monday.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = Math.min(Number(searchParams.get("days") ?? 90), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const supabase = await createSupabaseServer();

  const [{ data: bookings }, { data: smsLogs }, { data: patients }] = await Promise.all([
    supabase
      .from("bookings")
      .select("id, booking_at, event_created_at, created_at, patient_id, treatment, service_name, practitioner_name, location_name, source, cancelled, bokadirekt_booking_id")
      .or(`event_created_at.gte.${since},and(event_created_at.is.null,created_at.gte.${since})`)
      .order("created_at", { ascending: false }),
    supabase
      .from("reminder_logs")
      .select("id, created_at, status, sequence_number, patient_id")
      .in("status", ["sent", "delivered"])
      .gte("created_at", since),
    supabase
      .from("patients")
      .select("id, full_name, first_name, last_name, normalized_phone, last_booking_at"),
  ]);

  // Group bookings by week of booking creation (EventCreated ?? created_at)
  const bookingsByWeek: Record<string, number> = {};
  for (const b of bookings ?? []) {
    const effectiveDate = (b as { event_created_at?: string | null }).event_created_at ?? b.created_at;
    if (!effectiveDate) continue;
    const k = weekKey(effectiveDate);
    bookingsByWeek[k] = (bookingsByWeek[k] ?? 0) + 1;
  }

  // Group SMS by week
  const smsByWeek: Record<string, number> = {};
  for (const l of smsLogs ?? []) {
    const k = weekKey(l.created_at);
    smsByWeek[k] = (smsByWeek[k] ?? 0) + 1;
  }

  // Build unified week axis (all weeks that appear in either dataset)
  const allWeeks = [...new Set([...Object.keys(bookingsByWeek), ...Object.keys(smsByWeek)])].sort();

  const series = allWeeks.map((week) => ({
    week,
    bookings: bookingsByWeek[week] ?? 0,
    sms: smsByWeek[week] ?? 0,
  }));

  // Enrich bookings list with patient name for the table
  const patientMap = new Map((patients ?? []).map((p) => [p.id, p]));
  const bookingRows = (bookings ?? [])
    .map((b) => ({
      id: b.id,
      booking_at: b.booking_at,
      patient_name: b.patient_id ? (patientMap.get(b.patient_id)?.full_name ?? null) : null,
      treatment: b.service_name ?? b.treatment ?? null,
      practitioner: b.practitioner_name ?? null,
      location: b.location_name ?? null,
      source: b.source,
      cancelled: b.cancelled,
      via_webhook: !!b.bokadirekt_booking_id,
    }));

  return NextResponse.json({ series, bookings: bookingRows, days });
}
