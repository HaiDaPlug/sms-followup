-- Harden reminder_logs for production use

-- 1. CHECK constraint on status — only valid values accepted at DB level
alter table reminder_logs
  add constraint reminder_logs_status_check
  check (status in ('sent', 'delivered', 'failed', 'dry_run', 'skipped', 'cycle_reset'));

-- 2. UNIQUE partial index on provider_message_id — prevents webhook updating
--    multiple rows if a duplicate ID somehow appears
create unique index if not exists reminder_logs_provider_message_id_idx
  on reminder_logs (provider_message_id)
  where provider_message_id is not null;

-- 3. Index on (patient_id, created_at DESC) — fast per-patient log queries
create index if not exists reminder_logs_patient_created_idx
  on reminder_logs (patient_id, created_at desc);

-- 4. Unique partial index on (patient_id, sequence_number) for sent/dry_run/delivered
--    — prevents the same sequence step being written twice for the same patient
--    (guards against double cron fires or race conditions)
create unique index if not exists reminder_logs_patient_seq_unique_idx
  on reminder_logs (patient_id, sequence_number)
  where status in ('sent', 'dry_run', 'delivered') and sequence_number is not null;
