import "server-only";
import { createSupabaseServer } from "@/lib/supabase/server";

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
  days: number;
}

const TZ = "Europe/Stockholm";

function stockholmDayKey(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: TZ }); // "YYYY-MM-DD"
}

function stockholmYmdOf(date: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

// DST-safe: Stockholm midnight -> UTC instant, via iterative offset correction.
// Each pass recomputes the Stockholm UTC offset from the current guess, but
// always applies it against the fixed target wall-clock time (not against the
// previous guess) — applying it against the evolving guess would compound the
// correction on the second pass instead of converging.
function stockholmWallClockAsUtc(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
}

// Derive Stockholm's offset without parsing in the server process timezone.

function stockholmMidnightToUtc(y: number, m: number, d: number): Date {
  const target = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const offsetMs = stockholmWallClockAsUtc(new Date(guess)) - guess;
    guess = target - offsetMs;
  }
  return new Date(guess);
}

// Pure calendar-day arithmetic anchored at UTC noon (never crosses a local DST
// edge because it never represents a local wall-clock instant) — safe to
// subtract whole days with plain millisecond math.
function buildStockholmDayKeys(days: number, now: Date): string[] {
  const today = stockholmYmdOf(now);
  const anchorUtcNoon = Date.UTC(today.y, today.m - 1, today.d, 12, 0, 0);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(new Date(anchorUtcNoon - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  return keys;
}

export async function getAnalyticsData(days: AnalyticsDays): Promise<AnalyticsData> {
  const now = new Date();
  const dayKeys = buildStockholmDayKeys(days, now);
  const [oldestY, oldestM, oldestD] = dayKeys[0].split("-").map(Number);
  const since = stockholmMidnightToUtc(oldestY, oldestM, oldestD).toISOString();

  const supabase = await createSupabaseServer();

  const [bookingsResult, smsLogsResult, patientsResult, conversionsResult] = await Promise.all([
      supabase
        .from("bookings")
        .select(
          "id, booking_at, event_created_at, created_at, patient_id, treatment, service_name, practitioner_name, location_name, source, cancelled, bokadirekt_booking_id"
        )
        .or(`event_created_at.gte.${since},and(event_created_at.is.null,created_at.gte.${since})`)
        .order("created_at", { ascending: false }),
      supabase
        .from("reminder_logs")
        .select("id, sent_at, status, sequence_number, patient_id")
        .in("status", ["sent", "delivered"])
        .gte("sent_at", since),
      supabase.from("patients").select("id, full_name"),
      supabase
        .from("sms_conversions")
        .select(
          "id, patient_name, booking_effective_at, reminder_log_sent_at, days_since_sms, reminder_log_sequence_number"
        )
        .eq("cancelled", false)
        .gte("booking_effective_at", since)
        .order("booking_effective_at", { ascending: false }),
    ]);

  if (bookingsResult.error) {
    throw new Error(`Failed to load analytics bookings: ${bookingsResult.error.message}`);
  }
  if (smsLogsResult.error) {
    throw new Error(`Failed to load analytics SMS logs: ${smsLogsResult.error.message}`);
  }
  if (patientsResult.error) {
    throw new Error(`Failed to load analytics patients: ${patientsResult.error.message}`);
  }
  if (conversionsResult.error) {
    throw new Error(`Failed to load analytics conversions: ${conversionsResult.error.message}`);
  }

  const bookings = bookingsResult.data;
  const smsLogs = smsLogsResult.data;
  const patients = patientsResult.data;
  const conversions = conversionsResult.data;


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

  return {
    series,
    bookings: bookingRows,
    conversions: conversionRows,
    activeBookingsCount,
    smsSentCount,
    days,
  };
}
