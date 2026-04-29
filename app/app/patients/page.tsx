import Link from "next/link";
import { PatientActions } from "@/components/PatientActions";
import { readStore } from "@/lib/data/repository";
import { calculatePatientReminderStatus } from "@/lib/reminders/eligibility";
import { daysSince, formatDate, patientDisplayName } from "@/lib/patients/status";

export const dynamic = "force-dynamic";

const filterLabels: Record<string, string> = {
  all: "Alla",
  Ready: "Redo",
  Sent: "Skickat",
  "Future booking": "Har bokat en tid",
  "Missing phone": "Saknar telefon",
  "Do not contact": "Kontakta ej",
  "Needs review": "Behöver granskas"
};

const statusLabels: Record<string, string> = {
  Ready: "Redo",
  Sent: "Skickat",
  "Future booking": "Har bokat en tid",
  "Missing phone": "Saknar telefon",
  "Do not contact": "Kontakta ej",
  "Needs review": "Behöver granskas",
  Waiting: "Väntar",
  "No valid booking": "Ingen giltig bokning"
};

const filters = ["all", "Ready", "Sent", "Future booking", "Missing phone", "Do not contact", "Needs review"];

function badgeClass(status: string) {
  if (status === "Ready" || status === "Sent") return "ready";
  if (status === "Future booking") return "future";
  if (status === "Missing phone") return "missing";
  if (status === "Needs review") return "review";
  if (status === "Do not contact") return "ignored";
  return "waiting";
}

function buildHref(params: { status?: string; sort?: string }, overrides: Record<string, string>) {
  const merged = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .filter(([, v]) => v && v !== "all")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `/app/patients${qs ? `?${qs}` : ""}`;
}

export default async function PatientsPage({
  searchParams
}: {
  searchParams: Promise<{ status?: string; sort?: string }>;
}) {
  const { status: active = "all", sort = "oldest" } = await searchParams;
  const store = await readStore();
  const settings = store.reminder_settings[0];

  let patients = store.patients
    .map((patient) => ({
      patient,
      status: calculatePatientReminderStatus(
        patient,
        settings,
        store.bookings,
        store.reminder_logs,
        store.review_items
      )
    }))
    .filter((row) => active === "all" || row.status === active);

  // Sort by days since last booking
  patients = patients.sort((a, b) => {
    const dA = daysSince(a.patient.last_booking_at) ?? 0;
    const dB = daysSince(b.patient.last_booking_at) ?? 0;
    return sort === "recent" ? dA - dB : dB - dA;
  });

  const currentParams = { status: active, sort };

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Patienter</h2>
          <p className="page-subtitle">Kontakter, senaste bokning, SMS-status och manuella åtgärder.</p>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div className="filters" style={{ margin: 0 }}>
          {filters.map((filter) => (
            <Link
              className={active === filter ? "active" : undefined}
              href={buildHref(currentParams, { status: filter })}
              key={filter}
            >
              {filterLabels[filter] ?? filter}
            </Link>
          ))}
        </div>

        <div className="filters" style={{ margin: 0 }}>
          <Link
            className={sort === "oldest" ? "active" : undefined}
            href={buildHref(currentParams, { sort: "oldest" })}
          >
            Äldst bokning först
          </Link>
          <Link
            className={sort === "recent" ? "active" : undefined}
            href={buildHref(currentParams, { sort: "recent" })}
          >
            Senast bokad först
          </Link>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Namn</th>
              <th>Telefon</th>
              <th>E-post</th>
              <th>Senaste bokning</th>
              <th>Dagar sedan</th>
              <th>Behandling</th>
              <th>Status</th>
              <th>Åtgärder</th>
            </tr>
          </thead>
          <tbody>
            {patients.map(({ patient, status }) => (
              <tr key={patient.id}>
                <td style={{ fontWeight: 600 }}>{patientDisplayName(patient)}</td>
                <td>
                  {patient.phone ?? <span className="muted">—</span>}
                  {patient.normalized_phone ? (
                    <div className="muted">{patient.normalized_phone}</div>
                  ) : null}
                </td>
                <td>{patient.email ?? <span className="muted">—</span>}</td>
                <td>{formatDate(patient.last_booking_at)}</td>
                <td>{daysSince(patient.last_booking_at) ?? <span className="muted">—</span>}</td>
                <td>{patient.latest_treatment ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`badge ${badgeClass(status)}`}>
                    {statusLabels[status] ?? status}
                  </span>
                </td>
                <td>
                  <PatientActions patientId={patient.id} />
                </td>
              </tr>
            ))}
            {patients.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="empty-state">Inga patienter matchar det valda filtret.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
