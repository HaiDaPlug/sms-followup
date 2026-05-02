import { NextResponse } from "next/server";
import { readStore } from "@/lib/data/repository";

export async function GET() {
  const store = await readStore();
  const patientMap = new Map(store.patients.map((p) => [p.id, p]));

  const logs = store.reminder_logs
    .filter((l) => !l.is_cycle_reset)
    .map((l) => {
      const patient = l.patient_id ? patientMap.get(l.patient_id) : undefined;
      return {
        id: l.id,
        full_name: patient?.full_name ?? null,
        phone: l.phone,
        sequence_number: l.sequence_number,
        status: l.status,
        created_at: l.created_at,
      };
    });

  return NextResponse.json(logs);
}
