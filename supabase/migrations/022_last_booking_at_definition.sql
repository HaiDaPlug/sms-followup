-- One definition of "last_booking_at" for every writer.
--
-- Why: four SQL sites recomputed this column with `where cancelled = false`
-- ordered by booking_at desc, while the CSV import path
-- (src/lib/import/bokadirekt.ts) additionally excluded future bookings. The two
-- definitions disagreed whenever a patient had an upcoming appointment:
--
--   * the RPCs set last_booking_at to the FUTURE booking, which makes
--     daysBetween() in eligibility.ts return a negative number. The "Waiting"
--     status hides this day-to-day, so it was invisible until an import
--     rewrote the column back to the last attended visit and moved the patient
--     by weeks.
--   * latestValidBooking() matches on booking.booking_at === last_booking_at.
--     When the two writers disagreed the match failed, booking_id resolved to
--     null, and the reservation landed on the null-booking unique index
--     (013_outbox_and_cycle_index.sql) instead of the booking-scoped one --
--     i.e. duplicate protection silently changed shape depending on which
--     writer touched the row last.
--
-- The definition: the most recent booking that has already happened and was not
-- cancelled. A future appointment never sets it, which means cancelling that
-- appointment cannot change it either -- the fallback to the previous attended
-- visit is a property of the definition rather than something each cancellation
-- handler has to remember to implement.
--
-- Note on "attended": the schema records cancellations, not attendance, so a
-- no-show is indistinguishable from a completed visit. "Past and not cancelled"
-- is the honest ceiling here.

create or replace function public.patient_last_attended_booking(
  p_patient_id uuid
) returns table (booking_at timestamptz, treatment text)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select b.booking_at, coalesce(b.treatment, b.service_name)
  from public.bookings b
  where b.patient_id = p_patient_id
    and b.cancelled = false
    and b.booking_at is not null
    and b.booking_at <= now()
  order by b.booking_at desc
  limit 1;
$$;

comment on function public.patient_last_attended_booking(uuid) is
  'Single source of truth for a patient''s last attended booking: most recent '
  'non-cancelled booking in the past. Used by every writer of '
  'patients.last_booking_at so they cannot drift apart. Mirrors the filter in '
  'src/lib/import/bokadirekt.ts.';

-- Recompute both metadata columns for one patient using that definition.
create or replace function public.refresh_patient_booking_metadata(
  p_patient_id uuid
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_booking_at timestamptz;
  v_treatment  text;
begin
  if p_patient_id is null then
    return;
  end if;

  select booking_at, treatment
  into v_booking_at, v_treatment
  from public.patient_last_attended_booking(p_patient_id);

  update public.patients
  set
    last_booking_at  = v_booking_at,
    latest_treatment = v_treatment,
    updated_at       = now()
  where id = p_patient_id;
end;
$$;

comment on function public.refresh_patient_booking_metadata(uuid) is
  'Recomputes patients.last_booking_at and latest_treatment from '
  'patient_last_attended_booking(). Call this instead of hand-writing the '
  'query so all writers share one definition.';

-- Cancel any queued scheduled SMS for a patient whose cycle just reset.
--
-- Only 'pending' rows: a 'processing' row may already have reached 46elks, and
-- rewriting it would lose the record of a message that actually went out.
-- claim_due_scheduled_sms (016) sweeps stuck processing rows to 'unknown' on
-- exactly the same reasoning.
create or replace function public.cancel_pending_scheduled_sms(
  p_patient_id uuid,
  p_reason     text default 'Avbruten: patientens cykel återställdes'
) returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_cancelled integer;
begin
  if p_patient_id is null then
    return 0;
  end if;

  with cancelled as (
    update public.scheduled_sms
    set
      status       = 'cancelled',
      completed_at = now(),
      error        = p_reason
    where patient_id = p_patient_id
      and status = 'pending'
    returning 1
  )
  select count(*) into v_cancelled from cancelled;

  return v_cancelled;
end;
$$;

comment on function public.cancel_pending_scheduled_sms(uuid, text) is
  'Cancels queued (pending only, never processing) scheduled SMS for a patient '
  'whose reminder cycle just reset. Called from the booking RPCs inside the '
  'same transaction as the cycle_reset write.';

revoke execute on function public.patient_last_attended_booking(uuid) from public, anon;
revoke execute on function public.refresh_patient_booking_metadata(uuid) from public, anon;
revoke execute on function public.cancel_pending_scheduled_sms(uuid, text) from public, anon;
grant execute on function public.patient_last_attended_booking(uuid) to service_role;
grant execute on function public.refresh_patient_booking_metadata(uuid) to service_role;
grant execute on function public.cancel_pending_scheduled_sms(uuid, text) to service_role;

-- Backfill: correct every patient currently pointing at a future booking.
do $$
declare
  r record;
begin
  for r in select id from public.patients loop
    perform public.refresh_patient_booking_metadata(r.id);
  end loop;
end $$;
