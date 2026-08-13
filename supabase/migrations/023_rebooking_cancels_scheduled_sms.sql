-- Two changes to the booking mutation RPCs, following the established pattern
-- in 017/018: bodies are copied verbatim from their latest definition
-- (apply_bokadirekt_booking from 014, cancel_bokadirekt_booking from 017) with
-- the additions marked NEW.
--
-- Change 1 -- use the shared last_booking_at definition from 022.
--   The hand-written `where cancelled = false order by booking_at desc` blocks
--   included FUTURE bookings, disagreeing with the CSV import path. See 022 for
--   the full rationale.
--
-- Change 2 -- cancel pending scheduled SMS when a booking resets the cycle.
--   Nothing previously cancelled a queued scheduled_sms row when the patient
--   rebooked, so a stale row survived the cycle reset it should not have. When
--   it later fired, processScheduledSms passes forceNext = true and the stored
--   sequence_override, which skips the soft-block check in process.ts -- so a
--   day-180 "we haven't seen you in a while" message could send days AFTER the
--   patient was in the chair, consuming that step's slot in the fresh cycle and
--   corrupting the sequence.
--
--   This runs in the same transaction as the cycle_reset write. Doing it in
--   application code afterwards would leave a window where a reset cycle still
--   has a live scheduled row -- exactly the state that produces the bad send.
--
--   Only 'pending' rows are cancelled, never 'processing': a processing row may
--   have already reached 46elks, and rewriting it would lose the record of a
--   message that actually went out. claim_due_scheduled_sms already sweeps
--   stuck processing rows to 'unknown' on the same reasoning.

create or replace function public.apply_bokadirekt_booking(
  p_patient_id             uuid,
  p_bokadirekt_customer_id text,
  p_full_name              text,
  p_first_name             text,
  p_last_name              text,
  p_phone                  text,
  p_normalized_phone       text,
  p_email                  text,
  p_booking_id_external    text,
  p_booking_at             timestamptz,
  p_service_name           text,
  p_practitioner_name      text,
  p_location_name          text,
  p_price                  integer,
  p_booked_online          boolean,
  p_event_created_at       timestamptz,
  p_raw_data               jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_patient_id        uuid := p_patient_id;
  v_prev_patient_id   uuid;
  v_booking_db_id     uuid;
  v_already_confirmed boolean := false;
  v_existing_customer_id text;
begin
  if p_booking_id_external is null or p_booking_id_external = '' then
    raise exception 'BokaDirekt booking ID is required';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_booking_id_external));

  -- Capture existing booking state for idempotency check and reassignment detection
  select patient_id, (patient_id is not null)
  into v_prev_patient_id, v_already_confirmed
  from public.bookings
  where bokadirekt_booking_id = p_booking_id_external;

  if v_patient_id is null then
    insert into public.patients (
      bokadirekt_customer_id,
      full_name,
      first_name,
      last_name,
      phone,
      normalized_phone,
      email,
      latest_treatment,
      source
    ) values (
      nullif(p_bokadirekt_customer_id, ''),
      p_full_name,
      nullif(p_first_name, ''),
      nullif(p_last_name, ''),
      nullif(p_phone, ''),
      nullif(p_normalized_phone, ''),
      nullif(p_email, ''),
      nullif(p_service_name, ''),
      'bokadirekt_webhook'
    )
    returning id into v_patient_id;
  else
    select bokadirekt_customer_id
    into v_existing_customer_id
    from public.patients
    where id = v_patient_id
    for update;

    if not found then
      raise exception 'Patient % not found', v_patient_id;
    end if;

    if v_existing_customer_id is not null
       and nullif(p_bokadirekt_customer_id, '') is not null
       and v_existing_customer_id <> p_bokadirekt_customer_id then
      raise exception 'Patient % is already linked to a different BokaDirekt customer',
        v_patient_id;
    end if;

    -- Existing identity values are authoritative. Fill blanks, but never
    -- transfer or clear an identity merely because a booking contains new data.
    update public.patients
    set
      bokadirekt_customer_id = coalesce(
        bokadirekt_customer_id,
        nullif(p_bokadirekt_customer_id, '')
      ),
      full_name  = coalesce(nullif(p_full_name, ''),  full_name),
      first_name = coalesce(nullif(p_first_name, ''), first_name),
      last_name  = coalesce(nullif(p_last_name, ''),  last_name),
      normalized_phone = coalesce(normalized_phone, nullif(p_normalized_phone, '')),
      phone = case
        when normalized_phone is null then nullif(p_phone, '')
        else phone
      end,
      email = coalesce(email, nullif(p_email, '')),
      updated_at = now()
    where id = v_patient_id;
  end if;

  insert into public.bookings (
    bokadirekt_booking_id,
    patient_id,
    patient_name,
    phone,
    normalized_phone,
    email,
    booking_at,
    treatment,
    status,
    service_name,
    practitioner_name,
    booking_date,
    location_name,
    price,
    booked_online,
    cancelled,
    event_created_at,
    source,
    raw_data
  ) values (
    p_booking_id_external,
    v_patient_id,
    p_full_name,
    p_phone,
    p_normalized_phone,
    p_email,
    p_booking_at,
    p_service_name,
    'Booked',
    p_service_name,
    p_practitioner_name,
    p_booking_at,
    p_location_name,
    p_price,
    p_booked_online,
    false,
    p_event_created_at,
    'bokadirekt_webhook',
    p_raw_data
  )
  on conflict (bokadirekt_booking_id) do update
  set
    patient_id       = excluded.patient_id,
    patient_name     = excluded.patient_name,
    phone            = excluded.phone,
    normalized_phone = excluded.normalized_phone,
    email            = excluded.email,
    booking_at       = excluded.booking_at,
    treatment        = excluded.treatment,
    status           = 'Booked',
    service_name     = excluded.service_name,
    practitioner_name = excluded.practitioner_name,
    booking_date     = excluded.booking_date,
    location_name    = excluded.location_name,
    price            = excluded.price,
    booked_online    = excluded.booked_online,
    cancelled        = false,
    event_created_at = coalesce(public.bookings.event_created_at, excluded.event_created_at),
    raw_data         = excluded.raw_data,
    updated_at       = now()
  returning id into v_booking_db_id;

  -- Recompute booking metadata for the patient who now owns this booking.
  -- NEW: delegated to refresh_patient_booking_metadata (022) instead of an
  -- inline query, so every writer shares one definition.
  perform public.refresh_patient_booking_metadata(v_patient_id);

  if v_prev_patient_id is not null and v_prev_patient_id <> v_patient_id then
    -- Booking moved to a different patient: recompute old patient's metadata
    -- and transfer the cycle-reset log so it follows the booking.
    perform public.refresh_patient_booking_metadata(v_prev_patient_id);

    -- Move the cycle-reset to the new patient; create one if it was never recorded
    update public.reminder_logs
    set
      patient_id = v_patient_id,
      created_at = now()
    where booking_id = v_booking_db_id
      and is_cycle_reset = true;

    if not found then
      insert into public.reminder_logs (
        patient_id, booking_id, phone, message, status,
        sequence_number, is_cycle_reset, provider_message_id,
        skip_reason, error, sent_at
      ) values (
        v_patient_id, v_booking_db_id, null, '', 'cycle_reset',
        null, true, null, null, null, null
      );
    end if;

    -- NEW: the reset invalidates anything queued for either patient.
    perform public.cancel_pending_scheduled_sms(
      v_patient_id, 'Avbruten: patienten bokade en ny tid'
    );
    perform public.cancel_pending_scheduled_sms(
      v_prev_patient_id, 'Avbruten: bokningen flyttades till en annan patient'
    );
  elsif not coalesce(v_already_confirmed, false) then
    -- New booking, not yet confirmed: insert the initial cycle-reset
    insert into public.reminder_logs (
      patient_id, booking_id, phone, message, status,
      sequence_number, is_cycle_reset, provider_message_id,
      skip_reason, error, sent_at
    ) values (
      v_patient_id, v_booking_db_id, null, '', 'cycle_reset',
      null, true, null, null, null, null
    );

    -- NEW: the cycle restarted, so any queued step from the old cycle is stale.
    perform public.cancel_pending_scheduled_sms(
      v_patient_id, 'Avbruten: patienten bokade en ny tid'
    );
  end if;

  return v_patient_id;
end;
$$;

-- Cancellation path: same two changes. Note that with 022's definition a
-- future booking never set last_booking_at in the first place, so cancelling
-- one now correctly leaves the last attended visit in place.
create or replace function public.cancel_bokadirekt_booking(
  p_booking_id_external text
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_booking_db_id    uuid;
  v_patient_id       uuid;
begin
  if p_booking_id_external is null or p_booking_id_external = '' then
    raise exception 'BokaDirekt booking ID is required';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_booking_id_external));

  select id, patient_id
  into v_booking_db_id, v_patient_id
  from public.bookings
  where bokadirekt_booking_id = p_booking_id_external
  for update;

  if found then
    update public.bookings
    set cancelled = true, status = 'Cancelled', updated_at = now()
    where id = v_booking_db_id;

    delete from public.reminder_logs
    where booking_id = v_booking_db_id
      and is_cycle_reset = true;

    -- if this booking had a logged SMS-conversion, mark it cancelled so
    -- it drops out of the analytics metric (same advisory-locked transaction).
    update public.sms_conversions
    set cancelled = true
    where bokadirekt_booking_id = p_booking_id_external;

    -- NEW: shared definition instead of an inline query.
    if v_patient_id is not null then
      perform public.refresh_patient_booking_metadata(v_patient_id);
    end if;
  end if;

  update public.review_items
  set status = 'resolved', updated_at = now()
  where type = 'pending_booking_match'
    and status = 'open'
    and raw_data->'booking'->>'Id' = p_booking_id_external;
end;
$$;

revoke execute on function public.cancel_bokadirekt_booking(text)
  from public, anon;
grant execute on function public.cancel_bokadirekt_booking(text)
  to service_role;

revoke execute on function public.apply_bokadirekt_booking(
  uuid, text, text, text, text, text, text, text, text, timestamptz,
  text, text, text, integer, boolean, timestamptz, jsonb
) from public, anon;
grant execute on function public.apply_bokadirekt_booking(
  uuid, text, text, text, text, text, text, text, text, timestamptz,
  text, text, text, integer, boolean, timestamptz, jsonb
) to service_role;
