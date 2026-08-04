# Current State - Clinic Rebooking Reminder System

**Last updated:** 2026-08-04 (session 16 - analytics correctness, attribution window, pg_cron scheduling, RLS)
**Phase:** Migrations 001–021 applied to production. Deployed and building. Analytics page renders live data; conversion tracking is **not yet proven end-to-end** because no BokaDirekt webhook booking has ever been received.

---

## What This Product Is

A clinic rebooking engine built for Osteopaticentrum (Borås) that:
1. Imports patient booking history from a BokaDirekt CSV export
2. Receives live booking events via BokaDirekt webhooks (BookingCreated / BookingUpdated / BookingCancelled)
3. Deterministically auto-applies safe webhook matches and stages unmatched or conflicting identities for manual review
4. Atomically links or creates the patient, upserts the booking, recalculates booking metadata, and resets the SMS cycle once
5. Sends a 5-step SMS sequence — manually (next sequential step, bypassing day threshold) or via daily cron (highest threshold crossed)
6. Reserves each SMS step before calling the provider, preventing concurrent duplicate sends
7. Logs all activity and surfaces booking matches, failed SMS, and uncertain deliveries for review
8. Lets staff schedule a specific SMS template for a specific patient at a future date/time, delivered by an independent 15-minute worker that atomically claims due jobs so it can never double-send or collide with the daily cron
9. Reports on effectiveness — SMS sent, bookings received, and the subset of rebookings attributable to a preceding SMS within a selectable 30/60/90-day window

One deployment per clinic. Supabase Auth gate in place.

---

## Infrastructure

- **Next.js 15** App Router + TypeScript, React 19
- **Supabase** (Stockholm region, project `updomqqgivylpunzuanw`) — migrations 001–021 applied
- **SMS**: 46elks adapter in `src/lib/sms/provider.ts` — virtual number +46766864658
- **Auth**: Supabase Auth via `@supabase/ssr`. Middleware protects `/app/*` and `/api/*`. Cron + webhook routes use secret-based auth.
- **RLS**: enabled on all nine application tables (migration 021). Writes and most reads use the service role, which bypasses RLS; the only anon-key data reader is the analytics page, covered by four `authenticated`-scoped SELECT policies. Verified 2026-08-04 that the anon key returns `42501 permission denied` on every table.
- **Deployment**: Vercel, auto-deploys on push to `main`
- **Cron**:
  - Vercel cron `0 8 * * *` → `/api/cron/daily-reminders` (daily; Hobby-compatible)
  - Supabase `pg_cron` job `scheduled-sms-worker`, every 15 min → `pg_net` POST to `/api/cron/scheduled-sms`. Moved off Vercel cron because Hobby rejects sub-daily schedules at deploy time. Setup and verification queries in `docs/scheduled-sms-setup.md`.
- **Testing**: `vitest` (`npm run test`) — see [Testing](#testing) section

---

## Environment Variables

| Variable | Local | Vercel | Notes |
|---|---|---|---|
| `SUPABASE_URL` | ✅ | ✅ | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ✅ | |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | ✅ | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | ✅ | |
| `SMS_PROVIDER` | ✅ | ✅ | `46elks` |
| `FORTYSIX_ELKS_USERNAME` | ✅ | ✅ | |
| `FORTYSIX_ELKS_PASSWORD` | ✅ | ✅ | |
| `FORTYSIX_ELKS_FROM` | ✅ | ✅ | `OsteopatiC` |
| `FORTYSIX_ELKS_VIRTUAL_NUMBER` | ⚠️ | ⚠️ | `+46766864658` — add to both |
| `BOKADIREKT_WEBHOOK_SECRET` | ❌ | ❌ | Rotate the exposed old credential in BokaDirekt, then set the replacement in Vercel |
| `TEST_SMS_TO` | ✅ | — | |
| `CRON_SECRET` | ✅ | — | Must also be mirrored into the Supabase Vault as `cron_secret` — the scheduled-SMS worker is triggered by `pg_cron`, not Vercel |
| `SMS_DELIVERY_WEBHOOK_SECRET` | ❓ | ❓ | Required for 46elks delivery receipts. Without it no delivery URL is sent to the provider **and** the webhook rejects every request, so logs stay at `sent` and never advance to `delivered`/`failed` |

**Supabase Vault secrets** (separate from env vars, set once per project — see `docs/scheduled-sms-setup.md`):

| Secret | Purpose |
|---|---|
| `app_base_url` | Deployed app base URL the `pg_cron` trigger posts to |
| `cron_secret` | Must equal `CRON_SECRET`; sent as the bearer token |

---

## Pages

| Route | Status | Notes |
|-------|--------|-------|
| `/app/dashboard` | Working | KPI strip, modals, daily snapshot |
| `/app/patients` | Working | Card rows, bulk select, status filters (including Delivery pending), manual send |
| `/app/sms-history` | Working | Per-patient SMS log, pending/unknown delivery states, bulk send, DNC toggle |
| `/app/import` | Working | CSV upload, idempotent |
| `/app/review` | Working | Review queue — failed SMS, unknown deliveries, and pending booking matches |
| `/app/settings` | Working | 5 editable SMS steps, dry-run toggle, emoji picker, char counter |
| `/app/inbox` | Working | Incoming SMS from virtual number, inline reply |
| `/app/analytics` | Working (renders live data) | Daily SMS/bookings chart, four stat tiles incl. conversion rate, bookings table, SMS-matched bookings log, 30/90/180/365-day period selector and a separate 30/60/90-day attribution picker. Conversion figures are **not yet proven** — see session 16 concerns |
| `/app/scheduled-sms` | Working in code | Management table for scheduled SMS — status, scheduled time, resolved template, cancel action; shows snapshotted name/phone if the patient was later deleted. Delivery via `pg_cron` not yet verified against a live tick |

---

## API Routes

| Endpoint | Status | Notes |
|----------|--------|-------|
| `POST /api/import/bokadirekt` | Working | CSV upload, idempotent |
| `GET /api/dashboard/*` | Working | stats, ready-patients, sms-this-month, review-items, activity |
| `POST /api/reminders/send` | Working | Manual send — `forceNext` bypasses day threshold (NOT safety gates) |
| `POST /api/reminders/send-message` | Working | Failed-SMS retry; server validates patient/cycle, reserves sequence, resolves review only on success |
| `POST /api/reminders/test` | Working | Test SMS to configured phone |
| `GET/POST /api/settings` | Working | |
| `POST /api/patients` | Working | Manual patient creation |
| `POST /api/patients/[id]/do-not-contact` | Working | |
| `POST /api/patients/[id]/reactivate` | Working | |
| `POST /api/review/[id]` | Working | Resolve/ignore |
| `POST /api/review/confirm-booking-match` | Working | Confirms a staged candidate or creates a patient through the shared transactional RPC |
| `POST /api/review/resolve-delivery` | Working | Atomically resolves an unknown SMS delivery as sent or failed |
| `GET /api/analytics` | Working in code | Stockholm-calendar daily bookings/SMS, zero-filled series, period totals, booking rows, and non-cancelled automatic SMS matches |
| `GET /api/cron/daily-reminders` | Working | Daily batch; excludes any patient with an active (`pending`/`processing`) scheduled SMS |
| `POST /api/scheduled-sms` | Working in code | Creates a scheduled SMS; validates patient, hard-block eligibility, clinic timezone, future date, and sequence bounds server-side; freezes the rendered message at creation |
| `GET /api/scheduled-sms` | Working in code | Lists scheduled SMS (capped at 250 rows, newest first) |
| `DELETE /api/scheduled-sms/:id` | Working in code | Cancels only if still `pending`; returns 409 if already claimed/completed |
| `GET /api/cron/scheduled-sms` | Working in code | Independent worker — atomically claims due jobs and delivers them. Triggered every 15 min by Supabase `pg_cron`, **not** by `vercel.json` |
| `POST /api/webhooks/bokadirekt` | Working in code | Auto-applies deterministic matches; stages unmatched and conflicting identities for review |
| `POST /api/webhooks/sms-incoming` | Working | 46elks incoming SMS → inbox |
| `POST /api/webhooks/sms-delivery` | Working | 46elks delivery receipts |
| `POST /api/sms/reply` | Working | Reply via 46elks |
| `GET /api/sms/inbox` | Working | |
| `DELETE /api/logs/:id` | Working | |
| `DELETE /api/logs` | Working | |

---

## SMS Sequence Logic

5 steps seeded in `reminder_settings.sms_steps` (migration 009). Mattias's real templates.

| SMS | Day threshold | Behaviour |
|-----|--------------|-----------|
| 1 | 5 | First follow-up |
| 2 | 14 | Second follow-up |
| 3 | 90 | 3-month check-in |
| 4 | 180 | 6-month check-in |
| 5 | 365 | 12-month check-in |

**Cron:** picks the **highest** threshold crossed that hasn't been sent yet. Patient at day 180 with no history → SMS 4. Next run waits for day 365.

**Manual send (`forceNext=true`):** picks the **highest crossed threshold** not yet sent, same as cron. If no new threshold has been crossed since the last send (e.g. testing by re-sending), re-sends the last sent step instead of advancing. This means a patient at 212 days gets SMS 4 on manual send, not SMS 1.

**Safety gates (always enforced, even on force):** Do not contact, Missing phone, Future booking, Needs review, Delivery pending, No valid booking.

**Cycle reset:** the shared booking RPC writes one `is_cycle_reset=true` row for a new booking. Retries do not duplicate it. If a booking is reassigned, the reset moves to the selected patient with a fresh `created_at` so the new cycle starts immediately.

### SMS Reservation / Outbox Flow

For live sends, the app now:
1. Inserts a `pending` reminder log using the cycle key `(patient_id, booking_id, sequence_number)`
2. Relies on a partial unique index to reject concurrent reservations with `23505`
3. Calls the SMS provider only after the reservation succeeds
4. Finalizes the same row as `sent` or `failed`

`dry_run` rows use the same uniqueness key and are final immediately.

If the provider call may have completed but database finalization did not, the row remains `pending`. Cron reconciles `pending` rows older than five minutes to `unknown` and creates a `delivery_unknown` review item atomically. Both statuses produce the hard block **Delivery pending**, so no later sequence step can send until an operator resolves it:
- **Markera skickad** → log becomes `sent`, `sent_at` is set, sequence remains consumed
- **Markera misslyckad** → log becomes `failed`, reservation is released, step can retry

---

## Scheduled SMS

Staff can schedule a specific SMS template for a specific patient at a future clinic-local (Europe/Stockholm) date/time from the patient row.

**Creation (`POST /api/scheduled-sms`):** server re-validates everything the client already checked — patient exists, hard-block eligibility (do not contact, missing phone, future booking, needs review, delivery pending, no valid booking), timezone must equal `Europe/Stockholm`, date must be in the future, `sequenceOverride` must be an integer within the resolved step range. The message is rendered from the template and frozen into `message_override` at creation time, along with a `patient_name`/`recipient_phone` snapshot — delivery never re-renders the template later.

**Delivery (`GET/POST /api/cron/scheduled-sms`, every 15 minutes via Supabase `pg_cron`):**
1. `claim_due_scheduled_sms` (migration 016) atomically claims due `pending` rows with `FOR UPDATE SKIP LOCKED`, flipping them to `processing` in the same statement — two concurrent workers cannot claim the same row.
2. A crashed/orphaned `processing` row older than 30 minutes is auto-reconciled to `unknown` rather than retried.
3. Eligibility hard blocks are rechecked at delivery time; soft blocks (`Waiting`/already `Sent`) are intentionally bypassed since an explicit schedule overrides normal cadence.
4. The reservation (`reminder_logs` row) is always written before the provider is called.
5. Outcomes are `sent`, `dry_run`, `unknown` (provider result ambiguous — never auto-retried), `skipped` (e.g. patient deleted), or `failed`. Dry-run is never mapped to `sent`.
6. `completeScheduledSms` only updates a row that is still `processing`; if the row moved on (e.g. reconciled as stale), it throws instead of overwriting.

**Cancellation (`DELETE /api/scheduled-sms/:id`):** only succeeds while the row is still `pending`; once claimed, cancellation returns 409 rather than racing the worker.

**Collision with the daily cron:** `processDailyReminders` excludes any patient with an active (`pending`/`processing`) scheduled SMS from its own batch, so the daily worker cannot consume a sequence step out from under a pending scheduled job. The two crons run as fully separate endpoints, so an exception in one cannot block the other.

**Patient deletion:** `patient_id` is `ON DELETE SET NULL` (not cascade) — history is preserved via the `patient_name`/`recipient_phone` snapshot taken at creation.

---

## BokaDirekt Webhook Integration

**Confirmed payload shape** (from live test 2026-06-05):
- Auth: `webhook-secret` header (not `x-webhook-secret`)
- Event type: `webhook-event` header — `BookingCreated`, `BookingUpdated`, `BookingCancelled`
- Key fields: `Customer.MobilePhoneNumber`, `Customer.EmailAdress` (note typo), `Customer.Id`, `BookingStartDate`, `ServiceName`, `PersonName`, `Cancelled` boolean, `EventCreated`

**Webhook URL:** `https://sms-followup.vercel.app/api/webhooks/bokadirekt` (all 3 event types → same endpoint)

**Matching tiers:**
1. Exact `bokadirekt_customer_id`
2. Exact unique `normalized_phone`
3. Exact normalized email only when exactly one patient matches

All available identity keys are checked before mutation. If keys point to different patients, a key matches multiple patients, or no patient matches, the webhook creates an open `pending_booking_match` review item. Safe single-patient matches call the shared RPC automatically. Successful auto-matches create a resolved audit item; audit insertion failure is logged but cannot turn an already-applied webhook into a failure.

Review items expose deduplicated candidate patients from `raw_data.identity_lookups`. Operators can select a staged candidate or create a new patient. The SQL wrapper rejects arbitrary patient IDs. Conflicting identifiers owned by another patient are preserved and are never transferred or cleared automatically.

### Shared Booking Transaction
Migration 014 adds service-role-only `apply_bokadirekt_booking` and replaces `confirm_booking_match` with a validating wrapper. The transaction:
- Takes an advisory lock per BokaDirekt booking ID
- Creates the patient, or for an existing patient: locks the row, rejects the mutation if the patient is already linked to a *different* `bokadirekt_customer_id`, and otherwise only fills blank identity fields (`bokadirekt_customer_id`, `normalized_phone`, `phone`, `email`) — an existing non-null value is never overwritten or cleared
- Upserts the booking idempotently
- Recomputes `last_booking_at` and `latest_treatment` from the latest non-cancelled booking
- Writes one cycle reset for a new booking
- Recomputes both patients and moves the reset with a fresh timestamp if a booking is reassigned
- Resolves a manual review item only after the shared mutation succeeds

Duplicate webhook retries do not duplicate bookings or cycle resets. Any mutation failure rolls back the transaction. `findDeterministicMatch` also flags a cross-tier `bokadirekt_customer_id` mismatch as a conflict on the webhook side before the RPC is ever called, so a phone/email-tier match against a patient already linked to a different BokaDirekt ID goes to manual review instead of auto-applying; the SQL-level guard above is the enforcement point for the manual-confirmation path, which doesn't go through that pre-check.

### Cancellation

Cancellation is now one atomic, advisory-locked transaction: migration 014 adds `cancel_bokadirekt_booking(p_booking_id_external)`, which the webhook calls directly. It locks the booking row, marks it `cancelled=true` with status `Cancelled`, deletes its cycle-reset log, recomputes the linked patient's `last_booking_at` and `latest_treatment` from remaining non-cancelled bookings, and resolves any open `pending_booking_match` review item for that booking — all in one transaction. Because it shares the same advisory lock key as `apply_bokadirekt_booking`, a cancellation can no longer interleave with a concurrent create/update/reassignment for the same booking. A cancellation for an unknown or not-yet-confirmed booking is accepted as a no-op (only the review-item close runs). Retries are idempotent. `Customer.Id` is optional in the payload parser, so a cancellation payload that omits it no longer throws before reaching this handler.

### Analytics and SMS-Matched Bookings

The analytics page now reports activity by the day it entered the system, regardless of the future appointment date:

- Bookings use `event_created_at ?? created_at`; cancelled bookings remain visible but are excluded from totals and chart counts.
- SMS use the original `reminder_logs.sent_at`; delivery receipts no longer overwrite the send timestamp.
- All selected Stockholm calendar days are emitted, including zero-activity days, with DST-safe period boundaries.
- The top chart surfaces total SMS sent, active bookings, and matched bookings for 30/90/180/365-day periods.
- The lower panels show booking-recorded and appointment dates on the left, and deterministic SMS-matched bookings on the right.
- Query failures are surfaced instead of silently appearing as zero metrics; period refresh failures preserve the current UI data.

Migration 017 adds `sms_conversions` and the service-role-only `apply_bokadirekt_booking_auto_matched` wrapper. The wrapper calls migration 014's booking mutation and records an eligible conversion in the same PostgreSQL transaction. Only webhook matches that never entered `pending_booking_match` review qualify; manual confirmations remain excluded even if a later BookingUpdated event becomes deterministically matchable. The latest sent/delivered SMS before the booking-recorded timestamp qualifies, with no attribution-window cap. Duplicate webhook deliveries are idempotent by BokaDirekt booking ID. Cancellation marks the conversion cancelled in the same advisory-locked transaction.


---

## Migrations Applied (001-011)
| Migration | What it adds |
|-----------|-------------|
| 001 | Base schema: patients, bookings, reminder_settings, reminder_logs, review_items |
| 002 | `content_hash` unique index on review_items |
| 003 | `sms_steps` JSONB on reminder_settings |
| 004 | reminder_logs hardening: CHECK constraint, unique indexes |
| 005 | `skip_reason`, `daily_snapshots`, future-booking index |
| 006 | `incoming_sms` table |
| 007 | `allow_same_number_override` on reminder_settings |
| 008 | Webhook fields on bookings/patients: `bokadirekt_booking_id`, `bokadirekt_customer_id`, `service_name`, `practitioner_name`, `booking_date`, `location_name`, `price`, `booked_online`, `cancelled` |
| 009 | Seed 5-step SMS sequence with Mattias's real templates |
| 010 | Change SMS step 2 from day 10 to day 14 |
| 011 | Add `event_created_at` to bookings for analytics |

| 012 | `confirm_booking_match` RPC |
| 013 | Outbox and cycle index; `resolve_delivery_unknown` |
| 014 | Shared auto/manual booking RPC, deterministic identity safety, reassignment handling, cycle-reset transfer |
| 015 | Scheduled SMS queue and scheduling fields |
| 016 | Scheduled-send claiming, retries, delivery-state hardening |
| 017 | SMS-match conversions, cancellation state, atomic auto-match wrapper |
| 018 | Shared `log_sms_conversion` used by both auto and manual paths; `match_type` column; attribution window |
| 019 | Widen conversion recording lookback to 365 days so attribution can be narrowed at read time |
| 020 | `pg_cron` + `pg_net` trigger for the scheduled-SMS worker; Vault-backed config |
| 021 | Enable RLS on all nine application tables; four `authenticated` SELECT policies; revoke blanket `anon` grants |

**Applied in production:** 001–021 (confirmed 2026-08-04).

---

## Session 10 — Audit Hardening Implemented

- **Transactional booking confirmation:** replaced the multi-query confirmation flow with the `confirm_booking_match` RPC.
- **Cycle-scoped duplicate prevention:** replaced the all-time `(patient_id, sequence_number)` index with booking-cycle-aware indexes.
- **Race-safe sends:** cron, manual sequence sends, failed-SMS retries, and dry runs reserve the sequence key before provider activity.
- **Unknown-delivery workflow:** stale reservations become review items with explicit sent/failed operator actions.
- **Retry hardening:** failed-SMS retry derives patient, phone, sequence, and booking cycle from server data; stale reviews and safety-gate failures return 409.
- **Cancellation error handling:** critical queries and mutations now propagate errors.
- **Fail-closed auth:** cron and BokaDirekt webhook return 401 when their configured secret is absent or incorrect.
- **Credential cleanup:** the exposed BokaDirekt credential was removed from HEAD. It still exists in git history and must be rotated.
- **UI updates:** Delivery pending is visible/filterable on Patients; pending and unknown logs have Swedish labels in SMS history.

### Verification

- `npm run build` — passes
- `npm run typecheck` — passes
- `git diff --check` — passes
- Exposed credential literal — absent from working tree
- Old fail-open auth pattern — absent from cron and BokaDirekt webhook routes

Remote database behavior has not been exercised yet because migrations 012, 013, and 014 have not been applied.

---

## Session 11 - BokaDirekt Auto-Match Implemented

- Added typed translation and validation for confirmed BokaDirekt payload fields.
- Replaced in-memory matching with targeted Supabase lookups by customer ID, unique normalized phone, then unique normalized email.
- Added cross-key conflict detection; conflicts and unmatched customers remain review-only.
- Added atomic auto-apply through migration 014 while retaining manual confirmation as a wrapper.
- Added resolved auto-match audit records without allowing audit insertion failure to fail a successful webhook.
- Added review UI candidate selection with visible API/network errors.
- Added SQL candidate authorization so manual confirmation accepts only staged candidates.
- Preserved identity keys owned by other patients rather than transferring or clearing them.
- Kept `last_booking_at` and `latest_treatment` aligned with the latest non-cancelled booking.
- Reassignment recomputes both patients and transfers the cycle reset with a fresh timestamp.
- Cancellation recomputes both booking metadata fields.

### Session 11 Verification

- `npm.cmd run typecheck` - passes
- `npm.cmd run build` - passes
- `git diff --check` - passes (Windows line-ending warnings only)
- Multiple independent read-only audits completed; no remaining code findings
- Migration 014 has not been applied or exercised against a live Supabase database

---

## Session 12 - Fixed 3 Audit Findings

A follow-up audit of session 11's work found 2 important issues and 1 minor issue, all in the BokaDirekt webhook/RPC path. All three are fixed:

1. **Cancellation was not atomic.** The old `handleCancellation` ran the booking cancel, cycle-reset delete, patient metadata recompute, and review-item resolution as four separate un-transacted calls with no advisory lock, unlike `apply_bokadirekt_booking`. A cancellation could interleave with a concurrent locked create/update/reassignment for the same booking, or leave partial state on a mid-sequence failure. Fixed by moving all of it into the new `cancel_bokadirekt_booking` RPC, which takes the same advisory lock key as `apply_bokadirekt_booking`.
2. **Silent `bokadirekt_customer_id` overwrite.** A patient matched via the phone/email tier (not the ID tier) could have its existing `bokadirekt_customer_id` silently rebound to a different incoming ID with no conflict raised. Fixed with two layers: `apply_bokadirekt_booking` now locks the patient row and raises an exception if it's already linked to a different non-null ID, and switched to fill-blanks-only `coalesce` for all identity fields instead of conditional overwrite; `findDeterministicMatch` also now flags this as a conflict before the webhook ever calls the RPC.
3. **`Customer.Id` was required even for cancellations.** `translateBokaDirektPayload` threw if `Customer.Id` was missing, regardless of event type, even though cancellation never reads it. `BokaDirektCustomer.Id` is now `string | null` and parsed with `optionalString`; `booking.Id` (the BokaDirekt booking ID) remains required for all event types.

### Session 12 Verification

- `npm.cmd run typecheck` - passes
- `npm.cmd run build` - passes
- `git diff --check` - passes (Windows line-ending warnings only)
- Independent audit re-verified all 3 fixes line-by-line against the failure scenarios that were originally flagged; no remaining findings
- Migration 014 has still not been applied or exercised against a live Supabase database

---

## Session 13 - Daily Analytics and SMS-Matched Booking Tracking

Claude implemented the daily analytics feature after the investigation and plan review.

### Session 13 Implementation

- Replaced weekly analytics buckets with zero-filled daily Stockholm-calendar series for SMS sent and bookings recorded.
- Extracted duplicated page/API queries into `src/lib/analytics/getAnalyticsData.ts` and added strict 30/90/180/365-day API validation.
- Added migration 017 with the `sms_conversions` table and unique BokaDirekt booking ID deduplication.
- Added `apply_bokadirekt_booking_auto_matched`, which composes migration 014's booking mutation and conversion logging inside one PostgreSQL transaction while leaving manual confirmation on the original RPC.
- Extended cancellation to mark conversions cancelled, and preserved the original SMS `sent_at` when delivery receipts arrive.
- Updated `/app/analytics` to show daily lines and totals at the top, bookings in the lower-left panel, and `SMS-matchade bokningar` in the lower-right panel.

### Post-Implementation Audit Fixes

The implementation diff was audited against the original request and plan. The following findings were patched:

1. Replaced host-timezone-dependent localized-date parsing with `Intl.DateTimeFormat().formatToParts()` offset calculation, producing correct Stockholm midnight boundaries in local and server environments.
2. Added a permanent review-history guard so a booking that entered `pending_booking_match` cannot later be counted as automatic after a BookingUpdated webhook.
3. Added explicit error propagation for bookings, SMS logs, patients, and conversions queries so database failures cannot masquerade as zero performance.
4. Added responsive lower-panel stacking at the 960px breakpoint and `min-width: 0` containment for both tables.
5. Made appointment dates nullable with an em-dash fallback, and added safe period-refresh loading/error handling that preserves the previous result on failure.

### Session 13 Verification

- `npm.cmd run typecheck` - passes
- `npm.cmd run build` - passes
- `git diff --check` - passes (Windows line-ending warnings only)
- Stockholm boundary checks pass for summer, winter, the 2026 DST start, and the 2026 DST end
- Database-backed migration/webhook tests have not run because migrations 012-017 are still pending in development Supabase

---

## Session 14 - Scheduled SMS Hardening, Audit, and Test Coverage

An earlier pass added scheduled SMS (migration 015) but shipped without a durable delivery state machine: it could double-send under two workers, let cancellation race an in-flight send, let free-text custom messages bypass eligibility/reservations, permanently mislabeled dry-run sends as `sent`, and depended on a once-daily cron that couldn't hit a scheduled time.

### Session 14 Hardening (migration 016)

- Added atomic claiming via `claim_due_scheduled_sms` (`FOR UPDATE SKIP LOCKED`), replacing plain `pending`-row selection.
- Added `processing`, `skipped`, `unknown`, and `dry_run` as first-class terminal/in-flight states.
- Made cancellation and completion conditional on current status (`pending` for cancel, `processing` for complete) instead of unconditional updates, closing the cancel/send race.
- Removed the free-text custom-message delivery path entirely — scheduling now only selects an existing template step, which is rendered and frozen server-side at creation and delivered through the same eligibility/reservation path as every other send.
- Classified provider network failures as `unknown` (never auto-retried) instead of a definite `failed`.
- Split scheduled delivery onto its own cron/endpoint (`/api/cron/scheduled-sms`, every 5 minutes) so it no longer depends on or can be blocked by the daily-reminders worker, and excluded patients with an active scheduled job from the daily batch.
- Added server-side validation for patient, timezone (`Europe/Stockholm`), future date, and sequence bounds; changed `patient_id` to `ON DELETE SET NULL` with a name/phone snapshot so deleting a patient no longer erases scheduled history.

### Independent Audit

A follow-up audit (not the implementing session) verified the hardening fix-by-fix against the original failure scenarios by reading the actual code (not just trusting the report): all 7 originally-flagged critical issues and 8 of 9 important issues were confirmed fixed. The one remaining gap — no automated tests existed for any of these guarantees — was then closed in the same session (below).

### Test Coverage Added

First automated test suite in the repo: `vitest` (`npm run test`), covering the specific guarantees above rather than re-testing existing behavior:

- `src/lib/storage/store.test.ts` — `cancelScheduledSms` only touches `pending` rows and no-ops otherwise; `completeScheduledSms` only touches `processing` rows and throws (rather than silently overwriting) otherwise; `claimDueScheduledSms` calls the atomic RPC with the right args.
- `src/lib/reminders/process.test.ts` — a claimed row for a deleted patient resolves to `skipped`; a dry-run send is never marked `sent`; provider network uncertainty is classified `unknown`, never a definite `failed`.

Real concurrent-worker races and cancellation races still require a live Postgres instance (Supabase staging) to observe directly — the atomic-claim pattern is correct by inspection and by unit test, but hasn't been exercised under real concurrency.

### Session 14 Verification

- `npm.cmd run typecheck` - passes
- `npm.cmd run build` - passes (one transient Windows `.next` cache failure on `/api/analytics`, same as prior sessions; clean rebuild succeeded)
- `npm.cmd run test` - passes, 8/8
- `git diff --check` - passes (Windows line-ending warnings only)
- Migrations 015/016 have not been applied or exercised against a live Supabase database; no real concurrent-worker test has been run

---

## Session 15 - SMS Sequencing Fix, 46elks Delivery URL, Debug UX

### Fixes

- **SMS sequence logic:** manual send now picks the highest crossed day threshold (same as cron) instead of always starting from step 1. A patient at 212 days with nothing sent gets SMS 4, not SMS 1. If no new threshold has been crossed since the last send (e.g. re-testing), re-sends the last step rather than advancing.
- **46elks `whendelivered` rejection:** the delivery callback URL is now only sent when `NEXT_PUBLIC_APP_URL` starts with `https://`. Localhost URLs were causing 46elks to reject every send with 403.
- **Error visibility:** failed sends now show the actual error inline (HTTP status + message) instead of just "Misslyckades", for both single-send and bulk-send paths. Raw DB error messages are no longer forwarded to the client — logged server-side instead.
- **Phone PII in browser logs:** removed phone number from client-side `console.error` in `FailedSmsActions`.
- **Keyboard shortcuts:** `Cmd/Ctrl+1–8` jump to sidebar nav items. Shortcut number hints appear on hover.
- **Migrations 012 and 013 applied to production** — SMS outbox reservation and constraint fix are live.

### Session 15 Verification

- `npm.cmd run typecheck` - passes
- `git diff --check` - passes
- SMS send confirmed working end-to-end against production 46elks
- Correct step selection verified: 212-day patient → SMS 4

---

## Session 16 — Analytics Correctness, Attribution Window, pg_cron, RLS

### Analytics defects fixed

- **1000-row PostgREST cap.** None of the four analytics queries set a range, so past 1000 rows results were silently truncated: chart counts and totals under-reported, and the patients lookup dropped names so the bookings table showed dashes at random. No error was raised. All four now page until a short page returns, capped at 50k rows. Each query also gained a stable `id` tiebreaker — without a total ordering, paged ranges can repeat or skip rows.
- **Manual matches were never counted as conversions.** 017 logged conversions only on the deterministic webhook auto-match path, and permanently excluded anything that had ever been staged for review. That excluded precisely the rebookings a human had verified, biasing the metric toward clean data and under-reporting real effectiveness. 018 extracts a shared `log_sms_conversion` used by both paths and adds `match_type` (`auto`/`manual`) so the deterministic subset stays isolable.
- **Unbounded attribution.** An SMS of any age could claim credit for a booking. Now bounded, and selectable.
- **Read-time attribution window.** 018 froze the window at write time, so near-misses were lost and the window could not be changed retroactively. 019 widens recording to a 365-day lookback and the window (30/60/90) is applied at read time against `days_since_sms`. **Consequence:** `sms_conversions` is now a record of *candidates*, not of counted conversions — anything querying it directly must apply its own filter.
- **Conversion rate added**, computed on distinct patients (three sequence steps to one person is one customer, not three) and intersected with the SMS'd set so the rate cannot exceed 100%. Renders `—` rather than `0 %` when no SMS went out in the window.
- **Superseded requests cancelled** via `AbortController` — a slow 365-day load could previously land after and overwrite a 30-day one requested afterwards.
- **`sent_at` no longer overwritten by delivery receipts** — a delayed receipt could shift which day an SMS bucketed into and corrupt `days_since_sms`.

### Infrastructure

- **Scheduled-SMS trigger moved from Vercel cron to Supabase `pg_cron` + `pg_net`** (migration 020). The `*/5` Vercel cron is rejected on Hobby at deploy time, which made a core feature depend on a paid plan. No application code changed — all correctness (atomic claiming, stuck-row recovery, attempt counting) already lived in Postgres; Vercel's cron was only a heartbeat. `pg_net` posts to the existing route rather than the database calling 46elks directly, keeping the third-party boundary out of the data layer. Secrets come from Vault, never the migration.
- **RLS enabled on all nine tables** (migration 021). Four `authenticated`-scoped SELECT policies cover the analytics reader; no write policies anywhere, since all writes go through the service role. Blanket `anon` grants revoked as defence in depth.
- **Build fix:** `readStoreForUi` moved out of the `repository.ts` re-export barrel into its own module. Declaring a value export alongside re-exports made Next drop it for importers resolving through the barrel — `next build` failed while `tsc --noEmit` accepted it.

### Verified

- Anon key returns `42501 permission denied` on all nine tables (was returning live patient names before 021).
- `/app/analytics` renders live data post-RLS; 41 unit tests, typecheck, and `next build` all pass.

### Concerns and known gaps

- **Conversion tracking is unproven end-to-end.** There are 4,715 bookings, all from the 2026-05-07 CSV import, and **zero** with `event_created_at` — no BokaDirekt webhook booking has ever been received. `sms_conversions` is empty. The pipeline is therefore untested against real data, and "SMS-matchade: 0" is expected rather than informative until webhooks are wired.
- **Analytics zeros are currently correct, not a fault.** All bookings bucket to the single 2026-05-07 import date, so any window shorter than ~90 days shows `Bokningar: 0`. Selecting 365 days should surface them as one spike. Worth re-checking once webhook bookings start arriving.
- **No conversions backfill.** 018/019 only affect rows written after they were applied; conversions skipped under the earlier 90-day write-time rule were never stored and cannot be recovered.
- **Attribution semantics are last-touch.** The most recent qualifying SMS gets credit. If the question becomes "which sequence step converts", that is a different query and the current data answers it only for the last step sent.
- **Migration 020/021 SQL was never executed locally** — no local Postgres — so it was verified by review and by post-apply checks against production, not by a test run.
- **`pg_net` does not retry.** Safe by design (the queue is the source of truth, so a missed tick delays rather than drops), but it means scheduled-SMS delivery has no independent alerting if the trigger silently stops firing.
- **The pg_cron schedule now lives in the database, not `vercel.json`** — it will not be visible when reading repo config. See `docs/scheduled-sms-setup.md`.
- **Anon key not yet rotated.** It was unrestricted for the life of the project, so it should be treated as compromised; 021 protects going forward but not against data already captured.

### Testing gaps to close

- Analytics has **no integration test** — `getAnalyticsData` imports `server-only` and calls Supabase directly, and the existing mock does not support `.or()`, `.in()`, `.gte()`, `.order()`, or terminal `await` on the builder. Only the extracted pure helpers (`dayKeys`, `conversionRate`, `attributionWindow`) are covered.
- The **scheduled-SMS claim path has no test against a real database.** `claim_due_scheduled_sms` concurrency (`FOR UPDATE SKIP LOCKED`) is the highest-risk untested code in the app — a bug there means duplicate SMS to real customers.
- **No test covers the RLS policies themselves.** The curl check proves the `anon` revoke works, but the `authenticated` read path is verified only by loading the page.
- **`log_sms_conversion` is untested** in both its auto and manual call paths.

---

## What Still Needs to Be Done

### Blocking / highest value

- [ ] **Wire and test the BokaDirekt webhook.** Nothing has ever been received (`event_created_at` null on all 4,715 bookings), so conversion tracking is entirely unproven. Until this fires, "SMS-matchade" stays 0 regardless of real-world results.
- [ ] **Test the Supabase `pg_cron` scheduled-SMS job end-to-end.** Never verified against a live tick. Steps:
  - [ ] Confirm both Vault secrets exist: `select name from vault.secrets where name in ('app_base_url','cron_secret');`
  - [ ] Confirm the job is registered and active: `select jobname, schedule, active from cron.job where jobname = 'scheduled-sms-worker';`
  - [ ] Fire it manually and check for an error: `select public.trigger_scheduled_sms();`
  - [ ] Check run history: `select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'scheduled-sms-worker') order by start_time desc limit 10;`
  - [ ] Schedule a real SMS a few minutes out and confirm it moves `pending → processing → sent` within ~15 minutes
  - [ ] Confirm the empty-tick short-circuit works — a tick with no due rows should make **no** HTTP call (no corresponding Vercel function invocation)
  - [ ] Confirm the route rejects an unauthenticated call (wrong/missing bearer → 401)
- [ ] **Compare conversions against reality** — ask the clinic whether any of the 30 messaged customers actually rebooked, and reconcile against what the app reports. This is the only way to distinguish "SMS aren't working" from "tracking isn't capturing it".
- [ ] **Rotate the Supabase anon key** and update Vercel + `.env.local`. It was unrestricted for the project's life.
- [ ] Rotate the exposed BokaDirekt webhook secret in BokaDirekt and set the replacement as `BOKADIREKT_WEBHOOK_SECRET` in Vercel
- [ ] Set `CRON_SECRET` in Vercel, and confirm the Vault `cron_secret` matches it
- [ ] Confirm `SMS_DELIVERY_WEBHOOK_SECRET` is set in Vercel — without it, delivery receipts silently never arrive and logs stay at `sent`

### Analytics QA (post-migration)
- [ ] Run development webhook smoke tests: ID match, phone match, email match, conflict, unknown customer, retry, reassignment, and cancellation
- [ ] Smoke test the session 12 fixes specifically: concurrent cancellation vs. update/create for the same booking (no interleaving), a manual confirm where the selected candidate has a different `bokadirekt_customer_id` than the raw booking (should raise, not silently overwrite), and a cancellation payload missing `Customer.Id`
- [ ] Smoke test analytics conversion cases: prior SMS + automatic match creates one row; no prior SMS creates none; manual confirmation followed by BookingUpdated stays excluded; duplicate retries remain idempotent; cancellation removes the conversion from metrics
- [ ] Verify 30/90/180/365-day analytics totals, zero-filled days, Stockholm boundaries, cancelled-booking counts, and responsive lower-panel stacking against development data
- [ ] Verify the attribution picker (30/60/90 d): narrowing must make the count **drop or hold, never rise**; the rate tile label must follow the selection
- [ ] Verify pagination past 1000 rows — patient names must not go missing in the bookings table once any query exceeds a single page
- [ ] Confirm a manual review confirmation now logs a conversion with `match_type = 'manual'` (the systematic undercount fixed in 018)
- [ ] Confirm cancelling a booking drops its conversion from the metric but leaves the booking visible in the table as "Avbokad" (deliberate asymmetry)
- [ ] Test stale pending resolution against the deployed database/provider flow
- [ ] Exercise real concurrent-worker claiming and cancellation races against staging Supabase before enabling scheduled-SMS provider delivery in production
- [ ] Add an integration test for `getAnalyticsData` — needs the Supabase mock extended to support `.or()`, `.in()`, `.gte()`, `.order()`, and terminal `await`
- [ ] Add coverage for `log_sms_conversion` on both the auto and manual paths
- [ ] Multi-tenant portal (clinic_id on all tables, per-clinic isolated data)
- [ ] Domain decision

---

## Testing

`npm run test` runs `vitest run`. Coverage is intentionally narrow — it targets specific safety guarantees added during hardening passes rather than the whole app:

- `src/lib/storage/store.test.ts` — scheduled-SMS cancel/complete/claim conditional-update guarantees
- `src/lib/reminders/process.test.ts` — scheduled-SMS delivery outcome mapping (skipped/dry-run/unknown)
- `src/lib/analytics/dayKeys.test.ts` — Stockholm day bucketing and window boundaries across both 2026 DST transitions; the UTC-noon anchor producing strictly consecutive days
- `src/lib/analytics/conversionRate.test.ts` — distinct-patient counting, null vs. 0 %, and the intersection that keeps the rate ≤ 100 %
- `src/lib/analytics/attributionWindow.test.ts` — exclusive upper bound, untrusted query-param parsing, and the monotonicity property that makes the window safe to change retroactively

**41 tests across 5 files.** Note the shape of this coverage: it is all *pure functions*. Nothing exercises a real database, a real HTTP call, or the RLS policies — see "Testing gaps to close" in session 16.

`src/test/mockSupabase.ts` provides a small reusable chainable Supabase mock for tests that need to assert on `.eq()`/`.update()` call arguments without a live database.

---

## References

- Supabase project: `https://supabase.com/dashboard/project/updomqqgivylpunzuanw`
- GitHub repo: `https://github.com/HaiDaPlug/sms-followup`
- Scheduled-SMS `pg_cron` setup and verification queries: `docs/scheduled-sms-setup.md`
- RLS rollout, verification and rollback: `docs/rls-rollout.md`
- Webhook payload confirmed: `docs/` — see session 9 conversation
