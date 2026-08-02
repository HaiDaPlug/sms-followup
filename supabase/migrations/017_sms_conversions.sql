-- Tracks deterministic BokaDirekt auto-matches where the patient had a prior
-- reminder SMS (sent/delivered) before this booking's effective date -- a
-- follow-up SMS that appears to have been followed by a rebooking.
--
-- Migration 014 is intentionally NOT modified (it may already be applied in
-- some environment). Everything here is additive: the table, a new wrapper
-- RPC that calls the existing apply_bokadirekt_booking and logs the
-- conversion in the same transaction, and a create-or-replace of
-- cancel_bokadirekt_booking that layers a conversion-cancel update on top of
-- 014's definition.

create table if not exists public.sms_conversions (
  id                            uuid primary key default gen_random_uuid(),
  bokadirekt_booking_id         text not null,
  booking_id                    uuid references public.bookings(id) on delete set null,
  patient_id                    uuid references public.patients(id) on delete set null,
  patient_name                  text,
  booking_effective_at          timestamptz not null,
  reminder_log_id               uuid references public.reminder_logs(id) on delete set null,
  reminder_log_sent_at          timestamptz not null,
  reminder_log_sequence_number  integer,
  days_since_sms                integer not null,
  cancelled                     boolean not null default false,
  created_at                    timestamptz not null default now()
);

create unique index if not exists sms_conversions_bokadirekt_booking_id_idx
  on public.sms_conversions (bokadirekt_booking_id);

create index if not exists sms_conversions_booking_effective_at_idx
  on public.sms_conversions (booking_effective_at desc)
  where not cancelled;

create index if not exists sms_conversions_patient_id_idx
  on public.sms_conversions (patient_id);

-- Wrapper RPC for the deterministic webhook auto-apply path only. Calls the
-- existing apply_bokadirekt_booking (from migration 014, untouched) as a
-- nested call, then logs the conversion in the SAME transaction: if the
-- conversion insert raises, the whole apply rolls back (the webhook's retry
-- is safe -- advisory-locked and idempotent). The manual-review path keeps
-- calling apply_bokadirekt_booking directly via confirm_booking_match, so it
-- never logs a conversion.
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
  v_patient_id    uuid;
  v_booking_db_id uuid;
  v_effective_at  timestamptz;
  v_sms_id        uuid;
  v_sms_sent_at   timestamptz;
  v_sms_sequence  integer;
  v_was_staged    boolean;
begin
  v_patient_id := public.apply_bokadirekt_booking(
    p_patient_id, p_bokadirekt_customer_id, p_full_name, p_first_name, p_last_name,
    p_phone, p_normalized_phone, p_email, p_booking_id_external, p_booking_at,
    p_service_name, p_practitioner_name, p_location_name, p_price, p_booked_online,
    p_event_created_at, p_raw_data
  );

  -- Conversion effective date is always the booking's recorded-in-system
  -- date (event_created_at, falling back to created_at) -- never
  -- p_booking_at / BookingStartDate, which is the appointment date and is
  -- irrelevant to conversion attribution.
  select id, coalesce(event_created_at, created_at)
  into v_booking_db_id, v_effective_at
  from public.bookings
  where bokadirekt_booking_id = p_booking_id_external;

  -- Keep bookings that entered manual review out of the automatic metric,
  -- including when a later BookingUpdated event becomes auto-matchable.
  select exists (
    select 1
    from public.review_items
    where type = 'pending_booking_match'
      and raw_data->'booking'->>'Id' = p_booking_id_external
  ) into v_was_staged;

  if v_booking_db_id is not null and not v_was_staged then
    select id, sent_at, sequence_number
    into v_sms_id, v_sms_sent_at, v_sms_sequence
    from public.reminder_logs
    where patient_id = v_patient_id
      and status in ('sent', 'delivered')
      and sent_at is not null
      and sent_at < v_effective_at
    order by sent_at desc
    limit 1;

    if v_sms_id is not null then
      insert into public.sms_conversions (
        bokadirekt_booking_id, booking_id, patient_id, patient_name,
        booking_effective_at, reminder_log_id, reminder_log_sent_at,
        reminder_log_sequence_number, days_since_sms
      ) values (
        p_booking_id_external, v_booking_db_id, v_patient_id, p_full_name,
        v_effective_at, v_sms_id, v_sms_sent_at, v_sms_sequence,
        floor(extract(epoch from (v_effective_at - v_sms_sent_at)) / 86400)
      )
      on conflict (bokadirekt_booking_id) do nothing;
    end if;
  end if;

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

-- Layer a conversion-cancel update on top of 014's cancel_bokadirekt_booking,
-- via create-or-replace, rather than editing migration 014 directly. Body is
-- copied verbatim from 014 with one addition (marked NEW).
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

    -- NEW: if this booking had a logged SMS-conversion, mark it cancelled so
    -- it drops out of the analytics metric (same advisory-locked transaction).
    update public.sms_conversions
    set cancelled = true
    where bokadirekt_booking_id = p_booking_id_external;

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
