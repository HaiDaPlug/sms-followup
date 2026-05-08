-- Incoming SMS from patients via the dedicated virtual number
create table if not exists incoming_sms (
  id                  text primary key,          -- 46elks message ID
  from_number         text not null,             -- sender's number (E.164)
  to_number           text not null,             -- our virtual number
  message             text not null,
  received_at         timestamptz not null,      -- from 46elks "created" field
  patient_id          uuid references patients(id) on delete set null,
  -- Reply fields (null until a reply is sent)
  replied_at          timestamptz,
  reply_message       text,
  reply_provider_id   text,                      -- 46elks ID of the outbound reply
  created_at          timestamptz not null default now()
);

create index if not exists incoming_sms_patient_idx
  on incoming_sms (patient_id, received_at desc);

create index if not exists incoming_sms_from_number_idx
  on incoming_sms (from_number);

create index if not exists incoming_sms_received_at_idx
  on incoming_sms (received_at desc);
