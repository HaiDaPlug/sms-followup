-- Add event_created_at to bookings for analytics (BokaDirekt EventCreated field)
alter table bookings add column if not exists event_created_at timestamptz;
