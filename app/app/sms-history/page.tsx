import { readStore } from "@/lib/data/repository";
import { SmsHistoryClient, type PatientRow } from "@/components/SmsHistoryClient";

export const dynamic = "force-dynamic";

export default async function SmsHistoryPage() {
  const store = await readStore();
  const patientMap = new Map(store.patients.map((p) => [p.id, p]));

  const grouped = new Map<string, PatientRow>();
  for (const log of store.reminder_logs) {
    if (!log.patient_id || log.is_cycle_reset) continue;
    const patient = patientMap.get(log.patient_id);
    if (!patient) continue;

    if (!grouped.has(log.patient_id)) {
      grouped.set(log.patient_id, {
        patientId: log.patient_id,
        name: patient.full_name,
        phone: patient.normalized_phone ?? patient.phone ?? null,
        doNotContact: patient.do_not_contact,
        logs: [],
        sentCount: 0,
        failedCount: 0,
        lastActivity: "",
      });
    }
    grouped.get(log.patient_id)!.logs.push({
      id: log.id,
      status: log.status,
      sequence_number: log.sequence_number ?? null,
      message: log.message,
      error: log.error ?? null,
      sent_at: log.sent_at ?? null,
      created_at: log.created_at,
    });
  }

  const rows: PatientRow[] = Array.from(grouped.values())
    .map((row) => {
      const sorted = [...row.logs].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      return {
        ...row,
        logs: sorted,
        sentCount:   sorted.filter((l) => l.status === "sent" || l.status === "delivered").length,
        failedCount: sorted.filter((l) => l.status === "failed").length,
        lastActivity: sorted[0]?.created_at ?? "",
      };
    })
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());

  const totalSent   = rows.reduce((n, r) => n + r.sentCount, 0);
  const totalFailed = rows.reduce((n, r) => n + r.failedCount, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">SMS-historik</h2>
          <p className="page-subtitle">
            {rows.length} patienter kontaktade
            {totalSent > 0 && <> · <span style={{ color: "var(--accent)" }}>{totalSent} skickade</span></>}
            {totalFailed > 0 && <> · <span style={{ color: "var(--red)" }}>{totalFailed} misslyckade</span></>}
          </p>
        </div>
      </div>

      <SmsHistoryClient initialRows={rows} />
    </>
  );
}
