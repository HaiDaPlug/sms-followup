-- Move the scheduled-SMS trigger from Vercel cron into Postgres.
--
-- Why: the worker needs to run every few minutes to honour a scheduled send
-- time, but Vercel's Hobby plan rejects any cron more frequent than daily at
-- deploy time. The scheduling was the only part of this feature that depended
-- on a paid plan -- all the correctness (atomic claiming via
-- claim_due_scheduled_sms, stuck-row recovery, attempt counting) already lives
-- in Postgres, and Vercel's cron was only ever a dumb heartbeat.
--
-- Design notes:
--   * pg_net issues the HTTP call OUT of the database rather than the database
--     talking to 46elks itself. Outbound calls to a third party from inside a
--     transaction would couple the data layer to that provider's availability;
--     keeping the Next.js route in the middle preserves that boundary.
--   * pg_net is fire-and-forget and does not retry. That is safe here because
--     the queue -- not the trigger -- is the source of truth: a missed tick
--     delays sends, it never drops them, since the next tick re-claims
--     anything still pending.
--   * Secrets come from Vault, never from this file. A migration is committed
--     to git, so a hardcoded CRON_SECRET would be a credential leak.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Config lives in Vault so the migration stays secret-free and re-runnable.
-- Populate these once per environment before the job can fire (see
-- docs/scheduled-sms-setup.md):
--
--   select vault.create_secret('https://your-app.vercel.app', 'app_base_url');
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
--
-- Re-running this migration never overwrites them.

create or replace function public.trigger_scheduled_sms()
  returns void
  language plpgsql
  security definer
  set search_path = public, extensions
as $$
declare
  v_base_url    text;
  v_cron_secret text;
begin
  select decrypted_secret into v_base_url
  from vault.decrypted_secrets where name = 'app_base_url';

  select decrypted_secret into v_cron_secret
  from vault.decrypted_secrets where name = 'cron_secret';

  -- Fail loudly rather than firing an unauthenticated request that the route
  -- would reject with a 401 every few minutes, forever, with nothing to show
  -- for it. A missing secret is a setup error, not a runtime condition.
  if v_base_url is null or v_base_url = '' then
    raise exception 'trigger_scheduled_sms: vault secret "app_base_url" is not set';
  end if;
  if v_cron_secret is null or v_cron_secret = '' then
    raise exception 'trigger_scheduled_sms: vault secret "cron_secret" is not set';
  end if;

  -- Skip the round trip entirely when nothing is due. Most ticks are empty,
  -- and this keeps the function invocation count (and bill) proportional to
  -- real work rather than to the tick rate.
  if not exists (
    select 1 from public.scheduled_sms
    where status = 'pending' and scheduled_for <= now()
  ) and not exists (
    -- Also wake for rows stuck in processing: claim_due_scheduled_sms sweeps
    -- them back to 'unknown', but only when it actually runs.
    select 1 from public.scheduled_sms
    where status = 'processing' and claimed_at < now() - interval '30 minutes'
  ) then
    return;
  end if;

  perform net.http_post(
    url     := rtrim(v_base_url, '/') || '/api/cron/scheduled-sms',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_cron_secret
    ),
    body    := '{}'::jsonb,
    -- Shorter than the 30-minute stuck-row threshold by a wide margin, so a
    -- hung request is abandoned long before its rows become recoverable.
    timeout_milliseconds := 60000
  );
end;
$$;

revoke execute on function public.trigger_scheduled_sms() from public, anon, authenticated;

-- Idempotent (re)scheduling: unschedule first so re-running this migration
-- updates the interval instead of stacking duplicate jobs.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'scheduled-sms-worker') then
    perform cron.unschedule('scheduled-sms-worker');
  end if;

  -- Every 15 minutes. A follow-up SMS arriving at 14:12 instead of 14:00 is
  -- not materially different to the recipient, and a lower tick rate means
  -- fewer wasted wake-ups than the 5-minute Vercel schedule this replaces.
  perform cron.schedule(
    'scheduled-sms-worker',
    '*/15 * * * *',
    $job$ select public.trigger_scheduled_sms(); $job$
  );
end $$;

comment on function public.trigger_scheduled_sms() is
  'Heartbeat for the scheduled-SMS queue, invoked by the pg_cron job '
  '"scheduled-sms-worker". POSTs to /api/cron/scheduled-sms; all claiming and '
  'delivery logic lives in the application worker, not here. Reads app_base_url '
  'and cron_secret from Vault.';
