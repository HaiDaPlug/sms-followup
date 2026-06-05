-- Add BokaDirekt external IDs and booking detail columns for webhook integration

alter table patients
  add column if not exists bokadirekt_customer_id text unique;

alter table bookings
  add column if not exists bokadirekt_booking_id text unique,
  add column if not exists service_name text,
  add column if not exists practitioner_name text,
  add column if not exists booking_date timestamptz,
  add column if not exists location_name text,
  add column if not exists price integer,
  add column if not exists booked_online boolean,
  add column if not exists cancelled boolean not null default false;
