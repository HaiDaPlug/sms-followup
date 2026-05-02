import { NextResponse } from "next/server";
import { readStore } from "@/lib/data/repository";

export async function GET() {
  const store = await readStore();

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const patientMap = new Map(store.patients.map((p) => [p.id, p]));

  const logs = store.reminder_logs
    .filter((l) => l.status === "sent" && new Date(l.created_at) >= monthStart)
    .map((l) => {
      const patient = l.patient_id ? patientMap.get(l.patient_id) : undefined;
      return {
        id: l.id,
        phone: l.phone,
        sequence_number: l.sequence_number,
        sent_at: l.sent_at ?? l.created_at,
        patient_id: l.patient_id,
        full_name: patient?.full_name ?? null,
      };
    });

  return NextResponse.json(logs);
}
