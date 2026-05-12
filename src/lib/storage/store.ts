import { supabase } from "@/lib/supabase/client";
import type {
  Booking,
  ClinicStore,
  DailySnapshot,
  IncomingSms,
  Patient,
  ReminderLog,
  ReminderSettings,
  ReviewItem
} from "@/types/clinic";

const defaultTemplate1 =
  "Hej {{firstName}}! Det har gått 30 dagar sedan ditt senaste besök hos {{clinicName}}. Vill du boka en ny tid? Du kan boka här: {{bookingLink}}";

const defaultTemplate2 =
  "Hej {{firstName}}! Vi saknar dig på {{clinicName}}. Det har nu gått 60 dagar sedan ditt besök. Boka enkelt online: {{bookingLink}}";

const defaultTemplate3 =
  "Hej {{firstName}}! Det har gått 90 dagar sedan vi sågs på {{clinicName}}. Vi hoppas att allt är bra – kom gärna tillbaka! Boka här: {{bookingLink}}";

export function nowIso() {
  return new Date().toISOString();
}

export function createId(_prefix: string) {
  return crypto.randomUUID();
}

function defaultSettings(): Omit<ReminderSettings, "id" | "created_at" | "updated_at"> {
  return {
    days_after_booking: 30,
    send_time: "09:00",
    max_per_day: 25,
    sms_template: defaultTemplate1,
    sms_template_2: defaultTemplate2,
    sms_template_3: defaultTemplate3,
    sms_steps: null,
    booking_link: "",
    clinic_name: "Kliniken",
    is_active: true,
    dry_run_mode: true,
    allow_same_number_override: false
  };
}

function throwOnError<T>(data: T | null, error: { message: string } | null, label: string): T {
  if (error) throw new Error(`Supabase ${label}: ${error.message}`);
  if (data === null) throw new Error(`Supabase ${label}: no data returned`);
  return data;
}

// ---------------------------------------------------------------------------
// Read full store (used by eligibility / process modules that need everything)
// ---------------------------------------------------------------------------

export async function readStoreForImport(): Promise<Pick<ClinicStore, "patients" | "bookings">> {
  const [patients, bookings] = await Promise.all([
    supabase.from("patients").select("*"),
    supabase.from("bookings").select("id,external_booking_id,patient_id,booking_at,treatment,status,created_at")
  ]);
  throwOnError(patients.data, patients.error, "patients select");
  throwOnError(bookings.data, bookings.error, "bookings select");
  return {
    patients: (patients.data ?? []) as Patient[],
    bookings: (bookings.data ?? []) as Booking[]
  };
}

export async function readStore(): Promise<ClinicStore> {
  const [patients, bookings, settings, logs, reviewItems] = await Promise.all([
    supabase.from("patients").select("*").order("created_at", { ascending: false }),
    supabase.from("bookings").select("*").order("created_at", { ascending: false }),
    supabase.from("reminder_settings").select("*").limit(1),
    supabase.from("reminder_logs").select("*").order("created_at", { ascending: false }),
    supabase.from("review_items").select("*").order("created_at", { ascending: false })
  ]);

  throwOnError(patients.data, patients.error, "patients select");
  throwOnError(bookings.data, bookings.error, "bookings select");
  throwOnError(settings.data, settings.error, "reminder_settings select");
  throwOnError(logs.data, logs.error, "reminder_logs select");
  throwOnError(reviewItems.data, reviewItems.error, "review_items select");

  return {
    patients: (patients.data ?? []) as Patient[],
    bookings: (bookings.data ?? []) as Booking[],
    reminder_settings: (settings.data ?? []) as ReminderSettings[],
    reminder_logs: (logs.data ?? []) as ReminderLog[],
    review_items: (reviewItems.data ?? []) as ReviewItem[]
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<ReminderSettings> {
  const { data, error } = await supabase
    .from("reminder_settings")
    .select("*")
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Supabase getSettings: ${error.message}`);
  if (!data) {
    const defaults = defaultSettings();
    const { data: inserted, error: insertError } = await supabase
      .from("reminder_settings")
      .insert(defaults)
      .select()
      .single();
    throwOnError(inserted, insertError, "reminder_settings insert defaults");
    return inserted as ReminderSettings;
  }
  return data as ReminderSettings;
}

export async function updateSettings(input: Partial<ReminderSettings>): Promise<ReminderSettings> {
  const current = await getSettings();
  const updated: ReminderSettings = {
    ...current,
    ...input,
    days_after_booking: Number(input.days_after_booking ?? current.days_after_booking),
    max_per_day: Number(input.max_per_day ?? current.max_per_day),
    is_active: input.is_active ?? current.is_active,
    dry_run_mode: input.dry_run_mode ?? current.dry_run_mode,
    allow_same_number_override: input.allow_same_number_override ?? current.allow_same_number_override ?? false,
    updated_at: nowIso()
  };
  const { data, error } = await supabase
    .from("reminder_settings")
    .update(updated)
    .eq("id", current.id)
    .select()
    .single();
  throwOnError(data, error, "reminder_settings update");
  return data as ReminderSettings;
}

// ---------------------------------------------------------------------------
// Reminder logs
// ---------------------------------------------------------------------------

export async function addReminderLog(
  log: Omit<ReminderLog, "id" | "created_at">
): Promise<ReminderLog> {
  const { data, error } = await supabase
    .from("reminder_logs")
    .insert(log)
    .select()
    .single();
  throwOnError(data, error, "reminder_logs insert");
  return data as ReminderLog;
}

export async function resetPatientCycle(
  patientId: string,
  bookingId: string | null
): Promise<ReminderLog> {
  return addReminderLog({
    patient_id: patientId,
    booking_id: bookingId,
    phone: null,
    message: "",
    status: "cycle_reset",
    sequence_number: null,
    is_cycle_reset: true,
    provider_message_id: null,
    skip_reason: null,
    error: null,
    sent_at: null
  });
}

// ---------------------------------------------------------------------------
// Review items
// ---------------------------------------------------------------------------

export async function addReviewItem(
  item: Omit<ReviewItem, "id" | "created_at" | "updated_at">
): Promise<ReviewItem> {
  const { data, error } = await supabase
    .from("review_items")
    .insert(item)
    .select()
    .single();
  throwOnError(data, error, "review_items insert");
  return data as ReviewItem;
}

export async function updateReviewItem(
  id: string,
  patch: Partial<Pick<ReviewItem, "status">>
): Promise<ReviewItem | null> {
  const { data, error } = await supabase
    .from("review_items")
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", id)
    .select()
    .single();
  if (error?.code === "PGRST116") return null; // row not found
  throwOnError(data, error, "review_items update");
  return data as ReviewItem;
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export async function upsertPatient(patient: Patient): Promise<Patient> {
  const { data, error } = await supabase
    .from("patients")
    .upsert(patient, { onConflict: "id" })
    .select()
    .single();
  throwOnError(data, error, "patients upsert");
  return data as Patient;
}

export async function updatePatient(
  id: string,
  patch: Partial<Patient>
): Promise<Patient | null> {
  const { data, error } = await supabase
    .from("patients")
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", id)
    .select()
    .single();
  if (error?.code === "PGRST116") return null;
  throwOnError(data, error, "patients update");
  return data as Patient;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export async function upsertBooking(booking: Booking): Promise<Booking> {
  const { data, error } = await supabase
    .from("bookings")
    .upsert(booking, { onConflict: "id" })
    .select()
    .single();
  throwOnError(data, error, "bookings upsert");
  return data as Booking;
}

export async function bulkUpsertPatients(patients: Patient[]): Promise<Patient[]> {
  if (patients.length === 0) return [];
  const { data, error } = await supabase
    .from("patients")
    .upsert(patients, { onConflict: "id" })
    .select();
  throwOnError(data, error, "patients bulk upsert");
  return (data ?? []) as Patient[];
}

export async function bulkUpsertBookings(bookings: Booking[]): Promise<Booking[]> {
  if (bookings.length === 0) return [];
  const { data, error } = await supabase
    .from("bookings")
    .upsert(bookings, { onConflict: "external_booking_id" })
    .select();
  throwOnError(data, error, "bookings bulk upsert");
  return (data ?? []) as Booking[];
}

export async function bulkAddReviewItems(
  items: Omit<ReviewItem, "id" | "created_at" | "updated_at">[]
): Promise<void> {
  if (items.length === 0) return;

  const withHash = items.filter((i) => i.content_hash);
  const withoutHash = items.filter((i) => !i.content_hash);

  if (withHash.length > 0) {
    const hashes = withHash.map((i) => i.content_hash as string);
    const { data: existing, error: fetchError } = await supabase
      .from("review_items")
      .select("content_hash")
      .in("content_hash", hashes);
    if (fetchError) throw new Error(`Supabase review_items fetch: ${fetchError.message}`);
    const existingSet = new Set((existing ?? []).map((r: { content_hash: string }) => r.content_hash));
    const newItems = withHash.filter((i) => !existingSet.has(i.content_hash as string));
    if (newItems.length > 0) {
      const { error } = await supabase.from("review_items").insert(newItems);
      if (error) throw new Error(`Supabase review_items insert: ${error.message}`);
    }
  }

  if (withoutHash.length > 0) {
    const { error } = await supabase.from("review_items").insert(withoutHash);
    if (error) throw new Error(`Supabase review_items insert: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Touch helpers (kept for callers that use them)
// ---------------------------------------------------------------------------

export function touchPatient(patient: Patient): Patient {
  return { ...patient, updated_at: nowIso() };
}

export function touchBooking(booking: Booking): Booking {
  return { ...booking, updated_at: nowIso() };
}

// ---------------------------------------------------------------------------
// updateStore — not supported with Supabase; kept as a compile-time trap
// so callers produce a clear error at build time rather than silently passing.
// ---------------------------------------------------------------------------

export async function writeStore(_store: ClinicStore): Promise<void> {
  throw new Error("writeStore is not supported with Supabase. Use targeted operations.");
}

export async function updateStore<T>(
  _mutator: (store: ClinicStore) => T | Promise<T>
): Promise<T> {
  throw new Error("updateStore is not supported with Supabase. Use targeted operations.");
}

// ---------------------------------------------------------------------------
// Daily snapshots
// ---------------------------------------------------------------------------

export async function insertDailySnapshot(
  snapshot: Omit<DailySnapshot, "id" | "snapped_at">
): Promise<void> {
  const { error } = await supabase.from("daily_snapshots").insert(snapshot);
  if (error) throw new Error(`Supabase daily_snapshots insert: ${error.message}`);
}

export async function getDailySnapshots(limitDays = 90): Promise<DailySnapshot[]> {
  const since = new Date(Date.now() - limitDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("daily_snapshots")
    .select("*")
    .gte("snapped_at", since)
    .order("snapped_at", { ascending: false });
  if (error) throw new Error(`Supabase daily_snapshots select: ${error.message}`);
  return (data ?? []) as DailySnapshot[];
}

// ---------------------------------------------------------------------------
// Incoming SMS
// ---------------------------------------------------------------------------

export async function insertIncomingSms(
  sms: Omit<IncomingSms, "created_at">
): Promise<IncomingSms> {
  const { data, error } = await supabase
    .from("incoming_sms")
    .upsert(sms, { onConflict: "id" })
    .select()
    .single();
  if (error) throw new Error(`Supabase incoming_sms insert: ${error.message}`);
  return data as IncomingSms;
}

export async function getIncomingSms(limit = 100): Promise<IncomingSms[]> {
  const { data, error } = await supabase
    .from("incoming_sms")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Supabase incoming_sms select: ${error.message}`);
  return (data ?? []) as IncomingSms[];
}

export async function getIncomingSmsForPatient(patientId: string): Promise<IncomingSms[]> {
  const { data, error } = await supabase
    .from("incoming_sms")
    .select("*")
    .eq("patient_id", patientId)
    .order("received_at", { ascending: false });
  if (error) throw new Error(`Supabase incoming_sms select: ${error.message}`);
  return (data ?? []) as IncomingSms[];
}

export async function markIncomingSmsReplied(
  id: string,
  reply: { reply_message: string; reply_provider_id: string | null; replied_at: string }
): Promise<void> {
  const { error } = await supabase
    .from("incoming_sms")
    .update(reply)
    .eq("id", id);
  if (error) throw new Error(`Supabase incoming_sms update: ${error.message}`);
}
