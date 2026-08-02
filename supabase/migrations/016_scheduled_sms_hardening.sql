-- Harden scheduled SMS delivery with durable claiming and explicit outcomes.

alter table public.scheduled_sms
  add column if not exists booking_id uuid references public.bookings(id) on delete set null,
  add column if not exists patient_name text,
  add column if not exists recipient_phone text,
  add column if not exists claimed_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists attempt_count integer not null default 0;

alter table public.scheduled_sms
  drop constraint if exists scheduled_sms_status_check;

alter table public.scheduled_sms
  add constraint scheduled_sms_status_check
  check (status in (
    'pending',
    'processing',
    'sent',
    'cancelled',
    'skipped',
    'failed',
    'unknown',
    'dry_run'
  ));

alter table public.scheduled_sms
  drop constraint if exists scheduled_sms_sequence_override_check;

alter table public.scheduled_sms
  add constraint scheduled_sms_sequence_override_check
  check (sequence_override is null or sequence_override > 0) not valid;

-- Keep audit rows when patients are deleted. New rows still receive a patient,
-- name, and phone snapshot from the server at creation time.
alter table public.scheduled_sms
  drop constraint if exists scheduled_sms_patient_id_fkey;

alter table public.scheduled_sms
  add constraint scheduled_sms_patient_id_fkey
  foreign key (patient_id) references public.patients(id) on delete set null;

create index if not exists scheduled_sms_active_patient_idx
  on public.scheduled_sms (patient_id, status)
  where status in ('pending', 'processing');

create or replace function public.claim_due_scheduled_sms(
  p_limit integer default 25
) returns setof public.scheduled_sms
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- A crashed worker may have contacted the provider. Never retry these rows
  -- automatically; surface them as unknown for manual reconciliation.
  update public.scheduled_sms
  set
    status = 'unknown',
    completed_at = now(),
    error = coalesce(error, 'Bearbetningen avbröts - leveransstatus okänd')
  where status = 'processing'
    and claimed_at < now() - interval '30 minutes';

  return query
  with candidates as (
    select id
    from public.scheduled_sms
    where status = 'pending'
      and scheduled_for <= now()
    order by scheduled_for asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.scheduled_sms as scheduled
  set
    status = 'processing',
    claimed_at = now(),
    attempt_count = scheduled.attempt_count + 1,
    error = null
  from candidates
  where scheduled.id = candidates.id
  returning scheduled.*;
end;
$$;

revoke execute on function public.claim_due_scheduled_sms(integer) from public, anon;
grant execute on function public.claim_due_scheduled_sms(integer) to service_role;
