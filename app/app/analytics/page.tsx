import { AnalyticsChart } from "@/components/AnalyticsChart";
import { createSupabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function weekKey(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay() === 0 ? 6 : d.getDay() - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  return monday.toISOString().slice(0, 10);
}

export default async function AnalyticsPage() {
  const days = 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const supabase = await createSupabaseServer();

  const [{ data: bookings }, { data: smsLogs }, { data: patients }] = await Promise.all([
    supabase
      .from("bookings")
      .select("id, booking_at, patient_id, treatment, service_name, practitioner_name, location_name, source, cancelled, bokadirekt_booking_id")
      .gte("booking_at", since)
      .order("booking_at", { ascending: false }),
    supabase
      .from("reminder_logs")
      .select("id, created_at, status, sequence_number, patient_id")
      .in("status", ["sent", "dry_run", "delivered"])
      .gte("created_at", since),
    supabase
      .from("patients")
      .select("id, full_name"),
  ]);

  const bookingsByWeek: Record<string, number> = {};
  for (const b of bookings ?? []) {
    if (!b.booking_at) continue;
    const k = weekKey(b.booking_at);
    bookingsByWeek[k] = (bookingsByWeek[k] ?? 0) + 1;
  }

  const smsByWeek: Record<string, number> = {};
  for (const l of smsLogs ?? []) {
    const k = weekKey(l.created_at);
    smsByWeek[k] = (smsByWeek[k] ?? 0) + 1;
  }

  const allWeeks = [...new Set([...Object.keys(bookingsByWeek), ...Object.keys(smsByWeek)])].sort();
  const series = allWeeks.map((week) => ({
    week,
    bookings: bookingsByWeek[week] ?? 0,
    sms: smsByWeek[week] ?? 0,
  }));

  const patientMap = new Map((patients ?? []).map((p) => [p.id, p]));
  const bookingRows = (bookings ?? [])
    .filter((b) => b.booking_at)
    .map((b) => ({
      id: b.id,
      booking_at: b.booking_at as string,
      patient_name: b.patient_id ? (patientMap.get(b.patient_id)?.full_name ?? null) : null,
      treatment: b.service_name ?? b.treatment ?? null,
      practitioner: b.practitioner_name ?? null,
      location: b.location_name ?? null,
      source: b.source,
      cancelled: b.cancelled ?? false,
      via_webhook: !!b.bokadirekt_booking_id,
    }));

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Analys</h2>
          <p className="page-subtitle">Bokningar och SMS-utskick över tid — se om utskicken driver återbesök.</p>
        </div>
      </div>
      <AnalyticsChart
        initialSeries={series}
        initialBookings={bookingRows}
        initialDays={days}
      />
    </>
  );
}
