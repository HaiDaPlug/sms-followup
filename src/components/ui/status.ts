/**
 * Patient reminder status → Swedish label, chip style and dot color.
 * The keys are the engine's PatientReminderStatus values (English on purpose,
 * they are also the ?status= URL values); only the presentation is Swedish.
 */

export type StatusMeta = {
  label: string;
  /** Shorter label for tight spots (filter tabs). Falls back to label. */
  short?: string;
  /** Chip modifier class, see .chip in globals.css */
  chip: string;
  /** Solid color for dots, bars and legends */
  dot: string;
  /** One-line explanation, used in tooltips and legends */
  hint: string;
};

export const PATIENT_STATUS: Record<string, StatusMeta> = {
  Ready: {
    label: "Redo",
    chip: "ready",
    dot: "#3aa99c",
    hint: "Har passerat en uppföljningsdag och kan kontaktas nu",
  },
  Sent: {
    label: "Skickat",
    chip: "sent",
    dot: "#2f7d64",
    hint: "Alla aktiva uppföljningar är skickade i den här cykeln",
  },
  "Future booking": {
    label: "Har bokat en tid",
    short: "Har bokat",
    chip: "future",
    dot: "#4a8ab5",
    hint: "Har en kommande bokning och hoppas över",
  },
  "Missing phone": {
    label: "Saknar telefon",
    chip: "review",
    dot: "#d25353",
    hint: "Kan inte nås via SMS förrän ett nummer läggs till",
  },
  "Do not contact": {
    label: "Kontakta ej",
    chip: "blocked",
    dot: "#8a7d6d",
    hint: "Undantagen från alla utskick",
  },
  "Needs review": {
    label: "Behöver granskas",
    short: "Granskas",
    chip: "warn",
    dot: "#d49a2a",
    hint: "Har ett öppet granskningsärende",
  },
  "Delivery pending": {
    label: "Leverans väntar",
    chip: "warn",
    dot: "#b9852a",
    hint: "Ett SMS väntar på leveransbesked",
  },
  Waiting: {
    label: "Väntar",
    chip: "neutral",
    dot: "#b4bdb9",
    hint: "Ingen uppföljning är aktuell ännu",
  },
  "No valid booking": {
    label: "Ingen giltig bokning",
    short: "Ingen bokning",
    chip: "neutral",
    dot: "#cfd5d2",
    hint: "Saknar ett senaste besök att räkna från",
  },
};

export function statusMeta(status: string): StatusMeta {
  return PATIENT_STATUS[status] ?? { label: status, chip: "neutral", dot: "#b4bdb9", hint: "" };
}

/** Reminder-log statuses (one SMS) → label + chip class. */
export const LOG_STATUS: Record<string, { label: string; chip: string }> = {
  pending:     { label: "Skickas",          chip: "pending" },
  unknown:     { label: "Leverans okänd",   chip: "unknown" },
  sent:        { label: "Skickat",          chip: "sent" },
  delivered:   { label: "Levererat",        chip: "delivered" },
  dry_run:     { label: "Testläge",         chip: "dry_run" },
  failed:      { label: "Misslyckades",     chip: "failed" },
  skipped:     { label: "Hoppades över",    chip: "skipped" },
  cycle_reset: { label: "Cykel återställd", chip: "waiting" },
};

export function logStatusMeta(status: string) {
  return LOG_STATUS[status] ?? { label: status, chip: "waiting" };
}
