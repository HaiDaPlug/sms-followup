import { ReviewActions } from "@/components/ReviewActions";
import { FailedSmsActions } from "@/components/FailedSmsActions";
import { BookingMatchActions } from "@/components/BookingMatchActions";
import { readStore } from "@/lib/data/repository";
import { formatDate } from "@/lib/patients/status";

export const dynamic = "force-dynamic";

const severityLabels: Record<string, string> = {
  high: "Hög",
  medium: "Medel",
  low: "Låg"
};

const statusLabels: Record<string, string> = {
  open: "Öppen",
  resolved: "Löst",
  ignored: "Ignorerad"
};

export default async function ReviewPage() {
  const store = await readStore();
  const items = store.review_items;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Granskning</h2>
          <p className="page-subtitle">Osäkra matchningar, dubbletter, saknade telefonnummer och importproblem.</p>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Typ</th>
              <th>Allvarlighet</th>
              <th>Rubrik</th>
              <th>Beskrivning</th>
              <th>Föreslagen åtgärd</th>
              <th>Status</th>
              <th>Skapad</th>
              <th>Åtgärder</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <span className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.4px", fontWeight: 700 }}>
                    {item.type}
                  </span>
                </td>
                <td>
                  <span className={`badge ${item.severity === "high" ? "failed" : "waiting"}`}>
                    {severityLabels[item.severity] ?? item.severity}
                  </span>
                </td>
                <td style={{ fontWeight: 600 }}>{item.title}</td>
                <td style={{ maxWidth: 280, whiteSpace: "normal", lineHeight: 1.4 }}>{item.description}</td>
                <td style={{ maxWidth: 220, whiteSpace: "normal", lineHeight: 1.4 }}>
                  {item.suggested_action ?? <span className="muted">—</span>}
                </td>
                <td>
                  <span className={`badge ${item.status}`}>
                    {statusLabels[item.status] ?? item.status}
                  </span>
                </td>
                <td className="muted">{formatDate(item.created_at)}</td>
                <td>
                  {item.status === "open" && item.type === "pending_booking_match" ? (
                    <BookingMatchActions
                      reviewId={item.id}
                      matchedPatientId={typeof item.raw_data.match_patient_id === "string" ? item.raw_data.match_patient_id : null}
                      matchedPatientName={
                        (() => {
                          const pid = item.raw_data.match_patient_id;
                          if (typeof pid !== "string") return null;
                          return store.patients.find((p) => p.id === pid)?.full_name ?? null;
                        })()
                      }
                      matchTier={String(item.raw_data.match_tier ?? "")}
                    />
                  ) : item.status === "open" && item.type === "failed_sms" ? (
                    <FailedSmsActions
                      reviewId={item.id}
                      patientId={String(item.raw_data.patient_id ?? "")}
                      phone={String(item.raw_data.phone ?? "")}
                      sequenceNumber={typeof item.raw_data.sequence_number === "number" ? item.raw_data.sequence_number : null}
                      initialMessage={String(item.raw_data.rendered_message ?? "")}
                    />
                  ) : item.status === "open" ? (
                    <ReviewActions reviewId={item.id} />
                  ) : null}
                </td>
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="empty-state">Inga granskningsärenden ännu.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
