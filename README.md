# Clinic Rebooking Reminder Demo

Working V1 scaffold for importing BokaDirekt CSV exports, cleaning/deduping patients, calculating SMS reminder eligibility, sending manual reminders, and exposing cron/webhook scaffolds.

## Run

```bash
npm install
npm run dev
```

Open `/app/dashboard`.

The app uses `data/dev-db.json` for local demo storage. The app talks to persistence through `src/lib/data/repository.ts`, so Supabase can replace the JSON adapter without rewriting import, matching, reminder, SMS, cron, or UI logic. Apply `supabase/migrations/001_clinic_rebooking.sql` in Supabase before switching to production persistence.

## Demo Safety

- Keep `dry_run_mode` enabled unless intentionally testing real SMS.
- Set `CRON_SECRET` before deploying cron publicly.
- Set `BOKADIREKT_WEBHOOK_SECRET` before exposing the webhook URL.
- Do not deploy public live SMS routes without auth.
- Webhook mapping is scaffolded until a real BokaDirekt payload is confirmed.

## Manual configuration

- Set `FORTYSIX_ELKS_USERNAME`, `FORTYSIX_ELKS_PASSWORD`, and optionally `FORTYSIX_ELKS_FROM` for 46elks.
- Or set `SMS_PROVIDER_WEBHOOK_URL` and `SMS_PROVIDER_API_KEY` to send real SMS through the generic adapter.
- Set `CRON_SECRET` and call `POST /api/cron/daily-reminders` with `Authorization: Bearer <secret>`.
- Set `BOKADIREKT_WEBHOOK_SECRET` and configure BokaDirekt webhooks to call `POST /api/webhooks/bokadirekt`.
