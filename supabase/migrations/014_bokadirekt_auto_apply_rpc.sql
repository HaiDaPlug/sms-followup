-- Share the BokaDirekt booking mutation between manual review confirmation
-- and deterministic webhook auto-matches.

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
  v_last_booking_at   timestamptz;
  v_latest_treatment  text;
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

  -- Recompute booking metadata for the patient who now owns this booking
  select booking_at, coalesce(treatment, service_name)
  into v_last_booking_at, v_latest_treatment
  from public.bookings
  where patient_id = v_patient_id
    and cancelled = false
  order by booking_at desc nulls last
  limit 1;

  update public.patients
  set
    last_booking_at  = v_last_booking_at,
    latest_treatment = v_latest_treatment,
    updated_at       = now()
  where id = v_patient_id;

  if v_prev_patient_id is not null and v_prev_patient_id <> v_patient_id then
    -- Booking moved to a different patient: recompute old patient's metadata
    -- and transfer the cycle-reset log so it follows the booking.
    select booking_at, coalesce(treatment, service_name)
    into v_last_booking_at, v_latest_treatment
    from public.bookings
    where patient_id = v_prev_patient_id
      and cancelled = false
    order by booking_at desc nulls last
    limit 1;

    update public.patients
    set
      last_booking_at  = v_last_booking_at,
      latest_treatment = v_latest_treatment,
      updated_at       = now()
    where id = v_prev_patient_id;

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
  end if;

  return v_patient_id;
end;
$$;

revoke execute on function public.apply_bokadirekt_booking(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  integer,
  boolean,
  timestamptz,
  jsonb
) from public, anon;
grant execute on function public.apply_bokadirekt_booking(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  integer,
  boolean,
  timestamptz,
  jsonb
) to service_role;

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
  v_last_booking_at  timestamptz;
  v_latest_treatment text;
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

    if v_patient_id is not null then
      select booking_at, coalesce(treatment, service_name)
      into v_last_booking_at, v_latest_treatment
      from public.bookings
      where patient_id = v_patient_id
        and cancelled = false
      order by booking_at desc nulls last
      limit 1;

      update public.patients
      set
        last_booking_at = v_last_booking_at,
        latest_treatment = v_latest_treatment,
        updated_at = now()
      where id = v_patient_id;
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

create or replace function public.confirm_booking_match(
  p_review_item_id         uuid,
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
  v_patient_id        uuid;
  v_review_status     text;
  v_review_type       text;
  v_review_booking_id text;
  v_raw_data          jsonb;
  v_candidate_ids     uuid[];
begin
  select
    status,
    type,
    raw_data->'booking'->>'Id',
    raw_data
  into
    v_review_status,
    v_review_type,
    v_review_booking_id,
    v_raw_data
  from public.review_items
  where id = p_review_item_id
  for update;

  if v_review_status is null then
    raise exception 'Review item % not found', p_review_item_id;
  end if;
  if v_review_status <> 'open' then
    raise exception 'Review item % is already %', p_review_item_id, v_review_status;
  end if;
  if v_review_type <> 'pending_booking_match' then
    raise exception 'Review item % has wrong type: %', p_review_item_id, v_review_type;
  end if;
  if v_review_booking_id is distinct from p_booking_id_external then
    raise exception 'Review item booking mismatch: expected %, got %',
      v_review_booking_id, p_booking_id_external;
  end if;

  -- Validate that p_patient_id is one of the staged candidates.
  -- Null is allowed (create a new patient).
  if p_patient_id is not null then
    select array(
      select id from (
        -- Candidates from identity_lookups written by the webhook
        select distinct (p->>'id')::uuid as id
        from jsonb_array_elements(
               coalesce(v_raw_data->'identity_lookups', '[]'::jsonb)
             ) as lu
        cross join jsonb_array_elements(
               coalesce(lu->'patients', '[]'::jsonb)
             ) as p
        where (p->>'id') is not null and (p->>'id') <> ''
        union
        -- Legacy single-match field (older review items)
        select (v_raw_data->>'match_patient_id')::uuid
        where v_raw_data->>'match_patient_id' is not null
          and v_raw_data->>'match_patient_id' <> ''
      ) sub
    ) into v_candidate_ids;

    if not (p_patient_id = any(v_candidate_ids)) then
      raise exception 'Patient % is not a staged candidate for review item %',
        p_patient_id, p_review_item_id;
    end if;
  end if;

  select public.apply_bokadirekt_booking(
    p_patient_id,
    p_bokadirekt_customer_id,
    p_full_name,
    p_first_name,
    p_last_name,
    p_phone,
    p_normalized_phone,
    p_email,
    p_booking_id_external,
    p_booking_at,
    p_service_name,
    p_practitioner_name,
    p_location_name,
    p_price,
    p_booked_online,
    p_event_created_at,
    p_raw_data
  ) into v_patient_id;

  update public.review_items
  set status = 'resolved', updated_at = now()
  where id = p_review_item_id;

  return v_patient_id;
end;
$$;

revoke execute on function public.confirm_booking_match(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  integer,
  boolean,
  timestamptz,
  jsonb
) from public, anon;
grant execute on function public.confirm_booking_match(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  integer,
  boolean,
  timestamptz,
  jsonb
) to service_role;
