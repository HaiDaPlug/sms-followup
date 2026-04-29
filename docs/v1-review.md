# V1 Scaffold Review — Demo Safety

**Date:** 2026-04-28
**Reviewer:** Claude Code
**Scope:** Correctness, data safety, duplicate prevention, import idempotency, dry-run safety, SMS safety rules, secret handling, Supabase swap-readiness.

---

## Overall Verdict

Strong one-shot scaffold. Architecture is clean: core logic lives in `src/lib/`, not inside React pages or API routes. The repository abstraction in `src/lib/storage/store.ts` is the only file that needs to change to swap from local JSON to Supabase. All critical product rules (do_not_contact, missing phone, future booking exclusion, cancelled booking exclusion, dry-run gate) are implemented and correctly wired.

Two bugs were found and fixed. No features were added.

---

## Fixes Applied

### Fix 1 — `dry_run` logs did not block duplicate sends

**File:** `src/lib/reminders/eligibility.ts:35-40`
**Severity: Critical**

`hasReminderForLatestBooking` only checked `log.status === "sent"`. A patient who received a `dry_run` log remained `"Ready"` and would be sent a real SMS the moment dry-run mode was turned off. During a demo where dry-run is toggled on/off, this would send duplicate SMS to real patients for the same booking.

**Change:** Extended the status check to also match `"dry_run"`.

```ts
// before
log.status === "sent"

// after
log.status === "sent" || log.status === "dry_run"
```

**Why this matters:** The demo flow almost certainly involves showing dry-run first, then flipping the switch to prove live SMS works. Without this fix, every patient that went through dry-run would get a real SMS the moment you switched modes.

### Fix 2 — Vercel Cron route silently 405'd in production

**File:** `app/api/cron/daily-reminders/route.ts`
**Severity: Blocker in production (not a local demo blocker)**

Vercel Cron calls the configured path with a GET request. The route only exported `POST`. In production this would result in a silent 405 and no reminders ever being sent automatically by the cron schedule. You would not get an error — it would just never run.

**Change:** Added a `GET` handler that runs the same logic. `POST` delegates to `GET` so manual curl/Postman calls still work.

---

## Confirmed Safe — All 8 Questions Answered

### 1. Can CSV import be run multiple times without duplicating bookings?

**Yes.** `upsertBooking` in `src/lib/import/bokadirekt.ts:104` deduplicates on `external_booking_id`. That ID comes from the explicit `Id`/`BookingId` column in the CSV if present, or falls back to a SHA-256 hash of `Date + Interval + Customer + Phone + Service + Performer`. Running the same CSV twice will update existing bookings in place, not create new ones.

**Caveat:** The hash-based fallback ID is sensitive to CSV column name changes (see Remaining Risks below).

### 2. Does latest valid booking exclude cancelled and future bookings correctly?

**Yes.** `recalculatePatients` in `src/lib/import/bokadirekt.ts:133` filters bookings for each patient to only those that:
- Have a non-null `booking_at`
- Are not future (`!isFutureBooking(booking_at)`)
- Are not cancelled (`!isCancelledBooking(status)`)

Then sorts descending by date and takes the first. `patient.last_booking_at` and `patient.latest_treatment` are set from this. This runs after every import over the full store, so it's always consistent.

### 3. Are patients with future bookings excluded from reminders?

**Yes.** `calculatePatientReminderStatus` in `src/lib/reminders/eligibility.ts:53` checks `patient.has_future_booking` early in the priority chain, before the days-elapsed check. If true, it returns `"Future booking"` immediately, and the patient never reaches `"Ready"`.

### 4. Is duplicate SMS prevention implemented per latest booking?

**Yes, with Fix 1 applied.** `hasReminderForLatestBooking` looks up the patient's latest valid booking by matching `booking.booking_at === patient.last_booking_at`, then checks whether any log exists with that exact `booking_id` and `patient_id` with status `"sent"` or `"dry_run"`. If a log exists, the patient status becomes `"Sent"` and they are excluded from the eligible list.

### 5. Does dry-run mode guarantee no provider call?

**Yes.** In `src/lib/reminders/process.ts:36`, `sendReminderToPatient` checks `settings.dry_run_mode` before calling `sendSms`. If true, it writes a `dry_run` log and returns immediately — `sendSms` is never called. The test route (`/api/reminders/test`) also checks `settings.dry_run_mode` and short-circuits before calling the provider.

### 6. Does manual SMS respect all safety rules?

**Yes.** `sendReminderToPatient` calls `calculatePatientReminderStatus` first. If the result is anything other than `"Ready"`, it logs a `"skipped"` entry with the reason and returns — no SMS is sent. This covers:
- `do_not_contact: true` → `"Do not contact"`
- `normalized_phone` is null → `"Missing phone"`
- `has_future_booking: true` → `"Future booking"`
- Open review item linked to patient → `"Needs review"`
- No valid past booking → `"No valid booking"`
- Days threshold not yet met → `"Waiting"`
- Already sent/dry-run for this booking → `"Sent"`

### 7. Are local JSON writes safe enough for a local demo?

**Yes, for single-user local use.** `updateStore` does read-modify-write without a file lock. Under Node.js's single-threaded async model, each `await updateStore(...)` call completes before the next one starts, so there is no interleaving in practice. The risk only appears under concurrent requests (e.g. two browser tabs sending at the exact same millisecond), which won't happen in a demo. Flag for Supabase migration.

### 8. Are secrets kept server-side and never exposed to client components?

**Yes.** All sensitive env vars are used only in `src/lib/` and API routes (`app/api/`). None have the `NEXT_PUBLIC_` prefix. The vars in question: `FORTYSIX_ELKS_USERNAME`, `FORTYSIX_ELKS_PASSWORD`, `CRON_SECRET`, `BOKADIREKT_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`. Client components receive no credentials.

---

## Remaining Risks — Not Fixed, Intentional

### Risk 1 — Cron and webhook endpoints are open when secrets are not set

**Files:** `app/api/cron/daily-reminders/route.ts`, `app/api/webhooks/bokadirekt/route.ts`
**Severity: High if deployed, not a local demo issue**

Both routes share the pattern:
```ts
const secret = process.env.CRON_SECRET;
if (!secret) return true; // no secret set → allow all callers
```

If deployed without setting `CRON_SECRET` and `BOKADIREKT_WEBHOOK_SECRET`, any HTTP caller can trigger the daily reminder run or inject booking data via the webhook. The eligibility and dry-run rules still apply, so no SMS is sent unsafely — but triggering cron runs freely is still undesirable.

**Action before any external deployment:** Set both `CRON_SECRET` and `BOKADIREKT_WEBHOOK_SECRET` in `.env.local` / Vercel environment. Until then, keep the server off public networks.

### Risk 2 — `/api/settings` and `/api/reminders/send` have no authentication

**Files:** `app/api/settings/route.ts`, `app/api/reminders/send/route.ts`
**Severity: Medium if deployed, not a local demo issue**

Anyone who can reach the server can:
- POST to `/api/settings` to turn off dry-run mode, change the clinic name, or change the SMS template.
- POST `{"patientId": "..."}` to `/api/reminders/send` to trigger a manual send for any patient.

On the send endpoint, all safety rules (eligibility, do_not_contact, dry_run_mode) still apply, so a rogue send attempt is still safe in terms of SMS correctness. But the surface is open.

**Not a blocker for a local demo running on localhost.**

### Risk 3 — Medium-confidence patient matches are imported before review

**File:** `src/lib/import/bokadirekt.ts:96`
**Severity: Low / intentional**

When a booking row matches a patient with "medium" confidence (last 7 digits of phone overlap + name similarity ≥ 0.5, or email domain overlap + name similarity ≥ 0.75), `upsertPatientFromBooking` still applies the match and updates the patient record. It also sets `uncertain: true`, which causes the import loop to create a review item saying "Review before merging."

The problem is that the merge has already happened by the time the review item appears. The review item is informational, not a gate.

**What to tell the client:** "Uncertain patient matches are imported optimistically — the system flags them for review but does not hold up the import. High-confidence matches (exact phone or exact email) are silent. If you see a review item tagged 'Uncertain patient match', inspect it and correct any wrong merge manually."

### Risk 4 — `stableBookingId` hash breaks if CSV column names change

**File:** `src/lib/import/normalizers.ts:91-106`
**Severity: Low**

When the CSV has no explicit `Id` / `BookingId` column, the deduplication ID is a SHA-256 hash of:
```
Date | Interval | Customer | Phone | Service | Performer
```
If BokaDirekt changes any of these column names in a future export, the hash changes and reimporting the same data will create duplicate bookings instead of updating existing ones. This is unlikely in V1 but worth knowing when onboarding a new CSV file format.

**Mitigation:** Always inspect the column headers of a new CSV export before running import. If columns were renamed, run a one-time data cleanup.

### Risk 5 — `has_future_booking` is only accurate at import time

**File:** `src/lib/import/normalizers.ts:45-48`
**Severity: Low**

`isFutureBooking` compares `booking_at` against `Date.now()` at the moment of import. A booking scheduled for today at 14:00 is "future" in the morning and "past" in the afternoon — but the patient's `has_future_booking` flag only updates when a new import runs.

This means a patient with a same-day appointment could flip from excluded to eligible mid-day without any action. In practice this is harmless for a demo and acceptable for V1, since the cron runs once per day in the morning. In a production system with frequent imports this self-corrects.

---

## Code-Level Notes

### `latestValidBooking` uses string equality on timestamps

**File:** `src/lib/reminders/eligibility.ts:22`

```ts
booking.booking_at === patient.last_booking_at
```

This works because `last_booking_at` is assigned directly from `latest?.booking_at` during `recalculatePatients` — the same string from the same booking record. It is correct today but fragile: if any other code path sets `last_booking_at` from a different source (e.g. reformatted date string from Supabase), the match will silently fail and `latestValidBooking` will return `undefined`. When migrating to Supabase, ensure date strings are stored and retrieved in the same ISO format.

### `cancelled` status check is consistent between import and eligibility

The import uses the full `isCancelledBooking` regex (`cancelled|canceled|avbokad|avbokat|avbokning|installd|aflyst`), but normalizes the stored `status` to `"Cancelled"` for any match. The eligibility check uses `/cancelled|avbokad/i.test(booking.status)`. Since stored cancelled bookings always have status `"Cancelled"`, both checks catch them correctly. The stored value is always the normalized form, not the raw Swedish variant.

### `suggestReviewActionWithAI` is a stub

**File:** `src/lib/review/ai.ts`

```ts
export function suggestReviewActionWithAI(input: { type: string; description: string }) {
  return `Review manually: ${input.description}`;
}
```

This is a plain string return, not an AI call. The name is aspirational. It is imported by `src/lib/import/bokadirekt.ts` for review item suggestions. No AI dependency in V1 — correct for the demo.

---

## Architecture Notes — Supabase Swap

The storage abstraction is intentionally thin. `src/lib/data/repository.ts` is a pure re-export:

```ts
export { addReminderLog, readStore, updateStore, writeStore, ... } from "@/lib/storage/store";
```

All business logic in `src/lib/import/`, `src/lib/reminders/`, and `src/lib/patients/` calls only through these named exports and has no knowledge of where data lives.

To replace the local JSON store with Supabase:

1. Replace `readStore` and `writeStore` implementations in `src/lib/storage/store.ts` with Supabase client calls using the existing table schema.
2. Apply `supabase/migrations/001_clinic_rebooking.sql` to your Supabase project.
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment.

No other files need to change.

---

## Pre-Demo Checklist

- [ ] Import the real BokaDirekt CSV via `/app/import` — do not demo with the placeholder `data/dev-db.json` data if you have real data available.
- [ ] Verify at least one patient shows status `"Ready"` in the patients list.
- [ ] Confirm dry-run mode is **on** in settings before the meeting starts.
- [ ] Send one real SMS to your own phone after the demo to prove the button works (set `FORTYSIX_ELKS_*` env vars, flip dry-run off, use the test SMS endpoint).
- [ ] Do not present the webhook endpoint as fully functional — say: "The webhook endpoint is prepared. Once we see a real BokaDirekt payload, we map it into the same import pipeline."
- [ ] Set `CRON_SECRET` and `BOKADIREKT_WEBHOOK_SECRET` before exposing the server URL to anyone outside the room.
