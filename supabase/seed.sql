-- ===========================================================================
-- SANDBOX ONLY. Never copy anything from this file into supabase/migrations/.
--
-- The Supabase CLI runs this file after the migrations on the local stack
-- ("supabase start" on a fresh volume, "supabase db reset --local"). It ALSO
-- runs under "supabase db push --include-seed", and this repo is linked to the
-- PRODUCTION project (supabase/.temp/project-ref), so that command would run it
-- against the live database: unschedule the scheduled-sms-worker, install the
-- sandbox_* functions and truncate every patient, booking and log. Feeding it
-- to any other client pointed at a remote database ("psql -f supabase/seed.sql",
-- a GUI "run script") would do the same.
--
-- The whole file is ONE statement: a single DO block whose first act is the
-- guard. A refusal therefore aborts everything, whatever the client does next.
-- As separate statements, a client that keeps going after an error (plain
-- "psql -f" without ON_ERROR_STOP, many GUI script runners) would print the
-- refusal and then still unschedule the cron job and install the functions.
-- Do not split it back up, and do not add anything after the DO block.
--
-- The guard is a backstop, not a permission: never run "db push" (with or
-- without --include-seed), "config push", or this file against anything but
-- the local stack. A function copied from here into a migration would also
-- ship sandbox_reset() to production, guard or not.
--
-- What it provides (see docs/sandbox.md):
--   * a deterministic follow-up config: 5/14/90/180/365 days, dry run on
--   * sandbox_advance_days(n): time travel by shifting stored time back n days
--   * sandbox_reset(): wipe application data and insert a synthetic cohort
-- ===========================================================================

do $seed$
declare
  v_detail text;
begin
  -- -------------------------------------------------------------------------
  -- The real-data check. Created first and called straight away as the seed's
  -- own guard, so the seed and the sandbox_* functions can never disagree on
  -- what counts as real data. If it refuses, this whole statement rolls back,
  -- the function included: nothing is left behind on the refused database.
  --
  -- Every sandbox_* function that writes calls it first as well. The seed
  -- guard only protects the moment of seeding; this keeps the functions
  -- refusing if they ever end up on a database that has (or later gains) real
  -- data, e.g. copied into a migration or run by hand.
  --
  -- Mostly an allow-list rather than a list of bad signs: every public base
  -- table is enumerated from the catalog, the few the sandbox writes to must
  -- hold only what the sandbox writes, and any other table must be empty. A
  -- table added by a later migration is therefore refused until someone
  -- decides the sandbox may own its rows. The signals are independent, so
  -- production refuses even when several stop holding there (no patients left
  -- after a purge, no provider ids, no Vault secrets).
  --
  -- Plain queries whose errors propagate: a missing table or a permission
  -- error aborts the caller, which is also a refusal. Only the Vault check may
  -- be skipped, because Vault can be absent or unreadable, and it runs last so
  -- skipping it never skips the others.
  --
  -- Security definer so the checks see what the owner sees rather than what
  -- the calling role sees: a service_role caller that cannot read Vault or a
  -- table must not make the check pass by default.
  -- -------------------------------------------------------------------------
  create or replace function public.sandbox_assert_local()
    returns void
    language plpgsql
    security definer
    set search_path = public
  as $fn$
  declare
    -- PTS's fiction range 070-1740605 to 070-1740699, in the two shapes the
    -- sandbox writes (national and E.164). sandbox_add_patient only ever uses
    -- it, so a phone outside it is a real person's.
    c_fiction_phone constant text := '^(\+46|0)7017406(0[5-9]|[1-9][0-9])$';
    v_signal text;
    v_vault  boolean := false;
    v_found  boolean;
    r        record;
  begin
    if exists (select 1 from public.patients where source is distinct from 'sandbox') then
      v_signal := 'public.patients has rows whose source is not ''sandbox''';
    elsif exists (select 1 from public.bookings where source is distinct from 'sandbox') then
      v_signal := 'public.bookings has rows whose source is not ''sandbox''';
    elsif exists (
      -- The sandbox only dry-runs, so it writes dry_run, skipped and
      -- cycle_reset rows, always for a patient. A provider id or sent_at is an
      -- SMS that really left, and pending/unknown/sent/delivered/failed are
      -- real send attempts: the webhook provider can leave provider_message_id
      -- null, so the status is checked too. A log without a patient is one
      -- whose patient was deleted, which the sandbox never does.
      select 1 from public.reminder_logs
      where provider_message_id is not null
         or sent_at is not null
         or status is null
         or status not in ('dry_run', 'skipped', 'cycle_reset')
         or patient_id is null
    ) then
      v_signal := 'public.reminder_logs has a row the sandbox never writes (a real send, send attempt or orphaned log)';
    elsif exists (
      -- A sandbox test schedules a row, which the dry-run worker completes as
      -- dry_run (or cancels or skips). sent/failed/unknown are real attempts.
      select 1 from public.scheduled_sms
      where status is null
         or status not in ('pending', 'processing', 'dry_run', 'cancelled', 'skipped')
         or patient_id is null
    ) then
      v_signal := 'public.scheduled_sms has a row the sandbox never writes (a real send or orphaned row)';
    elsif exists (
      -- Dry run is on after every reset and no sandbox test turns it off; a
      -- live clinic runs with it off. The link/name pair is either the
      -- sandbox's or migration 009's untouched default (a fresh database,
      -- just before the seed rewrites it). A clinic with its own link is not.
      select 1 from public.reminder_settings
      where dry_run_mode is not true
         or (booking_link, clinic_name) not in (
              ('https://sandbox.invalid/boka', 'Sandbox-kliniken'),
              ('https://bokat.se/osteopaticentrum', 'Osteopaticentrum')
            )
    ) then
      v_signal := 'public.reminder_settings is live (dry run off) or has a booking link/clinic name the sandbox never sets';
    elsif exists (select 1 from public.daily_snapshots where dry_run_mode is not true) then
      v_signal := 'public.daily_snapshots has a run taken with dry run off';
    end if;

    -- Every other table must be empty: the sandbox never writes incoming_sms,
    -- review_items or sms_conversions (conversions need a sent SMS, review
    -- items a failed or uncertain one), and a table from a later migration is
    -- unknown until listed here. pg_class rather than information_schema,
    -- which hides tables the current role has no privilege on.
    if v_signal is null then
      for r in
        select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and c.relname not in (
            'patients', 'bookings', 'reminder_logs', 'scheduled_sms',
            'daily_snapshots', 'reminder_settings'
          )
        order by c.relname
      loop
        execute format('select exists (select 1 from public.%I)', r.relname) into v_found;
        if v_found then
          v_signal := format('public.%I has rows, and the sandbox never writes to it', r.relname);
          exit;
        end if;
      end loop;
    end if;

    -- Every text column named like a phone number, in every public table:
    -- anything outside the fiction range is a real person's number.
    if v_signal is null then
      for r in
        select c.relname, a.attname
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and a.attnum > 0
          and not a.attisdropped
          and a.attname like '%phone%'
          and a.atttypid in ('text'::regtype, 'varchar'::regtype)
        order by c.relname, a.attname
      loop
        execute format(
          'select exists (select 1 from public.%I where %I <> '''' and %I !~ %L)',
          r.relname, r.attname, r.attname, c_fiction_phone
        ) into v_found;
        if v_found then
          v_signal := format('public.%I.%I has a phone number outside the fiction range', r.relname, r.attname);
          exit;
        end if;
      end loop;
    end if;

    -- The Vault secrets production's pg_cron heartbeat (020) reads. The local
    -- stack never has them.
    if v_signal is null and to_regclass('vault.secrets') is not null then
      begin
        -- Dynamic so a database without Vault never has to resolve the name.
        execute $q$select exists (
          select 1 from vault.secrets where name in ('app_base_url', 'cron_secret')
        )$q$ into v_vault;
      exception when insufficient_privilege then
        v_vault := false;
      end;
      if v_vault then
        v_signal := 'vault.secrets holds app_base_url or cron_secret (production pg_cron config)';
      end if;
    end if;

    if v_signal is not null then
      raise exception 'sandbox refused: this database holds real data — the sandbox_* functions are local-only'
        using detail = v_signal,
              hint = 'On the local sandbox, a test that left non-sandbox rows behind is cleared by "npm run sandbox:reset".';
    end if;
  end;
  $fn$;

  -- -------------------------------------------------------------------------
  -- The guard. Nothing below may run before it, not even the cron unschedule.
  -- Only the check's own refusal is re-raised under the seed's name; any other
  -- error (a missing table, a permission error) propagates as it is, which
  -- also aborts the seed.
  -- -------------------------------------------------------------------------
  begin
    perform public.sandbox_assert_local();
  exception when raise_exception then
    get stacked diagnostics v_detail = pg_exception_detail;
    raise exception 'sandbox seed refused: this database holds real data — seed.sql is local-only'
      using detail = v_detail,
            hint = 'Only "npm run sandbox:reset" (supabase db reset --local) may run seed.sql. '
                   'Never run "supabase db push --include-seed", or seed.sql through psql or any '
                   'other client, against a remote database.';
  end;

  -- -------------------------------------------------------------------------
  -- The pg_cron heartbeat from migration 020 POSTs to whatever app_base_url
  -- the local Vault holds. Nothing sets it here, so every tick would just
  -- raise; but a developer who copies production Vault values into the
  -- sandbox would get a local database waking the live app. The heartbeat has
  -- no effect on the data itself (claiming happens in the app), so removing it
  -- loses nothing the sandbox tests exercise.
  -- -------------------------------------------------------------------------
  if to_regclass('cron.job') is not null
     and exists (select 1 from cron.job where jobname = 'scheduled-sms-worker') then
    perform cron.unschedule('scheduled-sms-worker');
  end if;

  -- -------------------------------------------------------------------------
  -- Settings. Fixed step ids so tests and log rows can name a step without
  -- reading the settings first. Kept in a function because sandbox_reset()
  -- must restore them: a test that flips dry_run_mode off must never leak that
  -- into the next test.
  -- -------------------------------------------------------------------------
  create or replace function public.sandbox_apply_settings()
    returns void
    language plpgsql
    security definer
    set search_path = public
  as $fn$
  begin
    perform public.sandbox_assert_local();

    -- Migration 009 guarantees a row; guard anyway so a hand-emptied table
    -- does not leave the engine falling back to its 30/60/90 legacy defaults.
    if not exists (select 1 from public.reminder_settings) then
      insert into public.reminder_settings default values;
    end if;

    update public.reminder_settings
    set
      sms_steps = '[
        {"id": "5a4db0c5-0000-4000-8000-000000000005", "day": 5,   "active": true,
         "template": "Hej {{firstName}}! 5 dagar sedan besöket. Boka: {{bookingLink}}"},
        {"id": "5a4db0c5-0000-4000-8000-000000000014", "day": 14,  "active": true,
         "template": "Hej {{firstName}}! 14 dagar sedan besöket. Boka: {{bookingLink}}"},
        {"id": "5a4db0c5-0000-4000-8000-000000000090", "day": 90,  "active": true,
         "template": "Hej {{firstName}}! 90 dagar sedan besöket. Boka: {{bookingLink}}"},
        {"id": "5a4db0c5-0000-4000-8000-000000000180", "day": 180, "active": true,
         "template": "Hej {{firstName}}! 180 dagar sedan besöket. Boka: {{bookingLink}}"},
        {"id": "5a4db0c5-0000-4000-8000-000000000365", "day": 365, "active": true,
         "template": "Hej {{firstName}}! 365 dagar sedan besöket. Boka: {{bookingLink}}"}
      ]'::jsonb,
      -- .invalid is reserved (RFC 2606): even a rendered link can never resolve.
      booking_link = 'https://sandbox.invalid/boka',
      clinic_name  = 'Sandbox-kliniken',
      dry_run_mode = true,
      is_active    = true,
      max_per_day  = 25,
      allow_same_number_override = false,
      updated_at   = now()
    where true;
  end;
  $fn$;

  -- -------------------------------------------------------------------------
  -- Time travel.
  --
  -- Moving both clocks (JS Date.now() in the engine, Postgres now() in SQL)
  -- forward n days is equivalent to moving every stored instant back n days,
  -- and the second needs no clock mocking in two runtimes. Columns are
  -- enumerated from the catalog rather than listed so a table or column added
  -- by a later migration cannot silently stay behind -- a forgotten column
  -- would read as "moved into the future" and skew exactly the comparisons
  -- under test.
  --
  -- Deliberately NOT done here:
  --   * refresh_patient_booking_metadata(): production never recomputes
  --     last_booking_at when time passes, only on writes. Refreshing here
  --     would hide the behaviour the sandbox exists to show (R4).
  --   * jsonb payloads (bookings.raw_data etc.) keep their original
  --     timestamps. No engine path reads time out of them; rewriting them
  --     would mean parsing vendor payloads for a fidelity nothing consumes.
  --   * Disabling triggers: the application schema has no user triggers (none
  --     of 001-026 creates one), no check constraint mentions a timestamp, and
  --     a uniform shift preserves every unique index, so nothing needs
  --     suspending.
  -- -------------------------------------------------------------------------
  create or replace function public.sandbox_advance_days(p_days integer)
    returns void
    language plpgsql
    security definer
    set search_path = public
  as $fn$
  declare
    r record;
  begin
    perform public.sandbox_assert_local();

    if p_days is null then
      raise exception 'sandbox_advance_days: p_days is required';
    end if;

    for r in
      select
        c.table_name,
        string_agg(
          case
            when c.data_type = 'date'
              then format('%1$I = %1$I - %2$s', c.column_name, p_days)
            else format('%1$I = %1$I - make_interval(days => %2$s)', c.column_name, p_days)
          end,
          ', '
        ) as assignments
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public'
        and t.table_type = 'BASE TABLE'
        and c.data_type in (
          'timestamp with time zone',
          'timestamp without time zone',
          'date'
        )
      group by c.table_name
    loop
      -- "where true": PostgREST sessions load pg-safeupdate, which rejects an
      -- UPDATE without a WHERE clause even inside a function.
      execute format('update public.%I set %s where true', r.table_name, r.assignments);
    end loop;
  end;
  $fn$;

  -- -------------------------------------------------------------------------
  -- One synthetic patient with one attended visit.
  --
  -- Ids are derived from p_key so every run produces the same rows and a test
  -- can address a patient without querying for it:
  --   patient  00000000-5a4d-4000-8000-<key, 12 digits>
  --   booking  00000000-b00c-4000-8000-<key, 12 digits>
  --
  -- Phone numbers come from the range PTS reserves for fiction, 070-1740605
  -- to 070-1740699, so even a send that slipped past every other guard could
  -- not reach a subscriber. p_phone_index (0-94) picks one; the unique index
  -- on normalized_phone means each patient needs its own.
  --
  -- The visit instant is a parameter rather than "n hours ago" because the
  -- engine measures elapsed time with the JS clock: a test that computes the
  -- instant itself is immune to drift between the host and the Docker VM.
  -- -------------------------------------------------------------------------
  create or replace function public.sandbox_add_patient(
    p_key         integer,
    p_phone_index integer,
    p_visit_at    timestamptz,
    p_label       text
  )
    returns uuid
    language plpgsql
    security definer
    set search_path = public
  as $fn$
  declare
    v_pid      uuid;
    v_national text;
    v_e164     text;
  begin
    perform public.sandbox_assert_local();

    if p_phone_index is null or p_phone_index < 0 or p_phone_index > 94 then
      raise exception 'sandbox_add_patient: p_phone_index % is outside the 95-number fiction range', p_phone_index;
    end if;

    v_pid      := ('00000000-5a4d-4000-8000-' || lpad(p_key::text, 12, '0'))::uuid;
    v_national := '0701740' || (605 + p_phone_index)::text;
    v_e164     := '+46701740' || (605 + p_phone_index)::text;

    insert into public.patients (
      id, full_name, first_name, last_name, phone, normalized_phone,
      has_future_booking, do_not_contact, source, created_at, updated_at
    ) values (
      v_pid,
      'Sandbox ' || p_label,
      'Sandbox',
      p_label,
      v_national,
      v_e164,
      false, false, 'sandbox',
      p_visit_at - interval '14 days',
      p_visit_at - interval '14 days'
    );

    -- Booked two weeks ahead, like a typical online booking: created_at is
    -- when the record entered the system, which isStaleScheduledSend compares.
    insert into public.bookings (
      id, external_booking_id, patient_id, patient_name, phone, normalized_phone,
      booking_at, booking_date, treatment, service_name, status, cancelled,
      source, event_created_at, created_at, updated_at
    ) values (
      ('00000000-b00c-4000-8000-' || lpad(p_key::text, 12, '0'))::uuid,
      'sandbox-visit-' || p_key,
      v_pid,
      'Sandbox ' || p_label,
      v_national,
      v_e164,
      p_visit_at, p_visit_at, 'Sandbox-behandling', 'Sandbox-behandling', 'Booked', false,
      'sandbox',
      p_visit_at - interval '14 days',
      p_visit_at - interval '14 days',
      p_visit_at - interval '14 days'
    );

    -- The production definition of last_booking_at (022), not a hand-set
    -- value: a visit still ahead leaves the column null, exactly as for a
    -- real patient.
    perform public.refresh_patient_booking_metadata(v_pid);
    return v_pid;
  end;
  $fn$;

  -- The database clock, so a test can refuse to run when the Docker VM has
  -- drifted from the host (WSL2 VMs are known to after the host sleeps):
  -- seeding and the claim function use this clock, the engine uses the JS one.
  create or replace function public.sandbox_now()
    returns timestamptz
    language sql
    stable
  as $fn$ select now() $fn$;

  -- -------------------------------------------------------------------------
  -- Synthetic cohort.
  --
  -- One patient per age in days since the last visit. The ages straddle every
  -- step boundary (4/5/6, 13/14/15, 89/90/91, 179/180, 364/365) plus a few
  -- mid-gap values, so one cron run shows which step each position gets. The
  -- visit is at 11:00 UTC on that day -- after the 08:00 UTC production cron
  -- -- so the "day N" vs "120 elapsed hours" question (R2) shows up in the
  -- data rather than being hidden by a midnight timestamp.
  --
  -- The key is the age; the phone index is the age's position in the array,
  -- so src/test/sandbox/followups.sandbox.ts must keep the same array in the
  -- same order.
  -- -------------------------------------------------------------------------
  create or replace function public.sandbox_reset()
    returns void
    language plpgsql
    security definer
    set search_path = public
  as $fn$
  declare
    v_tables text;
    v_ages   integer[] := array[
      0, 3, 4, 5, 6, 9, 10, 13, 14, 15, 16, 60, 89, 90, 91, 179, 180, 200, 364, 365, 400
    ];
    v_i      integer;
  begin
    -- Before the truncate: this is the call that would erase a real clinic.
    perform public.sandbox_assert_local();

    -- Every application table except the settings row, enumerated for the
    -- same reason as in sandbox_advance_days. One TRUNCATE covers the foreign
    -- keys between them, so no CASCADE (which could reach outside this list).
    select string_agg(format('public.%I', table_name), ', ')
    into v_tables
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
      and table_name <> 'reminder_settings';

    if v_tables is not null then
      execute 'truncate ' || v_tables;
    end if;

    perform public.sandbox_apply_settings();

    -- Anchored on the database's UTC date. The tests derive every expectation
    -- from the stored timestamps rather than from today's date, so a reset
    -- just before 00:00 UTC and a run just after it still agree. Age 0 before
    -- 11:00 UTC has its visit still ahead and so no last_booking_at.
    for v_i in 1 .. array_length(v_ages, 1) loop
      perform public.sandbox_add_patient(
        v_ages[v_i],
        v_i - 1,
        ((now() at time zone 'utc')::date - v_ages[v_i] + time '11:00') at time zone 'utc',
        'Dag ' || v_ages[v_i]
      );
    end loop;
  end;
  $fn$;

  -- Service role only: these rewrite or erase every row. anon/authenticated
  -- could otherwise call them through PostgREST with the public key.
  -- sandbox_assert_local() included: it reads Vault and every table as its
  -- owner, so it is not something anon should be able to probe either.
  revoke execute on function public.sandbox_assert_local() from public, anon, authenticated;
  revoke execute on function public.sandbox_apply_settings() from public, anon, authenticated;
  revoke execute on function public.sandbox_advance_days(integer) from public, anon, authenticated;
  revoke execute on function public.sandbox_add_patient(integer, integer, timestamptz, text) from public, anon, authenticated;
  revoke execute on function public.sandbox_now() from public, anon, authenticated;
  revoke execute on function public.sandbox_reset() from public, anon, authenticated;
  grant execute on function public.sandbox_assert_local() to service_role;
  grant execute on function public.sandbox_apply_settings() to service_role;
  grant execute on function public.sandbox_advance_days(integer) to service_role;
  grant execute on function public.sandbox_add_patient(integer, integer, timestamptz, text) to service_role;
  grant execute on function public.sandbox_now() to service_role;
  grant execute on function public.sandbox_reset() to service_role;

  perform public.sandbox_reset();
end $seed$;
