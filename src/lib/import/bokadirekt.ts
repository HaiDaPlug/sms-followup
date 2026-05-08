import { createHash } from "crypto";
import type { Booking, ImportSummary, NormalizedBookingRow, Patient, ReviewItem } from "@/types/clinic";
import {
  bulkAddReviewItems,
  bulkUpsertBookings,
  bulkUpsertPatients,
  createId,
  nowIso,
  readStoreForImport
} from "@/lib/data/repository";
import { parseDelimited } from "./csv";
import {
  isCancelledBooking,
  isFutureBooking,
  normalizeBokaDirektRow,
  normalizeName
} from "./normalizers";
import { suggestReviewActionWithAI } from "@/lib/review/ai";

function reviewItemHash(item: Omit<ReviewItem, "id" | "created_at" | "updated_at" | "content_hash">) {
  return createHash("sha256")
    .update(`${item.type}|${item.title}|${JSON.stringify(item.raw_data)}`)
    .digest("hex")
    .slice(0, 32);
}

export function parseBokaDirektCsv(csvText: string) {
  return parseDelimited(csvText, ";").map(normalizeBokaDirektRow);
}

function nameSimilarity(a?: string | null, b?: string | null) {
  const left = new Set(normalizeName(a).split(" ").filter(Boolean));
  const right = new Set(normalizeName(b).split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / Math.max(left.size, right.size);
}

export function matchBookingToPatient(row: NormalizedBookingRow, patients: Patient[]) {
  if (row.normalized_phone) {
    const exactPhone = patients.find((p) => p.normalized_phone === row.normalized_phone);
    if (exactPhone) return { patient: exactPhone, confidence: "high" as const };
  }

  if (row.email) {
    const exactEmail = patients.find((p) => p.email === row.email);
    if (exactEmail) return { patient: exactEmail, confidence: "high" as const };
  }

  if (row.normalized_phone && row.patient_name) {
    const last7 = row.normalized_phone.slice(-7);
    const partial = patients.find(
      (p) =>
        p.normalized_phone?.endsWith(last7) &&
        nameSimilarity(p.full_name, row.patient_name) >= 0.5
    );
    if (partial) return { patient: partial, confidence: "medium" as const };
  }

  if (row.email && row.patient_name) {
    const domain = row.email.split("@")[1];
    const partial = patients.find(
      (p) =>
        p.email?.endsWith(`@${domain}`) &&
        nameSimilarity(p.full_name, row.patient_name) >= 0.75
    );
    if (partial) return { patient: partial, confidence: "medium" as const };
  }

  return { patient: null, confidence: "none" as const };
}

function makePatientFromBooking(row: NormalizedBookingRow): Patient {
  const now = nowIso();
  return {
    id: createId("patient"),
    full_name: row.patient_name ?? "Okand patient",
    first_name: row.first_name,
    last_name: row.last_name,
    phone: row.phone,
    normalized_phone: row.normalized_phone,
    email: row.email,
    last_booking_at: null,
    latest_treatment: null,
    has_future_booking: false,
    do_not_contact: false,
    source: row.source,
    created_at: now,
    updated_at: now
  };
}

export async function importBokaDirektCsv(csvText: string): Promise<ImportSummary> {
  const rows = parseBokaDirektCsv(csvText);

  // Load existing data once — all matching is done in memory
  const store = await readStoreForImport();
  const patients = store.patients;

  // Index existing bookings by external_booking_id for O(1) lookup
  const existingByExtId = new Map(store.bookings.map((b) => [b.external_booking_id, b]));

  const summary: ImportSummary = {
    totalRows: rows.length,
    importedBookings: 0,
    importedOrUpdatedPatients: 0,
    skippedRows: 0,
    missingPhoneCount: 0,
    cancelledCount: 0,
    futureBookingCount: 0,
    reviewItemsCreated: 0
  };

  // Collect review items to bulk-insert at the end
  const reviewItems: Omit<ReviewItem, "id" | "created_at" | "updated_at">[] = [];

  // Maps to collect patients and bookings to upsert
  // Keyed by patient id to deduplicate rows for the same patient
  const patientMap = new Map<string, Patient>();
  // Keyed by booking id
  const bookingMap = new Map<string, Booking>();
  // Patient id → bookings list (all bookings in this import for recalculation)
  const patientBookingRows = new Map<string, Booking[]>();

  const now = nowIso();

  for (const row of rows) {
    if (!row.normalized_phone) summary.missingPhoneCount += 1;
    if (isCancelledBooking(row.status)) summary.cancelledCount += 1;
    if (isFutureBooking(row.booking_at)) summary.futureBookingCount += 1;

    // Collect data quality review items
    for (const issue of row.issues) {
      const item = {
        type: issue.type,
        severity: issue.severity,
        title: issue.title,
        description: `${issue.description} Customer: ${row.patient_name ?? "unknown"}.`,
        suggested_action: suggestReviewActionWithAI(issue),
        status: "open" as const,
        raw_data: row.raw_data
      };
      reviewItems.push({ ...item, content_hash: reviewItemHash(item) });
    }

    if (!row.booking_at) {
      summary.skippedRows += 1;
      continue;
    }

    // Patient matching (against DB patients + any new patients added this run)
    const match = matchBookingToPatient(row, patients);
    let patient: Patient | null = null;
    let uncertain = false;

    if (match.confidence === "none" && !row.normalized_phone && !row.email) {
      uncertain = true;
    } else if (match.patient) {
      patient = {
        ...match.patient,
        full_name: match.patient.full_name || row.patient_name || "Okand patient",
        first_name: match.patient.first_name ?? row.first_name,
        last_name: match.patient.last_name ?? row.last_name,
        phone: match.patient.phone ?? row.phone,
        normalized_phone: match.patient.normalized_phone ?? row.normalized_phone,
        email: match.patient.email ?? row.email,
        // Never overwrite do_not_contact — import must not silently re-enable a blocked patient
        do_not_contact: match.patient.do_not_contact,
        updated_at: now
      };
      // Keep local cache in sync so subsequent rows match correctly
      const idx = patients.findIndex((p) => p.id === patient!.id);
      if (idx >= 0) patients[idx] = patient;
      uncertain = match.confidence !== "high";
    } else {
      patient = makePatientFromBooking(row);
      // Add to local cache immediately so later rows for the same person match
      patients.push(patient);
    }

    if (uncertain) {
      const item = {
        type: "uncertain_match",
        severity: "medium" as const,
        title: "Uncertain patient match",
        description: `Could not confidently match ${row.patient_name ?? "unknown customer"}.`,
        suggested_action: "Review the row before merging patient records.",
        status: "open" as const,
        raw_data: row.raw_data
      };
      reviewItems.push({ ...item, content_hash: reviewItemHash(item) });
    }

    if (patient) {
      patientMap.set(patient.id, patient);
    }

    // Build booking record
    const existingBooking = existingByExtId.get(row.external_booking_id);
    const bookingRow: Booking = {
      id: existingBooking?.id ?? createId("booking"),
      external_booking_id: row.external_booking_id,
      patient_id: patient?.id ?? null,
      patient_name: row.patient_name,
      phone: row.phone,
      normalized_phone: row.normalized_phone,
      email: row.email,
      booking_at: row.booking_at,
      treatment: row.treatment,
      status: row.status,
      source: row.source,
      raw_data: row.raw_data,
      created_at: existingBooking?.created_at ?? now,
      updated_at: now
    };

    bookingMap.set(bookingRow.external_booking_id, bookingRow);
    if (!existingBooking) summary.importedBookings += 1;

    if (patient?.id) {
      const list = patientBookingRows.get(patient.id) ?? [];
      if (!list.some((b) => b.external_booking_id === bookingRow.external_booking_id)) {
        list.push(bookingRow);
      }
      patientBookingRows.set(patient.id, list);
    }
  }

  summary.importedOrUpdatedPatients = patientMap.size;
  summary.reviewItemsCreated = reviewItems.length;

  // Recalculate last_booking_at / latest_treatment / has_future_booking
  // using all bookings for each patient (DB bookings + new ones from this import)
  for (const [patientId, patient] of patientMap) {
    // Combine existing DB bookings for this patient with new ones from this run
    const dbBookings = store.bookings.filter((b) => b.patient_id === patientId);
    const newBookings = patientBookingRows.get(patientId) ?? [];
    // Merge, new bookings take precedence (same id = overwrite)
    const newById = new Map(newBookings.map((b) => [b.id, b]));
    const allBookings = [...dbBookings.map((b) => newById.get(b.id) ?? b), ...newBookings.filter((b) => !dbBookings.some((d) => d.id === b.id))];

    const futureBookings = allBookings.filter((b) => isFutureBooking(b.booking_at));
    const validPast = allBookings
      .filter((b) => b.booking_at && !isFutureBooking(b.booking_at) && !isCancelledBooking(b.status))
      .sort((a, b) => new Date(b.booking_at!).getTime() - new Date(a.booking_at!).getTime());

    const latest = validPast[0];
    patientMap.set(patientId, {
      ...patient,
      last_booking_at: latest?.booking_at ?? null,
      latest_treatment: latest?.treatment ?? null,
      has_future_booking: futureBookings.length > 0,
      updated_at: now
    });
  }

  // Bulk write — 3 round-trips regardless of file size
  await bulkUpsertPatients([...patientMap.values()]);
  await bulkUpsertBookings([...bookingMap.values()]);
  await bulkAddReviewItems(reviewItems);

  return summary;
}
