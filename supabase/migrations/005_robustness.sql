-- Migration 005: Robustness hardening for pilot
-- 1. Structured skip reasons on reminder_logs
-- 2. Daily cohort snapshot table for iteration/analysis
-- 3. Index on bookings(patient_id, booking_at) for fast future-booking checks

-- 1. Add skip_reason as a typed column alongside the free-text error field.
--    Existing rows keep error text; new rows get a machine-readable reason.
alter table reminder_logs
  add column if not exists skip_reason text
  check (skip_reason in (
    'future_booking',
    'missing_phone',
    'do_not_contact',
    'needs_review',
    'no_valid_booking',
    'waiting',
    'unresolved_placeholder',
    'sequence_complete'
  ));

-- 2. Daily cohort snapshot — one row per cron run, forever queryable.
create table if not exists daily_snapshots (
  id           uuid primary key default gen_random_uuid(),
  snapped_at   timestamptz not null default now(),
  total_patients         integer not null default 0,
  ready                  integer not null default 0,
  waiting                integer not null default 0,
  sent_complete          integer not null default 0,
  future_booking         integer not null default 0,
  missing_phone          integer not null default 0,
  do_not_contact         integer not null default 0,
  needs_review           integer not null default 0,
  no_valid_booking       integer not null default 0,
  sms_sent               integer not null default 0,
  sms_dry_run            integer not null default 0,
  sms_failed             integer not null default 0,
  sms_skipped            integer not null default 0,
  dry_run_mode           boolean not null default true,
  is_active              boolean not null default true
);

create index if not exists daily_snapshots_snapped_at_idx
  on daily_snapshots (snapped_at desc);

-- 3. Fast index for live future-booking checks during eligibility calculation
create index if not exists bookings_patient_booking_at_idx
  on bookings (patient_id, booking_at)
  where booking_at is not null;
