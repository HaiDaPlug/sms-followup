/**
 * Read-time attribution window.
 *
 * Conversions are RECORDED with a wide 365-day lookback (migration 019) so no
 * near-miss is lost, then narrowed here. Keeping the decision at read time is
 * what makes the window retroactive: changing it re-answers history instead of
 * needing a migration, and every stored candidate is preserved either way.
 *
 * Pure and free of "server-only" so it can be unit-tested directly.
 */

export const ATTRIBUTION_WINDOWS = [30, 60, 90] as const;
export type AttributionDays = (typeof ATTRIBUTION_WINDOWS)[number];

export const DEFAULT_ATTRIBUTION_DAYS: AttributionDays = 90;

export function parseAttributionDays(value: string | null): AttributionDays {
  const parsed = Number(value);
  return (ATTRIBUTION_WINDOWS as readonly number[]).includes(parsed)
    ? (parsed as AttributionDays)
    : DEFAULT_ATTRIBUTION_DAYS;
}

/**
 * A conversion counts when the SMS preceded the booking by less than the
 * window. days_since_sms is a floor of whole elapsed days, so a same-day
 * rebooking is 0 and the comparison is exclusive at the upper bound: at a
 * 30-day window, day 29 counts and day 30 does not.
 */
export function isWithinAttributionWindow(
  daysSinceSms: number,
  attributionDays: number
): boolean {
  return daysSinceSms >= 0 && daysSinceSms < attributionDays;
}

export function filterByAttributionWindow<T extends { days_since_sms: number }>(
  conversions: T[],
  attributionDays: number
): T[] {
  return conversions.filter((c) => isWithinAttributionWindow(c.days_since_sms, attributionDays));
}
