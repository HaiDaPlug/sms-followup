import { readStore } from "@/lib/data/repository";
import { formatDate } from "@/lib/patients/status";
import { SmsHistoryActions } from "@/components/SmsHistoryActions";

export const dynamic = "force-dynamic";

const statusSv: Record<string, string> = {
  sent:    "Skickat",
  dry_run: "Testläge",
  failed:  "Misslyckades",
  skipped: "Hoppades över",
};

function badgeClass(status: string) {
  if (status === "sent")    return "ready";
  if (status === "dry_run") return "future";
  if (status === "failed")  return "review";
  return "waiting";
}

export default async function SmsHistoryPage() {
  const store = await readStore();
  const patientMap = new Map(store.patients.map((p) => [p.id, p]));

  // Group logs by patient, newest-first within each group
  const grouped = new Map<string, { logs: typeof store.reminder_logs; patientId: string }>();
  for (const log of store.reminder_logs) {
    if (!log.patient_id || log.is_cycle_reset) continue;
    const key = log.patient_id;
    if (!grouped.has(key)) grouped.set(key, { logs: [], patientId: key });
    grouped.get(key)!.logs.push(log);
  }

  // Sort groups by most recent SMS
  const rows = Array.from(grouped.values())
    .map(({ logs, patientId }) => {
      const patient = patientMap.get(patientId);
      const sorted = [...logs].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      return { patient, patientId, logs: sorted, lastSent: sorted[0]?.created_at ?? "" };
    })
    .filter((r) => r.patient)
    .sort((a, b) => new Date(b.lastSent).getTime() - new Date(a.lastSent).getTime());

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">SMS-historik</h2>
          <p className="page-subtitle">Alla patienter som fått ett SMS — lägg till eller ta bort dem.</p>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500 }}>
          {rows.length} patienter kontaktade
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Namn</th>
              <th>Telefon</th>
              <th>Senaste SMS</th>
              <th>Historik</th>
              <th>Åtgärder</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ patient, patientId, logs, lastSent }) => (
              <tr key={patientId}>
                <td style={{ fontWeight: 600 }}>
                  {patient!.full_name}
                  {patient!.do_not_contact && (
                    <span className="badge ignored" style={{ marginLeft: 8, fontSize: 10 }}>Kontakta ej</span>
                  )}
                </td>
                <td>{patient!.normalized_phone ?? patient!.phone ?? <span className="muted">—</span>}</td>
                <td>{formatDate(lastSent)}</td>
                <td>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {logs.map((log) => (
                      <span key={log.id} className={`badge ${badgeClass(log.status)}`} title={log.message}>
                        {log.sequence_number ? `SMS ${log.sequence_number}` : statusSv[log.status] ?? log.status}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <SmsHistoryActions patientId={patientId} doNotContact={patient!.do_not_contact} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">Inga SMS skickade ännu.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
