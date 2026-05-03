# Current State — Clinic Rebooking Reminder System

**Last updated:** 2026-05-03 (patients page redesign + UX polish)
**Phase:** Supabase live, branding applied, deployed to Vercel via GitHub. 46elks credentials added locally. Dashboard modals, SMS-historik page, pagination, dynamic SMS steps, and failed SMS review loop complete.

---

## What This Product Is

A clinic rebooking engine built for Osteopaticentrum (Borås) that:
1. Imports patient booking history from a BokaDirekt CSV export
2. Cleans, deduplicates, and matches patients deterministically
3. Calculates each patient's reminder eligibility using a 3-step SMS sequence (day 30, 60, 90)
4. Sends the correct SMS in the sequence — manually or on a daily cron schedule
5. Resets a patient's sequence when a new booking arrives via webhook, preserving full history
6. Logs all activity and surfaces data quality issues for review

One deployment per clinic. No multi-tenancy, no auth — intentional for V1.

> **Future idea — white-label:** Upload a logo, the app extracts the brand colors and applies them automatically. Each clinic gets their own look without any manual theming. Potential path to selling this as a product rather than a bespoke deployment.

> **Future idea — portal & isolated data:** Each clinic should eventually get their own login through a shared portal, with fully isolated data per tenant (own patients, bookings, settings, SMS logs). Right now everything lives in one shared Supabase project with no auth. Moving to per-user isolated data is the prerequisite for selling this to multiple clinics without manual re-deploys. See `docs/scalability.md` for the full breakdown.

---

## Infrastructure

- **Next.js 15** App Router + TypeScript, React 19
- **Supabase** (Stockholm region, project `updomqqgivylpunzuanw`) — live, migration applied
- **Storage**: all data in Supabase — `patients`, `bookings`, `reminder_settings`, `reminder_logs`, `review_items`
- **SMS**: 46elks adapter in `src/lib/sms/provider.ts` — credentials set locally, not yet in Vercel
- **Deployment**: Vercel, connected to `github.com/HaiDaPlug/sms-followup`, auto-deploys on push to `main`
- **Cron**: Vercel cron at `0 8 * * *` → `/api/cron/daily-reminders`
- `typecheck` and `build` both pass clean

---

## Environment Variables

| Variable | Local | Vercel | Notes |
|---|---|---|---|
| `SUPABASE_URL` | ✅ | ✅ | Set |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ✅ | Set |
| `SMS_PROVIDER` | ✅ | — | `46elks` |
| `FORTYSIX_ELKS_USERNAME` | ✅ | — | Set locally, needed in Vercel for live SMS |
| `FORTYSIX_ELKS_PASSWORD` | ✅ | — | Set locally, needed in Vercel for live SMS |
| `FORTYSIX_ELKS_FROM` | ✅ | — | Sender name/number |
| `TEST_SMS_TO` | placeholder | — | For `/api/reminders/test` |
| `CRON_SECRET` | placeholder | — | Security — set before public URL |
| `BOKADIREKT_WEBHOOK_SECRET` | placeholder | — | Security — set before public URL |

---

## What's Built and Working

### Pages
| Route | Status | Notes |
|-------|--------|-------|
| `/app/dashboard` | Working | KPI strip with clickable modals, daily prognos, alerts, varningar, senaste aktivitet |
| `/app/patients` | Working | Redesigned table with card-style rows, left-bar status accents, instant client-side search, sticky column header with inline pagination, fill-sweep SMS + DNC buttons, status dot indicators |
| `/app/sms-history` | Working | All contacted patients, full SMS log per patient, send + remove/reactivate actions |
| `/app/import` | Working | Upload BokaDirekt CSV, Swedish summary labels |
| `/app/review` | Working | Review queue with resolve/ignore actions |
| `/app/settings` | Working | 3 SMS templates, timing, dry-run toggle with live label update |

### Dashboard — interactive KPI modals
All four KPI cards are clickable and open modals:
- **Redo för påminnelse** — paginated list (50/page) with Senast/Äldst sort toggle (Senast left, Äldst right) and "Skicka SMS" per row with fill-sweep hover effect. Sends immediately, patient slides out, KPI counts update live.
- **SMS denna månad** — all sent logs this month with patient name, phone, sequence number, and date.
- **Inväntar granskning** — open review items with title, description, and severity badge.
- **Senaste aktivitet** — preview panel with "Visa alla ↗" button opening full activity history modal.

All modals share:
- Dark green (`#073B2C`) header matching sidebar
- Shimmer skeleton loading state
- Staggered row entrance animations (Framer Motion)
- Alternating row tints for readability
- Escape key + backdrop click to close

### SMS-historik page (`/app/sms-history`)
- Lists every patient who has received at least one SMS, sorted by most recent contact
- Shows full badge history per patient (SMS 1, SMS 2, SMS 3, Testläge, Misslyckades)
- **Ta bort** — marks patient as do-not-contact, removes from future send queue
- **Återaktivera** — reactivates a blocked patient via new `/api/patients/[id]/reactivate` endpoint
- **Skicka SMS** — disabled for blocked patients

### Settings form
- Three named sections: Klinik & timing / SMS-mallar / Körläge
- Dry-run toggle is a card that changes color and label live
- Primary buttons use brand dark green `#073B2C`

### Branding
- Sidebar: `#073B2C` (exact Osteopaticentrum brand green)
- Logo: `public/osteopaticentrum.svg` — inverted white in sidebar
- Accent: `#5bbfb5` (mint from website CTA)
- Main area: pure white surfaces on `#f6f8f7` background

### API Routes
| Endpoint | Status | Notes |
|----------|--------|-------|
| `POST /api/import/bokadirekt` | Working | Accepts file upload or raw CSV — idempotent upsert on `external_booking_id` |
| `GET /api/dashboard/stats` | Working | Powers dashboard KPI strip |
| `GET /api/dashboard/ready-patients` | Working | Paginated (`?page&sort`), 50/page |
| `GET /api/dashboard/sms-this-month` | Working | Sent logs this month with patient names |
| `GET /api/dashboard/review-items` | Working | Open review items |
| `GET /api/dashboard/activity` | Working | Full activity log with patient names |
| `POST /api/reminders/send` | Working | Manual send for a single patient |
| `POST /api/reminders/send-message` | Working | Send a literal pre-rendered message, resolves review item on success |
| `POST /api/reminders/test` | Working | Send a test SMS to a given phone number |
| `POST /api/patients` | Working | Manually create a patient (name, phone, email) |
| `GET/POST /api/settings` | Working | Read/update settings |
| `POST /api/patients/[id]/do-not-contact` | Working | Blocks patient from future SMS |
| `POST /api/patients/[id]/reactivate` | Working | Re-enables a blocked patient |
| `POST /api/review/[id]` | Working | Resolve/ignore review items |
| `GET /api/cron/daily-reminders` | Working | Daily batch runner |
| `POST /api/webhooks/bokadirekt` | Working | Import + cycle reset |

### Core Logic
| Module | Status | Notes |
|--------|--------|-------|
| `src/lib/storage/store.ts` | Complete | Full Supabase implementation |
| `src/lib/supabase/client.ts` | Complete | Service role singleton |
| `src/lib/import/bokadirekt.ts` | Complete | Idempotent upserts, recalculates per touched patient |
| `src/lib/reminders/eligibility.ts` | Complete | `getNextSequence()` drives all send decisions |
| `src/lib/reminders/process.ts` | Complete | Per-patient send with correct template per step |
| `src/lib/sms/provider.ts` | Complete | 46elks + generic webhook fallback |
| `src/lib/data/repository.ts` | Complete | Re-export boundary |

---

## SMS Sequence Logic

Up to 3 SMS per patient per booking cycle. Interval configured via **"Dagar mellan steg"** (default: 30).

| SMS | Skickas på dag | Mall |
|-----|---------------|------|
| 1 | 30 | `sms_template` |
| 2 | 60 | `sms_template_2` |
| 3 | 90 | `sms_template_3` |

- `getNextSequence()` checks days elapsed + logs since last `cycle_reset`
- `dry_run` logs count as sent — toggling live mode won't re-send already-logged steps
- Cycle reset writes a `cycle_reset` log; all history before it is preserved
- CSV re-import is safe — fully idempotent, keyed on `external_booking_id` per booking and normalized phone per patient

---

## Architecture

```
BokaDirekt CSV / Webhook
      ↓
/api/import/bokadirekt  OR  /api/webhooks/bokadirekt
      ↓
src/lib/import/bokadirekt.ts
  → normalizes rows
  → upserts patients row-by-row (Supabase)
  → upserts bookings row-by-row (Supabase)
  → recalculates last_booking_at / has_future_booking per touched patient
  → creates review items for data quality issues

[Webhook only]
  → matches patient by phone/email
  → resetPatientCycle() → INSERT reminder_logs (cycle_reset)
      ↓
Supabase  ←→  src/lib/storage/store.ts  ←→  src/lib/data/repository.ts
      ↓
src/lib/reminders/eligibility.ts
  → calculatePatientReminderStatus
  → getNextSequence() → Ready (sequence 1/2/3) / Waiting / Sent
      ↓
src/lib/reminders/process.ts
  → sendReminderToPatient
      picks sms_template / _2 / _3
      if dry_run → log status=dry_run
      if live → src/lib/sms/provider.ts → 46elks
      → INSERT reminder_logs with sequence_number
```

---

## What Still Needs to Be Done

## Current Priorities

### 1. Prove the core SMS loop (next up)
- [ ] Add `FORTYSIX_ELKS_USERNAME`, `FORTYSIX_ELKS_PASSWORD`, `FORTYSIX_ELKS_FROM` to Vercel env vars
- [ ] Turn off dry-run mode in `/app/settings`
- [ ] Add yourself as a patient via the new "+ Lägg till patient" button on `/app/patients`
- [ ] Hit "Skicka SMS" on your own row — confirm delivery end-to-end
- [ ] Send one test SMS via `/api/reminders/test` as a secondary check

### 2. Wire in BokaDirekt webhooks (automatic booking updates)
- [ ] Get a real webhook payload sample from BokaDirekt to confirm field names (`phone`/`Phone`/`mobilnummer` etc.)
- [ ] Update `src/lib/webhooks/bokadirekt.ts` field mapping to match real payload
- [ ] Set `BOKADIREKT_WEBHOOK_SECRET` in Vercel and verify signature check in `/api/webhooks/bokadirekt`
- [ ] Register the webhook URL with BokaDirekt pointing to `https://<your-domain>/api/webhooks/bokadirekt`
- [ ] Test: make a real booking and confirm patient `last_booking_at` updates and cycle resets automatically

### Before sharing the URL publicly
- [ ] Set `CRON_SECRET` — without it anyone can trigger mass SMS sends
- [ ] Set `BOKADIREKT_WEBHOOK_SECRET` — see priority 2 above
- [ ] Add auth to `/api/settings` and `/api/reminders/send`

### Recently completed (2026-05-03 — session 2)

#### Patients page redesign
- Card-style rows with a 4px colored left-bar keyed to status (mint = ready/sent, blue = future, red = alert, amber = do-not-contact, grey = inactive)
- Alternating row depth + mint hover tint
- Sticky column header pulled outside scroll container — stays visible while scrolling 970 rows
- Inline pagination (← 1/20 →) lives in the "Åtgärder" header cell — no scrolling to bottom to change pages
- Instant client-side search via `PatientSearch` component — filters rows on every keystroke, updates count chip live, no network round-trip
- Fill-sweep "Skicka SMS" button (dark green → mint sweep) and fill-sweep "Kontakta ej" (transparent → red sweep), consistent with dashboard modal buttons
- Status badges redesigned: dot indicator + label in sentence case, no background fills. Ready = mint dot, Sent = darker mint, Future = steel blue, alert states = red, Waiting = warm grey, Do not contact = amber
- Filter pills changed from full-pill to rounded rectangles (radius-sm), consistent with the rest of the UI
- Control bar: title + count chip inline, segmented sort toggle, expanding search input
- "Skicka SMS" fill-sweep also applied to KPI modal for consistency

### Recently completed (2026-05-03 — session 1)

#### Hardening
- Review items are now idempotent on re-import — upsert on `content_hash`, no more duplicates
- `do_not_contact` flag is never overwritten by import — blocked patients stay blocked
- `has_future_booking` is now checked live against bookings at eligibility time, not from a stale stored flag
- Patients can be added manually via UI (`+ Lägg till patient` on `/app/patients`)

#### Dynamic SMS steps
- "Dagar mellan steg" removed — each SMS step now has its own individually configurable day threshold
- Steps editable inline: click the "dag 30" chip to type a new value, add/remove steps freely
- `sms_steps` JSONB column drives eligibility; legacy 3-template columns kept in sync for backwards compat
- `resolveSteps()` in `src/lib/reminders/steps.ts` is the single source of truth used by eligibility, process, and the form

#### Failed SMS review loop
- Failed or skipped sends (including unresolved `{{placeholders}}`) automatically create a `failed_sms` review item containing the fully rendered message
- `/app/review` shows an inline editable textarea for `failed_sms` items — tweak the specific message and hit "Skicka nu" without touching the global template
- `POST /api/reminders/send-message` sends a literal message string, bypasses template rendering, logs the result, and auto-resolves the review item on success
- Template rendering validated before every send — any unresolved `{{token}}` blocks the send and surfaces in the review queue

#### Pending migrations (run in Supabase SQL editor if not yet applied)
```sql
alter table review_items add column if not exists content_hash text;
create unique index if not exists review_items_content_hash_idx
  on review_items (content_hash) where content_hash is not null;

alter table reminder_settings add column if not exists sms_steps jsonb;
```

### Known limitations
- Webhook field names (`phone`, `Phone`, `mobilnummer`) are guesses until real BokaDirekt samples arrive
- Medium-confidence patient matches imported optimistically, flagged in review queue

---

## References

- Supabase project: `https://supabase.com/dashboard/project/updomqqgivylpunzuanw`
- GitHub repo: `https://github.com/HaiDaPlug/sms-followup`
- Supabase schema: `supabase/migrations/001_clinic_rebooking.sql`
- Environment variable reference: `.env.example`
