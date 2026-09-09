-- Retire the position-keyed duplicate guard from 013.
--
-- Prerequisite: the code that writes reminder_logs.step_id on every
-- reservation (Deploy B) is live and has been observed writing it:
--
--   select count(*) from public.reminder_logs
--   where status in ('pending','unknown','sent','dry_run','delivered')
--     and step_id is null and created_at > '<Deploy B timestamp>';   -- must be 0
--
-- Rows written by the OLD code between 025 and Deploy B are backfilled below
-- (same statement as 025, idempotent) so nothing loses its guard when the old
-- indexes go.
--
-- Why drop at all: with steps identified by id, the position-keyed indexes
-- produce false collisions the moment sorted positions shift -- delete the
-- day-14 step, or edit day-5 to day-100, and day-90 becomes position 2; a
-- correct day-90 send is then written with the position an old day-14 row
-- holds, and the patient is blocked for the cycle with a bogus "Redan
-- reserverad av parallell förfrågan". Once this has run, steps may be added,
-- removed, and re-timed freely.

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

drop index if exists public.reminder_logs_booking_seq_idx;
drop index if exists public.reminder_logs_null_booking_seq_idx;

-- sequence_number itself stays: it is informational for the UI and is what
-- mark_pending_unknown (013) puts in review-item titles.
