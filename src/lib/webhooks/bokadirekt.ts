import { readStore, resetPatientCycle } from "@/lib/data/repository";
import { normalizePhone } from "@/lib/import/normalizers";
import { createClient } from "@/lib/supabase/server";

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
    return handleBookingUpsert(booking);
  }

  return { ok: false, error: `unhandled event type: ${eventType}` };
}

async function handleBookingUpsert(booking: BokaDirektPayload) {
  const supabase = await createClient();
  const customer = booking.Customer;
  const rawPhone = customer.MobilePhoneNumber || customer.PhoneNumber;
  const phone = normalizePhone(rawPhone);
  const fullName = `${customer.FirstName} ${customer.LastName}`.trim();

  // Upsert patient — prefer matching on bokadirekt_customer_id, fall back to phone
  const { data: patient, error: patientError } = await supabase
    .from("patients")
    .upsert(
      {
        bokadirekt_customer_id: customer.Id,
        full_name: fullName,
        first_name: customer.FirstName,
        last_name: customer.LastName,
        phone: rawPhone,
        normalized_phone: phone,
        email: customer.EmailAdress,
      },
      { onConflict: "bokadirekt_customer_id", ignoreDuplicates: false }
    )
    .select("id")
    .single();

  let patientId: string;

  if (patientError || !patient) {
    // Fall back to matching by phone/email from in-memory store
    const store = await readStore();
    const matched = store.patients.find(
      (p) =>
        (phone && p.normalized_phone === phone) ||
        (customer.EmailAdress && p.email?.toLowerCase() === customer.EmailAdress.toLowerCase())
    );
    if (!matched) return { ok: false, error: "patient not found and could not be created" };
    patientId = matched.id;
  } else {
    patientId = patient.id;
  }

  await upsertBookingAndResetCycle(patientId, booking);
  return { ok: true, patientId };
}

async function upsertBookingAndResetCycle(patientId: string, booking: BokaDirektPayload) {
  const supabase = await createClient();

  const { data: upsertedBooking } = await supabase
    .from("bookings")
    .upsert(
      {
        bokadirekt_booking_id: booking.Id,
        patient_id: patientId,
        patient_name: `${booking.Customer.FirstName} ${booking.Customer.LastName}`.trim(),
        phone: booking.Customer.MobilePhoneNumber || booking.Customer.PhoneNumber,
        normalized_phone: normalizePhone(booking.Customer.MobilePhoneNumber || booking.Customer.PhoneNumber),
        email: booking.Customer.EmailAdress,
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

  await resetPatientCycle(patientId, upsertedBooking?.id ?? null);
}

async function handleCancellation(booking: BokaDirektPayload) {
  const supabase = await createClient();

  await supabase
    .from("bookings")
    .update({ cancelled: true })
    .eq("bokadirekt_booking_id", booking.Id);

  return { ok: true, cancelled: true, bookingId: booking.Id };
}
