import { NextResponse } from "next/server";
import { createScheduledSms, listScheduledSms, readStore } from "@/lib/data/repository";
import {
  calculatePatientReminderStatus,
  getNextSchedulableSequence,
  latestValidBooking,
  renderSmsTemplate,
  resolveSteps,
  unresolvedPlaceholders
} from "@/lib/reminders/eligibility";

const CLINIC_TIME_ZONE = "Europe/Stockholm";
const HARD_BLOCKS = new Set([
  "Do not contact",
  "Missing phone",
  "Future booking",
  "Needs review",
  "Delivery pending",
  "No valid booking"
]);

export async function POST(request: Request) {
  let body: {
    patientId?: string;
    scheduledFor?: string;
    sequenceOverride?: number;
    timeZone?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Ogiltig JSON" }, { status: 400 });
  }

  if (!body.patientId || !body.scheduledFor) {
    return NextResponse.json({ error: "Patient och schemalagd tid krävs" }, { status: 400 });
  }
  if (body.timeZone !== CLINIC_TIME_ZONE) {
    return NextResponse.json(
      { error: "Schemaläggning måste göras i klinikens tidszon Europe/Stockholm" },
      { status: 400 }
    );
  }

  const scheduledDate = new Date(body.scheduledFor);
  if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
    return NextResponse.json({ error: "Välj ett giltigt datum i framtiden" }, { status: 400 });
  }

  try {
    const store = await readStore();
    const patient = store.patients.find((candidate) => candidate.id === body.patientId);
    const settings = store.reminder_settings[0];
    if (!patient) {
      return NextResponse.json({ error: "Patienten hittades inte" }, { status: 404 });
    }
    if (!settings) {
      return NextResponse.json({ error: "Påminnelseinställningar saknas" }, { status: 500 });
    }

    const status = calculatePatientReminderStatus(
      patient,
      settings,
      store.bookings,
      store.reminder_logs,
      store.review_items
    );
    if (HARD_BLOCKS.has(status)) {
      return NextResponse.json(
        { error: `Patienten kan inte schemaläggas: ${status}` },
        { status: 409 }
      );
    }

    const steps = resolveSteps(settings);
    if (
      body.sequenceOverride !== undefined &&
      (!Number.isInteger(body.sequenceOverride) || body.sequenceOverride < 1 || body.sequenceOverride > steps.length)
    ) {
      return NextResponse.json({ error: "Ogiltigt mallval" }, { status: 400 });
    }

    const next = body.sequenceOverride !== undefined
      ? { sequenceNumber: body.sequenceOverride }
      : getNextSchedulableSequence(patient, settings, store.reminder_logs);
    if (!next) {
      return NextResponse.json({ error: "Det finns inget återstående SMS att schemalägga" }, { status: 409 });
    }

    const template = steps[next.sequenceNumber - 1]?.template;
    if (!template) {
      return NextResponse.json({ error: "Den valda SMS-mallen finns inte" }, { status: 400 });
    }
    const message = renderSmsTemplate(template, patient, settings);
    const unresolved = unresolvedPlaceholders(message);
    if (unresolved.length > 0) {
      return NextResponse.json(
        { error: `Mallen innehåller okända platshållare: ${unresolved.join(", ")}` },
        { status: 409 }
      );
    }

    const booking = latestValidBooking(patient, store.bookings);
    const scheduled = await createScheduledSms({
      patient_id: patient.id,
      booking_id: booking?.id ?? null,
      patient_name: patient.full_name,
      recipient_phone: patient.normalized_phone,
      sequence_override: next.sequenceNumber,
      message_override: message,
      scheduled_for: scheduledDate.toISOString()
    });
    return NextResponse.json(scheduled, { status: 201 });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Oväntat fel";
    return NextResponse.json({ error }, { status: 500 });
  }
}

export async function GET() {
  try {
    return NextResponse.json(await listScheduledSms());
  } catch (err) {
    const error = err instanceof Error ? err.message : "Oväntat fel";
    return NextResponse.json({ error }, { status: 500 });
  }
}
