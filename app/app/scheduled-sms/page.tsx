import { listScheduledSms, readStoreForUi } from "@/lib/data/repository";
import { ScheduledSmsClient, type ScheduledSmsRow } from "@/components/ScheduledSmsClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { resolveSteps } from "@/lib/reminders/steps";

export const dynamic = "force-dynamic";

export default async function ScheduledSmsPage() {
  const [scheduled, store] = await Promise.all([listScheduledSms(), readStoreForUi()]);
  const patientMap = new Map(store.patients.map((p) => [p.id, p]));

  const rows: ScheduledSmsRow[] = scheduled.map((s) => {
    const patient = s.patient_id ? patientMap.get(s.patient_id) : undefined;
    return {
      ...s,
      patientName: patient?.full_name ?? s.patient_name,
      patientPhone: patient?.normalized_phone ?? patient?.phone ?? s.recipient_phone,
    };
  });

  const activeCount = rows.filter((row) => row.status === "pending" || row.status === "processing").length;

  return (
    <div className="page">
      <PageHeader
        title="Schemalagda SMS"
        count={`${rows.length} totalt`}
        subtitle={
          activeCount > 0
            ? <><strong style={{ color: "var(--accent-ink)" }}>{activeCount} aktiva</strong> väntar på att skickas. Avbryt ett utskick fram till att det har börjat bearbetas.</>
            : "Inga utskick väntar just nu. Schemalägg från en kunds rad på sidan Kunder."
        }
      />

      <ScheduledSmsClient initialRows={rows} steps={resolveSteps(store.reminder_settings[0])} />
    </div>
  );
}
