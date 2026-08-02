import { normalizeEmail, normalizePhone } from "@/lib/import/normalizers";
import { supabase } from "@/lib/supabase/client";

interface BokaDirektCustomer {
  Id: string | null;
  MobilePhoneNumber: string | null;
  PhoneNumber: string | null;
  FirstName: string | null;
  LastName: string | null;
  EmailAdress: string | null; // BokaDirekt typo: "Adress" not "Address"
  SocialSecurityNumber: string | null;
  NewCustomer: boolean | null;
}

interface BokaDirektPayload {
  Id: string;
  LocationId: string | null;
  LocationName: string | null;
  PersonId: string | null;
  PersonName: string | null;
  ServiceId: string | null;
  ServiceName: string | null;
  BookingPrice: number | null;
  BookingStartDate: string;
  BookingEndDate: string | null;
  Customer: BokaDirektCustomer;
  EventCreated: string | null;
  BookedOnline: boolean | null;
  Cancelled: boolean;
  NewCustomer: boolean | null;
  Note: string | null;
}

type MatchTier = "bokadirekt_id" | "phone" | "email" | "none" | "conflict";

type PatientMatchRow = {
  id: string;
  full_name: string | null;
  bokadirekt_customer_id: string | null;
  normalized_phone: string | null;
  email: string | null;
};

type IdentityLookup = {
  tier: Exclude<MatchTier, "none" | "conflict">;
  matchedOn: string;
  patients: PatientMatchRow[];
};

type MatchResult = {
  patientId: string | null;
  patientName: string | null;
  tier: MatchTier;
  matchedOn: string;
  conflictReasons: string[];
  lookups: IdentityLookup[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredString(record: Record<string, unknown>, key: string) {
  const value = optionalString(record, key);
  if (!value) throw new Error(`BokaDirekt payload missing ${key}`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return null;
}

function optionalNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function assertDate(value: string, field: string) {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new Error(`BokaDirekt payload has invalid ${field}: ${value}`);
  }
  return value;
}

function translateBokaDirektPayload(payload: Record<string, unknown>): BokaDirektPayload {
  const customerValue = payload.Customer;
  if (!isRecord(customerValue)) {
    throw new Error("BokaDirekt payload missing Customer");
  }

  const bookingStart = assertDate(requiredString(payload, "BookingStartDate"), "BookingStartDate");
  const eventCreated = optionalString(payload, "EventCreated");
  if (eventCreated) assertDate(eventCreated, "EventCreated");

  const customer: BokaDirektCustomer = {
    Id: optionalString(customerValue, "Id"),
    MobilePhoneNumber: optionalString(customerValue, "MobilePhoneNumber"),
    PhoneNumber: optionalString(customerValue, "PhoneNumber"),
    FirstName: optionalString(customerValue, "FirstName"),
    LastName: optionalString(customerValue, "LastName"),
    EmailAdress: optionalString(customerValue, "EmailAdress"),
    SocialSecurityNumber: optionalString(customerValue, "SocialSecurityNumber"),
    NewCustomer: optionalBoolean(customerValue, "NewCustomer"),
  };

  return {
    Id: requiredString(payload, "Id"),
    LocationId: optionalString(payload, "LocationId"),
    LocationName: optionalString(payload, "LocationName"),
    PersonId: optionalString(payload, "PersonId"),
    PersonName: optionalString(payload, "PersonName"),
    ServiceId: optionalString(payload, "ServiceId"),
    ServiceName: optionalString(payload, "ServiceName"),
    BookingPrice: optionalNumber(payload, "BookingPrice"),
    BookingStartDate: bookingStart,
    BookingEndDate: optionalString(payload, "BookingEndDate"),
    Customer: customer,
    EventCreated: eventCreated,
    BookedOnline: optionalBoolean(payload, "BookedOnline"),
    Cancelled: optionalBoolean(payload, "Cancelled") ?? false,
    NewCustomer: optionalBoolean(payload, "NewCustomer"),
    Note: optionalString(payload, "Note"),
  };
}

function rawPhone(booking: BokaDirektPayload) {
  return booking.Customer.MobilePhoneNumber ?? booking.Customer.PhoneNumber;
}

function normalizedEmail(booking: BokaDirektPayload) {
  return normalizeEmail(booking.Customer.EmailAdress);
}

function fullName(booking: BokaDirektPayload) {
  const name = [booking.Customer.FirstName, booking.Customer.LastName].filter(Boolean).join(" ").trim();
  return name || "Okand patient";
}

function tierLabel(tier: MatchTier) {
  const labels: Record<MatchTier, string> = {
    bokadirekt_id: "Exact BokaDirekt ID",
    phone: "Exact phone",
    email: "Exact email",
    none: "No match",
    conflict: "Conflicting match",
  };
  return labels[tier];
}

async function fetchPatientsBy(
  column: "bokadirekt_customer_id" | "normalized_phone" | "email",
  value: string
): Promise<PatientMatchRow[]> {
  const query = supabase
    .from("patients")
    .select("id, full_name, bokadirekt_customer_id, normalized_phone, email")
    .limit(3);

  const { data, error } = await query.eq(column, value);

  if (error) {
    throw new Error(`Failed to look up patient by ${column}: ${error.message}`);
  }

  return (data ?? []) as PatientMatchRow[];
}

async function findDeterministicMatch(booking: BokaDirektPayload): Promise<MatchResult> {
  const customer = booking.Customer;
  const phone = normalizePhone(rawPhone(booking));
  const email = normalizedEmail(booking);
  const lookups: IdentityLookup[] = [];
  const conflictReasons: string[] = [];

  if (customer.Id) {
    lookups.push({
      tier: "bokadirekt_id",
      matchedOn: `BokaDirekt ID ${customer.Id}`,
      patients: await fetchPatientsBy("bokadirekt_customer_id", customer.Id),
    });
  }

  if (phone) {
    lookups.push({
      tier: "phone",
      matchedOn: `phone ${phone}`,
      patients: await fetchPatientsBy("normalized_phone", phone),
    });
  }

  if (email) {
    lookups.push({
      tier: "email",
      matchedOn: `email ${email}`,
      patients: await fetchPatientsBy("email", email),
    });
  }

  for (const lookup of lookups) {
    if (lookup.patients.length > 1) {
      conflictReasons.push(`${lookup.matchedOn} matched ${lookup.patients.length} patients`);
    }
  }

  const matchedPatients = lookups.flatMap((lookup) =>
    lookup.patients.map((patient) => ({ lookup, patient }))
  );

  for (const { patient } of matchedPatients) {
    if (
      customer.Id &&
      patient.bokadirekt_customer_id &&
      customer.Id !== patient.bokadirekt_customer_id
    ) {
      conflictReasons.push(`patient ${patient.id} is already linked to another BokaDirekt ID`);
    }
  }
  const patientIds = new Set(matchedPatients.map(({ patient }) => patient.id));

  if (conflictReasons.length > 0 || patientIds.size > 1) {
    if (patientIds.size > 1) {
      conflictReasons.push("identity keys point to different patients");
    }
    return {
      patientId: null,
      patientName: null,
      tier: "conflict",
      matchedOn: conflictReasons.join("; "),
      conflictReasons,
      lookups,
    };
  }

  if (patientIds.size === 0) {
    return {
      patientId: null,
      patientName: null,
      tier: "none",
      matchedOn: "no existing patient matched BokaDirekt ID, phone, or email",
      conflictReasons,
      lookups,
    };
  }

  const winningLookup =
    lookups.find((lookup) => lookup.tier === "bokadirekt_id" && lookup.patients.length === 1) ??
    lookups.find((lookup) => lookup.tier === "phone" && lookup.patients.length === 1) ??
    lookups.find((lookup) => lookup.tier === "email" && lookup.patients.length === 1);

  const patient = winningLookup?.patients[0];
  if (!winningLookup || !patient) {
    throw new Error("Could not resolve deterministic BokaDirekt match");
  }

  return {
    patientId: patient.id,
    patientName: patient.full_name,
    tier: winningLookup.tier,
    matchedOn: winningLookup.matchedOn,
    conflictReasons,
    lookups,
  };
}

function bookingRpcParams(booking: BokaDirektPayload, patientId: string | null) {
  const phone = rawPhone(booking);
  return {
    p_patient_id: patientId,
    p_bokadirekt_customer_id: booking.Customer.Id,
    p_full_name: fullName(booking),
    p_first_name: booking.Customer.FirstName,
    p_last_name: booking.Customer.LastName,
    p_phone: phone,
    p_normalized_phone: normalizePhone(phone),
    p_email: normalizedEmail(booking),
    p_booking_id_external: booking.Id,
    p_booking_at: booking.BookingStartDate,
    p_service_name: booking.ServiceName,
    p_practitioner_name: booking.PersonName,
    p_location_name: booking.LocationName,
    p_price: booking.BookingPrice,
    p_booked_online: booking.BookedOnline,
    p_event_created_at: booking.EventCreated,
    p_raw_data: booking,
  };
}

async function applyBookingToPatient(booking: BokaDirektPayload, patientId: string) {
  // Deterministic webhook auto-apply path only: this wrapper RPC (migration
  // 017) calls apply_bokadirekt_booking and logs an SMS-conversion in the
  // same transaction. Manual review confirmations go through
  // confirmBookingMatch below, which calls plain apply_bokadirekt_booking
  // directly and never logs a conversion.
  const { data: resolvedPatientId, error } = await supabase.rpc(
    "apply_bokadirekt_booking_auto_matched",
    bookingRpcParams(booking, patientId)
  );

  if (error) {
    throw new Error(`BokaDirekt booking apply failed: ${error.message}`);
  }
  if (typeof resolvedPatientId !== "string") {
    throw new Error("BokaDirekt booking apply did not return a patient ID");
  }

  return resolvedPatientId;
}

async function insertReviewItem(item: {
  type: string;
  severity: "low" | "medium" | "high";
  title: string;
  description: string;
  suggested_action: string | null;
  status: "open" | "resolved";
  raw_data: Record<string, unknown>;
  content_hash: string;
}) {
  const { error } = await supabase.from("review_items").insert(item);
  if (error && error.code !== "23505") {
    throw new Error(`Failed to insert BokaDirekt review item: ${error.message}`);
  }
}

function reviewDescription(booking: BokaDirektPayload, match: MatchResult) {
  const customer = booking.Customer;
  const lookupSummary = match.lookups
    .map((lookup) => {
      const patients = lookup.patients.length
        ? lookup.patients
            .map((patient) => `${patient.full_name ?? "Unnamed patient"} (${patient.id})`)
            .join(", ")
        : "no patient";
      return `${lookup.matchedOn}: ${patients}`;
    })
    .join(" | ");

  return [
    `Incoming: ${fullName(booking)}, ${rawPhone(booking) ?? "no phone"}, ${normalizedEmail(booking) ?? "no email"}`,
    `Booking: ${booking.ServiceName ?? "unknown service"} with ${booking.PersonName ?? "unknown practitioner"} on ${new Date(booking.BookingStartDate).toLocaleDateString("sv-SE")}`,
    `Match: ${tierLabel(match.tier)} - ${match.matchedOn}`,
    lookupSummary ? `Candidates: ${lookupSummary}` : null,
    `BokaDirekt customer: ${customer.Id}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

async function stageForReview(booking: BokaDirektPayload, eventType: string, match: MatchResult) {
  await insertReviewItem({
    type: "pending_booking_match",
    severity: match.tier === "conflict" ? "high" : "medium",
    title:
      match.tier === "conflict"
        ? `BokaDirekt booking conflict - ${fullName(booking)}`
        : `New BokaDirekt booking - ${fullName(booking)} - no existing patient`,
    description: reviewDescription(booking, match),
    suggested_action:
      match.tier === "conflict"
        ? "Review the identity conflict before confirming a patient."
        : "Confirm to create a new patient, or match this booking to an existing patient.",
    status: "open",
    raw_data: {
      booking,
      match_patient_id: null,
      match_patient_name: null,
      match_tier: match.tier,
      match_on: match.matchedOn,
      conflict_reasons: match.conflictReasons,
      identity_lookups: match.lookups,
    },
    content_hash: `bokadirekt:review:${eventType}:${booking.Id}:${booking.EventCreated ?? booking.BookingStartDate}`,
  });

  return {
    ok: true,
    staged: true,
    autoApplied: false,
    matchTier: match.tier,
    matchedPatientId: null,
  };
}

async function insertAutoMatchAudit(
  booking: BokaDirektPayload,
  eventType: string,
  match: MatchResult,
  patientId: string
) {
  await insertReviewItem({
    type: "bokadirekt_auto_match",
    severity: "low",
    title: `BokaDirekt booking auto-matched - ${fullName(booking)} to ${match.patientName ?? patientId}`,
    description: reviewDescription(booking, match),
    suggested_action: null,
    status: "resolved",
    raw_data: {
      booking,
      match_patient_id: patientId,
      match_patient_name: match.patientName,
      match_tier: match.tier,
      match_on: match.matchedOn,
      event_type: eventType,
      auto_applied: true,
    },
    content_hash: `bokadirekt:auto:${eventType}:${booking.Id}:${booking.EventCreated ?? booking.BookingStartDate}`,
  });
}

export async function handleBokaDirektWebhook(
  payload: Record<string, unknown>,
  eventType: string
) {
  const booking = translateBokaDirektPayload(payload);

  if (eventType === "BookingCancelled" || booking.Cancelled) {
    return handleCancellation(booking);
  }

  if (eventType !== "BookingCreated" && eventType !== "BookingUpdated") {
    return { ok: false, error: `unhandled event type: ${eventType}` };
  }

  if (!booking.Customer.Id && !rawPhone(booking) && !normalizedEmail(booking)) {
    throw new Error("BokaDirekt payload has no customer identity or contact info");
  }

  const match = await findDeterministicMatch(booking);
  if (!match.patientId) {
    return stageForReview(booking, eventType, match);
  }

  const resolvedPatientId = await applyBookingToPatient(booking, match.patientId);

  try {
    await insertAutoMatchAudit(booking, eventType, match, resolvedPatientId);
  } catch (error) {
    // Booking mutation already succeeded; a failed audit insert must not
    // turn this into a webhook failure and trigger a BokaDirekt retry.
    console.error("BokaDirekt auto-match audit insert failed", error);
  }

  return {
    ok: true,
    staged: false,
    autoApplied: true,
    matchTier: match.tier,
    matchedPatientId: resolvedPatientId,
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

  const rawBooking = (item.raw_data as Record<string, unknown>).booking;
  if (!isRecord(rawBooking)) {
    throw new Error("Review item does not contain a valid booking payload");
  }

  const booking = translateBokaDirektPayload(rawBooking);
  const { data: resolvedPatientId, error: rpcError } = await supabase.rpc(
    "confirm_booking_match",
    {
      p_review_item_id: reviewItemId,
      ...bookingRpcParams(booking, patientId),
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
  const { error } = await supabase.rpc("cancel_bokadirekt_booking", {
    p_booking_id_external: booking.Id,
  });
  if (error) {
    throw new Error(`BokaDirekt booking cancellation failed: ${error.message}`);
  }

  return { ok: true, cancelled: true, bookingId: booking.Id };
}
