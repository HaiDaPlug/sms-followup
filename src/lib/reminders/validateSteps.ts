import type { StoredSmsStep } from "@/types/clinic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STALE_STEPS_ERROR = "Ladda om sidan och försök igen";

export type NormalizedSteps =
  | { ok: true; steps: StoredSmsStep[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize and validate a posted sms_steps array against what is stored.
 *
 * Id protection: once the stored steps carry ids, every posted element must
 * carry one too. The current form always posts ids, so an id-less element can
 * only come from a stale tab running an older UI, and merging it would risk
 * erasing ids that reminder_logs already references. Rejecting is the only
 * safe answer. Before the stored steps have ids, id-less elements are minted
 * here — the one place besides migration 025 that creates them.
 *
 * Pure and free of "server-only" so it can be unit-tested; `mintId` is
 * injectable for the same reason.
 */
export function normalizeAndValidateSmsSteps(
  posted: unknown,
  stored: StoredSmsStep[] | null | undefined,
  mintId: () => string = () => crypto.randomUUID()
): NormalizedSteps {
  if (!Array.isArray(posted)) return { ok: false, error: "Ogiltigt format för sms_steps" };
  for (const item of posted) {
    if (!isRecord(item) || typeof item.day !== "number" || typeof item.template !== "string") {
      return { ok: false, error: "Ogiltigt format för sms_steps" };
    }
  }
  const records = posted as Array<Record<string, unknown> & { day: number; template: string }>;

  const hasId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const storedHasIds = (stored ?? []).some((step) => hasId(step.id));
  if (storedHasIds && records.some((record) => !hasId(record.id))) {
    return { ok: false, error: STALE_STEPS_ERROR };
  }

  const steps: StoredSmsStep[] = [];
  for (const record of records) {
    const id = hasId(record.id) ? record.id : mintId();
    if (!UUID_RE.test(id)) return { ok: false, error: `Ogiltigt id för uppföljning: ${id}` };
    if (!Number.isInteger(record.day) || record.day <= 0) {
      return { ok: false, error: `Ogiltig dag för uppföljning: ${record.day}` };
    }
    if (record.active !== undefined && typeof record.active !== "boolean") {
      return { ok: false, error: "Ogiltigt värde för aktiv" };
    }
    // Only known keys survive, so a stray field can never reach the jsonb column.
    steps.push({
      id,
      day: record.day,
      template: record.template,
      active: record.active === undefined ? true : record.active,
    });
  }

  const ids = new Set<string>();
  const days = new Set<number>();
  for (const step of steps) {
    if (ids.has(step.id!)) return { ok: false, error: "Två uppföljningar har samma id" };
    if (days.has(step.day)) {
      // Two steps on the same day make ordering ambiguous: sending one would
      // mark the other as "already sent" forever.
      return { ok: false, error: `Två uppföljningar har samma dag (${step.day})` };
    }
    ids.add(step.id!);
    days.add(step.day);
  }

  steps.sort((a, b) => a.day - b.day);
  return { ok: true, steps };
}
