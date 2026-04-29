import type { Patient } from "@/types/clinic";

export function daysSince(date?: string | null) {
  if (!date) return null;
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
}

export function formatDate(date?: string | null) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(date));
}

export function patientDisplayName(patient: Patient) {
  return patient.full_name || patient.email || patient.phone || "Okand patient";
}
