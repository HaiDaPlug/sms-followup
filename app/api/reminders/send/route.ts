import { NextResponse } from "next/server";
import { readStore } from "@/lib/data/repository";
import { sendReminderToPatient } from "@/lib/reminders/process";

export async function POST(request: Request) {
  let body: { patientId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Ogiltig JSON" }, { status: 400 });
  }

  const store = await readStore();
  const patient = store.patients.find((p) => p.id === body.patientId);

  if (!patient) {
    return NextResponse.json({ error: "Patienten hittades inte" }, { status: 404 });
  }

  try {
    const log = await sendReminderToPatient(patient);
    return NextResponse.json({ status: log.status, error: log.error ?? null, log });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Oväntat fel";
    return NextResponse.json({ status: "failed", error }, { status: 500 });
  }
}
