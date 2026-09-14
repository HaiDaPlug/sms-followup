import type { ReminderLog, ReminderLogStatus } from "@/types/clinic";

/**
 * The single vocabulary every send path reports back in.
 *
 * Why this exists: each of the six send call sites previously collapsed the
 * result into a boolean, and each drew the line in a different place. The common
 * shape was `data.status === "sent" || data.status === "dry_run"`, which reports
 * a dry run as a real send, and treats BOTH `skipped` and `unknown` as success
 * because they fall through to the else branch. That is how a send blocked by
 * the duplicate guard came back to the operator as "Skickat ✓".
 *
 * Distinguishing these six states is the whole point — do not reduce this to a
 * boolean at the call site.
 */
export type SendOutcomeKind =
  /** Provider accepted the message. Not yet proof it reached the handset. */
  | "sent"
  /** Provider confirmed it reached the handset. */
  | "delivered"
  /** Dry-run mode: logged, deliberately never handed to the provider. */
  | "dry_run"
  /** Deliberately not sent — a guard refused it. `reason` says which. */
  | "skipped"
  /** Provider rejected it. Safe to retry. */
  | "failed"
  /** Provider may or may not have accepted it. NOT safe to retry. */
  | "unknown";

export type SendOutcome = {
  kind: SendOutcomeKind;
  /** Operator-facing Swedish summary. Always present. */
  message: string;
  /** Extra detail: provider error, skip reason, verification result. */
  detail?: string | null;
  /** Set when the outcome came from an actual log row. */
  logId?: string | null;
  sequenceNumber?: number | null;
  /** True when the provider's own status API confirmed the outcome. */
  verified?: boolean;
};

/** Only these two mean an SMS actually left the building. */
export function isRealSend(kind: SendOutcomeKind): boolean {
  return kind === "sent" || kind === "delivered";
}

/**
 * Log statuses that represent a real outbound SMS, for counting.
 *
 * "delivered" must be included everywhere "sent" is: the delivery webhook has
 * always promoted logs to delivered, and verification now does so at send time,
 * so counting only the literal "sent" under-reports precisely the sends that
 * were confirmed to arrive.
 */
export function isSentLogStatus(status: ReminderLogStatus): boolean {
  return status === "sent" || status === "delivered";
}

/** Outcomes an operator must act on. */
export function needsAttention(kind: SendOutcomeKind): boolean {
  return kind === "failed" || kind === "unknown";
}

const SKIP_REASON_LABELS: Record<string, string> = {
  future_booking: "Patienten har redan en kommande bokning",
  missing_phone: "Telefonnummer saknas",
  do_not_contact: "Patienten har avregistrerat sig",
  needs_review: "Patienten har en öppen granskningspost",
  no_valid_booking: "Ingen giltig bokning",
  waiting: "Väntar — tidsgränsen är inte nådd",
  unresolved_placeholder: "Mallen innehåller ej lösta platshållare",
  sequence_complete: "Sekvensen är redan slutförd",
  delivery_pending: "En tidigare leverans är inte bekräftad",
  stale_cycle: "Patienten har bokat en ny tid sedan SMS:et schemalades",
  out_of_order: "SMS-steget kommer före ett som redan skickats",
};

/** Default operator-facing wording per outcome. */
export function defaultMessage(kind: SendOutcomeKind, sequenceNumber?: number | null): string {
  const step = sequenceNumber ? ` (SMS ${sequenceNumber})` : "";
  switch (kind) {
    case "sent":      return `SMS skickat${step}`;
    case "delivered": return `SMS levererat${step}`;
    case "dry_run":   return `Loggat i testläge — inget SMS skickades${step}`;
    case "skipped":   return `SMS skickades inte${step}`;
    case "failed":    return `SMS misslyckades${step}`;
    case "unknown":   return `Okänd leveransstatus${step} — kontrollera innan du skickar igen`;
  }
}

/**
 * Build an outcome from a persisted reminder log. Keeps the mapping from
 * ReminderLogStatus to operator-facing vocabulary in exactly one place.
 */
export function outcomeFromLog(log: ReminderLog): SendOutcome {
  const kind = kindFromLogStatus(log.status);
  const skipLabel = log.skip_reason ? SKIP_REASON_LABELS[log.skip_reason] : null;

  return {
    kind,
    message: kind === "skipped" && skipLabel
      ? `SMS skickades inte: ${skipLabel}`
      : defaultMessage(kind, log.sequence_number),
    detail: log.error ?? skipLabel ?? null,
    logId: log.id,
    sequenceNumber: log.sequence_number,
    // "delivered" is only ever written by the provider confirming the message,
    // either via the delivery webhook or post-send verification. "sent" means
    // the request was accepted and nothing more.
    verified: kind === "delivered",
  };
}

export function kindFromLogStatus(status: ReminderLogStatus): SendOutcomeKind {
  switch (status) {
    case "sent":      return "sent";
    case "delivered": return "delivered";
    case "dry_run":   return "dry_run";
    case "skipped":   return "skipped";
    case "unknown":   return "unknown";
    case "pending":   return "unknown"; // still in flight — never report as sent
    case "failed":    return "failed";
    // cycle_reset is bookkeeping, never the result of a send request.
    default:          return "failed";
  }
}
