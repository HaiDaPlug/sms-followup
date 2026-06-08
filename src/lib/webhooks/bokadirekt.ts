import { readStore, addReviewItem, resetPatientCycle } from "@/lib/data/repository";
import { normalizePhone } from "@/lib/import/normalizers";
import { createSupabaseServer } from "@/lib/supabase/server";

interface BokaDirektCustomer {
  Id: string;
  MobilePhoneNumber: string;
  PhoneNumber: string;
  FirstName: string;
  LastName: string;
  EmailAdress: string; // BokaDirekt typo — "Adress" not "Address"
  SocialSecurityNumber: string | null;
  NewCustomer: boolean;
}

interface BokaDirektPayload {
  Id: string;
  LocationId: string;
  LocationName: string;
  PersonId: string;
  PersonName: string;
  ServiceId: string;
  ServiceName: string;
  BookingPrice: number;
  BookingStartDate: string;
  BookingEndDate: string;
  Customer: BokaDirektCustomer;
  EventCreated: string;
  BookedOnline: boolean;
  Cancelled: boolean;
  NewCustomer: boolean;
  Note: string;
}

type MatchTier = "bokadirekt_id" | "phone" | "email" | "none";

interface MatchResult {
  patientId: string | null;
  tier: MatchTier;
  matchedOn: string;
}

function findPatientMatch(booking: BokaDirektPayload, store: Awaited<ReturnType<typeof readStore>>): MatchResult {
  const customer = booking.Customer;
  const phone = normalizePhone(customer.MobilePhoneNumber || customer.PhoneNumber);
  const email = customer.EmailAdress?.toLowerCase();

  // Tier 1: BokaDirekt customer ID
  const byExternalId = store.patients.find(
    (p) => (p as Record<string, unknown>).bokadirekt_customer_id === customer.Id
  );
  if (byExternalId) {
    return { patientId: byExternalId.id, tier: "bokadirekt_id", matchedOn: `BokaDirekt ID ${customer.Id}` };
  }

  // Tier 2: normalized phone
  if (phone) {
    const byPhone = store.patients.find((p) => p.normalized_phone === phone);
    if (byPhone) {
      return { patientId: byPhone.id, tier: "phone", matchedOn: `telefon ${phone}` };
    }
  }

  // Tier 3: email
  if (email) {
    const byEmail = store.patients.find((p) => p.email?.toLowerCase() === email);
    if (byEmail) {
      return { patientId: byEmail.id, tier: "email", matchedOn: `e-post ${customer.EmailAdress}` };
    }
  }

  return { patientId: null, tier: "none", matchedOn: "ingen matchning hittad" };
}

export async function handleBokaDirektWebhook(
  payload: Record<string, unknown>,
  eventType: string
) {
  const booking = payload as unknown as BokaDirektPayload;
  const customer = booking.Customer;

  if (!customer?.MobilePhoneNumber && !customer?.PhoneNumber && !customer?.EmailAdress) {
    return { ok: false, error: "no customer contact info" };
  }

  if (eventType === "BookingCancelled" || booking.Cancelled) {
    return handleCancellation(booking);
  }

  if (eventType === "BookingCreated" || eventType === "BookingUpdated") {
    return stageForReview(booking);
  }

  return { ok: false, error: `unhandled event type: ${eventType}` };
}

async function stageForReview(booking: BokaDirektPayload) {
  const store = await readStore();
  const match = findPatientMatch(booking, store);
  const customer = booking.Customer;

  const matchedPatient = match.patientId
    ? store.patients.find((p) => p.id === match.patientId)
    : null;

  const tierLabel: Record<MatchTier, string> = {
    bokadirekt_id: "Exakt (BokaDirekt-ID)",
    phone:         "Exakt (telefon)",
    email:         "Exakt (e-post)",
    none:          "Ingen matchning",
  };

  await addReviewItem({
    type: "pending_booking_match",
    severity: match.patientId ? "low" : "medium",
    title: match.patientId
      ? `Ny bokning — ${customer.FirstName} ${customer.LastName} matchar ${matchedPatient?.full_name}`
      : `Ny bokning — ${customer.FirstName} ${customer.LastName} — ingen befintlig patient`,
    description: [
      `Inkommande: ${customer.FirstName} ${customer.LastName}, ${customer.MobilePhoneNumber || customer.PhoneNumber}, ${customer.EmailAdress}`,
      `Tjänst: ${booking.ServiceName} hos ${booking.PersonName} den ${new Date(booking.BookingStartDate).toLocaleDateString("sv-SE")}`,
      `Matchning: ${tierLabel[match.tier]} — ${match.matchedOn}`,
    ].join(" · "),
    suggested_action: match.patientId
      ? "Bekräfta matchning för att återstarta SMS-sekvensen från dag 0."
      : "Bekräfta för att skapa ny patient och starta SMS-sekvens.",
    status: "open",
    raw_data: {
      booking,
      match_patient_id: match.patientId,
      match_tier: match.tier,
      match_on: match.matchedOn,
    },
  });

  return { ok: true, staged: true, matchTier: match.tier, matchedPatientId: match.patientId };
}

export async function confirmBookingMatch(
  reviewItemId: string,
  patientId: string | null // null = create new patient
) {
  const supabase = await createSupabaseServer();

  // Load the review item to get the booking payload
  const { data: item } = await supabase
    .from("review_items")
    .select("raw_data")
    .eq("id", reviewItemId)
    .single();

  if (!item) throw new Error("Review item not found");

  const booking = (item.raw_data as Record<string, unknown>).booking as BokaDirektPayload;
  const customer = booking.Customer;
  const rawPhone = customer.MobilePhoneNumber || customer.PhoneNumber;
  const phone = normalizePhone(rawPhone);
  const fullName = `${customer.FirstName} ${customer.LastName}`.trim();

  let resolvedPatientId = patientId;

  if (!resolvedPatientId) {
    // Create new patient
    const { data: newPatient, error } = await supabase
      .from("patients")
      .insert({
        bokadirekt_customer_id: customer.Id,
        full_name: fullName,
        first_name: customer.FirstName,
        last_name: customer.LastName,
        phone: rawPhone,
        normalized_phone: phone,
        email: customer.EmailAdress,
        source: "bokadirekt_webhook",
      })
      .select("id")
      .single();

    if (error || !newPatient) throw new Error(`Failed to create patient: ${error?.message}`);
    resolvedPatientId = newPatient.id;
  } else {
    // Update existing patient with BokaDirekt customer ID and latest contact info
    await supabase
      .from("patients")
      .update({
        bokadirekt_customer_id: customer.Id,
        first_name: customer.FirstName,
        last_name: customer.LastName,
        phone: rawPhone,
        normalized_phone: phone,
        email: customer.EmailAdress,
      })
      .eq("id", resolvedPatientId);
  }

  // Upsert the booking record
  const { data: upsertedBooking } = await supabase
    .from("bookings")
    .upsert(
      {
        bokadirekt_booking_id: booking.Id,
        patient_id: resolvedPatientId,
        patient_name: fullName,
        phone: rawPhone,
        normalized_phone: phone,
        email: customer.EmailAdress,
        booking_at: booking.BookingStartDate,
        treatment: booking.ServiceName,
        service_name: booking.ServiceName,
        practitioner_name: booking.PersonName,
        booking_date: booking.BookingStartDate,
        location_name: booking.LocationName,
        price: booking.BookingPrice,
        booked_online: booking.BookedOnline,
        cancelled: false,
        source: "bokadirekt_webhook",
        raw_data: booking,
      },
      { onConflict: "bokadirekt_booking_id", ignoreDuplicates: false }
    )
    .select("id")
    .single();

  // Reset SMS cycle — this is the moment the sequence restarts
  await resetPatientCycle(resolvedPatientId, upsertedBooking?.id ?? null);

  // Mark review item resolved
  await supabase
    .from("review_items")
    .update({ status: "resolved" })
    .eq("id", reviewItemId);

  return { ok: true, patientId: resolvedPatientId };
}

async function handleCancellation(booking: BokaDirektPayload) {
  const supabase = await createSupabaseServer();

  await supabase
    .from("bookings")
    .update({ cancelled: true })
    .eq("bokadirekt_booking_id", booking.Id);

  return { ok: true, cancelled: true, bookingId: booking.Id };
}
