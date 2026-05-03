-- Variable-length SMS step sequence: [{day: number, template: string}, ...]
-- Replaces the fixed days_after_booking + sms_template/2/3 model.
-- Legacy columns are kept so old data is preserved; sms_steps takes precedence when present.
alter table reminder_settings
  add column if not exists sms_steps jsonb;
