import { NextResponse } from "next/server";
import { readStore } from "@/lib/data/repository";
import { sendReminderToPatient } from "@/lib/reminders/process";
import { outcomeFromLog, type SendOutcome } from "@/lib/sms/outcome";

export async function POST(request: Request) {
  let body: { patientId?: string; sequenceOverride?: number; forceNext?: boolean };
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
    const log = await sendReminderToPatient(patient, store, false, body.sequenceOverride, body.forceNext ?? false);
    const outcome = outcomeFromLog(log);

    // A deliberate skip is a successful request whose send was refused, so it
    // stays 200 and lets outcome.kind carry the distinction. Only a genuine
    // provider problem is a 502.
    const httpStatus = outcome.kind === "failed" || outcome.kind === "unknown" ? 502 : 200;

    // `status` and `error` remain alongside `outcome` so existing callers keep
    // working while the UI migrates to reading the outcome.
    const payload: { status: string; error: string | null; outcome: SendOutcome; log: typeof log } = {
      status: log.status,
      error: log.error ?? null,
      outcome,
      log,
    };
    return NextResponse.json(payload, { status: httpStatus });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Oväntat fel";
    return NextResponse.json({ status: "failed", error }, { status: 500 });
  }
}
