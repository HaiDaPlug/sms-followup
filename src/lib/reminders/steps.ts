import type { ReminderSettings, SmsStep, StoredSmsStep } from "@/types/clinic";

/**
 * Deterministic, RFC-shaped id for a step that has none at rest. Used for the
 * legacy three-template fallback (sms_steps null) and, transiently, for a
 * stored element that predates migration 025. Positional on purpose: it is
 * stable across reads without ever being written back, so it cannot drift
 * between two calls the way a random id would.
 */
export function fallbackStepId(position: number): string {
  return `00000000-0000-4000-8000-0000000000${String(position).padStart(2, "0")}`;
}

function sortByDay<T extends { day: number; id?: string }>(steps: T[]): T[] {
  // Day first; id second so two equal days still resolve in one order.
  return [...steps].sort((a, b) => a.day - b.day || (a.id ?? "").localeCompare(b.id ?? ""));
}

/**
 * The single place steps are read for the engine. Every returned step carries
 * an id and an active flag. Never mints random ids: that happens only in the
 * settings route and migration 025, otherwise the same step would change
 * identity on every read.
 */
export function resolveSteps(settings: ReminderSettings): SmsStep[] {
  if (settings.sms_steps && settings.sms_steps.length > 0) {
    return sortByDay(settings.sms_steps).map((step, index) => ({
      id: step.id ?? fallbackStepId(index + 1),
      day: step.day,
      template: step.template,
      active: step.active ?? true,
    }));
  }
  const d = settings.days_after_booking;
  return [
    { id: fallbackStepId(1), day: d,     template: settings.sms_template,   active: true },
    { id: fallbackStepId(2), day: d * 2, template: settings.sms_template_2, active: true },
    { id: fallbackStepId(3), day: d * 3, template: settings.sms_template_3, active: true },
  ];
}

/**
 * Steps for the settings form: the stored array as-is, ids preserved exactly
 * (undefined stays undefined) so a resolver fallback id is never persisted by
 * a save. Only the legacy-null path falls back to resolveSteps, whose fixed
 * legacy ids are then persisted on first save — consistent with any logs the
 * engine already wrote under them.
 */
export function stepsForEditing(settings: ReminderSettings): StoredSmsStep[] {
  if (settings.sms_steps && settings.sms_steps.length > 0) {
    return sortByDay(settings.sms_steps).map((step) => ({ ...step }));
  }
  return resolveSteps(settings);
}

export function stepById(steps: SmsStep[], id: string | null | undefined): SmsStep | undefined {
  if (!id) return undefined;
  return steps.find((step) => step.id === id);
}

/**
 * 1-based position in the full sorted list, inactive steps included. This is
 * what the legacy `sequence_number` column and its labels mean.
 */
export function stepPosition(steps: SmsStep[], id: string): number | null {
  const index = steps.findIndex((step) => step.id === id);
  return index === -1 ? null : index + 1;
}

export function activeSteps(steps: SmsStep[]): SmsStep[] {
  return steps.filter((step) => step.active);
}
