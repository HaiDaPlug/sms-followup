-- Stable identity for follow-up steps.
--
-- Why: reminder_logs.sequence_number is a 1-based POSITION into
-- reminder_settings.sms_steps sorted by day. Every reader resolves it
-- positionally and the duplicate-send guard from 013 is keyed on it. That is
-- only sound while the step list never changes shape. Insert a step in the
-- middle or delete one and every later position shifts: an old log row
-- silently describes a different message, and a fresh send can collide with a
-- row that belonged to a different step (false 23505) or fail to collide with
-- one that was the same step (duplicate send).
--
-- Fix: give each step an immutable uuid inside the jsonb, snapshot that id and
-- the step's trigger day onto every log row, and key the guard on the id.
--
-- Everything here is additive and re-runnable.
--   1. Assign id (and active = true) to every sms_steps element lacking one.
--      No-op for elements that already carry an id (the settings route from
--      Deploy A may have minted them). Element ORDER is preserved so
--      not-yet-redeployed engine code keeps resolving positions correctly.
--      PREREQUISITE: Deploy A must be live, otherwise a Settings save from the
--      old UI replaces sms_steps wholesale and strips these ids while
--      reminder_logs already references them.
--   2. Add reminder_logs.step_id / step_day and scheduled_sms.step_id, nullable.
--   3. Backfill both from position, using the settings row getSettings() reads.
--      ASSUMPTIONS: the day order of sms_steps has not changed since 010
--      (009 seeded 5/10/90/180/365; 010 changed 10 -> 14 in place), and no
--      positional log predates 009. Verification below checks both.
--   4. New unique indexes keyed on step_id, same predicate as 013. The 013
--      indexes are KEPT: until the new code is deployed, old code inserts rows
--      without step_id and only the old indexes protect those. 026 drops them.
--      Between this migration and 026, do NOT add, delete, reorder, or change
--      the trigger day of any step -- any of those shifts sorted positions and
--      lets a correct day-based send collide on the position-keyed index.
--      Template text (and, after Deploy B, the active flag) may change.
--   5. skip_reason 'step_removed' for sends whose step no longer exists.
--
-- DEPLOY ORDER: Deploy A (id-preserving settings route) -> THIS -> Deploy B
-- (code that writes step_id; PGRST204 otherwise fails every send and marks
-- claimed scheduled rows 'unknown') -> 026 the same day.
-- After applying, confirm the REST layer sees the column before Deploy B.
--
-- Verification (SQL editor, after db push):
--
--   select count(*) from public.reminder_settings;                    -- 1
--
--   select e.ord, e.elem->>'id' id, e.elem->>'day' day, e.elem->>'active' active
--   from public.reminder_settings,
--        jsonb_array_elements(sms_steps) with ordinality e(elem, ord)
--   order by e.ord;                                  -- 5 rows, all ids, all true
--
--   select
--     count(*) filter (where sequence_number is not null)                     as with_seq,
--     count(*) filter (where step_id is not null)                             as with_step,
--     count(*) filter (where sequence_number is not null and step_id is null) as unmapped,  -- 0
--     count(*) filter (where is_cycle_reset)                                  as cycle_resets,
--     min(created_at) filter (where sequence_number is not null)              as oldest_positional_log
--   from public.reminder_logs;              -- oldest_positional_log after 009 was applied
--
--   select sequence_number, count(distinct step_id) steps, min(step_day) day
--   from public.reminder_logs where sequence_number is not null
--   group by 1 order by 1;                                       -- steps = 1 per row
--
--   select
--     count(*) filter (where sequence_override is not null)                                  with_seq,
--     count(*) filter (where step_id is not null)                                            with_step,
--     count(*) filter (where status in ('pending','processing') and step_id is null)         active_unmapped  -- 0
--   from public.scheduled_sms;
--
--   select indexname from pg_indexes where tablename = 'reminder_logs'
--     and (indexname like 'reminder_logs_%seq%' or indexname like 'reminder_logs_%step%');   -- 4
--
--   select pg_get_constraintdef(oid) from pg_constraint
--   where conname = 'reminder_logs_skip_reason_check';           -- includes step_removed

-- ---------------------------------------------------------------------------
-- 1. ids + active, element order preserved. gen_random_uuid() is volatile, so
--    it is evaluated once per element.
-- ---------------------------------------------------------------------------

update public.reminder_settings
set sms_steps = (
  select jsonb_agg(
    e.elem
      || case when e.elem ? 'id'     then '{}'::jsonb else jsonb_build_object('id', gen_random_uuid()::text) end
      || case when e.elem ? 'active' then '{}'::jsonb else '{"active": true}'::jsonb end
    order by e.ord
  )
  from jsonb_array_elements(sms_steps) with ordinality as e(elem, ord)
)
where sms_steps is not null
  and jsonb_typeof(sms_steps) = 'array'
  and exists (
    select 1 from jsonb_array_elements(sms_steps) as x(elem)
    where not (x.elem ? 'id') or not (x.elem ? 'active')
  );

-- ---------------------------------------------------------------------------
-- 2. snapshot columns
-- ---------------------------------------------------------------------------

alter table public.reminder_logs
  add column if not exists step_id  uuid,
  add column if not exists step_day integer;

alter table public.scheduled_sms
  add column if not exists step_id uuid;

comment on column public.reminder_logs.step_id is
  'Immutable id of the sms_steps element this row reserved/sent. Null on cycle_reset, test sends, and rows written before 025.';
comment on column public.reminder_logs.step_day is
  'Trigger day of that step at send time. Survives deletion of the step so it can still bound ordering and be labelled in analytics.';
comment on column public.scheduled_sms.step_id is
  'Step chosen or resolved when the job was created. sequence_override is kept as the position at creation time.';

-- ---------------------------------------------------------------------------
-- 3. backfill from position. Re-runnable (where step_id is null); cycle_reset
--    rows have null sequence_number and are skipped by the predicate.
--    Position = row_number over (day asc, original order) -- the same order
--    resolveSteps() produces.
-- ---------------------------------------------------------------------------

with settings as (
  select sms_steps from public.reminder_settings
  where sms_steps is not null and jsonb_typeof(sms_steps) = 'array'
  order by updated_at desc limit 1
),
positioned as (
  select (e.elem->>'id')::uuid as step_id, (e.elem->>'day')::integer as step_day,
         row_number() over (order by (e.elem->>'day')::integer, e.ord) as position
  from settings s cross join jsonb_array_elements(s.sms_steps) with ordinality as e(elem, ord)
)
update public.reminder_logs l
set step_id = p.step_id, step_day = p.step_day
from positioned p
where l.step_id is null and l.sequence_number is not null and l.sequence_number = p.position;

with settings as (
  select sms_steps from public.reminder_settings
  where sms_steps is not null and jsonb_typeof(sms_steps) = 'array'
  order by updated_at desc limit 1
),
positioned as (
  select (e.elem->>'id')::uuid as step_id,
         row_number() over (order by (e.elem->>'day')::integer, e.ord) as position
  from settings s cross join jsonb_array_elements(s.sms_steps) with ordinality as e(elem, ord)
)
update public.scheduled_sms s
set step_id = p.step_id
from positioned p
where s.step_id is null and s.sequence_override is not null and s.sequence_override = p.position;

-- ---------------------------------------------------------------------------
-- 4. duplicate guard keyed on step id. Same predicate as 013 so pending
--    reservations, uncertain sends, and dry runs all hold the slot. The 013
--    indexes stay in place until 026 (see header).
-- ---------------------------------------------------------------------------

create unique index if not exists reminder_logs_booking_step_idx
  on public.reminder_logs (patient_id, booking_id, step_id)
  where status in ('pending', 'unknown', 'sent', 'dry_run', 'delivered')
    and booking_id is not null
    and step_id is not null;

create unique index if not exists reminder_logs_null_booking_step_idx
  on public.reminder_logs (patient_id, step_id)
  where status in ('pending', 'unknown', 'sent', 'dry_run', 'delivered')
    and booking_id is null
    and step_id is not null;

-- ---------------------------------------------------------------------------
-- 5. skip_reason: full list from 024 plus step_removed
-- ---------------------------------------------------------------------------

alter table public.reminder_logs
  drop constraint if exists reminder_logs_skip_reason_check;

alter table public.reminder_logs
  add constraint reminder_logs_skip_reason_check
  check (
    skip_reason in (
      'future_booking',
      'missing_phone',
      'do_not_contact',
      'needs_review',
      'no_valid_booking',
      'waiting',
      'unresolved_placeholder',
      'sequence_complete',
      'delivery_pending',
      'stale_cycle',
      'out_of_order',
      'step_removed'
    )
  );
