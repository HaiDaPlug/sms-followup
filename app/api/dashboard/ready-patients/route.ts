import { NextResponse } from "next/server";
import { readStore } from "@/lib/data/repository";
import { calculatePatientReminderStatus } from "@/lib/reminders/eligibility";

const PAGE_SIZE = 50;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sort = searchParams.get("sort") ?? "oldest";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));

  const store = await readStore();
  const settings = store.reminder_settings[0];

  const smsCountByPatient = new Map<string, number>();
  for (const log of store.reminder_logs) {
    if (!log.patient_id || log.is_cycle_reset) continue;
    if (log.status === "sent" || log.status === "delivered") {
      smsCountByPatient.set(log.patient_id, (smsCountByPatient.get(log.patient_id) ?? 0) + 1);
    }
  }

  const all = store.patients
    .filter(
      (p) =>
        calculatePatientReminderStatus(
          p,
          settings,
          store.bookings,
          store.reminder_logs,
          store.review_items
        ) === "Ready"
    )
    .map((p) => ({
      id: p.id,
      full_name: p.full_name,
      phone: p.normalized_phone ?? p.phone,
      last_booking_at: p.last_booking_at,
      latest_treatment: p.latest_treatment,
      smsCount: smsCountByPatient.get(p.id) ?? 0,
    }))
    .sort((a, b) => {
      const tA = a.last_booking_at ? new Date(a.last_booking_at).getTime() : 0;
      const tB = b.last_booking_at ? new Date(b.last_booking_at).getTime() : 0;
      return sort === "oldest" ? tA - tB : tB - tA;
    });

  const total = all.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const items = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return NextResponse.json({ items, total, page, totalPages });
}
