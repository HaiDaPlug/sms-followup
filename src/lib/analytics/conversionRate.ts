/**
 * Effectiveness is a per-patient question, not a per-message one: a patient who
 * received three sequence steps and rebooked once is one converted patient, not
 * three. Both sides are therefore counted as distinct patients.
 *
 * The conversion side is intersected with the SMS'd set rather than trusted on
 * its own, so the rate cannot exceed 1 when a conversion references an SMS sent
 * before the current window.
 *
 * Pure and free of "server-only" so it can be unit-tested directly.
 */
export function calculateConversionRate(
  smsPatientIds: (string | null)[],
  convertedPatientIds: (string | null)[]
): { smsPatientCount: number; conversionRate: number | null } {
  const smsed = new Set(smsPatientIds.filter((id): id is string => !!id));
  if (smsed.size === 0) return { smsPatientCount: 0, conversionRate: null };

  const converted = new Set(
    convertedPatientIds.filter((id): id is string => !!id && smsed.has(id))
  );

  return { smsPatientCount: smsed.size, conversionRate: converted.size / smsed.size };
}
