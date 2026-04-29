import type { Booking, ImportSummary, NormalizedBookingRow, Patient } from "@/types/clinic";
import {
  addReviewItem,
  createId,
  nowIso,
  readStore,
  touchBooking,
  upsertBooking,
  upsertPatient
} from "@/lib/data/repository";
import { parseDelimited } from "./csv";
import {
  isCancelledBooking,
  isFutureBooking,
  normalizeBokaDirektRow,
  normalizeName
} from "./normalizers";
import { suggestReviewActionWithAI } from "@/lib/review/ai";

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

  // Load current patients once — used for matching throughout the import
  const store = await readStore();
  const patients = store.patients;

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

  // Collect all upserted bookings so we can recalculate patients at the end
  const processedPatientIds = new Set<string>();

  for (const row of rows) {
    if (!row.normalized_phone) summary.missingPhoneCount += 1;
    if (isCancelledBooking(row.status)) summary.cancelledCount += 1;
    if (isFutureBooking(row.booking_at)) summary.futureBookingCount += 1;

    // Review items for data quality issues
    for (const issue of row.issues) {
      await addReviewItem({
        type: issue.type,
        severity: issue.severity,
        title: issue.title,
        description: `${issue.description} Customer: ${row.patient_name ?? "unknown"}.`,
        suggested_action: suggestReviewActionWithAI(issue),
        status: "open",
        raw_data: row.raw_data
      });
      summary.reviewItemsCreated += 1;
    }

    if (!row.booking_at) {
      summary.skippedRows += 1;
      continue;
    }

    // Patient upsert
    const match = matchBookingToPatient(row, patients);
    let patient: Patient | null = null;
    let uncertain = false;

    if (match.confidence === "none" && !row.normalized_phone && !row.email) {
      uncertain = true;
    } else if (match.patient) {
      const updated: Patient = {
        ...match.patient,
        full_name: match.patient.full_name || row.patient_name || "Okand patient",
        first_name: match.patient.first_name ?? row.first_name,
        last_name: match.patient.last_name ?? row.last_name,
        phone: match.patient.phone ?? row.phone,
        normalized_phone: match.patient.normalized_phone ?? row.normalized_phone,
        email: match.patient.email ?? row.email,
        updated_at: nowIso()
      };
      patient = await upsertPatient(updated);
      // Keep local cache in sync for subsequent rows in this import
      const idx = patients.findIndex((p) => p.id === patient!.id);
      if (idx >= 0) patients[idx] = patient;
      uncertain = match.confidence !== "high";
    } else {
      const newPatient = makePatientFromBooking(row);
      patient = await upsertPatient(newPatient);
      patients.push(patient);
    }

    if (uncertain) {
      await addReviewItem({
        type: "uncertain_match",
        severity: "medium",
        title: "Uncertain patient match",
        description: `Could not confidently match ${row.patient_name ?? "unknown customer"}.`,
        suggested_action: "Review the row before merging patient records.",
        status: "open",
        raw_data: row.raw_data
      });
      summary.reviewItemsCreated += 1;
    }

    if (patient) {
      summary.importedOrUpdatedPatients += 1;
      processedPatientIds.add(patient.id);
    }

    // Booking upsert
    const existingBooking = store.bookings.find(
      (b) => b.external_booking_id === row.external_booking_id
    );
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
      created_at: existingBooking?.created_at ?? nowIso(),
      updated_at: nowIso()
    };
    const saved = await upsertBooking(existingBooking ? touchBooking(bookingRow) : bookingRow);
    if (!existingBooking) {
      summary.importedBookings += 1;
      store.bookings.push(saved);
    } else {
      const idx = store.bookings.findIndex((b) => b.id === saved.id);
      if (idx >= 0) store.bookings[idx] = saved;
    }
  }

  // Recalculate last_booking_at / has_future_booking for all touched patients
  for (const patientId of processedPatientIds) {
    const patientBookings = store.bookings.filter((b) => b.patient_id === patientId);
    const futureBookings = patientBookings.filter((b) => isFutureBooking(b.booking_at));
    const validPast = patientBookings
      .filter(
        (b) =>
          b.booking_at &&
          !isFutureBooking(b.booking_at) &&
          !isCancelledBooking(b.status)
      )
      .sort((a, b) => new Date(b.booking_at!).getTime() - new Date(a.booking_at!).getTime());

    const latest = validPast[0];
    const patientIdx = patients.findIndex((p) => p.id === patientId);
    if (patientIdx >= 0) {
      const updated: Patient = {
        ...patients[patientIdx],
        last_booking_at: latest?.booking_at ?? null,
        latest_treatment: latest?.treatment ?? null,
        has_future_booking: futureBookings.length > 0,
        updated_at: nowIso()
      };
      await upsertPatient(updated);
      patients[patientIdx] = updated;
    }
  }

  return summary;
}
