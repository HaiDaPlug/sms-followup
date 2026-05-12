-- Allow overriding the double-send guard for testing purposes
alter table reminder_settings
  add column if not exists allow_same_number_override boolean not null default false;
