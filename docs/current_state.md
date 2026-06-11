# Current State — Clinic Rebooking Reminder System

**Last updated:** 2026-06-10 (session 10 — transactional booking confirmation, race-safe SMS outbox, delivery review flow)
**Phase:** Audit hardening implemented and build verified. Migrations 012–013 are ready and must be applied before deployment.

---

## What This Product Is

A clinic rebooking engine built for Osteopaticentrum (Borås) that:
1. Imports patient booking history from a BokaDirekt CSV export
2. Receives live booking events via BokaDirekt webhooks (BookingCreated / BookingUpdated / BookingCancelled)
3. Stages incoming bookings for manual review and deterministic patient matching
4. On confirmation: atomically links/creates the patient, upserts the booking, recalculates `last_booking_at`, and resets the SMS cycle once
5. Sends a 5-step SMS sequence — manually (next sequential step, bypassing day threshold) or via daily cron (highest threshold crossed)
6. Reserves each SMS step before calling the provider, preventing concurrent duplicate sends
7. Logs all activity and surfaces booking matches, failed SMS, and uncertain deliveries for review

One deployment per clinic. Supabase Auth gate in place.

---

## Infrastructure

- **Next.js 15** App Router + TypeScript, React 19
- **Supabase** (Stockholm region, project `updomqqgivylpunzuanw`) — migrations 001–011 applied
- **SMS**: 46elks adapter in `src/lib/sms/provider.ts` — virtual number +46766864658
- **Auth**: Supabase Auth via `@supabase/ssr`. Middleware protects `/app/*` and `/api/*`. Cron + webhook routes use secret-based auth.
- **Deployment**: Vercel, auto-deploys on push to `main`
- **Cron**: Vercel cron at `0 8 * * *` → `/api/cron/daily-reminders`

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
| `CRON_SECRET` | ✅ | — | Set before public URL |

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
| `/app/analytics` | Working | Dual-line ECharts chart (bookings vs SMS), bookings table, period selector |

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
| `POST /api/review/confirm-booking-match` | Working | Calls transactional confirmation RPC → links patient, upserts booking, resets cycle once |
| `POST /api/review/resolve-delivery` | Working | Atomically resolves an unknown SMS delivery as sent or failed |
| `GET /api/analytics` | Working | Bookings + SMS grouped by week for chart |
| `GET /api/cron/daily-reminders` | Working | Daily batch |
| `POST /api/webhooks/bokadirekt` | Working | Stages pending_booking_match review item for manual confirmation |
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

**Manual send (`forceNext=true`):** picks the **next sequential** unsent step, ignoring date threshold. SMS 1 sent, day 8 → sends SMS 2.

**Safety gates (always enforced, even on force):** Do not contact, Missing phone, Future booking, Needs review, Delivery pending, No valid booking.

**Cycle reset:** triggered only on the first confirmation of a booking match. The confirmation RPC writes `is_cycle_reset=true` in the same transaction as the patient/booking mutations. A later `BookingUpdated` confirmation updates details without resetting the cycle again.

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

## BokaDirekt Webhook Integration

**Confirmed payload shape** (from live test 2026-06-05):
- Auth: `webhook-secret` header (not `x-webhook-secret`)
- Event type: `webhook-event` header — `BookingCreated`, `BookingUpdated`, `BookingCancelled`
- Key fields: `Customer.MobilePhoneNumber`, `Customer.EmailAdress` (note typo), `Customer.Id`, `BookingStartDate`, `ServiceName`, `PersonName`, `Cancelled` boolean, `EventCreated`

**Webhook URL:** `https://sms-followup.vercel.app/api/webhooks/bokadirekt` (all 3 event types → same endpoint)

**Matching tiers:**
1. `bokadirekt_customer_id` exact match
2. `normalized_phone` exact match
3. `email` exact match

No auto-confirm — always creates a `pending_booking_match` review item. Exact webhook retries are deduplicated through `content_hash`.

### Confirmation Transaction

Migration 012 adds `confirm_booking_match`, a service-role-only Supabase RPC. It:
- Takes an advisory transaction lock per BokaDirekt booking ID
- Locks and validates the open `pending_booking_match` review item
- Validates that the review item references the booking being confirmed
- Creates or updates the patient
- Upserts the booking while preserving the original `event_created_at`
- Recalculates `last_booking_at` from the latest non-cancelled booking
- Writes `cycle_reset` only on first confirmation
- Resolves the review item last

Any failure rolls back the complete confirmation; the review item remains open.

### Cancellation

`BookingCancelled` now checks every database mutation:
- Booking lookup uses `maybeSingle()` because pre-confirmation cancellation is valid
- Booking is marked cancelled
- Its cycle-reset row is removed when present
- Patient `last_booking_at` is recalculated from remaining non-cancelled bookings
- Matching open booking-review items are resolved

Database errors are thrown so the webhook returns non-200 and BokaDirekt can retry.

---

## Migrations Applied (001–011)

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

**Pending migrations (apply before deploying this change):**
- `012_confirm_booking_rpc.sql` — transactional booking confirmation
- `013_outbox_and_cycle_index.sql` — SMS reservations, cycle-scoped uniqueness, and unknown-delivery resolution

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

Remote database behavior has not been exercised yet because migrations 012 and 013 have not been applied.

---

## What Still Needs to Be Done

- [ ] Apply migrations 012 and 013 to Supabase before deploying the code
- [ ] Rotate the exposed BokaDirekt webhook secret in BokaDirekt and set the replacement as `BOKADIREKT_WEBHOOK_SECRET` in Vercel
- [ ] Set `CRON_SECRET` in Vercel
- [ ] Run the production smoke test: confirm booking → send → cancel → confirm new booking → send SMS 1 again
- [ ] Test stale pending resolution against the deployed database/provider flow
- [ ] Multi-tenant portal (clinic_id on all tables, per-clinic isolated data)
- [ ] Domain decision

---

## References

- Supabase project: `https://supabase.com/dashboard/project/updomqqgivylpunzuanw`
- GitHub repo: `https://github.com/HaiDaPlug/sms-followup`
- Webhook payload confirmed: `docs/` — see session 9 conversation
