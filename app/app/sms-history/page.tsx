import { readStoreForUi } from "@/lib/data/repository";
import { SmsHistoryClient, type PatientRow, type Tab } from "@/components/SmsHistoryClient";
import { PageHeader } from "@/components/ui/PageHeader";

export const dynamic = "force-dynamic";

export default async function SmsHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const initialTab: Tab = tab === "failed" || tab === "sent" ? tab : "all";
  const store = await readStoreForUi();
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
    <div className="page">
      <PageHeader
        title="SMS-historik"
        count={`${rows.length} patienter kontaktade`}
        subtitle={
          <>
            Varje utskick per kund. Klicka på ett SMS för att läsa meddelandet.
            {totalSent > 0 && <> · <strong style={{ color: "var(--accent-ink)" }}>{totalSent} skickade</strong></>}
            {totalFailed > 0 && <> · <strong style={{ color: "var(--danger)" }}>{totalFailed} misslyckade</strong></>}
          </>
        }
      />

      <SmsHistoryClient initialRows={rows} initialTab={initialTab} />
    </div>
  );
}
