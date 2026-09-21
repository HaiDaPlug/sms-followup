import { NextResponse } from "next/server";
import { createScheduledSms, listScheduledSms, readStore } from "@/lib/data/repository";
import {
  calculatePatientReminderStatus,
  getNextSchedulableSequence,
  latestValidBooking,
  renderSmsTemplate,
  resolveSteps,
  unresolvedPlaceholders,
  validateSequenceOrder
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
    stepId?: string;
    sequenceOverride?: number;
    timeZone?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Ogiltig JSON" }, { status: 400 });
  }

  // A stale tab would send a position; refuse rather than schedule a different
  // step than the operator picked (see /api/reminders/send).
  if (body.sequenceOverride !== undefined) {
    return NextResponse.json({ error: "Ladda om sidan och försök igen" }, { status: 400 });
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
    if (body.stepId !== undefined && !steps.some((step) => step.id === body.stepId)) {
      return NextResponse.json({ error: "Ogiltigt val av uppföljning" }, { status: 400 });
    }

    // Range alone is not enough: picking a step that has already been sent in
    // this cycle would queue an out-of-order send. Rejecting it here gives the
    // operator the reason immediately instead of surfacing it as a silent skip
    // when the job fires, possibly months later. The send path re-checks too,
    // since the cycle can advance in between.
    if (body.stepId !== undefined) {
      const orderError = validateSequenceOrder(
        patient.id,
        body.stepId,
        settings,
        store.reminder_logs
      );
      if (orderError) {
        return NextResponse.json({ error: orderError }, { status: 409 });
      }
    }

    const chosen = body.stepId !== undefined
      ? steps.find((step) => step.id === body.stepId)!
      : null;
    const next = chosen
      ? { stepId: chosen.id, day: chosen.day, sequenceNumber: steps.indexOf(chosen) + 1 }
      : getNextSchedulableSequence(patient, settings, store.reminder_logs);
    if (!next) {
      return NextResponse.json({ error: "Det finns inget återstående SMS att schemalägga" }, { status: 409 });
    }

    const template = steps.find((step) => step.id === next.stepId)?.template;
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
      // Both: the position keeps the pre-025 readers working, the id survives a
      // later re-ordering of the step list.
      step_id: next.stepId,
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
