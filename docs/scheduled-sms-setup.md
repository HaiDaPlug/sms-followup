# Scheduled SMS — trigger setup

The scheduled-SMS queue is drained by a worker at `/api/cron/scheduled-sms`.
That worker is triggered from **Supabase (`pg_cron`)**, not from `vercel.json`.

## Why not Vercel cron

A scheduled send is only meaningful if the queue is checked every few minutes —
otherwise a message scheduled for 14:00 goes out the next day. Vercel's Hobby
plan **rejects any cron more frequent than daily at deploy time**, so keeping
the trigger there would have made a core feature depend on a paid plan.

Nothing about correctness moved. Atomic claiming (`claim_due_scheduled_sms`),
stuck-row recovery and attempt counting were always in Postgres; Vercel's cron
was only a heartbeat, and that heartbeat now comes from Postgres too.

`daily-reminders` stays on Vercel cron — it runs once a day, which Hobby allows.

## One-time setup per environment

Migration `020_scheduled_sms_pg_cron.sql` creates the trigger function and
schedules the job, but it deliberately contains **no secrets** — migrations are
committed to git. Supply them via Vault, once per project:

```sql
-- Your deployed app's base URL, no trailing slash.
select vault.create_secret('https://your-app.vercel.app', 'app_base_url');

-- Must match the CRON_SECRET set in the Vercel environment.
select vault.create_secret('<the same value as CRON_SECRET>', 'cron_secret');
```

To rotate either value later:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'cron_secret'),
  '<new value>'
);
```

Until both secrets exist the job raises a clear error on every tick rather than
firing unauthenticated requests that the route would silently 401.

## Verifying it works

```sql
-- The job should be listed and active.
select jobname, schedule, active from cron.job where jobname = 'scheduled-sms-worker';

-- Recent runs; status 'succeeded' is what you want.
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'scheduled-sms-worker')
order by start_time desc
limit 10;

-- Fire it once by hand without waiting for the schedule.
select public.trigger_scheduled_sms();
```

To confirm end to end: schedule an SMS a couple of minutes out, then watch the
row move `pending → processing → sent`.

## Operational notes

- **Tick rate is every 15 minutes.** A follow-up arriving at 14:12 instead of
  14:00 is not materially different to the recipient. Change it by re-running
  the `cron.schedule` block in migration 020 with a different expression — it
  unschedules first, so re-running never stacks duplicate jobs.
- **Empty ticks cost nothing.** The trigger checks for due rows in Postgres and
  returns without an HTTP call when there is no work, so function invocations
  track real work rather than the tick rate.
- **`pg_net` does not retry.** This is safe: the queue is the source of truth,
  so a failed or missed tick delays sends rather than dropping them — the next
  tick re-claims anything still pending.
- **Rows stuck in `processing`** for over 30 minutes are swept to `unknown` by
  `claim_due_scheduled_sms`. They are never retried automatically, because a
  crashed worker may already have handed the message to the provider.

## Pausing

```sql
select cron.unschedule('scheduled-sms-worker');   -- stop
-- re-run the cron.schedule block in migration 020 to start again
```

Queued messages are not lost while paused; they send on the next tick after the
job resumes.
