import { NextResponse } from "next/server";
import { readStore } from "@/lib/data/repository";
import { sendReminderToPatient } from "@/lib/reminders/process";

export async function POST(request: Request) {
  const body = (await request.json()) as { patientId?: string };
  const store = await readStore();
  const patient = store.patients.find((item) => item.id === body.patientId);

  if (!patient) {
    return NextResponse.json({ error: "Patient not found" }, { status: 404 });
  }

  const log = await sendReminderToPatient(patient);
  return NextResponse.json({ status: log.status, log });
}
