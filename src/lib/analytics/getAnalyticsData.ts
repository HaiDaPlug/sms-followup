import "server-only";
import { createSupabaseServer } from "@/lib/supabase/server";
import { buildStockholmDayKeys, stockholmDayKey, windowStartIso } from "@/lib/analytics/dayKeys";
import { calculateConversionRate } from "@/lib/analytics/conversionRate";

export type AnalyticsDays = 30 | 90 | 180 | 365;

export interface AnalyticsSeriesPoint {
  day: string;
  bookings: number;
  sms: number;
}

export interface AnalyticsBookingRow {
  id: string;
  recorded_at: string; // event_created_at ?? created_at — when the booking entered the system
  booking_at: string | null; // the actual appointment date/time
  patient_name: string | null;
  treatment: string | null;
  practitioner: string | null;
  location: string | null;
  source: string;
  cancelled: boolean;
  via_webhook: boolean;
}

export interface AnalyticsConversionRow {
  id: string;
  patient_name: string | null;
  booking_effective_at: string;
  reminder_log_sent_at: string;
  days_since_sms: number;
  sequence_number: number | null;
}

export interface AnalyticsData {
  series: AnalyticsSeriesPoint[];
  bookings: AnalyticsBookingRow[];
  conversions: AnalyticsConversionRow[];
  activeBookingsCount: number;
  smsSentCount: number;
  /** Distinct patients who received at least one SMS in the window. */
  smsPatientCount: number;
  /** Distinct patients who received an SMS and then rebooked, as a share of
   *  smsPatientCount (0-1). Null when no SMS went out in the window. */
  conversionRate: number | null;
  days: number;
}

/**
 * PostgREST caps a response at 1000 rows. Every analytics query can exceed
 * that on a busy clinic, and the truncation is silent: counts under-report and
 * patient names go missing with no error surfaced. Page explicitly until a
 * short page comes back.
 */
const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // 50k rows — a hard stop so a runaway query can't hang the page

type PagedQuery<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
};

async function fetchAllRows<T>(
  build: () => PagedQuery<T>,
  label: string
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to load analytics ${label}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  console.warn(`[analytics] ${label} hit the ${MAX_PAGES * PAGE_SIZE}-row ceiling; results truncated`);
  return rows;
}


export async function getAnalyticsData(days: AnalyticsDays): Promise<AnalyticsData> {
  const now = new Date();
  const dayKeys = buildStockholmDayKeys(days, now);
  const since = windowStartIso(dayKeys);

  const supabase = await createSupabaseServer();

  type BookingRecord = {
    id: string; booking_at: string | null; event_created_at?: string | null; created_at: string;
    patient_id: string | null; treatment?: string | null; service_name?: string | null;
    practitioner_name?: string | null; location_name?: string | null; source: string;
    cancelled?: boolean; bokadirekt_booking_id?: string | null;
  };
  type SmsLogRecord = {
    id: string; sent_at: string | null; status: string;
    sequence_number: number | null; patient_id: string | null;
  };
  type PatientRecord = { id: string; full_name: string | null };
  type ConversionRecord = {
    id: string; patient_id: string | null; patient_name: string | null;
    booking_effective_at: string; reminder_log_sent_at: string;
    days_since_sms: number; reminder_log_sequence_number: number | null;
    match_type: string;
  };

  const [bookings, smsLogs, patients, conversions] = await Promise.all([
    fetchAllRows<BookingRecord>(
      () =>
        supabase
          .from("bookings")
          .select(
            "id, booking_at, event_created_at, created_at, patient_id, treatment, service_name, practitioner_name, location_name, source, cancelled, bokadirekt_booking_id"
          )
          .or(`event_created_at.gte.${since},and(event_created_at.is.null,created_at.gte.${since})`)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }),
      "bookings"
    ),
    fetchAllRows<SmsLogRecord>(
      () =>
        supabase
          .from("reminder_logs")
          .select("id, sent_at, status, sequence_number, patient_id")
          .in("status", ["sent", "delivered"])
          .gte("sent_at", since)
          .order("id", { ascending: true }),
      "SMS logs"
    ),
    fetchAllRows<PatientRecord>(
      () => supabase.from("patients").select("id, full_name").order("id", { ascending: true }),
      "patients"
    ),
    fetchAllRows<ConversionRecord>(
      () =>
        supabase
          .from("sms_conversions")
          .select(
            "id, patient_id, patient_name, booking_effective_at, reminder_log_sent_at, days_since_sms, reminder_log_sequence_number, match_type"
          )
          .eq("cancelled", false)
          .gte("booking_effective_at", since)
          .order("booking_effective_at", { ascending: false })
          .order("id", { ascending: false }),
      "conversions"
    ),
  ]);


  const bookingsByDay: Record<string, number> = {};
  for (const b of bookings ?? []) {
    if ((b as { cancelled?: boolean }).cancelled) continue;
    const effectiveDate = (b as { event_created_at?: string | null }).event_created_at ?? b.created_at;
    if (!effectiveDate) continue;
    const k = stockholmDayKey(new Date(effectiveDate));
    bookingsByDay[k] = (bookingsByDay[k] ?? 0) + 1;
  }

  const smsByDay: Record<string, number> = {};
  for (const l of smsLogs ?? []) {
    if (!l.sent_at) continue;
    const k = stockholmDayKey(new Date(l.sent_at));
    smsByDay[k] = (smsByDay[k] ?? 0) + 1;
  }

  const series: AnalyticsSeriesPoint[] = dayKeys.map((day) => ({
    day,
    bookings: bookingsByDay[day] ?? 0,
    sms: smsByDay[day] ?? 0,
  }));

  const patientMap = new Map((patients ?? []).map((p) => [p.id, p]));
  const bookingRows: AnalyticsBookingRow[] = (bookings ?? []).map((b) => ({
    id: b.id,
    recorded_at: (b as { event_created_at?: string | null }).event_created_at ?? b.created_at,
    booking_at: b.booking_at,
    patient_name: b.patient_id ? (patientMap.get(b.patient_id)?.full_name ?? null) : null,
    treatment: (b as { service_name?: string | null }).service_name ?? b.treatment ?? null,
    practitioner: (b as { practitioner_name?: string | null }).practitioner_name ?? null,
    location: (b as { location_name?: string | null }).location_name ?? null,
    source: b.source,
    cancelled: (b as { cancelled?: boolean }).cancelled ?? false,
    via_webhook: !!(b as { bokadirekt_booking_id?: string | null }).bokadirekt_booking_id,
  }));

  const activeBookingsCount = bookingRows.filter((b) => !b.cancelled).length;
  const smsSentCount = smsLogs?.length ?? 0;

  const conversionRows: AnalyticsConversionRow[] = (conversions ?? []).map((c) => ({
    id: c.id,
    patient_name: c.patient_name,
    booking_effective_at: c.booking_effective_at,
    reminder_log_sent_at: c.reminder_log_sent_at,
    days_since_sms: c.days_since_sms,
    sequence_number: c.reminder_log_sequence_number,
  }));

  const { smsPatientCount, conversionRate } = calculateConversionRate(
    smsLogs.map((l) => l.patient_id),
    conversions.map((c) => c.patient_id)
  );

  return {
    series,
    bookings: bookingRows,
    conversions: conversionRows,
    activeBookingsCount,
    smsSentCount,
    smsPatientCount,
    conversionRate,
    days,
  };
}
