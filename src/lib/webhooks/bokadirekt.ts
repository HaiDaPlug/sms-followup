import { readStore } from "@/lib/data/repository";
import { normalizePhone } from "@/lib/import/normalizers";
import { supabase } from "@/lib/supabase/client";

interface BokaDirektCustomer {
  Id: string;
  MobilePhoneNumber: string;
  PhoneNumber: string;
  FirstName: string;
  LastName: string;
  EmailAdress: string; // BokaDirekt typo: "Adress" not "Address"
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

function findPatientMatch(
  booking: BokaDirektPayload,
  store: Awaited<ReturnType<typeof readStore>>
): MatchResult {
  const customer = booking.Customer;
  const phone = normalizePhone(customer.MobilePhoneNumber || customer.PhoneNumber);
  const email = customer.EmailAdress?.toLowerCase();

  const byExternalId = store.patients.find(
    (patient) => patient.bokadirekt_customer_id === customer.Id
  );
  if (byExternalId) {
    return {
      patientId: byExternalId.id,
      tier: "bokadirekt_id",
      matchedOn: `BokaDirekt ID ${customer.Id}`,
    };
  }

  if (phone) {
    const byPhone = store.patients.find(
      (patient) => patient.normalized_phone === phone
    );
    if (byPhone) {
      return {
        patientId: byPhone.id,
        tier: "phone",
        matchedOn: `telefon ${phone}`,
      };
    }
  }

  if (email) {
    const byEmail = store.patients.find(
      (patient) => patient.email?.toLowerCase() === email
    );
    if (byEmail) {
      return {
        patientId: byEmail.id,
        tier: "email",
        matchedOn: `e-post ${customer.EmailAdress}`,
      };
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
    return stageForReview(booking, eventType);
  }

  return { ok: false, error: `unhandled event type: ${eventType}` };
}

async function stageForReview(booking: BokaDirektPayload, eventType: string) {
  const store = await readStore();
  const match = findPatientMatch(booking, store);
  const customer = booking.Customer;
  const matchedPatient = match.patientId
    ? store.patients.find((patient) => patient.id === match.patientId)
    : null;

  const tierLabel: Record<MatchTier, string> = {
    bokadirekt_id: "Exakt (BokaDirekt-ID)",
    phone: "Exakt (telefon)",
    email: "Exakt (e-post)",
    none: "Ingen matchning",
  };

  const reviewItem = {
    type: "pending_booking_match",
    severity: match.patientId ? "low" : "medium",
    title: match.patientId
      ? `Ny bokning - ${customer.FirstName} ${customer.LastName} matchar ${matchedPatient?.full_name}`
      : `Ny bokning - ${customer.FirstName} ${customer.LastName} - ingen befintlig patient`,
    description: [
      `Inkommande: ${customer.FirstName} ${customer.LastName}, ${customer.MobilePhoneNumber || customer.PhoneNumber}, ${customer.EmailAdress}`,
      `Tjänst: ${booking.ServiceName} hos ${booking.PersonName} den ${new Date(booking.BookingStartDate).toLocaleDateString("sv-SE")}`,
      `Matchning: ${tierLabel[match.tier]} - ${match.matchedOn}`,
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
    content_hash: `bokadirekt:${eventType}:${booking.Id}:${booking.EventCreated}`,
  };

  const { error } = await supabase.from("review_items").insert(reviewItem);
  if (error && error.code !== "23505") {
    throw new Error(`Failed to stage booking review: ${error.message}`);
  }

  return {
    ok: true,
    staged: true,
    matchTier: match.tier,
    matchedPatientId: match.patientId,
  };
}

export async function confirmBookingMatch(
  reviewItemId: string,
  patientId: string | null
) {
  const { data: item, error: itemError } = await supabase
    .from("review_items")
    .select("raw_data")
    .eq("id", reviewItemId)
    .single();

  if (itemError || !item) {
    throw new Error(`Review item not found: ${itemError?.message ?? reviewItemId}`);
  }

  const booking = (item.raw_data as Record<string, unknown>).booking as BokaDirektPayload;
  if (!booking?.Customer || !booking.Id) {
    throw new Error("Review item does not contain a valid booking payload");
  }

  const customer = booking.Customer;
  const rawPhone = customer.MobilePhoneNumber || customer.PhoneNumber;
  const phone = normalizePhone(rawPhone);
  const fullName = `${customer.FirstName} ${customer.LastName}`.trim();

  const { data: resolvedPatientId, error: rpcError } = await supabase.rpc(
    "confirm_booking_match",
    {
      p_review_item_id: reviewItemId,
      p_patient_id: patientId,
      p_bokadirekt_customer_id: customer.Id,
      p_full_name: fullName,
      p_first_name: customer.FirstName,
      p_last_name: customer.LastName,
      p_phone: rawPhone,
      p_normalized_phone: phone,
      p_email: customer.EmailAdress,
      p_booking_id_external: booking.Id,
      p_booking_at: booking.BookingStartDate,
      p_service_name: booking.ServiceName,
      p_practitioner_name: booking.PersonName,
      p_location_name: booking.LocationName,
      p_price: booking.BookingPrice,
      p_booked_online: booking.BookedOnline,
      p_event_created_at: booking.EventCreated,
      p_raw_data: booking,
    }
  );

  if (rpcError) {
    throw new Error(`Booking confirmation failed: ${rpcError.message}`);
  }
  if (typeof resolvedPatientId !== "string") {
    throw new Error("Booking confirmation did not return a patient ID");
  }

  return { ok: true, patientId: resolvedPatientId };
}

async function handleCancellation(booking: BokaDirektPayload) {
  const { data: existingBooking, error: lookupError } = await supabase
    .from("bookings")
    .select("id, patient_id")
    .eq("bokadirekt_booking_id", booking.Id)
    .maybeSingle();
  if (lookupError) {
    throw new Error(`Failed to look up cancelled booking: ${lookupError.message}`);
  }

  const { error: cancelError } = await supabase
    .from("bookings")
    .update({ cancelled: true })
    .eq("bokadirekt_booking_id", booking.Id);
  if (cancelError) {
    throw new Error(`Failed to cancel booking: ${cancelError.message}`);
  }

  if (existingBooking?.patient_id) {
    const { error: resetError } = await supabase
      .from("reminder_logs")
      .delete()
      .eq("booking_id", existingBooking.id)
      .eq("is_cycle_reset", true);
    if (resetError) {
      throw new Error(`Failed to remove cycle reset: ${resetError.message}`);
    }

    const { data: remaining, error: remainingError } = await supabase
      .from("bookings")
      .select("booking_at")
      .eq("patient_id", existingBooking.patient_id)
      .eq("cancelled", false)
      .order("booking_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (remainingError) {
      throw new Error(`Failed to find remaining bookings: ${remainingError.message}`);
    }

    const { error: patientError } = await supabase
      .from("patients")
      .update({ last_booking_at: remaining?.booking_at ?? null })
      .eq("id", existingBooking.patient_id);
    if (patientError) {
      throw new Error(`Failed to update patient booking date: ${patientError.message}`);
    }
  }

  const { error: reviewError } = await supabase
    .from("review_items")
    .update({ status: "resolved", updated_at: new Date().toISOString() })
    .eq("type", "pending_booking_match")
    .eq("status", "open")
    .filter("raw_data->booking->>Id", "eq", booking.Id);
  if (reviewError) {
    throw new Error(`Failed to close booking review: ${reviewError.message}`);
  }

  return { ok: true, cancelled: true, bookingId: booking.Id };
}
