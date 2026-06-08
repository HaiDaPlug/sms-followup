-- Seed the 5-step SMS sequence into sms_steps on the existing reminder_settings row.
-- Steps: day 5, 10, 90, 180, 365.
-- If no row exists yet, insert one with sensible defaults first.

insert into reminder_settings (
  days_after_booking, send_time, max_per_day,
  sms_template, sms_template_2, sms_template_3,
  booking_link, clinic_name, is_active, dry_run_mode,
  sms_steps
)
select
  5, '09:00', 25,
  '', '', '',
  'https://bokat.se/osteopaticentrum', 'Osteopaticentrum', true, true,
  '[
    {
      "day": 5,
      "template": "Hej {{firstName}},\nför att uppnå ett hållbart resultat rekommenderas vanligtvis 3–4 behandlingar, och i vissa fall kan fler behövas.\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    },
    {
      "day": 10,
      "template": "Hej {{firstName}},\nuppföljning ger ofta bättre och mer stabila resultat.\nSvar gärna på detta meddelande eller boka en tid via länken nedan:\n\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    },
    {
      "day": 90,
      "template": "Hej {{firstName}}! Det har nu gått några månader sedan ditt senaste besök hos mig. Hoppas att det känns bra i kroppen, annars kan det vara läge att boka ett besök snart.\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    },
    {
      "day": 180,
      "template": "Hej {{firstName}}! Det har nu gått ett tag sedan ditt senaste besök hos mig. Många upplever att regelbunden osteopatisk behandling hjälper till att förebygga stelhet och besvär innan de hinner bli större problem.\n\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    },
    {
      "day": 365,
      "template": "Hej {{firstName}}! Nu har det gått ett tag sedan din senaste behandling hos mig. Kroppen förändras över tid och många väntar tyvärr lite för länge innan de söker hjälp igen.\nEn uppföljande behandling kan vara ett bra sätt att förebygga återkommande besvär och hålla kroppen i balans. Hör gärna av dig om du vill boka en tid.\n\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    }
  ]'::jsonb
where not exists (select 1 from reminder_settings);

-- If a row already exists, update sms_steps on it
update reminder_settings
set sms_steps = '[
    {
      "day": 5,
      "template": "Hej {{firstName}},\nför att uppnå ett hållbart resultat rekommenderas vanligtvis 3–4 behandlingar, och i vissa fall kan fler behövas.\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    },
    {
      "day": 10,
      "template": "Hej {{firstName}},\nuppföljning ger ofta bättre och mer stabila resultat.\nSvar gärna på detta meddelande eller boka en tid via länken nedan:\n\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    },
    {
      "day": 90,
      "template": "Hej {{firstName}}! Det har nu gått några månader sedan ditt senaste besök hos mig. Hoppas att det känns bra i kroppen, annars kan det vara läge att boka ett besök snart.\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    },
    {
      "day": 180,
      "template": "Hej {{firstName}}! Det har nu gått ett tag sedan ditt senaste besök hos mig. Många upplever att regelbunden osteopatisk behandling hjälper till att förebygga stelhet och besvär innan de hinner bli större problem.\n\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    },
    {
      "day": 365,
      "template": "Hej {{firstName}}! Nu har det gått ett tag sedan din senaste behandling hos mig. Kroppen förändras över tid och många väntar tyvärr lite för länge innan de söker hjälp igen.\nEn uppföljande behandling kan vara ett bra sätt att förebygga återkommande besvär och hålla kroppen i balans. Hör gärna av dig om du vill boka en tid.\n\nMvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}"
    }
  ]'::jsonb
where exists (select 1 from reminder_settings);
