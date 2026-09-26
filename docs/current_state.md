# Current State - Clinic Rebooking Reminder System

**Last updated:** 2026-09-23 (session 21 — UI/UX overhaul of every page and a fast, client-side patients page, on top of session 20's follow-ups V2. **All on `followups-v2`; migrations 025/026 still unapplied and nothing deployed.** Open decision: `readStore()` loads only the newest 1000 of 4,738 bookings — see session 21.)
**Phase:** Migrations 001–024 are applied to production, verified by calling each function with real arguments. **025 and 026 exist but are unapplied** — see the session 20 rollout order, which is not the usual "apply then deploy". The BokaDirekt webhook is live on the custom domain `sms.khyte.se`, and on 2026-09-02 the first two webhook bookings arrived, auto-matched deterministically, and logged conversions inside the same transaction. **Conversion tracking is now proven end-to-end** — the gap that had blocked analytics since the project began is closed. Remaining gaps are narrower: no delivery receipt has ever been recorded (`delivered` = 0 across 168 sends), and one `pending_booking_match` review item from 17:09 on 2026-09-02 is still unexamined.

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
- **Supabase** (Stockholm region, project `updomqqgivylpunzuanw`) — migrations 001–024 applied (022–024 confirmed live 2026-09-02)
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
| `SUPABASE_SECRET_KEY` | ✅ | ❌ | Set locally 2026-08-12 and now winning the resolver. Verified: reads `patients` (200), i.e. still bypasses RLS like the old `service_role` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ✅ | Legacy, still live and still the only thing Vercel has. Remove from both **after** Vercel gets the new key and is verified — step 6 of `docs/supabase-key-rotation.md` |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | ✅ | |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ✅ | ❌ | Set locally 2026-08-12 and now winning the resolver. Verified: authenticates (200) **and** is correctly locked out of `patients` by RLS (`42501`), so it is no more privileged than the old anon key |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | ✅ | Legacy, still live. Remove after the cutover. Note this one needs a **redeploy** to take effect in Vercel — `NEXT_PUBLIC_*` is inlined at build time |
| `SMS_PROVIDER` | ✅ | ✅ | `46elks` |
| `FORTYSIX_ELKS_USERNAME` | ✅ | ✅ | |
| `FORTYSIX_ELKS_PASSWORD` | ✅ | ✅ | **Rotated twice (2026-08-12, 2026-08-13); confirmed correct in Vercel 2026-09-02.** `GET /a1/me` returns 200 with the current value, and three production sends on 2026-09-02 were accepted and delivered |
| `FORTYSIX_ELKS_FROM` | ✅ | ✅ | `OsteopatiC` in both since 2026-08-12 (local was the virtual number until then). Alphanumeric by deliberate choice: 10 chars, within 46elks' 11-char limit. **Patients cannot reply to an alphanumeric sender** — this is why `/app/inbox` is retired from the nav. Changing it back to a number means restoring that nav entry |
| `FORTYSIX_ELKS_VIRTUAL_NUMBER` | ✅ | ⚠️ | `+46766864658` — verified present locally 2026-08-12; still confirm in Vercel |
| `BOKADIREKT_WEBHOOK_SECRET` | ✅ | ✅ | Generated 2026-08-12, rotated 2026-08-13. **Verified matching in Vercel 2026-09-02** on both `sms-followup.vercel.app` and `sms.khyte.se`: the endpoint returns 401 without the header and **400** with it, i.e. the secret authenticates and only the empty probe payload is rejected. Entered in BokaDirekt for all three event types; real bookings are arriving. Header name is `webhook-secret` (not `x-webhook-secret`) |
| `TEST_SMS_TO` | ✅ | — | |
| `CRON_SECRET` | ✅ | — | Must also be mirrored into the Supabase Vault as `cron_secret` — the scheduled-SMS worker is triggered by `pg_cron`, not Vercel |
| `SMS_DELIVERY_WEBHOOK_SECRET` | ✅ | ✅ | Generated 2026-08-12, rotated 2026-08-13. **Verified matching in Vercel 2026-09-02** — returns 401 without the token and 400 with it. Auth is a `?token=` **query param**, not a header (`app/api/webhooks/sms-delivery/route.ts:10`). Despite this being correct, `delivered` is still 0 across 168 sends — see the open delivery-receipt gap below |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | ✅ | `https://sms.khyte.se` in Vercel as of 2026-09-02. Gates the 46elks delivery callback: `sendWith46Elks` only sends `whendelivered` when this starts with `https://` (`src/lib/sms/provider.ts:274`), which is why local sends never register a callback. **Despite the `NEXT_PUBLIC_` prefix this needs no rebuild** — it is read server-side at request time, and a grep of every deployed client chunk confirms it is not inlined into the browser bundle. A redeploy only makes the change immediate rather than waiting for a cold start. No trailing slash: the code builds `${appUrl}/api/...` |
| `SMS_VERIFY_DELIVERY` | unset (enabled in code) | ✅ `off` | Optional post-send 46elks polling. Set to `off` in Vercel 2026-09-02 per the session 18 decision. **Decision 2026-08-13: polling is not required for the working send path and should be set to `off` for production batches.** Accepted sends remain `sent`; the delivery webhook is the preferred asynchronous source of later `delivered`/`failed` truth |
| `SMS_VERIFY_BUDGET_MS` | unset (6000 ms) | ❓ | Only used when optional polling is enabled. The budget is per send and sequential today, which is why batch polling is not recommended. Do not solve this with concurrent polling unless requirements change |
| `SUPABASE_DB_PASSWORD` | ✅ | — | **Rotated 2026-08-12.** Supabase CLI only; not read by app code. Re-link the CLI if it prompts |

### Credential rotation (2026-08-12 / 2026-08-13)

Every credential in `.env.local` was treated as exposed and rotated. All checks below were run blind — values were never printed, only derived facts (HTTP status, which variable name resolved, character counts).

| Credential | State as of 2026-08-13 |
|---|---|
| 46elks password | Rotated twice. Current value 200; both earlier values confirmed dead (401) |
| Supabase secret key | Rotated twice. Current value reads `patients` (200); earlier value confirmed dead (401) |
| Supabase publishable key | Regenerated. Authenticates (200) and correctly blocked by RLS (`42501`), so it is no more privileged than the old anon key |
| Supabase DB password | Rotated twice |
| `BOKADIREKT_WEBHOOK_SECRET`, `SMS_DELIVERY_WEBHOOK_SECRET` | Regenerated three times (40 chars each). Both were previously unset entirely |
| `CRON_SECRET` | Regenerated 2026-08-12; owner-managed thereafter |
| Legacy Supabase JWTs | Deliberately still live. They are the only keys Vercel has and therefore the rollback path until the Vercel cutover completes |

**Accepted residual exposure (owner decision, 2026-08-13).** Several rotation rounds were undone by the IDE attaching `.env.local` to the assistant conversation — opening the file is sufficient, no selection required. After three rounds the owner chose to stop rotating and accept the residual risk rather than continue the cycle. The currently-live `SUPABASE_SECRET_KEY`, `FORTYSIX_ELKS_PASSWORD` and `SUPABASE_DB_PASSWORD` have therefore been present in an assistant transcript. This is a recorded decision, not an oversight.

Context for anyone revisiting it: the exposure is a chat transcript behind the owner's account, not a public repository, so it is not subject to the automated scraping that makes committed secrets an emergency. The highest-consequence item is the 46elks password, since it can send SMS as `OsteopatiC` to the patient list. If the decision is ever revisited, rotate that one first, and keep `.env.local` closed in the editor while doing so.

`next build` passes against the current keys. **Local is fully rotated; Vercel has none of it.** Until the values are copied across and redeployed, production still runs on a revoked 46elks password (every send fails auth) and the legacy Supabase keys.

### Where this was left on 2026-09-02

Re-probed live. Every "next action" from the 2026-08-13 list below had in fact been completed between sessions, so the previous table was stale in every row that mattered:

| Check | Result |
|---|---|
| `GET https://sms.khyte.se/login` | 200 — custom domain live, no redirect |
| `POST /api/webhooks/bokadirekt` with current secret | **400** — secret authenticates, only the empty payload rejected |
| `POST /api/webhooks/sms-delivery?token=…` | **400** — same |
| Either webhook with no secret | 401 — still fails closed |
| 46elks `GET /a1/me` | 200 — credentials current |
| Migrations 022/023/024 | **Applied** — verified by calling each function with real arguments |
| Bookings with `event_created_at` | **2** (first ever) |
| `sms_conversions` rows | **2**, both `match_type = 'auto'` |
| `reminder_logs` `delivered` | **0** of 168 — the one real remaining gap |
| Open `pending_booking_match` | 1, created 17:09 — unexamined |

**Method note, worth not repeating.** Probing an RPC with an empty body is not a test of whether it exists. PostgREST returns the same `PGRST202` 404 for "function missing" and "function exists but has no zero-argument overload," so every `security definer` function taking a required `uuid` looks absent. Migration 014's `cancel_bokadirekt_booking` — applied for weeks — 404s identically to a genuinely missing one. Call these with real arguments, or the result means nothing.

Similarly, `order=sent_at.desc` sorts NULLs **first** in PostgREST, so ordering `reminder_logs` that way surfaces the oldest skipped/failed rows, not the newest sends. Order by `created_at` when you want recent activity.

`CRON_SECRET` was not probed: a valid call to either cron route would send real SMS to real patients. Verify by eye in the Vercel dashboard.

**Supabase Vault secrets** (separate from env vars, set once per project — see `docs/scheduled-sms-setup.md`):

| Secret | Purpose |
|---|---|
| `app_base_url` | Deployed app base URL the `pg_cron` trigger posts to |
| `cron_secret` | Must equal `CRON_SECRET`; sent as the bearer token |

---

## Pages

| Route | Status | Notes |
|-------|--------|-------|
| `/app/dashboard` | Redesigned (session 21) | "Redo för påminnelse" hero with next-run volume and run mode, KPI tiles opening their lists, forecast as one stacked bar linking into patient filters, actionable warnings, activity feed |
| `/app/patients` | Redesigned (session 21) | Status tabs with counts, per-patient follow-up track, split send button, patient drawer with lazy-loaded SMS history, floating bulk send. Filtering, sorting, search and paging run in the browser over all patients; the URL stays in sync |
| `/app/sms-history` | Working, restyled | Per-patient SMS log, pending/unknown delivery states, bulk send, search, `?tab=failed` deep link |
| `/app/import` | Working, restyled | CSV upload (drag-and-drop), idempotent |
| `/app/review` | Working, restyled | Review queue as a card list — failed SMS, unknown deliveries, pending booking matches. Opens on open items; `?visa=alla` shows all |
| `/app/settings` | Working, restyled | Editable follow-ups with live SMS preview and click-to-insert variables, run-mode switches, sticky save bar |
| `/app/inbox` | **Retired from nav** (2026-08-12) | Still works if reached by URL; the incoming webhook and the 14 stored messages are untouched. Removed from the sidebar because production sends from the alphanumeric sender ID `OsteopatiC`, which cannot receive replies — so the page no longer represents a working reply loop. Restore the entry in `AppSidebar.tsx` if the sender goes back to a number. Note the incoming webhook still accepts messages sent directly to `FORTYSIX_ELKS_VIRTUAL_NUMBER`, so the page is dormant rather than dead |
| `/app/analytics` | Redesigned (session 21), renders live data | Line chart of SMS, bookings and SMS-matched bookings with a data-driven headline (weekly by default from 90 days), four stat tiles incl. conversion rate, lifetime funnel, time-to-rebooking, per-follow-up rates, tabbed bookings / SMS-matched tables with search, 30/90/180/365-day period selector and a separate 30/60/90-day attribution picker. Booking-arrival rows show clock time (Stockholm) beside the date. Conversion tracking **proven end-to-end 2026-09-02**; figures are real but N is still tiny — see session 19 |
| `/app/scheduled-sms` | Working in code | Management table for scheduled SMS — status, scheduled time, resolved template, cancel action; shows snapshotted name/phone if the patient was later deleted. Delivery via `pg_cron` not yet verified against a live tick |

---

## API Routes

| Endpoint | Status | Notes |
|----------|--------|-------|
| `POST /api/import/bokadirekt` | Working | CSV upload, idempotent |
| `GET /api/dashboard/*` | Working | stats, ready-patients, sms-this-month, review-items, activity |
| `POST /api/reminders/send` | Working | Manual send — `forceNext` bypasses day threshold (NOT safety gates). Returns a typed six-state outcome. Optional inline polling exists in code but is not required or recommended for production batches |
| `POST /api/reminders/send-message` | Working | Failed-SMS retry; server validates patient/cycle, reserves sequence, shares the same delivery classification as normal sends, and updates the existing failed review item rather than creating duplicates |
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
| `GET /api/logs?patientId=` | Working | One patient's SMS history, newest first — loaded by the patient drawer (session 21) |
| `DELETE /api/logs/:id` | Working | |
| `DELETE /api/logs` | Working | |

---

## Follow-up Logic

5 follow-ups seeded in `reminder_settings.sms_steps` (migration 009). Mattias's real templates.

| Follow-up | Day threshold | Behaviour |
|-----|--------------|-----------|
| 1 | 5 | First follow-up |
| 2 | 14 | Second follow-up |
| 3 | 90 | 3-month check-in |
| 4 | 180 | 6-month check-in |
| 5 | 365 | 12-month check-in |

Each follow-up is `{ id, day, template, active }` (session 20). The `id` is an immutable uuid: `reminder_logs.step_id` references it and `reminder_logs.step_day` snapshots the trigger day at send time, so re-timing, re-ordering or deleting a follow-up cannot change what a historical log meant. `sequence_number` is still written as the position in the day-sorted list, for the labels and the 013 indexes.

**Cron:** picks the **highest** threshold crossed that hasn't been sent yet, among **active** follow-ups. Patient at day 180 with no history → the 180-day follow-up. Next run waits for day 365.

**Inactive follow-ups are skipped, never blocking.** With 90 active, 180 inactive and 365 active, a patient who received the 90 goes on to the 365. They remain selectable for a manual or scheduled send, labelled "(inaktiv)" — deactivation governs the automation, not the operator.

**Ordering is by day, not position.** A step already sent is excluded by id as well, so editing its day upward cannot make it eligible again. A sent step's `step_day` bounds the cycle, so a follow-up re-timed from 90 to 180 after the fact still counts as the 90-day message it was.

**Manual send (`forceNext=true`):** picks the highest crossed threshold not yet sent, same as cron. A patient at 212 days gets the 180-day follow-up, not the 5-day one. Manual and scheduled sends pass a step **id**; a request still carrying the old positional `sequenceOverride` is refused with 400 so a stale browser tab cannot send a different message than the operator picked.

**Daily queue.** `max_per_day` (25) is a rate limit, not targeting. Every eligible patient is queued, ordered by **when they first became due** (`last_booking_at` + the earliest active follow-up still owed), and only then capped; the overflow stays eligible for the next run. This drains an old backlog first-come-first-served. Before session 20 the cap fell on `readStore()`'s `created_at desc`, handing every slot to the newest imports and starving old patients indefinitely. The ordering is monotonic per patient: waiting longer only ever improves your position.

**With no active follow-ups**, an untouched patient is `Waiting`, not `Sent` — disabling everything must not make the patient list look like a completed sequence. `Sent` still requires that something actually went out in the cycle.

**Safety gates (always enforced, even on force):** Do not contact, Missing phone, Future booking, Needs review, Delivery pending, No valid booking.

**Cycle reset:** the shared booking RPC writes one `is_cycle_reset=true` row for a new booking. Retries do not duplicate it. If a booking is reassigned, the reset moves to the selected patient with a fresh `created_at` so the new cycle starts immediately.

### SMS Reservation / Outbox Flow

For live sends, the app now:
1. Inserts a `pending` reminder log using the cycle key `(patient_id, booking_id, sequence_number)`
2. Relies on a partial unique index to reject concurrent reservations with `23505`
3. Calls the SMS provider only after the reservation succeeds
4. If optional polling is enabled, asks `GET /a1/SMS/{id}` for an early terminal verdict within `SMS_VERIFY_BUDGET_MS`; production batches should disable this
5. Finalizes the same row as `sent` after provider acceptance (or as `delivered`/`failed` if optional polling found a terminal result), while uncertain provider requests remain `unknown`. With polling off, the delivery webhook can later advance `sent` asynchronously

`dry_run` rows use the same uniqueness key and are final immediately.

All interactive send surfaces consume the same six-state vocabulary: `sent`, `delivered`, `dry_run`, `skipped`, `failed`, and `unknown`. Only `sent` and `delivered` mean a real SMS left the application; dry runs and guard skips are never presented as successful sends. Dashboard/monthly counts include both `sent` and `delivered`.

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
4. A stale-cycle guard refuses a frozen message if another non-cancelled booking was created or occurs after the scheduled row. This specifically closes the CSV-import path, which does not pass through the booking RPCs that cancel pending schedules.
5. Explicit sequence selection is checked both when scheduling and immediately before sending. A step equal to or behind the highest completed step in the current cycle is refused with `out_of_order` rather than silently sent.
6. The reservation (`reminder_logs` row) is always written before the provider is called.
7. Outcomes are `sent`, `delivered`, `dry_run`, `unknown` (provider result ambiguous — never auto-retried), `skipped` (e.g. stale cycle or patient deleted), or `failed`. Dry-run is never mapped to `sent`.
8. `completeScheduledSms` only updates a row that is still `processing`; if the row moved on (e.g. reconciled as stale), it throws instead of overwriting.

**Cancellation (`DELETE /api/scheduled-sms/:id`):** only succeeds while the row is still `pending`; once claimed, cancellation returns 409 rather than racing the worker.

**Collision with the daily cron:** `processDailyReminders` excludes any patient with an active (`pending`/`processing`) scheduled SMS from its own batch, so the daily worker cannot consume a sequence step out from under a pending scheduled job. The two crons run as fully separate endpoints, so an exception in one cannot block the other.

**Rebooking cancellation (migration 023, not yet applied):** when a webhook booking resets a reminder cycle, pending scheduled rows for that patient are cancelled inside the same database transaction. Rows already in `processing` are deliberately never rewritten because the provider may already have accepted them; the send-time stale-cycle guard is the final backstop. CSV imports do not call the RPC, so their protection is entirely the send-time guard.

**Patient deletion:** `patient_id` is `ON DELETE SET NULL` (not cascade) — history is preserved via the `patient_name`/`recipient_phone` snapshot taken at creation.

---

## BokaDirekt Webhook Integration

**Confirmed payload shape** (from live test 2026-06-05):
- Auth: `webhook-secret` header (not `x-webhook-secret`)
- Event type: `webhook-event` header — `BookingCreated`, `BookingUpdated`, `BookingCancelled`
- Key fields: `Customer.MobilePhoneNumber`, `Customer.EmailAdress` (note typo), `Customer.Id`, `BookingStartDate`, `ServiceName`, `PersonName`, `Cancelled` boolean, `EventCreated`

**Webhook URL:** `https://sms.khyte.se/api/webhooks/bokadirekt` (all 3 event types → same endpoint). This is what BokaDirekt posts to as of 2026-09-02; the older `sms-followup.vercel.app` host still serves the same endpoint and authenticates identically.

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

Migration 017 adds `sms_conversions` and the service-role-only `apply_bokadirekt_booking_auto_matched` wrapper, which calls migration 014's booking mutation and records an eligible conversion in the same PostgreSQL transaction. Migrations 018 and 019 then changed the recording rules:

- **Both paths count.** 018 extracts a shared `log_sms_conversion()` called by the webhook auto-match (`match_type = 'auto'`) and by `confirm_booking_match` (`'manual'`). 017's rule that a booking which ever entered `pending_booking_match` review could never count is gone — it excluded precisely the rebookings a human had verified.
- **The attribution window is applied at read time.** Recording uses a wide 365-day lookback (019); the 30/60/90-day window is applied against `days_since_sms` in `attributionWindow.ts`. `sms_conversions` is therefore a record of *candidates*, not of counted conversions — anything querying it directly must apply its own filter.

The latest sent/delivered SMS strictly before the booking-recorded timestamp qualifies. Duplicate webhook deliveries are idempotent by BokaDirekt booking ID. Cancellation marks the conversion cancelled in the same advisory-locked transaction.


---

## Migrations Applied (001–024)
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

| 022 | One `last_booking_at` definition; `patient_last_attended_booking`, `refresh_patient_booking_metadata`, `cancel_pending_scheduled_sms`; patient metadata backfill |
| 023 | Rebooking cancels pending scheduled SMS transactionally; rewrites `apply_bokadirekt_booking` and `cancel_bokadirekt_booking` onto the shared definition |
| 024 | `stale_cycle` and `out_of_order` added to the `reminder_logs.skip_reason` CHECK constraint |
| 025 | **Unapplied.** Stable follow-up ids: mints `id`/`active` inside `sms_steps`, adds `reminder_logs.step_id`/`step_day` and `scheduled_sms.step_id`, backfills them from position, adds step-keyed unique indexes beside the 013 ones, adds `step_removed` to the skip-reason CHECK |
| 026 | **Unapplied, and only after Deploy B.** Re-runs the 025 backfill, then drops the two position-keyed unique indexes from 013 |
| 027 | **Unapplied; must be live before Deploy B's first daily cron.** `refresh_passed_booking_metadata()`: moves `last_booking_at` forward through the 022 refresh for every patient whose newest past, non-cancelled booking is newer than the stored value. The daily cron calls it before reading the store (fixes R4). Additive, never moves the column backwards, service_role only |

**Applied in production:** 001–024 (022–024 confirmed 2026-09-02). 025 and 026 are written but unapplied.

Verified individually rather than assumed, each by calling with real arguments:

| Check | Result |
|---|---|
| `patient_last_attended_booking(uuid)` | Returns real data (`2022-11-10`, "Osteopati återbesök") |
| `refresh_patient_booking_metadata(uuid)` | 204 |
| `cancel_pending_scheduled_sms(uuid)` | Returns `0` |
| `cancel_bokadirekt_booking(text)` | 204 — idempotent no-op on an unknown booking, as designed |
| Insert `skip_reason: 'stale_cycle'` | **201 accepted** (probe row deleted immediately, absence verified) |

That last check cleared the merge blocker: `src/lib/reminders/process.ts` writes `skip_reason: "stale_cycle"`, which the pre-024 constraint rejected. **`typography-scale` is now safe to merge to `main`.**

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
- **Supabase key naming.** Key resolution moved into `src/lib/supabase/keys.ts`, reading the new publishable/secret names first and falling back to the legacy anon/service_role ones. This makes the rename and the value rotation separate, individually reversible steps — as of session 16 the code shipped with no values swapped, so the legacy keys stayed in use via the fallback. (Session 17 then set the new values locally; see the env table for current state.) The `NEXT_PUBLIC_*` names are written longhand because Next.js inlines them at build time by literal textual match; a dynamic lookup silently resolves to `undefined` in the browser. Verified the key is present in the built client bundle. Cutover order in `docs/supabase-key-rotation.md`.

### Verified

- Anon key returns `42501 permission denied` on all nine tables (was returning live patient names before 021).
- `/app/analytics` renders live data post-RLS; 41 unit tests, typecheck, and `next build` all pass.

### Concerns and known gaps

- ~~**Conversion tracking is unproven end-to-end.**~~ **Resolved 2026-09-02** — see session 19. Two webhook bookings received, both auto-matched, both logging conversions.
- **Analytics zeros were correct, not a fault.** The 4,715 CSV bookings all bucket to 2026-05-07, so short windows showed `Bokningar: 0`; 365 days surfaces them as one spike. Since 2026-09-02 the short windows also contain the new webhook bookings.
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

## Session 18 — SMS Correctness and Delivery Reality

### Implemented in code

- **One send-outcome vocabulary.** Interactive send paths now return and render `sent`, `delivered`, `dry_run`, `skipped`, `failed`, or `unknown` without collapsing dry runs, skips, or uncertain provider results into success. Toasts survive `router.refresh()` and provider-confirmed delivery is labelled explicitly.
- **Optional post-send delivery verification.** The code can poll accepted 46elks sends for an early terminal result within a strict deadline. This is verified and bounded, but it is not necessary for successful sending. The operational decision is to disable it for production batches and use the delivery webhook for asynchronous `delivered`/`failed` transitions. `unsupported`, `pending`, and `unreachable` never become false failures.
- **Shared delivery classification.** Normal, scheduled, and failed-SMS retry paths use `resolveDelivery`; the retry route returns the same typed outcome and refreshes its existing open review item on another failure instead of accumulating duplicate review work.
- **Scheduled-send rebooking safety.** Migration 023 cancels pending scheduled rows transactionally when webhook booking RPCs reset a cycle. The worker also refuses any schedule made stale by a later non-cancelled booking, including CSV imports that bypass those RPCs.
- **Sequence ordering.** Explicit sequence choices are validated at scheduling and send time; a step equal to or behind an already completed step is logged as `out_of_order`.
- **One `last_booking_at` definition.** Migration 022 defines it as the most recent non-cancelled booking at or before `now()`, provides one refresh function for SQL writers, aligns the CSV cancellation predicate, and backfills patient metadata. Migration 023 rewrites the live booking RPCs to call the shared definition without removing the conversion behavior added in 017/018.
- **Delivered counts are real sends.** Daily snapshots, dashboard totals, and the monthly SMS feed count both `sent` and `delivered`.

### Verified

- `npm test` — 76 tests across 9 files pass.
- `npm run typecheck` — passes.
- `npm run build` — passes; all 29 static pages generate and all routes compile.
- `git diff --check` — passes.
- `npm run lint` — **not available**: `next lint` opens the interactive first-time ESLint configuration prompt. No configuration was created implicitly.

### Correctness boundaries and remaining reality gaps

- **Migrations 022–024 are unapplied.** Their SQL bodies were reviewed against the latest definitions in 014, 017, and 018, but no live Postgres instance has parsed or executed them. Transactional scheduled-SMS cancellation and the metadata backfill do not exist in production until these migrations are applied.
- **The migration 022 backfill touches every patient.** Apply it first in a non-production environment and compare patients with future appointments, cancelled appointments, and no past valid booking before production rollout.
- **Inline polling is not part of the required production path.** Real 46elks polling timing remains unproven, but the clinic's accepted-send flow already works without it. With `max_per_day = 25`, the default per-send budget could add roughly 150 seconds to a worst-case sequential batch. Set `SMS_VERIFY_DELIVERY=off` rather than adding polling concurrency.
- **Concurrent polling is not a follow-up.** It would optimize an optional mechanism while adding coordination and rate-limit complexity. Revisit only if a future requirement demands immediate delivery verdicts inside the original request.
- **Webhook receipts are the preferred durable asynchronous path.** Accepted messages remain `sent`; later `delivered`/`failed` truth depends on `SMS_DELIVERY_WEBHOOK_SECRET` and a publicly reachable HTTPS callback. Sending functionality itself does not depend on receiving that callback.
- **The stale-cycle guard is intentionally conservative.** A later non-cancelled historical booking entered after scheduling may skip a legitimate message. Skipping is safer than sending a stale rebooking message, but this should be monitored after rollout.

### Follow-up order

1. Apply migrations 022–024 to a non-production Supabase database and validate the backfill plus both booking RPCs.
2. Set `SMS_VERIFY_DELIVERY=off` in the production environment before deploying the session 18 batch path; no concurrent-polling work is planned.
3. Run webhook, CSV-rebooking, scheduled-SMS, cancellation, ordering, and accepted-send smoke tests against that environment.
4. Configure and verify `SMS_DELIVERY_WEBHOOK_SECRET` in Vercel if delivered/failed tracking is desired; sending remains functional without it.
5. Apply migrations to production only after expected patient metadata changes are reviewed.

---

## Session 19 — First Webhook Bookings and First Conversions

**The thing that had blocked analytics since the project began is now closed.** On 2026-09-02 the BokaDirekt webhook received its first two real bookings, both auto-matched deterministically, and both logged conversions inside the same transaction. No manual review was needed.

### The two bookings

| | Booking 1 | Booking 2 |
|---|---|---|
| Patient | Karolin Johansson | Hai Bui |
| Arrived (UTC) | 17:30:15 | 17:33:12 |
| Appointment | 2026-09-09 | 2026-09-08 |
| Match | `auto` | `auto` |
| Attributed SMS | steg 1, 2026-05-08 | steg 2, 2026-08-04 |
| `days_since_sms` | **117** | **29** |

Cycle resets, booking-metadata recomputation and conversion logging all fired transactionally as designed. Duplicate-safe by BokaDirekt booking ID.

### Why only one shows as matched

Karolin's booking **matched fine** — what she lacks is an SMS close enough in time to credit. Her only message was 117 days before she booked, and the attribution picker's widest setting is 90 d, so she is excluded at every available window. This is the read-time filter working exactly as migration 019 intended: `sms_conversions` stores candidates, the window narrows them at display time. The UI already states this in the line under the panel header ("1 ytterligare ombokning skedde efter mer än 90 dagar och räknas inte här").

Worth preserving as a judgment, not a defect: a booking four months after a single SMS is very unlikely to be caused by it, and counting it would inflate the rate with a coincidence. Do not widen the window to 180 d just to make the number bigger.

**Read the tiles with care while N is tiny.** "1 % av 96 kunder" is one conversion against 96 distinct patients messaged in 90 days. With two bookings total this is noise, not a measurement. Reference figures at the time: 26 SMS in 30 days, 100 in 90 days, 168 lifetime.

### Infrastructure confirmed this session

- **Custom domain `sms.khyte.se` is live** and is what BokaDirekt now posts to (`https://sms.khyte.se/api/webhooks/bokadirekt`, all three event types). Serves the app directly with no redirect; both it and the `.vercel.app` domain authenticate the webhook secrets.
- **`NEXT_PUBLIC_APP_URL` corrected to the new domain.** A prior note in this doc claimed it needed a rebuild because of the `NEXT_PUBLIC_` prefix. That is wrong for this variable: it is read server-side at request time in `sendWith46Elks`, and it appears in no deployed client chunk. The general rule only binds variables actually referenced in client components.
- **`SMS_VERIFY_DELIVERY=off`** set in Vercel, closing the session 18 follow-up.
- **46elks credentials confirmed current** — three sends on 2026-09-02 were accepted and reported `delivered` by the provider.

### UI change

`src/components/AnalyticsChart.tsx` gained a `formatTime` helper, showing the clock time a booking arrived beside its date in both the "Bokningar under perioden" and "SMS-matchade bokningar" tables. Pinned to `Europe/Stockholm` rather than the viewer's timezone so it matches what staff see in BokaDirekt from any machine — the two bookings stored at 17:30/17:33 UTC display as 19:30/19:33. Deliberately applied only to arrival columns; appointment time and SMS-send date stay date-only, where a clock time would be noise.

### Session 19 verification

- `npm run typecheck` — passes
- `npm run test` — 76/76 across 9 files
- Migrations 022–024 verified live by direct RPC calls (table above)
- Webhook auth verified on both domains; delivery-receipt path still unproven

### Open after this session

- **No delivery receipt has ever been recorded.** `delivered` is 0 across 168 sends, while 46elks reports the recent ones delivered. The secret authenticates and the app URL is now https, so the remaining suspects are the callback not yet being registered on sends made before the env change landed, or a warm function still holding the old value. Cheapest test: send one SMS via `/api/reminders/test` and watch whether the row flips to `delivered` within a minute. This does **not** affect conversion tracking, which counts `sent` and `delivered` alike.
- **One open `pending_booking_match` from 17:09 on 2026-09-02**, predating both successful bookings — likely an earlier test whose identity did not match deterministically. Not yet examined.
- The 185 pre-existing open review items from the CSV import are unrelated to webhooks, but `needs_review` is a hard send gate, so those patients are excluded from sends.

---

## Session 20 — Follow-ups V2: Stable Ids, Activation, Queue, Lifetime Analytics

Branch `followups-v2`, off `typography-scale`. Code complete, 160 tests + typecheck + build green. **Nothing is applied or deployed yet** — the rollout below is not the usual order and the sequence matters.

| Commit | What it does | Rollout role |
|---|---|---|
| `50711f2` | Step ids in types/resolver; settings route mints them and refuses an id-less save | **Deploy A** |
| `27d6632` | Writes `step_id`/`step_day` at every log insert; selection still positional | Deploy B |
| `c71b6f2` | Selection by id/day, activation, overdue-first queue, step ids on the wire | Deploy B |
| `9475647` | Lifetime analytics, per-follow-up table, settings relabel + Aktiv toggle | Deploy B |
| `41a9340`, `18ecca0` | This documentation; removal of an unused field | Deploy B |

Each commit leaves typecheck and tests green on its own, so Deploy B can be cut at any of them if it needs splitting further.

### Why

Two problems, both of mental model rather than plumbing.

**A step had no identity.** `sms_steps` was `{day, template}` and `reminder_logs.sequence_number` was literally the 1-based index into that array, sorted by day. Insert a follow-up in the middle, delete one, or re-time one, and every historical log silently came to mean a different message. The duplicate-send guard from 013 was keyed on the same position, so a shifted list could also raise a false collision — blocking a legitimate send with "Redan reserverad" — or miss a real duplicate.

**The daily cap was doing targeting.** `processDailyReminders` filtered to Ready and then took `.slice(0, max_per_day)` with no sort, so the order came from `readStore()`'s `patients.created_at desc`. The newest imports won every slot and an old backlog could starve indefinitely.

### What changed

- **Stable ids.** Each follow-up is `{ id, day, template, active }`. Logs carry `step_id` plus a `step_day` snapshot. Ids preserve identity, the snapshot preserves historical meaning — a message sent as the 90-day follow-up stays a 90-day fact even if that step is later re-timed to 180.
- **Per-follow-up activation.** Inactive steps are skipped by the automation without blocking later ones, and stay selectable manually. With none active, untouched patients read `Waiting`, not `Sent`.
- **Overdue-first queue.** Patients are ordered by when they first became due, then capped. `src/lib/reminders/queue.ts` is pure and carries the reasoning.
- **Step ids on the wire.** Manual and scheduled sends pass an id; a request carrying the old positional field is refused with 400 rather than being treated as "no step chosen", which would have sent a different message than the operator picked. A step deleted before its scheduled row fires is a clean `step_removed` skip — never a throw, which the worker would have recorded as a false `unknown` on a message that was never sent.
- **Lifetime analytics.** `src/lib/analytics/lifetime.ts` answers "did they ever come back" separately from "can we credit the SMS", from one chronological pass so attributed is always a subset of eventual. A booking closes its follow-up cycle, so a patient returning three times after one message is one rebooking, not three. Bookings are dated by the earlier of their record and their appointment, so a CSV import timestamp cannot inflate the gap.

### Rollout order — Deploy A → 025 → Deploy B → 026

Not the usual "apply then deploy". Both halves of the ordering are load-bearing:

1. **Deploy A** = commit `50711f2`, "Give follow-up steps stable ids and protect them on save". Ships the id-preserving settings route with no visible change. It must be live **before** 025, because the live settings route replaces `sms_steps` wholesale: a Settings save from the old UI after 025 would strip the freshly minted ids while `reminder_logs` already referenced them. After this deploy an id-less save is refused with "Ladda om sidan och försök igen".
2. **Apply 025** (`npx supabase db push`), then run the verification queries in the migration header. Confirm PostgREST sees the new columns before continuing: `supabase.from("reminder_logs").select("step_id, step_day").limit(1)` from Node with the service role.
3. **Deploy B** = the rest of the branch. It must come **after** 025, because PostgREST rejects an insert naming an unknown column (PGRST204): every send path would fail, and the scheduled worker's catch would mark its claimed rows `unknown` — messages recorded as possibly-sent that were never attempted.
4. **Apply 026** the same day, once `select count(*) from reminder_logs where status in ('pending','unknown','sent','dry_run','delivered') and step_id is null and created_at > '<Deploy B timestamp>'` returns 0.

**027 (R4 fix) must be live before Deploy B's first daily cron.** Deploy B's `processDailyReminders` calls `refresh_passed_booking_metadata()` and fails the run if the function is missing, rather than sending against stale anchors. 027 is additive and harmless to apply at any earlier point.

**`npx supabase db push` applies every pending migration in order.** With 025, 026 and 027 all pending it cannot apply 025 alone, so step 2 as written would also apply 026 before Deploy B. Hold 026 back (or apply 025 and 027 individually) until step 4.

**Between 025 and 026, do not add, delete, reorder, or re-time a follow-up.** Both index families are live in that window, and any change to sorted positions lets a correct day-based send collide on the position-keyed index. Template text is safe; so is the Aktiv toggle once Deploy B is live.

### Verification

- `npm run typecheck`, `npm test` (160 across 14 files), `npm run build`, `git diff --check` — all pass.
- The suite was run five consecutive times to confirm the new queue and crediting tests are deterministic rather than order-dependent.
- **Not run:** no migration has touched a database, no browser check of `/app/settings` or `/app/analytics`, no cron dry-run. The SQL is reviewed only, as with every migration in this project (no local Postgres).

### Behaviour changes to expect on the patient list

Worth anticipating rather than treating as a regression when Deploy B lands:

- **Cohort counts shift.** The Waiting/Sent split changed: `Sent` now requires that something actually went out in the cycle. A patient whose applicable steps are all inactive moves from `Sent` to `Waiting`. `daily_snapshots` rows before and after the deploy are therefore not directly comparable.
- **A manual send that used to "re-send the last step" now returns null.** That branch only ever produced a bogus "Redan reserverad av parallell förfrågan" skip, because the reservation hit the unique index. It is gone rather than preserved.
- **The template dropdowns list days, not positions** — "90 dagar" instead of "Mall 3 (dag 90)", with "(inaktiv)" where it applies.

### Open after this session

- Everything in the rollout order above.
- The delivery-receipt gap and the open `pending_booking_match` from session 19 are untouched.
- `/api/reminders/test` still renders the legacy `sms_template` and is unaware of follow-ups.
- Campaigns remain deliberately out of scope: follow-ups are time-since-visit automation, campaigns would be one-off cohort sends. Nothing here forecloses them.

---

## Session 21 — UI/UX Overhaul and Patients-Page Performance

Branch `followups-v2`, on top of session 20. Pushed to `origin/followups-v2` 2026-09-23; **not merged or deployed** — like the rest of the branch it waits on the session 20 rollout.

| Commit | What it does |
|---|---|
| `42e8baa` | Makes the page store cache actually cache, and stops loading booking CSV rows it never uses |
| `9320a93` | Redesigns every page on one design system; patients page filters in the browser |

### Why

The app worked, but it read as a collection of individually hand-styled screens: six different popup implementations, ~190 inline font sizes, a patients table that overflowed on laptop widths, and an analytics page whose chart colours were silently broken. The ask was to make it world-class in UI, UX and usefulness without losing a feature. Midway through, switching tabs and filters on the patients page was also reported as slow — every click was a full server round trip.

### Where things stand

**Design system.** `app/globals.css` now holds the whole visual language: warm paper neutrals under the forest/mint brand, status chip/tab/panel/table/empty-state primitives, and one button material (a matte, grain-textured finish adapted from `crm-khyte`'s `.btn-grain`). Shared components live in `src/components/ui/` — one accessible `Modal` (dialog and drawer), `Menu`, `ConfirmDialog`, `PageHeader`, icons, formatting and status-label helpers. New UI should build on these rather than add inline styles.

**Pages.** All redesigned; nothing removed. The notable additions in usefulness:

- *Dashboard* leads with a "Redo för påminnelse" hero (next-run volume, paused/test-mode state), turns the daily forecast into one bar over every patient that links into the patient filters, and makes warnings actionable.
- *Kunder* has status tabs with counts, a per-patient follow-up track (which step was sent, which one the engine will send next — `src/lib/patients/followupTrack.ts`, tested against the engine's own cycle rules), a patient drawer with the full SMS history, and a floating bulk-send bar.
- *Analys* is a line chart of SMS, bookings and SMS-matched bookings with a data-driven headline, plus a lifetime funnel, time-to-rebooking and per-follow-up rate bars, and tabbed detail tables with search.
- Sidebar is grouped into Arbete / Utskick / System. **Ctrl+1–8 now follow that order** (Granskning moved to Ctrl+3).

**Performance.** Two causes, both fixed:

- `readStoreForUi` was `unstable_cache(readStore)`, but the snapshot is ~2.3 MB and Next's data cache refuses entries over 2 MB, so it **never cached** — every page read all five tables. It is now an in-process 3 s cache (the window originally intended) and no longer fetches `bookings.raw_data`, about half the bookings payload.
- The patients page shipped one filtered page per request. It now ships all patients once (~62 KB gzipped for 984) and filters, sorts, searches and pages in the browser, keeping the URL in sync, so switching costs no request. Message history loads when a patient's drawer opens (`GET /api/logs?patientId=`).

**Bugs fixed on the way:** ECharts was given CSS `var()` colours, which a canvas cannot resolve; `.notice.error` did not exist, so errors rendered amber; a Cyrillic "е" in the settings subtitle; and button sheen pseudo-elements escaping `all: unset` buttons and washing out whole panels. Buttons now carry their grain as a background layer, so that class of bug cannot recur.

### Verification

- `npm run typecheck`, `npm test` (**169 across 15 files**), `npm run build` pass.
- Browser-checked against production data: dashboard, patients (incl. layout measurement at laptop width), analytics chart and tooltip, sidebar. Every check was read-only — no send, schedule, delete or settings save was exercised through the new UI.
- **Not checked in a browser:** scheduled SMS, SMS history, review and import pages after the redesign, mobile widths, and clicking through the patients page's tabs, search and paging now that they run client-side.

### Behaviour changes to expect

- **Granskning opens on "Öppna"**; resolved and ignored items are under "Alla". Scheduled SMS opens on "Aktiva" when any exist.
- **Send is disabled for "Kontakta ej" patients** — the server always refused those sends as a hard block, so this only removes a pointless skipped log.
- **Choosing a follow-up in the send button's ▾ menu sends it immediately** (previously: pick in a dropdown, then press Skicka).
- **Deleting a patient and clearing all SMS history** use an in-app confirmation instead of the browser's.
- Settings now opens on Körläge, the most consequential section.

### Found, not fixed — needs a decision

- **Only the newest 1000 of 4,738 bookings are ever loaded** — PostgREST's default row cap, applied by `readStore()` itself. The **sending engine** reads through it too, so a patient whose upcoming appointment was booked long ago could be missed and messaged despite having rebooked. Checked 2026-09-23: all 6 upcoming appointments are currently inside the loaded 1000, so no patient is affected today; the gap widens as bookings accumulate. The fix is to page the reads (as `getAnalyticsData` already does), but it changes what the engine sees, so it was deliberately left for an explicit go-ahead. `readStoreForUi` mirrors the same cap on purpose, so the UI shows the status the engine computes.
- **"Sändningstid" in settings does nothing.** The daily run is fixed at `0 8 * * *` UTC in `vercel.json` and never reads `send_time`. The dashboard no longer shows a send time for that reason; the settings page still implies one.
- `src/components/SmsHistoryActions.tsx` is dead code (unused before this session).

---

## Typography and Type Scale

### Body font: Inter → Source Sans 3

Inter is a neutral grotesque — uniform strokes, closed apertures, engineered to disappear. It read as impersonal in a product whose whole job is a clinic talking to its patients. Source Sans 3 is humanist: open apertures and slight stroke modulation give it some warmth while still holding up in dense tables, and it pairs with the Merriweather headings the way a grotesque does not. Loaded from Google Fonts in `app/layout.tsx`; `--font-body` in `globals.css` is the only consumer.

Weight **700 is now loaded**. It is used on body text in roughly twenty components but only 400/500/600 were ever requested, so every bold was browser-synthesised (faux bold) — smeared, with letterforms the designer never drew.

### The scale

Six steps, defined as tokens at the top of `globals.css`. Before this pass the app used **18 distinct font sizes** between 10.5 and 38px, most of them arbitrary neighbours (13 and 13.5 and 14 all in play), which is what made the UI read as inconsistent rather than merely small.

| Token | Size | Role |
|---|---|---|
| `--fs-xs` | 12px | Uppercase micro-labels and column headers, counters, hints |
| `--fs-sm` | 14px | Secondary/muted text, chips, buttons |
| `--fs-body` | 16px | Default body, table cells, panel titles, sidebar nav |
| `--fs-lg` | 19px | Section and dialog titles |
| `--fs-title` | 28px | Page title |
| `--fs-display` | 40px | Metric values |
| `--fs-hero` | 56px | The dashboard's single hero figure — one per view, never reused |

**The rule: no in-between sizes.** Anything that needs to be "a bit smaller" goes to the next step down, not to a new value. That discipline is the whole point — the 18-size sprawl came from repeatedly nudging one element by half a pixel.

Two earlier choices were reversed in session 21, deliberately:

- **Nav is now at `body` (16), semibold.** At 14/500 and dimmed it read as passive — options rather than destinations. The old objection (wrapping "Schemalagda SMS") no longer applies: the sidebar is 232px and the shortcut hint floats over the item's edge instead of taking width.
- **Uppercase labels and column headers are now at `xs` (12) with wide tracking.** At 14, bold and uppercase across every panel and table they shouted; at 12 with 0.08–0.14em tracking they read as structure. Headings that carry meaning use serif titles instead.

### Gotcha for any future type change

**Font sizes are mostly centralised now, not entirely.** Session 21 moved the redesigned pages onto classes in `globals.css` that use the `--fs-*` tokens; a remainder of inline `style={{ fontSize: n }}` objects survives in older pieces (e.g. the SMS counter and emoji picker in `SettingsForm.tsx`, the toast host). The page files under `app/` are easy to miss — `app/app/dashboard/page.tsx` in particular owns `S.sectionLabel`, the uppercase eyebrow shared by every dashboard panel including Senaste aktivitet. A sweep that covers `src/components` but not `app/` produces exactly the symptom it looks like it fixed: half the dashboard scaled, half not, with adjacent panels visibly disagreeing.

The `--fs-*` tokens exist so this converges over time; components are still on raw px and can be migrated opportunistically.

`app/login/page.tsx` is intentionally **outside** the scale — its Cormorant Garamond hero type (56/48px) is a separate treatment for the unauthenticated shell.

---

## What Still Needs to Be Done

### Blocking / highest value

- [ ] **Roll out follow-ups V2 in order: Deploy A → 025 → Deploy B → 026.** See the session 20 rollout section for why each step precedes the next and what breaks if they are swapped. Deploy A is commit `50711f2`; the freeze on structural step edits holds from 025 until 026.
  - [ ] Deploy A (id-preserving settings route), then confirm an id-less settings save is refused
  - [ ] `npx supabase db push` for 025, then run the verification queries in its header
  - [ ] Confirm PostgREST sees `step_id`/`step_day` before deploying further
  - [ ] Apply 027 before Deploy B's first daily cron, then `select public.refresh_passed_booking_metadata();` (the header's verification query should then return 0). Mind that `db push` also applies 026 if it is still pending
  - [ ] Deploy B (rest of `followups-v2`)
  - [ ] Browser check: toggle a follow-up off, save, reload; schedule dialog lists it as "(inaktiv)"; `/app/analytics` shows "Sedan start"
  - [ ] Cron dry-run with `dry_run_mode` on: results ordered oldest-due first, each carrying `stepId`/`stepDay`. **Warning (R5 below):** every `dry_run` row consumes that step for a real patient, so up to 25 patients would never get it for real. Delete the run's `dry_run` rows afterwards, or do this check in the local sandbox instead
  - [ ] Apply 026 once no post-deploy row lacks `step_id`
- [x] ~~**Apply and validate migrations 022–024.**~~ Applied and verified in production 2026-09-02 by direct RPC calls.
- [x] ~~**Disable optional inline polling for production batches.**~~ `SMS_VERIFY_DELIVERY=off` set in Vercel 2026-09-02.
- [ ] **Decide on the 1000-booking read cap** (session 21). `readStore()` loads only the newest 1000 of 4,738 bookings, and the sending engine reads through it. Harmless today (all upcoming appointments are inside the window) but it will not stay so. Fix: page the reads the way `getAnalyticsData` does, in both `readStore()` and `readStoreForUi`.
- [ ] **Browser QA of the session 21 redesign** on the pages not yet checked — scheduled SMS, SMS history, review, import — plus mobile widths and the client-side patients tabs/search/paging.
- [ ] **"Sändningstid" is not used by the cron** (fixed `0 8 * * *` UTC). Either wire it or remove the field so the settings page stops implying it.
- [ ] **Investigate why no delivery receipt has ever landed.** `delivered` is 0 across 168 sends while 46elks reports recent messages delivered. Secret and app URL are both verified correct. Send one test SMS and watch whether the row advances within a minute; if not, redeploy to clear any warm function holding the stale URL.
- [ ] **Examine the open `pending_booking_match` from 17:09 on 2026-09-02** — it predates both successful bookings and has not been looked at.
- [ ] **Merge `typography-scale` to `main`.** Migration 024 removed the blocking constraint; typecheck and tests pass. `followups-v2` branches from it, so merging that first would carry both.
- [ ] **Smoke test session 18 against real integrations.** Cover webhook rebooking, CSV rebooking after the appointment passes, pending scheduled-row cancellation, a row already in `processing`, out-of-order schedule refusal, accepted 46elks sends, webhook-delivered/failed transitions, and failed retry review-item reuse.
- [x] ~~**Wire and test the BokaDirekt webhook.**~~ Live on `sms.khyte.se` for all three event types; first two bookings received 2026-09-02, both auto-matched, both logging conversions. Conversion tracking is proven end-to-end.
- [ ] **Test the Supabase `pg_cron` scheduled-SMS job end-to-end.** Never verified against a live tick. Steps:
  - [ ] Confirm both Vault secrets exist: `select name from vault.secrets where name in ('app_base_url','cron_secret');`
  - [ ] Confirm the job is registered and active: `select jobname, schedule, active from cron.job where jobname = 'scheduled-sms-worker';`
  - [ ] Fire it manually and check for an error: `select public.trigger_scheduled_sms();`
  - [ ] Check run history: `select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'scheduled-sms-worker') order by start_time desc limit 10;`
  - [ ] Schedule a real SMS a few minutes out and confirm it moves `pending → processing → sent` within ~15 minutes
  - [ ] Confirm the empty-tick short-circuit works — a tick with no due rows should make **no** HTTP call (no corresponding Vercel function invocation)
  - [ ] Confirm the route rejects an unauthenticated call (wrong/missing bearer → 401)
- [ ] **Compare conversions against reality** — ask the clinic whether any of the 30 messaged customers actually rebooked, and reconcile against what the app reports. This is the only way to distinguish "SMS aren't working" from "tracking isn't capturing it".
- [ ] **Finish the Supabase key cutover in Vercel.** New keys are set and verified locally; Vercel still has only the legacy ones. Remaining steps from `docs/supabase-key-rotation.md`:
  - [ ] Set `SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in Vercel, keeping the legacy vars in place
  - [ ] **Redeploy** — `NEXT_PUBLIC_*` is inlined at build time, so setting it without redeploying changes nothing
  - [ ] **Test an actual write in production** (CSV import or a settings edit), not just page loads — every write path assumes the server key bypasses RLS
  - [ ] Remove the legacy vars from Vercel, redeploy, then disable the legacy keys in Supabase (irreversible — do it last)
- [x] ~~Rotate the exposed BokaDirekt webhook secret and set it in Vercel~~ — done; verified matching on both domains 2026-09-02
- [x] ~~Confirm `SMS_DELIVERY_WEBHOOK_SECRET` is set in Vercel~~ — verified matching 2026-09-02 (but receipts still are not arriving; see above)
- [ ] Set `CRON_SECRET` in Vercel, and confirm the Vault `cron_secret` matches it — **still unverified**, deliberately not probed since a valid call would send real SMS

### Open follow-up gaps (found by the sandbox)

Ordered by impact. Each gap is pinned by a `known gap` test that asserts today's behaviour, with an `it.todo` for the fix (6 open). Numbers and scenarios are in `docs/sandbox.md` under "What the simulations showed"; run `npm test` (simulator) or `npm run sandbox:test` (local Supabase) to reproduce.

- [ ] **R6: `readStore()` silently drops the oldest rows past 1000 in every table, not only bookings.** Imminent: there were 984 patients on 2026-09-23.
  - Patients: from 1001 on, the patients the clinic has known longest stop getting follow-ups, without any error.
  - Logs: past 1000 rows, steps already sent look unsent and collide as "Redan reserverad".
  - Fix: page the reads the way `getAnalyticsData` does (same fix as the booking cap above).
- [ ] **R5: dry run consumes the step.** A `dry_run` row counts as sent, so switching dry run off does not give the rehearsed step back; the 5-day SMS is skipped for good. It also applies to scheduled SMS fired during dry run. Until fixed: delete the `dry_run` rows before switching dry run off, and see the warning on the rollout's dry-run check above.
- [ ] **R3: a large backlog costs fresh patients the 5-day SMS.** The queue serves the oldest due date first and each patient gets the highest crossed step. With more than 225 patients already due ahead (125 with 5/10 steps), a fresh patient's first message is the 14-day one. No row records the skipped step. Most likely right after Deploy B, when the imported backlog is first drained at 25/day. Decide whether short follow-ups should jump the queue or the cap should rise during the drain.
- [ ] **R2: most visits get the 5- and 14-day SMS a day late.** "Day N" means N × 24 elapsed hours at the 08:00 UTC cron, so a visit stored after 08:00 UTC gets them on days 6 and 15. That covers every visit a CSV import on Vercel stores after 08:00 local wall-clock time. On Vercel Hobby the cron may fire at any minute from 08:00 to 08:59 UTC, so visits stored in that hour can go either way. Decide whether "day N" should mean the Nth calendar day (related: the unused "Sändningstid" setting above).
- [ ] **A duplicate-reservation skip still uses a `max_per_day` slot.** Any "Redan reserverad" collision counts as processed, so it takes a slot from a patient who could have been sent. After R4's fix this needs a residual cause (R6's truncated logs, concurrent sends), but the cost is unchanged.
- [ ] **A failed send blocks the patient until someone acts.** The `failed_sms` review item puts them in Needs review; there is no automatic retry. Resolving the item without resending moves them on to the next step, so the failed one is lost.
- [ ] **Pausing the automation loses the steps that came due meanwhile.** With `is_active` off nothing is logged; on re-enable only the highest crossed step is sent. The scheduled-SMS worker ignores `is_active` (only dry run applies to it), which may be intended but is worth knowing.
- [ ] **Security: 022's `refresh_patient_booking_metadata()` is executable by `authenticated`.** 022 revoked only `public`/`anon`, and Supabase's default privileges grant `authenticated` (verified in the local sandbox). It is SECURITY DEFINER, so any signed-in user can recompute any patient's anchor; the damage is limited because the value is always the canonical one. Fix: revoke from `authenticated` in a new migration, as 027 does; check 022's other two functions at the same time.

Not yet verified anywhere:

- [ ] 025/026 have only run against an empty database; their backfill on production-shaped data is unrehearsed.
- [ ] The R3 boundaries come from the simulator only; the Vercel Hobby "any minute in the hour" timing is modelled from documentation, not observed.

Fixed in code, pending rollout:

- [x] **R4: a rebooking for a future date anchored the new cycle on the old visit** (early 5/14-day SMS right after the new visit, daily "Redan reserverad" collisions, review-queue patients never followed up). Migration 027 + the daily-cron sweep fix it once 027 and Deploy B are live; production still has the bug until then. Before/after numbers are in `docs/sandbox.md`.

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
- `src/lib/reminders/process.test.ts` — scheduled-SMS delivery outcomes, CSV/webhook stale-cycle refusal, provider verification, delivered counting, step resolution by id, and daily-queue ordering under the cap
- `src/lib/reminders/nextStep.test.ts` — follow-up selection by day/id: highest crossed threshold, inactive steps skipped without blocking, re-timed and deleted steps bounded by their snapshot, ordering guards, and the Waiting/Sent split when nothing is active (replaced `sequenceOrder.test.ts`)
- `src/lib/reminders/steps.test.ts` — step normalization, stable fallback ids, and the editing view that never persists them
- `src/lib/reminders/validateSteps.test.ts` — id minting, the stale-tab rejection, and duplicate id/day refusal
- `src/lib/reminders/queue.test.ts` — oldest-due-first ordering, monotonicity across a threshold, deterministic tie-breaks, and purity
- `src/lib/analytics/lifetime.test.ts` — one credit per follow-up cycle, the import-timestamp guard, bucket boundaries, per-step labelling, and attributed ⊆ eventual
- `app/api/settings/route.test.ts` — id minting and the stale-tab 400 at the route boundary
- `src/lib/sms/outcome.test.ts` — six-state outcome mapping, provider-confirmed delivery, and sent/delivered counting
- `src/lib/sms/verifyDelivery.test.ts` — bounded 46elks polling, terminal outcomes, unreachable/disabled behavior, and hanging-request deadline enforcement
- `app/api/reminders/send-message/route.test.ts` — repeated failed retries reuse one review item and return the resolved error
- `src/lib/analytics/dayKeys.test.ts` — Stockholm day bucketing and window boundaries across both 2026 DST transitions; the UTC-noon anchor producing strictly consecutive days
- `src/lib/analytics/conversionRate.test.ts` — distinct-patient counting, null vs. 0 %, and the intersection that keeps the rate ≤ 100 %
- `src/lib/analytics/attributionWindow.test.ts` — exclusive upper bound, untrusted query-param parsing, and the monotonicity property that makes the window safe to change retroactively
- `src/lib/patients/followupTrack.test.ts` — the patients-page follow-up track reads a cycle the way the engine does: id before day snapshot before position, earlier crossed steps passed over in favour of the latest, dry runs / pending / failures kept distinct from real sends
- `src/test/sim/smoke.sim.test.ts` — self-checks of the in-memory follow-up simulator. The simulator drives the real, unchanged `processDailyReminders`/`processScheduledSms` with a fake clock and a fake data layer
- `src/lib/reminders/simulation/thresholds.sim.test.ts` — day-N timing at the 08:00 UTC cron (R2); full 5/14/90/180/365 and 5/10 journeys; late discovery; inactive steps; new webhook patients confirmed before their visit
- `src/lib/reminders/simulation/backlog.sim.test.ts` — queue order and overflow under `max_per_day`, and how a backlog starves the 5-day SMS (R3)
- `src/lib/reminders/simulation/rebooking.sim.test.ts` — webhook rebookings anchored on the old visit (R4), cancelled rebookings, cancellation of scheduled SMS
- `src/lib/reminders/simulation/dryRunAndScheduled.sim.test.ts` — dry run consuming the step (R5), scheduled SMS, delivery unknown, provider failure, stale pending reservations, automation off

**229 tests (plus 6 `it.todo` recording the desired behaviour for known gaps) across 20 files.** `process.test.ts` also covers the R4 sweep: it runs before the store is read, and a failed sweep stops the run before anything is sent. Provider HTTP is mocked and route/database behavior is simulated. Nothing in `npm test` exercises a real database, real 46elks traffic, Vercel runtime limits, or the RLS policies — see the session 16 and session 18 gaps.

`npm run sandbox:test` is the opt-in exception. It runs `src/test/sandbox/followups.sandbox.ts` (8 tests) against a local Supabase stack in Docker, with time travel done by shifting stored timestamps. On that stack, migrations 001–026 apply cleanly to an empty database. It never touches the linked production project. See `docs/sandbox.md` for both layers, the commands and the safety rules.

`src/test/mockSupabase.ts` provides a small reusable chainable Supabase mock for tests that need to assert on `.eq()`/`.update()` call arguments without a live database.

---

## References

- Supabase project: `https://supabase.com/dashboard/project/updomqqgivylpunzuanw`
- GitHub repo: `https://github.com/HaiDaPlug/sms-followup`
- Scheduled-SMS `pg_cron` setup and verification queries: `docs/scheduled-sms-setup.md`
- RLS rollout, verification and rollback: `docs/rls-rollout.md`
- Webhook payload confirmed: `docs/` — see session 9 conversation
