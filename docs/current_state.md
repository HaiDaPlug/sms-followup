# Current State — Clinic Rebooking Reminder System

**Last updated:** 2026-04-28
**Phase:** V1 complete with 30/60/90-day SMS sequence, full Swedish UI, and frontend polish pass.

---

## What This Product Is

A clinic rebooking engine that:
1. Imports patient booking history from a BokaDirekt CSV export
2. Cleans, deduplicates, and matches patients deterministically
3. Calculates each patient's reminder eligibility using a 3-step SMS sequence (day 30, 60, 90)
4. Sends the correct SMS in the sequence — manually or on a daily cron schedule
5. Resets a patient's sequence when a new booking arrives via webhook, preserving full history
6. Logs all activity and surfaces data quality issues for review

It is intentionally source-flexible: CSV now, BokaDirekt webhooks as a supplement later, API only if a higher-paying client justifies it. The core logic does not care where data comes from.

---

## What's Built and Working

### Infrastructure
- Next.js 15 App Router + TypeScript, React 19
- Local JSON file store at `data/dev-db.json` behind a repository abstraction (`src/lib/data/repository.ts`)
- Supabase migration exists at `supabase/migrations/001_clinic_rebooking.sql` — ready to apply, not yet active
- `typecheck` and `build` both pass
- `.env.example` documents all required and optional env vars
- `data/*.json` is gitignored — patient data never goes to version control

### UI
- Full Swedish language throughout — all labels, statuses, descriptions, error messages
- Design: Merriweather (headings/metrics) + Inter (body), warm off-white `#f4f2ee` background, teal accent `#2c6e5a`, white surfaces
- Sidebar: white with teal active state, SVG icons per nav item
- Responsive: sidebar collapses to top bar on mobile

### Pages
| Route | Status | Notes |
|-------|--------|-------|
| `/app/dashboard` | Working | KPI strip, daily prognos ledger, high-severity alerts, varningar, senaste aktivitet with SMS sequence number shown |
| `/app/patients` | Working | Full-width table, status + sort filters (äldst/senast), all Swedish |
| `/app/import` | Working | Upload BokaDirekt CSV, Swedish summary labels |
| `/app/review` | Working | Review queue, Swedish column headers and action buttons |
| `/app/settings` | Working | Three separate SMS templates (dag 30/60/90), all fields in Swedish with hints |

### Patient statuses (Swedish → internal)
| Visas | Intern | Betydelse |
|-------|--------|-----------|
| Redo | Ready | Nästa SMS i sekvensen ska skickas nu |
| Väntar | Waiting | För tidigt — dagar ej uppnådda ännu |
| Skickat | Sent | Hela sekvensen genomförd |
| Har bokat en tid | Future booking | Aktiv framtida bokning — hoppas över |
| Saknar telefon | Missing phone | Kan ej nås |
| Kontakta ej | Do not contact | Blockerad manuellt |
| Behöver granskas | Needs review | Öppet granskningsärende |
| Ingen giltig bokning | No valid booking | Inga bokningar alls |

### API Routes
| Endpoint | Status | Notes |
|----------|--------|-------|
| `POST /api/import/bokadirekt` | Working | Accepts file upload or raw CSV text |
| `GET /api/dashboard/stats` | Working | Powers the dashboard page |
| `POST /api/reminders/send` | Working | Manual send for a single patient, picks correct sequence SMS |
| `POST /api/reminders/test` | Working | Send a test SMS to a given phone number |
| `GET /api/settings` | Working | Read current settings |
| `POST /api/settings` | Working | Update settings including all 3 SMS templates |
| `POST /api/patients/[id]/do-not-contact` | Working | Mark patient as do-not-contact |
| `POST /api/review/[id]` | Working | Update review item status (open/resolved/ignored) |
| `GET /api/cron/daily-reminders` | Working | Trigger daily reminder run (also accepts POST) |
| `POST /api/webhooks/bokadirekt` | Working | Receives payload, imports booking, resets patient SMS cycle |

### Core Logic
| Module | Status | Notes |
|--------|--------|-------|
| `src/lib/import/csv.ts` | Complete | Custom CSV parser, handles quoted fields, CRLF |
| `src/lib/import/normalizers.ts` | Complete | Phone, email, name, date normalization; stable booking ID hash |
| `src/lib/import/bokadirekt.ts` | Complete | Row matching, patient upsert, booking upsert, full recalculation |
| `src/lib/reminders/eligibility.ts` | Complete | Sequence-aware status calculation; `getNextSequence()` determines which SMS (1/2/3) is due |
| `src/lib/reminders/process.ts` | Complete | Per-patient send with correct template per sequence step; daily batch runner |
| `src/lib/sms/provider.ts` | Complete | 46elks adapter + generic webhook fallback |
| `src/lib/patients/status.ts` | Complete | Display helpers |
| `src/lib/storage/store.ts` | Complete | JSON read/write, 3-template defaults, `resetPatientCycle()`, backfill of new fields on old records |
| `src/lib/data/repository.ts` | Complete | Thin re-export — the Supabase swap boundary |
| `src/lib/webhooks/bokadirekt.ts` | Working | Maps payload to CSV, runs import, matches patient by phone/email, writes `cycle_reset` log |
| `src/lib/review/ai.ts` | Stub | Returns a plain string, no AI call — intentional for V1 |

---

## SMS Sequence Logic

The system sends up to 3 SMS per patient per booking cycle. The interval between each is configured via **"Dagar mellan SMS (steg)"** (default: 30).

| SMS | Skickas på dag | Mall |
|-----|---------------|------|
| 1 | `step` (30) | `sms_template` |
| 2 | `step × 2` (60) | `sms_template_2` |
| 3 | `step × 3` (90) | `sms_template_3` |

**Eligibility check** (`getNextSequence`):
1. How many days since `last_booking_at`?
2. Which step does that put us in (1, 2, or 3)?
3. Look at `reminder_logs` for this patient since the last `cycle_reset` — what's the highest `sequence_number` already sent?
4. If current step > already sent → patient is **Ready** for the next SMS
5. If current step ≤ already sent → **Sent** (or **Väntar** if not yet at step 1)

**Cycle reset** (new booking via webhook):
- A `cycle_reset` log entry (`is_cycle_reset: true`, `status: "cycle_reset"`) is written for the patient
- All subsequent eligibility checks treat this as the new cycle boundary — sequence restarts from 1
- All historical logs before the reset are preserved with their original sequence numbers

**`dry_run` logs count as sent** — flipping dry-run off after a dry-run cycle will not re-send the same sequence steps.

---

## What Was Fixed / Added Since Last State Doc

### Frontend polish pass
- Full Swedish translation of all UI text including status labels, column headers, filter tabs, button labels, form field labels, error messages, and nudge descriptions
- Merriweather + Inter font pairing via Google Fonts
- Warm bone/off-white palette, teal accent, clean sidebar with per-page icons
- Dashboard redesigned: KPI strip with hairline separators, prognos ledger, high-severity alert strips, activity log showing SMS sequence number
- Patients page: full-width (no max-width cap), sort by days (äldst/senast bokning), composed filter + sort URL params
- "Framtida bokning" renamed to "Har bokat en tid" everywhere

### SMS sequence system
- `ReminderLog` gains `sequence_number: number | null` and `is_cycle_reset: boolean`
- `ReminderSettings` gains `sms_template_2` and `sms_template_3`
- Default interval changed from 45 → 30 days
- `getNextSequence()` in eligibility.ts drives all send decisions
- `resetPatientCycle()` in store.ts writes the cycle boundary log
- Webhook handler now matches the patient from the payload and calls `resetPatientCycle()`
- Settings form exposes all 3 templates with dynamic day labels (e.g. "SMS 2 — dag 60")
- Old JSON records backfilled with `sequence_number: null` and `is_cycle_reset: false` on read

---

## What Still Needs to Be Done

### Before going live (any real deployment)

- [ ] **Set `CRON_SECRET`** — without it, anyone can hit `/api/cron/daily-reminders` and trigger SMS sends
- [ ] **Set `BOKADIREKT_WEBHOOK_SECRET`** — same, open by default if unset
- [ ] **Add authentication to `/api/settings` and `/api/reminders/send`** — currently no auth guard
- [ ] **Set 46elks credentials** — `FORTYSIX_ELKS_USERNAME`, `FORTYSIX_ELKS_PASSWORD`, optionally `FORTYSIX_ELKS_FROM`
- [ ] **Test one real SMS end-to-end** — dry-run is proven; live SMS path has not been smoke-tested with real credentials
- [ ] **Swap JSON store for Supabase** — apply migration, set env vars, replace `readStore`/`writeStore`

### Before scaling to multiple clinics

- [ ] **Multi-tenancy** — no clinic/tenant ID in the data model. One deployment per clinic for now.
- [ ] **Auth / login** — no user authentication exists
- [ ] **File locking on JSON store** — `updateStore` does read-modify-write with no lock; safe for single-user, breaks under concurrent writes. Supabase solves this.
- [ ] **Rate limiting on import and send endpoints**

### Known limitations

- **Webhook patient matching is best-effort.** Looks for phone (normalized) then email in the payload. If neither is present, no cycle reset is written. Review item is always created for audit.
- **`has_future_booking` is only accurate at import time.** Does not update live between imports.
- **Medium-confidence patient matches are imported optimistically.** Flagged in review queue but not held up.
- **`stableBookingId` hash breaks if BokaDirekt renames CSV columns.** Same bookings will re-import as duplicates if column names change.
- **Webhook payload mapping unconfirmed against real BokaDirekt samples.** Scaffold works end-to-end but field names (`phone`, `Phone`, `mobilnummer`) are guesses until real webhook data is received.

---

## Architecture: How the Pieces Connect

```
BokaDirekt CSV / Webhook
      ↓
/api/import/bokadirekt  OR  /api/webhooks/bokadirekt
      ↓
src/lib/import/bokadirekt.ts
  → normalizes rows (normalizers.ts)
  → upserts patients (phone → email → uncertain)
  → upserts bookings (deduped on external_booking_id)
  → recalculates patient.last_booking_at / has_future_booking
  → creates review items for data quality issues

[Webhook only]
  → matches patient by phone/email
  → resetPatientCycle() → writes cycle_reset log
      ↓
data/dev-db.json  ←→  src/lib/storage/store.ts
                           (swap this file for Supabase)
      ↓
src/lib/reminders/eligibility.ts
  → calculatePatientReminderStatus
      checks: do_not_contact → missing phone → future booking
              → needs review → no valid booking
              → getNextSequence() → Ready (with sequence 1/2/3)
              → Waiting / Sent
      ↓
src/lib/reminders/process.ts
  → sendReminderToPatient
      re-checks eligibility
      getNextSequence() → picks sms_template / _2 / _3
      renders template with patient variables
      if dry_run → log with sequence_number, status=dry_run
      if live → src/lib/sms/provider.ts → 46elks / webhook
      → logs result with sequence_number
```

## Supabase Swap: What Changes

Only one file: `src/lib/storage/store.ts`

Replace `readStore` and `writeStore` with Supabase client calls. Everything else stays the same. The new `sequence_number` and `is_cycle_reset` columns need to be added to the `reminder_logs` table migration, and `sms_template_2` / `sms_template_3` to `reminder_settings`.

Steps:
1. Add new columns to `supabase/migrations/001_clinic_rebooking.sql`
2. Apply migration
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
4. Rewrite `readStore` / `writeStore` in `src/lib/storage/store.ts`

---

## Demo Hardening Steps

1. Delete or reset `data/dev-db.json` if it contains placeholder data
2. Import the real BokaDirekt CSV at `/app/importera`
3. Check patient counts on `/app/dashboard` — numbers should match the CSV
4. Verify some patients show **Redo** status (means ≥ 30 days since last booking)
5. Confirm dry-run mode is **on** in `/app/installningar`
6. Click "Skicka SMS" on one patient — confirm a dry-run log with "SMS 1" appears in dashboard
7. Keep dry-run on for the meeting
8. After meeting: flip dry-run off, send one real SMS via `/api/reminders/test`, confirm arrival
9. Flip dry-run back on immediately after

## Deployment Safety Warning

> Do not deploy this publicly with real SMS credentials unless auth and secrets are locked.

- Local demo: fine as-is
- Private preview (shared URL): set `CRON_SECRET` and `BOKADIREKT_WEBHOOK_SECRET` first
- Public Vercel URL with SMS enabled and no auth: not safe — add auth to `/api/settings` and `/api/reminders/send` first

---

## References

- Full correctness and safety review: `docs/v1-review.md`
- Original scaffold review notes: `docs/first-review.md`
- Supabase schema: `supabase/migrations/001_clinic_rebooking.sql`
- Environment variable reference: `.env.example`
