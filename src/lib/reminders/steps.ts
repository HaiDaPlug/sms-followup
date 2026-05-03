import type { ReminderSettings, SmsStep } from "@/types/clinic";

export function resolveSteps(settings: ReminderSettings): SmsStep[] {
  if (settings.sms_steps && settings.sms_steps.length > 0) {
    return [...settings.sms_steps].sort((a, b) => a.day - b.day);
  }
  const d = settings.days_after_booking;
  return [
    { day: d,     template: settings.sms_template },
    { day: d * 2, template: settings.sms_template_2 },
    { day: d * 3, template: settings.sms_template_3 },
  ];
}
