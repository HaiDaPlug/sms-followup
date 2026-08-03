-- Makes the SMS-conversion metric reflect real effectiveness rather than only
-- the subset of bookings whose identity happened to resolve cleanly.
--
-- Three changes, all additive (014 and 017 are left untouched):
--   1. match_type on sms_conversions, so the deterministic subset stays
--      isolable after manual matches start being counted.
--   2. A shared log_sms_conversion() used by BOTH the auto and manual paths,
--      so the two can never drift apart.
--   3. A bounded attribution window: an SMS older than the window no longer
--      claims credit for a booking.

alter table public.sms_conversions
  add column if not exists match_type text not null default 'auto';

-- Existing rows all came from the auto path, so the 'auto' default backfills
-- them correctly and no data migration is needed.

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sms_conversions_match_type_check'
  ) then
    alter table public.sms_conversions
      add constraint sms_conversions_match_type_check
      check (match_type in ('auto', 'manual'));
  end if;
end $$;

create index if not exists sms_conversions_match_type_idx
  on public.sms_conversions (match_type)
  where not cancelled;

-- Attribution window. An SMS older than this no longer gets credit for a
-- booking: without a bound, a message from a year ago claims a rebooking it
-- almost certainly did not cause, which inflates the metric in exactly the
-- direction that damages its credibility.
create or replace function public.sms_conversion_window_days()
  returns integer
  language sql
  immutable
as $$ select 90 $$;

-- Shared conversion logger for both the auto-match and manual-confirmation
-- paths. Runs inside the caller's transaction, so it inherits the advisory
-- lock apply_bokadirekt_booking already took on the external booking ID.
create or replace function public.log_sms_conversion(
  p_booking_id_external text,
  p_patient_id          uuid,
  p_full_name           text,
  p_match_type          text
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_booking_db_id uuid;
  v_effective_at  timestamptz;
  v_sms_id        uuid;
  v_sms_sent_at   timestamptz;
  v_sms_sequence  integer;
begin
  if p_patient_id is null or p_booking_id_external is null then
    return;
  end if;

  -- Effective date is when the booking entered the system (event_created_at,
  -- falling back to created_at) -- never booking_at, which is the appointment
  -- date and irrelevant to attribution.
  select id, coalesce(event_created_at, created_at)
  into v_booking_db_id, v_effective_at
  from public.bookings
  where bokadirekt_booking_id = p_booking_id_external;

  if v_booking_db_id is null then
    return;
  end if;

  select id, sent_at, sequence_number
  into v_sms_id, v_sms_sent_at, v_sms_sequence
  from public.reminder_logs
  where patient_id = p_patient_id
    and status in ('sent', 'delivered')
    and sent_at is not null
    and sent_at < v_effective_at
    and sent_at >= v_effective_at - make_interval(days => public.sms_conversion_window_days())
  order by sent_at desc
  limit 1;

  if v_sms_id is null then
    return;
  end if;

  insert into public.sms_conversions (
    bokadirekt_booking_id, booking_id, patient_id, patient_name,
    booking_effective_at, reminder_log_id, reminder_log_sent_at,
    reminder_log_sequence_number, days_since_sms, match_type
  ) values (
    p_booking_id_external, v_booking_db_id, p_patient_id, p_full_name,
    v_effective_at, v_sms_id, v_sms_sent_at, v_sms_sequence,
    floor(extract(epoch from (v_effective_at - v_sms_sent_at)) / 86400),
    p_match_type
  )
  on conflict (bokadirekt_booking_id) do nothing;
end;
$$;

revoke execute on function public.log_sms_conversion(text, uuid, text, text)
  from public, anon;
grant execute on function public.log_sms_conversion(text, uuid, text, text)
  to service_role;

-- Replace 017's auto-match wrapper so it delegates to the shared logger.
-- Behaviour change vs 017: the "was ever staged for review" suppression is
-- gone. It existed to keep manually-touched bookings out of the metric, but
-- that excluded precisely the conversions a human had verified -- biasing the
-- number toward clean data instead of toward real effectiveness.
create or replace function public.apply_bokadirekt_booking_auto_matched(
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
  v_patient_id uuid;
begin
  v_patient_id := public.apply_bokadirekt_booking(
    p_patient_id, p_bokadirekt_customer_id, p_full_name, p_first_name, p_last_name,
    p_phone, p_normalized_phone, p_email, p_booking_id_external, p_booking_at,
    p_service_name, p_practitioner_name, p_location_name, p_price, p_booked_online,
    p_event_created_at, p_raw_data
  );

  perform public.log_sms_conversion(
    p_booking_id_external, v_patient_id, p_full_name, 'auto'
  );

  return v_patient_id;
end;
$$;

revoke execute on function public.apply_bokadirekt_booking_auto_matched(
  uuid, text, text, text, text, text, text, text, text, timestamptz,
  text, text, text, integer, boolean, timestamptz, jsonb
) from public, anon;
grant execute on function public.apply_bokadirekt_booking_auto_matched(
  uuid, text, text, text, text, text, text, text, text, timestamptz,
  text, text, text, integer, boolean, timestamptz, jsonb
) to service_role;

-- Log conversions on the manual confirmation path too. Body is 014's
-- confirm_booking_match verbatim, with one addition (marked NEW) so a
-- human-verified rebooking counts the same as an auto-matched one.
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

  -- NEW: a human-confirmed match is still a rebooking that followed an SMS.
  perform public.log_sms_conversion(
    p_booking_id_external, v_patient_id, p_full_name, 'manual'
  );

  update public.review_items
  set status = 'resolved', updated_at = now()
  where id = p_review_item_id;

  return v_patient_id;
end;
$$;

revoke execute on function public.confirm_booking_match(
  uuid, uuid, text, text, text, text, text, text, text, text, timestamptz,
  text, text, text, integer, boolean, timestamptz, jsonb
) from public, anon;
grant execute on function public.confirm_booking_match(
  uuid, uuid, text, text, text, text, text, text, text, text, timestamptz,
  text, text, text, integer, boolean, timestamptz, jsonb
) to service_role;
