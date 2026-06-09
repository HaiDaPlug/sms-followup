-- Fix SMS step 2 day from 10 → 14
update reminder_settings
set sms_steps = jsonb_set(
  sms_steps,
  '{1,day}',
  '14'
)
where sms_steps is not null;
