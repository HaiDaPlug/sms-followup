-- Enable row level security on every application table.
--
-- Why this matters: NEXT_PUBLIC_SUPABASE_ANON_KEY ships to every browser by
-- design -- RLS is what makes that safe. Without it, anyone who opens devtools
-- on the app can take that key plus the project URL and read patients,
-- bookings and reminder_logs straight from the REST API, bypassing the Next.js
-- middleware entirely. That is every customer name, phone number and message
-- body: a GDPR exposure, not just a hygiene issue.
--
-- Why this is safe to turn on:
--   * Every write path and almost every read path uses the SERVICE ROLE key
--     (src/lib/supabase/client.ts), which bypasses RLS entirely. Those are
--     unaffected by this migration.
--   * The ONLY anon-key data reader is getAnalyticsData (via
--     createSupabaseServer), which runs as the logged-in user. It needs the
--     four read policies below; without them the analytics page would silently
--     render zeros rather than erroring.
--
-- Failure mode to watch for: a missing policy does not raise -- it returns
-- zero rows. After applying, load /app/analytics and confirm real numbers.

-- ---------------------------------------------------------------------------
-- 1. Enable RLS everywhere. With RLS on and no policy, a table is readable
--    only by the service role. That is the correct default for every table
--    the browser-facing key has no business touching.
-- ---------------------------------------------------------------------------

alter table public.patients          enable row level security;
alter table public.bookings          enable row level security;
alter table public.reminder_settings enable row level security;
alter table public.reminder_logs     enable row level security;
alter table public.review_items      enable row level security;
alter table public.daily_snapshots   enable row level security;
alter table public.incoming_sms      enable row level security;
alter table public.scheduled_sms     enable row level security;
alter table public.sms_conversions   enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Read policies for the analytics page only.
--
--    Scoped to the "authenticated" role, never "anon": a signed-in staff
--    member can already see this data in the UI, so direct read access grants
--    them nothing new. An anonymous holder of the public key gets nothing.
--
--    SELECT only. Every write in this app goes through the service role, so
--    no insert/update/delete policy is needed by any code path -- and not
--    granting one means a stolen session cannot mutate data through the REST
--    API either.
-- ---------------------------------------------------------------------------

drop policy if exists "authenticated read patients"        on public.patients;
drop policy if exists "authenticated read bookings"        on public.bookings;
drop policy if exists "authenticated read reminder_logs"   on public.reminder_logs;
drop policy if exists "authenticated read sms_conversions" on public.sms_conversions;

create policy "authenticated read patients"
  on public.patients for select to authenticated using (true);

create policy "authenticated read bookings"
  on public.bookings for select to authenticated using (true);

create policy "authenticated read reminder_logs"
  on public.reminder_logs for select to authenticated using (true);

create policy "authenticated read sms_conversions"
  on public.sms_conversions for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Revoke the blanket table grants the anon role holds by default.
--
--    RLS alone is enough, but defence in depth: if a future migration enables
--    a table without policies being reviewed, or someone disables RLS to debug
--    and forgets to re-enable it, the anon role still has no privilege to fall
--    back on. "authenticated" keeps SELECT so the policies above can apply.
-- ---------------------------------------------------------------------------

revoke all on public.patients          from anon;
revoke all on public.bookings          from anon;
revoke all on public.reminder_settings from anon;
revoke all on public.reminder_logs     from anon;
revoke all on public.review_items      from anon;
revoke all on public.daily_snapshots   from anon;
revoke all on public.incoming_sms      from anon;
revoke all on public.scheduled_sms     from anon;
revoke all on public.sms_conversions   from anon;

-- Tables with no policy above are intentionally left unreadable by the
-- authenticated role too: reminder_settings, review_items, daily_snapshots,
-- incoming_sms and scheduled_sms are only ever read through service-role
-- code paths. Add a policy here if that ever changes -- do not disable RLS.
