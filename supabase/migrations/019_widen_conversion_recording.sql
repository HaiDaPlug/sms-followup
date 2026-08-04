-- Move the attribution window from write time to read time.
--
-- 018 froze the decision when the row was written: an SMS older than 90 days
-- was never recorded, so the near-misses were lost and the window could not be
-- changed retroactively. Recording now uses a deliberately wide 365-day net and
-- the UI filters on days_since_sms, so 30/60/90 all answer from the same data
-- and a different window can be applied to history after the fact.
--
-- Consequence worth knowing: sms_conversions is now a RECORD OF CANDIDATES,
-- not a list of counted conversions. A row at 300 days is stored but should
-- not count at any UI setting. Anything querying this table directly must
-- apply an attribution filter of its own -- see analyticsWindow.ts for the
-- read-time definition the app uses.

create or replace function public.sms_conversion_window_days()
  returns integer
  language sql
  immutable
as $$ select 365 $$;

comment on function public.sms_conversion_window_days() is
  'Recording lookback only -- how far back log_sms_conversion() will look for a '
  'preceding SMS. This is intentionally wide so attribution can be narrowed at '
  'read time; it is NOT the attribution window shown in the UI.';

comment on table public.sms_conversions is
  'Candidate SMS-to-rebooking links, recorded at a 365-day lookback. Rows are '
  'not all counted conversions: the effective attribution window is applied at '
  'read time against days_since_sms.';
