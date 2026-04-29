create extension if not exists pgcrypto;

create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  first_name text,
  last_name text,
  phone text,
  normalized_phone text,
  email text,
  last_booking_at timestamptz,
  latest_treatment text,
  has_future_booking boolean not null default false,
  do_not_contact boolean not null default false,
  source text not null default 'bokadirekt_csv',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists patients_normalized_phone_idx
  on patients (normalized_phone)
  where normalized_phone is not null and normalized_phone <> '';

create index if not exists patients_email_idx on patients (email);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  external_booking_id text unique,
  patient_id uuid references patients(id) on delete set null,
  patient_name text,
  phone text,
  normalized_phone text,
  email text,
  booking_at timestamptz,
  treatment text,
  status text,
  source text not null default 'bokadirekt_csv',
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists reminder_settings (
  id uuid primary key default gen_random_uuid(),
  days_after_booking integer not null default 30,
  send_time text not null default '09:00',
  max_per_day integer not null default 25,
  sms_template text not null default '',
  sms_template_2 text not null default '',
  sms_template_3 text not null default '',
  booking_link text not null default '',
  clinic_name text not null default 'Kliniken',
  is_active boolean not null default true,
  dry_run_mode boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists reminder_logs (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete set null,
  booking_id uuid references bookings(id) on delete set null,
  phone text,
  message text not null,
  status text not null,
  sequence_number integer,
  is_cycle_reset boolean not null default false,
  provider_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists review_items (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  severity text not null default 'medium',
  title text not null,
  description text not null,
  suggested_action text,
  status text not null default 'open',
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
