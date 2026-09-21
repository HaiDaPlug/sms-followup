import "server-only";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSettings } from "@/lib/data/repository";
import { resolveSteps } from "@/lib/reminders/steps";
import { buildStockholmDayKeys, stockholmDayKey, windowStartIso } from "@/lib/analytics/dayKeys";
import { calculateConversionRate } from "@/lib/analytics/conversionRate";
import {
  calculateLifetimeStats,
  type LifetimeBooking,
  type LifetimeLog,
  type LifetimeStats,
} from "@/lib/analytics/lifetime";
import {
  DEFAULT_ATTRIBUTION_DAYS,
  filterByAttributionWindow,
  type AttributionDays,
} from "@/lib/analytics/attributionWindow";

/** Time range shown on the chart. Distinct from AttributionDays, which decides
 *  how long after an SMS a rebooking still counts as attributable. */
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
  /** Trigger day of the credited follow-up, when it can still be resolved. */
  step_day: number | null;
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
  /** Attribution window these conversions were filtered to. */
  attributionDays: AttributionDays;
  /** Recorded candidates that fell outside the attribution window. Surfaced so
   *  a narrow window doesn't look like missing data. */
  conversionsOutsideWindow: number;
  /** All-time performance, independent of the selected period. */
  lifetime: LifetimeStats;
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


export async function getAnalyticsData(
  days: AnalyticsDays,
  attributionDays: AttributionDays = DEFAULT_ATTRIBUTION_DAYS
): Promise<AnalyticsData> {
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
    reminder_log_id: string | null;
    match_type: string;
  };
  type LifetimeLogRecord = LifetimeLog;

  const [bookings, smsLogs, patients, conversions, lifetimeLogs, settings] = await Promise.all([
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
            "id, patient_id, patient_name, booking_effective_at, reminder_log_sent_at, days_since_sms, reminder_log_sequence_number, reminder_log_id, match_type"
          )
          .eq("cancelled", false)
          .gte("booking_effective_at", since)
          .order("booking_effective_at", { ascending: false })
          .order("id", { ascending: false }),
      "conversions"
    ),
    // All-time, unfiltered by period: the lifetime block answers "did they ever
    // come back", which no window can express.
    fetchAllRows<LifetimeLogRecord>(
      () =>
        supabase
          .from("reminder_logs")
          .select("id, patient_id, sent_at, step_id, step_day, sequence_number")
          .in("status", ["sent", "delivered"])
          .not("sent_at", "is", null)
          .order("id", { ascending: true }),
      "lifetime SMS logs"
    ),
    // Service role, server-side: reminder_settings is deliberately not readable
    // with the anon key, so step labels cannot come from the queries above.
    getSettings(),
  ]);


  // Bookings that could possibly follow an SMS. Anything recorded before the
  // first message ever sent can credit nothing, which excludes the bulk CSV
  // import outright.
  const firstSentAt = lifetimeLogs
    .map((l) => l.sent_at)
    .filter((s): s is string => !!s)
    .sort()
    .at(0) ?? null;

  type LifetimeBookingRecord = {
    id: string; patient_id: string | null; booking_at: string | null;
    event_created_at?: string | null; created_at: string; cancelled?: boolean;
  };
  const lifetimeBookingRows = firstSentAt
    ? await fetchAllRows<LifetimeBookingRecord>(
        () =>
          supabase
            .from("bookings")
            .select("id, patient_id, booking_at, event_created_at, created_at, cancelled")
            .eq("cancelled", false)
            .or(`event_created_at.gte.${firstSentAt},and(event_created_at.is.null,created_at.gte.${firstSentAt})`)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false }),
        "lifetime bookings"
      )
    : [];

  const lifetimeBookings: LifetimeBooking[] = lifetimeBookingRows.map((b) => ({
    id: b.id,
    patient_id: b.patient_id,
    recorded_at: b.event_created_at ?? b.created_at,
    booking_at: b.booking_at,
    cancelled: b.cancelled ?? false,
  }));

  const lifetime = calculateLifetimeStats(
    lifetimeLogs,
    lifetimeBookings,
    resolveSteps(settings).map((step) => ({ id: step.id, day: step.day, active: step.active })),
    attributionDays
  );

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

  // Conversions are stored at a 365-day lookback; narrow to the requested
  // attribution window here so the same rows can answer any window.
  const attributed = filterByAttributionWindow(conversions, attributionDays);

  // The credited SMS is labelled by its follow-up day rather than its position,
  // which is only meaningful against the step list as it stood at the time.
  const logDayById = new Map(
    lifetimeLogs.map((l) => [l.id, l.step_day ?? null] as const)
  );
  const conversionRows: AnalyticsConversionRow[] = attributed.map((c) => ({
    id: c.id,
    patient_name: c.patient_name,
    booking_effective_at: c.booking_effective_at,
    reminder_log_sent_at: c.reminder_log_sent_at,
    days_since_sms: c.days_since_sms,
    sequence_number: c.reminder_log_sequence_number,
    step_day: c.reminder_log_id ? (logDayById.get(c.reminder_log_id) ?? null) : null,
  }));

  const { smsPatientCount, conversionRate } = calculateConversionRate(
    smsLogs.map((l) => l.patient_id),
    attributed.map((c) => c.patient_id)
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
    attributionDays,
    conversionsOutsideWindow: conversions.length - attributed.length,
    lifetime,
  };
}
