import { supabase } from "@/lib/supabase/client";
import type { Booking, ClinicStore, Patient, ReminderLog, ReminderSettings, ReviewItem } from "@/types/clinic";

/**
 * Read-only app pages can tolerate a few seconds of staleness. Sharing this
 * snapshot prevents every navbar transition from downloading the same five
 * complete tables again. Mutation and delivery paths use the uncached
 * readStore so safety checks always see live data.
 *
 * Why an in-process cache and not unstable_cache: the snapshot is ~2.3 MB and
 * Next's data cache refuses entries over 2 MB, so the previous
 * unstable_cache(readStore) never stored anything — every page paid the full
 * read, and logged "items over 2MB can not be cached". A module-level entry
 * has no size limit, and also de-duplicates reads that overlap in flight.
 *
 * Why a slimmer read than readStore: bookings.raw_data (the original CSV row,
 * about half the bookings payload) is never used by a page. Everything else is
 * the same query, in the same order, with the same row cap — so a status shown
 * in the UI is the status the engine computes from its own readStore().
 *
 * This lives outside repository.ts on purpose: repository.ts is a re-export
 * barrel, and defining a value export alongside those re-exports made Next's
 * build-time module analysis drop it for importers that resolve through the
 * barrel (eligibility.ts hit "has no exported member 'readStoreForUi'" during
 * `next build`, though `tsc --noEmit` accepted it). Library code should import
 * from here directly; repository.ts re-exports it for page-level callers.
 */

const TTL_MS = 3_000;

// Every Booking column except raw_data.
const BOOKING_UI_COLUMNS =
  "id,external_booking_id,patient_id,patient_name,phone,normalized_phone,email,booking_at,treatment,status,cancelled,source,event_created_at,created_at,updated_at";

let cached: { at: number; value: Promise<ClinicStore> } | null = null;

function check<T>(result: { data: T[] | null; error: { message: string } | null }, label: string): T[] {
  if (result.error) throw new Error(`Supabase ${label}: ${result.error.message}`);
  return result.data ?? [];
}

async function readUiStore(): Promise<ClinicStore> {
  const [patients, bookings, settings, logs, reviewItems] = await Promise.all([
    supabase.from("patients").select("*").order("created_at", { ascending: false }),
    supabase.from("bookings").select(BOOKING_UI_COLUMNS).order("created_at", { ascending: false }),
    supabase.from("reminder_settings").select("*").limit(1),
    supabase.from("reminder_logs").select("*").order("created_at", { ascending: false }),
    supabase.from("review_items").select("*").order("created_at", { ascending: false }),
  ]);

  return {
    patients: check(patients, "patients select") as Patient[],
    // raw_data is typed as required; pages never read it, so an empty object
    // keeps the type honest without shipping the column.
    bookings: (check(bookings, "bookings select") as unknown as Omit<Booking, "raw_data">[]).map(
      (b) => ({ ...b, raw_data: {} })
    ),
    reminder_settings: check(settings, "reminder_settings select") as ReminderSettings[],
    reminder_logs: check(logs, "reminder_logs select") as ReminderLog[],
    review_items: check(reviewItems, "review_items select") as ReviewItem[],
  };
}

export async function readStoreForUi(): Promise<ClinicStore> {
  const now = Date.now();
  if (!cached || now - cached.at >= TTL_MS) {
    const value = readUiStore();
    cached = { at: now, value };
    // A failed read must not be served to the next caller.
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
  }
  const store = await cached.value;
  // Callers share one snapshot: hand each its own arrays so an in-place sort
  // or filter on one page can never reorder another page's data.
  return {
    patients: [...store.patients],
    bookings: [...store.bookings],
    reminder_settings: [...store.reminder_settings],
    reminder_logs: [...store.reminder_logs],
    review_items: [...store.review_items],
  };
}
