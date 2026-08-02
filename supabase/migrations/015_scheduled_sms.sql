-- Scheduled SMS: staff can pick a patient and a future date/time, sent via the daily cron
create table if not exists scheduled_sms (
  id                  uuid primary key default gen_random_uuid(),
  patient_id          uuid references patients(id) on delete cascade,
  sequence_override   integer,                     -- null = auto-resolve next sequence step at send time
  message_override    text,                         -- null = use the template for the resolved sequence step
  scheduled_for       timestamptz not null,
  status              text not null default 'pending',
  reminder_log_id     uuid references reminder_logs(id) on delete set null,
  error               text,
  created_at          timestamptz not null default now()
);

alter table scheduled_sms
  add constraint scheduled_sms_status_check
  check (status in ('pending', 'sent', 'cancelled', 'failed'));

create index scheduled_sms_status_scheduled_for_idx
  on scheduled_sms (status, scheduled_for);
