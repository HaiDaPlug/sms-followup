import { listScheduledSms, readStoreForUi } from "@/lib/data/repository";
import { ScheduledSmsClient, type ScheduledSmsRow } from "@/components/ScheduledSmsClient";

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
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Schemalagda SMS</h2>
          <p className="page-subtitle">
            {rows.length} schemalagda
            {activeCount > 0 && (
              <> · <span style={{ color: "var(--accent)" }}>{activeCount} aktiva</span></>
            )}
          </p>
        </div>
      </div>

      <ScheduledSmsClient initialRows={rows} />
    </>
  );
}
