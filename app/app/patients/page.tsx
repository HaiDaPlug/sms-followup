import { AddPatientButton } from "@/components/AddPatientButton";
import { PatientsClient, type PatientListRow } from "@/components/PatientsClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatNumber } from "@/components/ui/format";
import { readStoreForUi } from "@/lib/data/repository";
import {
  buildEligibilityContext,
  calculatePatientReminderStatusFromContext,
  logsInCurrentCycle,
} from "@/lib/reminders/eligibility";
import { resolveSteps } from "@/lib/reminders/steps";
import { followUpTrack } from "@/lib/patients/followupTrack";
import { daysSince } from "@/lib/patients/status";
import type { Patient, StepOption } from "@/types/clinic";

export const dynamic = "force-dynamic";

function displayName(p: Patient) {
  if (p.first_name || p.last_name) return [p.first_name, p.last_name].filter(Boolean).join(" ");
  return p.full_name;
}

/**
 * Every patient is computed and shipped once per visit; filtering, sorting,
 * search and paging then happen in the browser (PatientsClient), so switching
 * a tab or a sort costs no request at all. Rows are kept compact for that
 * reason — message history is fetched by the drawer when it opens.
 */
export default async function PatientsPage() {
  const store = await readStoreForUi();
  const settings = store.reminder_settings[0];
  const steps = resolveSteps(settings);
  const eligibilityContext = buildEligibilityContext(
    store.bookings,
    store.reminder_logs,
    store.review_items
  );

  const rows: PatientListRow[] = store.patients.map((patient) => {
    const patientLogs = eligibilityContext.logsByPatient.get(patient.id) ?? [];
    const track = followUpTrack(
      steps,
      logsInCurrentCycle(patient.id, patientLogs),
      daysSince(patient.last_booking_at)
    );
    return {
      id: patient.id,
      name: displayName(patient),
      fullName: patient.full_name,
      phone: patient.phone,
      normalizedPhone: patient.normalized_phone,
      email: patient.email,
      lastBookingAt: patient.last_booking_at,
      treatment: patient.latest_treatment,
      doNotContact: patient.do_not_contact,
      status: calculatePatientReminderStatusFromContext(patient, settings, eligibilityContext),
      // Same count as before: sent or delivered, cycle resets excluded.
      sentCount: patientLogs.filter(
        (l) => !l.is_cycle_reset && (l.status === "sent" || l.status === "delivered")
      ).length,
      track: track.map((t) => (t.at ? { s: t.state, at: t.at } : { s: t.state })),
    };
  });

  // Pickers only need id, day and active — not the template text.
  const stepOptions: StepOption[] = steps.map(({ id, day, active }) => ({ id, day, active }));

  return (
    <div className="page">
      <PageHeader
        title="Kunder"
        count={`${formatNumber(store.patients.length)} i registret`}
        subtitle="Filtrera, sök och följ upp. Klicka på ett namn för kontaktuppgifter, uppföljningar och hela SMS-historiken."
        actions={<AddPatientButton />}
      />

      <PatientsClient rows={rows} steps={stepOptions} />
    </div>
  );
}
