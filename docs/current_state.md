# Current State — Clinic Rebooking Reminder System

**Last updated:** 2026-06-08 (session 9 — BokaDirekt webhook wired, 5-step sequence, analytics page, audit fixes in progress)
**Phase:** Webhook integration active. Build currently broken (audit fix in progress — see Known Issues).

---

## What This Product Is

A clinic rebooking engine built for Osteopaticentrum (Borås) that:
1. Imports patient booking history from a BokaDirekt CSV export
2. Receives live booking events via BokaDirekt webhooks (BookingCreated / BookingUpdated / BookingCancelled)
3. Stages incoming bookings for manual review and deterministic patient matching
4. On confirmation: links patient, upserts booking, resets SMS cycle from day 0
5. Sends a 5-step SMS sequence — manually (next sequential step, bypassing day threshold) or via daily cron (highest threshold crossed)
6. Logs all activity and surfaces data quality issues for review

One deployment per clinic. Supabase Auth gate in place.

---

## Infrastructure

- **Next.js 15** App Router + TypeScript, React 19
- **Supabase** (Stockholm region, project `updomqqgivylpunzuanw`) — migrations 001–009 applied
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
| `BOKADIREKT_WEBHOOK_SECRET` | ❌ | ❌ | Must set — BokaDirekt sends `Tw8K6Pk2FVhvbYl1JE5zgyp4cWaq0fmIGX9BH3URAndit7Nx` |
| `TEST_SMS_TO` | ✅ | — | |
| `CRON_SECRET` | ✅ | — | Set before public URL |

---

## Pages

| Route | Status | Notes |
|-------|--------|-------|
| `/app/dashboard` | Working | KPI strip, modals, daily snapshot |
| `/app/patients` | Working | Card rows, bulk select, status filters, manual send |
| `/app/sms-history` | Working | Per-patient SMS log, bulk send, DNC toggle |
| `/app/import` | Working | CSV upload, idempotent |
| `/app/review` | Working | Review queue — failed SMS + pending booking matches |
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
| `POST /api/reminders/send-message` | Working | Literal message, resolves review item |
| `POST /api/reminders/test` | Working | Test SMS to configured phone |
| `GET/POST /api/settings` | Working | |
| `POST /api/patients` | Working | Manual patient creation |
| `POST /api/patients/[id]/do-not-contact` | Working | |
| `POST /api/patients/[id]/reactivate` | Working | |
| `POST /api/review/[id]` | Working | Resolve/ignore |
| `POST /api/review/confirm-booking-match` | Working | Confirm pending webhook booking → links patient, resets cycle |
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
| 2 | 14 | Second follow-up (was 10, fix pending) |
| 3 | 90 | 3-month check-in |
| 4 | 180 | 6-month check-in |
| 5 | 365 | 12-month check-in |

**Cron:** picks the **highest** threshold crossed that hasn't been sent yet. Patient at day 180 with no history → SMS 4. Next run waits for day 365.

**Manual send (`forceNext=true`):** picks the **next sequential** unsent step, ignoring date threshold. SMS 1 sent, day 8 → sends SMS 2.

**Safety gates (always enforced, even on force):** Do not contact, Missing phone, Future booking, Needs review, No valid booking.

**Cycle reset:** triggered only on confirmed booking match (manual confirmation in Review page). Writes `is_cycle_reset=true` log. All prior history preserved before that log.

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

No auto-confirm — always creates a `pending_booking_match` review item. Dedup via `content_hash: bokadirekt-booking:{Id}` (prevents duplicates on retry).

---

## Migrations Applied (001–009)

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

**Pending migrations (audit fixes):**
- `010_fix_sms2_day.sql` — change SMS step 2 from day 10 → day 14
- `011_add_event_created_at.sql` — add `event_created_at` to bookings for analytics

---

## Known Issues (Audit — Fix in Progress)

1. **Build broken** — `resolvedPatientId: string | null` passed to `resetPatientCycle(patientId: string)` in `bokadirekt.ts:225`. TypeScript rejects it.
2. **Confirm booking doesn't set `last_booking_at`** — patient never becomes "Ready" after confirmation.
3. **Sequence logic picks earliest not highest** — day-180 patient gets SMS 1 instead of SMS 4.
4. **`forceNext` bypasses safety gates** — do-not-contact etc. can receive SMS via manual send.
5. **Cancellation incomplete** — doesn't undo cycle reset, doesn't update `last_booking_at`, cancelled bookings still block SMS via future-booking gate.
6. **Analytics groups by appointment date** — should use `EventCreated`/`created_at`; dry_run counted as sent.

---

## What Still Needs to Be Done

- [ ] Apply audit fixes (see Known Issues above)
- [ ] Set `BOKADIREKT_WEBHOOK_SECRET` in Vercel
- [ ] Set `CRON_SECRET` in Vercel
- [ ] Multi-tenant portal (clinic_id on all tables, per-clinic isolated data)
- [ ] Domain decision

---

## References

- Supabase project: `https://supabase.com/dashboard/project/updomqqgivylpunzuanw`
- GitHub repo: `https://github.com/HaiDaPlug/sms-followup`
- Webhook payload confirmed: `docs/` — see session 9 conversation
