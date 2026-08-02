import Link from "next/link";
import { AddPatientButton } from "@/components/AddPatientButton";
import { PatientSearch } from "@/components/PatientSearch";
import { PatientsClient } from "@/components/PatientsClient";
import { readStoreForUi } from "@/lib/data/repository";
import { buildEligibilityContext, calculatePatientReminderStatusFromContext } from "@/lib/reminders/eligibility";
import { resolveSteps } from "@/lib/reminders/steps";
import { daysSince, patientDisplayName } from "@/lib/patients/status";

export const dynamic = "force-dynamic";

const filterLabels: Record<string, string> = {
  all: "Alla",
  Ready: "Redo",
  Sent: "Skickat",
  "Future booking": "Har bokat en tid",
  "Missing phone": "Saknar telefon",
  "Do not contact": "Kontakta ej",
  "Needs review": "Behöver granskas",
  "Delivery pending": "Leverans väntar"
};

const filters = [
  "all",
  "Ready",
  "Sent",
  "Future booking",
  "Missing phone",
  "Do not contact",
  "Needs review",
  "Delivery pending",
];

const PAGE_SIZE = 50;

function buildHref(params: { status?: string; sort?: string; q?: string; page?: string }, overrides: Record<string, string>) {
  const merged = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .filter(([, v]) => v && v !== "all" && v !== "1")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `/app/patients${qs ? `?${qs}` : ""}`;
}

export default async function PatientsPage({
  searchParams
}: {
  searchParams: Promise<{ status?: string; sort?: string; q?: string; page?: string }>;
}) {
  const { status: active = "all", sort = "oldest", q = "", page = "1" } = await searchParams;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const store = await readStoreForUi();
  const settings = store.reminder_settings[0];
  const eligibilityContext = buildEligibilityContext(
    store.bookings,
    store.reminder_logs,
    store.review_items
  );

  const search = q.trim().toLowerCase();

  // Build per-patient log map (exclude cycle_reset noise)
  const logsByPatient = new Map<string, typeof store.reminder_logs>();
  for (const log of store.reminder_logs) {
    if (!log.patient_id || log.is_cycle_reset) continue;
    if (!logsByPatient.has(log.patient_id)) logsByPatient.set(log.patient_id, []);
    logsByPatient.get(log.patient_id)!.push(log);
  }

  let patients = store.patients
    .map((patient) => ({
      patient,
      status: calculatePatientReminderStatusFromContext(patient, settings, eligibilityContext),
      logs: logsByPatient.get(patient.id) ?? [],
    }))
    .filter((row) => active === "all" || row.status === active)
    .filter((row) => {
      if (!search) return true;
      const name = patientDisplayName(row.patient).toLowerCase();
      const phone = (row.patient.phone ?? "").toLowerCase();
      const email = (row.patient.email ?? "").toLowerCase();
      return name.includes(search) || phone.includes(search) || email.includes(search);
    });

  patients = patients.sort((a, b) => {
    const dA = daysSince(a.patient.last_booking_at) ?? 0;
    const dB = daysSince(b.patient.last_booking_at) ?? 0;
    return sort === "recent" ? dA - dB : dB - dA;
  });

  const totalFiltered = patients.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
  const currentPage = Math.min(pageNum, totalPages);
  const paginated = patients.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const currentParams = { status: active, sort, q, page };

  return (
    <>
      <style>{`
        .pt-search-input {
          padding: 8px 14px 8px 36px;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--surface);
          color: var(--text);
          font-size: 13.5px;
          width: 220px;
          outline: none;
          transition: border-color 180ms, box-shadow 180ms, width 220ms cubic-bezier(0.22,1,0.36,1);
        }
        .pt-search-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px rgba(91,191,181,0.15);
          width: 270px;
        }
        .pt-search-wrap {
          position: relative;
          display: flex;
          align-items: center;
        }
        .pt-search-icon {
          position: absolute;
          left: 11px;
          color: var(--text-faint);
          pointer-events: none;
          display: flex;
        }
        .pt-sort-seg {
          display: flex;
          background: var(--surface-sub);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          overflow: hidden;
          flex-shrink: 0;
        }
        .pt-sort-seg a {
          padding: 8px 15px;
          font-size: 13px;
          font-weight: 500;
          color: var(--text-muted);
          white-space: nowrap;
          transition: background 150ms, color 150ms;
          border-right: 1px solid var(--border);
        }
        .pt-sort-seg a:last-child { border-right: none; }
        .pt-sort-seg a:hover { color: #073B2C; }
        .pt-sort-seg a.active {
          background-color: #073B2C;
          background-image: var(--btn-sheen);
          color: #fff;
          font-weight: 600;
        }
        .pt-sort-seg a.active::before { display: none; }
        .pt-filter-bar {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .pt-filter-bar a {
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--surface);
          color: var(--text-muted);
          font-size: 13px;
          font-weight: 500;
          padding: 6px 15px;
          transition: all 140ms ease;
          white-space: nowrap;
          position: relative;
          overflow: hidden;
        }
        .pt-filter-bar a:hover {
          border-color: #5bbfb5;
          color: #073B2C;
        }
        .pt-filter-bar a.active {
          background-color: #073B2C;
          background-image: var(--btn-sheen);
          border-color: #073B2C;
          color: #fff;
          font-weight: 600;
        }
        .pt-filter-bar a.active::before { display: none; }
        .pt-control-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          margin-bottom: 18px;
          flex-wrap: wrap;
        }
        .pt-header-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 22px;
        }
        .pt-header-left {
          display: flex;
          align-items: baseline;
          gap: 14px;
        }
        .pt-count-chip {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-muted);
          background: var(--surface-sub);
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 3px 12px;
          letter-spacing: 0.02em;
          white-space: nowrap;
          align-self: center;
        }
      `}</style>

      {/* Header */}
      <div className="pt-header-row">
        <div className="pt-header-left">
          <h2 className="page-title" style={{ marginBottom: 0 }}>Kunder</h2>
          <span className="pt-count-chip">{totalFiltered} / {store.patients.length}</span>
        </div>
        <AddPatientButton />
      </div>

      {/* Control bar */}
      <div className="pt-control-bar">
        <div className="pt-filter-bar">
          {filters.map((filter) => (
            <Link
              className={`sweep-btn${active === filter ? " active" : ""}`}
              href={buildHref(currentParams, { status: filter, page: "1" })}
              key={filter}
            >
              <span>{filterLabels[filter] ?? filter}</span>
            </Link>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <PatientSearch defaultValue={q} currentParams={{ status: active, sort }} />

          <div className="pt-sort-seg">
            <Link
              className={`sweep-btn${sort === "oldest" ? " active" : ""}`}
              href={buildHref(currentParams, { sort: "oldest", page: "1" })}
            >
              <span>Äldst först</span>
            </Link>
            <Link
              className={`sweep-btn${sort === "recent" ? " active" : ""}`}
              href={buildHref(currentParams, { sort: "recent", page: "1" })}
            >
              <span>Senast först</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Pagination info in header area when needed */}
      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, marginBottom: 8 }}>
          {currentPage > 1 && (
            <Link href={buildHref(currentParams, { page: String(currentPage - 1) })} style={{ padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 5, fontSize: 13, color: "var(--text-muted)", background: "var(--surface)" }}>←</Link>
          )}
          <span style={{ fontSize: 12, color: "var(--text-faint)", padding: "0 4px" }}>
            Sida {currentPage} / {totalPages}
          </span>
          {currentPage < totalPages && (
            <Link href={buildHref(currentParams, { page: String(currentPage + 1) })} style={{ padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 5, fontSize: 13, color: "var(--text-muted)", background: "var(--surface)" }}>→</Link>
          )}
        </div>
      )}

      <PatientsClient rows={paginated} steps={resolveSteps(settings)} />
    </>
  );
}
