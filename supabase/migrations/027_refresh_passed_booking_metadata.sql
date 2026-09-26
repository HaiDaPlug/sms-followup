-- Move last_booking_at forward once a booked appointment has passed.
--
-- Why: patients.last_booking_at is recomputed only when something writes to
-- the patient (the booking RPCs, the CSV import). A webhook rebooking for a
-- FUTURE appointment runs refresh_patient_booking_metadata while that
-- appointment is still upcoming, and 022 deliberately excludes future
-- bookings, so the column keeps pointing at the previous visit. When the
-- appointment passes nothing writes to the patient again, and the engine
-- anchors the new cycle (the RPC already wrote its cycle_reset) on the OLD
-- visit:
--
--   * the 5-day SMS goes out the morning after the new visit, or the 14-day
--     one a few days after it;
--   * steps already sent against the old booking are picked again and collide
--     on the 025 unique index every day ("Redan reserverad av parallell
--     förfrågan"), each collision using one of the day's max_per_day slots;
--   * a patient created from the review queue before their first visit keeps
--     last_booking_at = null and never gets a follow-up.
--
-- Pinned by the R4 scenarios in src/lib/reminders/simulation/ and the R4 test
-- in src/test/sandbox/followups.sandbox.ts.
--
-- Fix: one sweep the daily cron runs before it reads the store. It touches only
-- patients who have a past, non-cancelled booking newer than their stored
-- last_booking_at (or have none stored), and refreshes them through
-- refresh_patient_booking_metadata() -- the same function every other writer
-- uses, so the column still has exactly one definition. It never moves the
-- column backwards: going back after a cancellation remains the cancel RPC's
-- job, as before.
--
-- Additive and re-runnable. DEPLOY ORDER: apply before the code that calls it
-- (processDailyReminders). That code fails the run on a missing function
-- rather than sending against stale anchors.
--
-- Verification (SQL editor, after db push):
--
--   select public.refresh_passed_booking_metadata();   -- patients moved forward
--
--   select count(*) from public.patients p
--   where exists (
--     select 1 from public.bookings b
--     where b.patient_id = p.id and b.cancelled = false
--       and b.booking_at <= now()
--       and (p.last_booking_at is null or b.booking_at > p.last_booking_at)
--   );                                                  -- 0 straight after

create or replace function public.refresh_passed_booking_metadata()
  returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_patient_id uuid;
  v_count      integer := 0;
begin
  for v_patient_id in
    select p.id
    from public.patients p
    where exists (
      select 1
      from public.bookings b
      where b.patient_id = p.id
        and b.cancelled = false
        and b.booking_at is not null
        and b.booking_at <= now()
        and (p.last_booking_at is null or b.booking_at > p.last_booking_at)
    )
  loop
    perform public.refresh_patient_booking_metadata(v_patient_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.refresh_passed_booking_metadata() is
  'Refreshes last_booking_at/latest_treatment for every patient whose newest '
  'past, non-cancelled booking is newer than the stored value. Called by the '
  'daily cron so a rebooked appointment becomes the anchor once it has passed.';

revoke execute on function public.refresh_passed_booking_metadata() from public, anon, authenticated;
grant execute on function public.refresh_passed_booking_metadata() to service_role;
