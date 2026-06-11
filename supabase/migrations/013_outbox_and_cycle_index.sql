-- Reserve SMS sequence steps before provider calls and handle uncertain sends.

alter table public.reminder_logs
  drop constraint if exists reminder_logs_status_check;

alter table public.reminder_logs
  add constraint reminder_logs_status_check
  check (
    status in (
      'pending',
      'unknown',
      'sent',
      'delivered',
      'failed',
      'dry_run',
      'skipped',
      'cycle_reset'
    )
  );

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
      'delivery_pending'
    )
  );

drop index if exists public.reminder_logs_patient_seq_unique_idx;

create unique index reminder_logs_booking_seq_idx
  on public.reminder_logs (patient_id, booking_id, sequence_number)
  where status in ('pending', 'unknown', 'sent', 'dry_run', 'delivered')
    and booking_id is not null
    and sequence_number is not null;

create unique index reminder_logs_null_booking_seq_idx
  on public.reminder_logs (patient_id, sequence_number)
  where status in ('pending', 'unknown', 'sent', 'dry_run', 'delivered')
    and booking_id is null
    and sequence_number is not null;

create or replace function public.mark_pending_unknown(
  p_log_ids uuid[]
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  r record;
begin
  for r in
    update public.reminder_logs
    set
      status = 'unknown',
      error = 'Leveransstatus okänd - kontrollera SMS-leverantören'
    where id = any(p_log_ids)
      and status = 'pending'
    returning id, patient_id, sequence_number, phone
  loop
    insert into public.review_items (
      type,
      severity,
      title,
      description,
      suggested_action,
      status,
      raw_data,
      content_hash
    ) values (
      'delivery_unknown',
      'high',
      format('Okänd SMS-leverans - SMS %s', r.sequence_number),
      'Reservationen skapades men leveransstatusen kunde inte bekräftas. Kontrollera leverantören och markera som skickat eller misslyckat.',
      'Verifiera med SMS-leverantören och välj åtgärd nedan.',
      'open',
      jsonb_build_object(
        'reminder_log_id', r.id,
        'patient_id', r.patient_id,
        'sequence_number', r.sequence_number,
        'phone', r.phone
      ),
      format('delivery_unknown:%s', r.id)
    );
  end loop;
end;
$$;

revoke execute on function public.mark_pending_unknown from public, anon;
grant execute on function public.mark_pending_unknown to service_role;

create or replace function public.resolve_delivery_unknown(
  p_review_item_id uuid,
  p_log_id uuid,
  p_outcome text
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_review public.review_items%rowtype;
begin
  if p_outcome not in ('sent', 'failed') then
    raise exception 'Invalid outcome: %', p_outcome;
  end if;

  select *
  into v_review
  from public.review_items
  where id = p_review_item_id
  for update;

  if v_review.id is null then
    raise exception 'Review item % not found', p_review_item_id;
  end if;
  if v_review.status <> 'open' then
    raise exception 'Review item % is already %', p_review_item_id, v_review.status;
  end if;
  if v_review.type <> 'delivery_unknown' then
    raise exception 'Review item % has wrong type: %', p_review_item_id, v_review.type;
  end if;
  if v_review.raw_data->>'reminder_log_id' is distinct from p_log_id::text then
    raise exception 'Log ID mismatch: review item references %, got %',
      v_review.raw_data->>'reminder_log_id', p_log_id;
  end if;

  update public.reminder_logs
  set
    status = p_outcome,
    sent_at = case when p_outcome = 'sent' then now() else null end
  where id = p_log_id
    and status = 'unknown';

  if not found then
    raise exception 'Log % not found or not in unknown status', p_log_id;
  end if;

  update public.review_items
  set status = 'resolved', updated_at = now()
  where id = p_review_item_id;
end;
$$;

revoke execute on function public.resolve_delivery_unknown from public, anon;
grant execute on function public.resolve_delivery_unknown to service_role;
