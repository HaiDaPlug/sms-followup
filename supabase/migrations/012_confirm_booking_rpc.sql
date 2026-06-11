-- Confirm a staged BokaDirekt booking atomically.

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
  v_patient_id        uuid := p_patient_id;
  v_booking_db_id     uuid;
  v_already_confirmed boolean := false;
  v_review_status     text;
  v_review_type       text;
  v_review_booking_id text;
begin
  perform pg_advisory_xact_lock(hashtext(p_booking_id_external));

  select
    status,
    type,
    raw_data->'booking'->>'Id'
  into
    v_review_status,
    v_review_type,
    v_review_booking_id
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

  select (patient_id is not null)
  into v_already_confirmed
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
      p_bokadirekt_customer_id,
      p_full_name,
      p_first_name,
      p_last_name,
      p_phone,
      p_normalized_phone,
      p_email,
      p_service_name,
      'bokadirekt_webhook'
    )
    returning id into v_patient_id;
  else
    update public.patients
    set
      bokadirekt_customer_id = p_bokadirekt_customer_id,
      full_name = p_full_name,
      first_name = p_first_name,
      last_name = p_last_name,
      phone = p_phone,
      normalized_phone = p_normalized_phone,
      email = p_email,
      latest_treatment = p_service_name,
      updated_at = now()
    where id = v_patient_id;

    if not found then
      raise exception 'Patient % not found', v_patient_id;
    end if;
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
    patient_id = excluded.patient_id,
    patient_name = excluded.patient_name,
    phone = excluded.phone,
    normalized_phone = excluded.normalized_phone,
    email = excluded.email,
    booking_at = excluded.booking_at,
    treatment = excluded.treatment,
    service_name = excluded.service_name,
    practitioner_name = excluded.practitioner_name,
    booking_date = excluded.booking_date,
    location_name = excluded.location_name,
    price = excluded.price,
    booked_online = excluded.booked_online,
    cancelled = false,
    event_created_at = coalesce(public.bookings.event_created_at, excluded.event_created_at),
    raw_data = excluded.raw_data,
    updated_at = now()
  returning id into v_booking_db_id;

  update public.patients
  set
    last_booking_at = (
      select max(booking_at)
      from public.bookings
      where patient_id = v_patient_id
        and cancelled = false
    ),
    updated_at = now()
  where id = v_patient_id;

  if not coalesce(v_already_confirmed, false) then
    insert into public.reminder_logs (
      patient_id,
      booking_id,
      phone,
      message,
      status,
      sequence_number,
      is_cycle_reset,
      provider_message_id,
      skip_reason,
      error,
      sent_at
    ) values (
      v_patient_id,
      v_booking_db_id,
      null,
      '',
      'cycle_reset',
      null,
      true,
      null,
      null,
      null,
      null
    );
  end if;

  update public.review_items
  set status = 'resolved', updated_at = now()
  where id = p_review_item_id;

  return v_patient_id;
end;
$$;

revoke execute on function public.confirm_booking_match from public, anon;
grant execute on function public.confirm_booking_match to service_role;
