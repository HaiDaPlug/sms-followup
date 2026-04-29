import { createHash } from "crypto";
import type { BookingStatus, ImportIssue, NormalizedBookingRow } from "@/types/clinic";

export function normalizePhone(phone?: string | null) {
  if (!phone) return null;
  let digits = phone.replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `46${digits.slice(1)}`;

  const onlyDigits = digits.replace(/\D/g, "");
  if (onlyDigits.length < 8) return null;
  return onlyDigits;
}

export function normalizeEmail(email?: string | null) {
  const value = email?.trim().toLowerCase();
  return value && value.includes("@") ? value : null;
}

export function normalizeName(name?: string | null) {
  return (name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function splitName(fullName?: string | null) {
  const normalized = (fullName ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return { firstName: null, lastName: null };
  const parts = normalized.split(" ");
  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null
  };
}

export function isCancelledBooking(status?: string | null) {
  return /cancelled|canceled|avbokad|avbokat|avbokning|installd|aflyst/i.test(status ?? "");
}

export function isFutureBooking(bookingAt?: string | null) {
  if (!bookingAt) return false;
  return new Date(bookingAt).getTime() > Date.now();
}

function parseDateParts(dateValue: string) {
  const value = dateValue.trim();
  const iso = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3])
    };
  }

  const european = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (european) {
    const year = Number(european[3].length === 2 ? `20${european[3]}` : european[3]);
    return {
      year,
      month: Number(european[2]),
      day: Number(european[1])
    };
  }

  return null;
}

export function parseBookingDate(date?: string | null, interval?: string | null) {
  if (!date) return null;
  const parts = parseDateParts(date);
  if (!parts) {
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const timeMatch = `${date} ${interval ?? ""}`.match(/(\d{1,2})[:.](\d{2})/);
  const hours = Number(timeMatch?.[1] ?? 0);
  const minutes = Number(timeMatch?.[2] ?? 0);
  const parsed = new Date(parts.year, parts.month - 1, parts.day, hours, minutes);

  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function stableBookingId(row: Record<string, string>) {
  const explicitId = row.Id ?? row.ID ?? row.BookingId ?? row.BookingID ?? row.ExternalBookingId;
  if (explicitId?.trim()) return explicitId.trim();

  const source = [
    row.Date,
    row.Interval,
    row.Customer,
    row.Phone,
    row.Service,
    row.Performer
  ]
    .map((value) => value ?? "")
    .join("|");

  return createHash("sha256").update(source).digest("hex").slice(0, 24);
}

export function normalizeBokaDirektRow(row: Record<string, string>): NormalizedBookingRow {
  const fullName = row.Customer?.trim() || null;
  const { firstName, lastName } = splitName(fullName);
  const phone = row.Phone?.trim() || null;
  const normalizedPhone = normalizePhone(phone);
  const email = normalizeEmail(row.CustomerEmail);
  const bookingAt = parseBookingDate(row.Date, row.Interval);
  const status: BookingStatus = isCancelledBooking(row.Status) ? "Cancelled" : row.Status || "Booked";
  const issues: ImportIssue[] = [];

  if (!fullName) {
    issues.push({
      type: "missing_name",
      severity: "medium",
      title: "Missing customer name",
      description: "The row has no Customer value, so matching is less reliable."
    });
  }

  if (!normalizedPhone) {
    issues.push({
      type: "missing_phone",
      severity: "high",
      title: "Missing or invalid phone",
      description: "SMS cannot be sent until a valid phone number exists."
    });
  }

  if (!email && !normalizedPhone) {
    issues.push({
      type: "missing_contact_key",
      severity: "high",
      title: "Missing contact key",
      description: "The row has neither a valid phone nor a valid email for deterministic matching."
    });
  }

  if (!bookingAt) {
    issues.push({
      type: "invalid_date",
      severity: "high",
      title: "Invalid booking date",
      description: "Date and Interval could not be parsed into a booking datetime."
    });
  }

  return {
    external_booking_id: stableBookingId(row),
    patient_name: fullName,
    first_name: firstName,
    last_name: lastName,
    phone,
    normalized_phone: normalizedPhone,
    email,
    booking_at: bookingAt,
    treatment: row.Service?.trim() || null,
    status,
    source: "bokadirekt_csv",
    raw_data: row,
    issues
  };
}

export function getPatientMatchKey(row: NormalizedBookingRow) {
  if (row.normalized_phone) return `phone:${row.normalized_phone}`;
  if (row.email) return `email:${row.email}`;
  return null;
}
