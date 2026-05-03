import Link from "next/link";
import { PatientActions } from "@/components/PatientActions";
import { AddPatientButton } from "@/components/AddPatientButton";
import { PatientSearch } from "@/components/PatientSearch";
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

// Status → left-bar accent color
const statusAccent: Record<string, string> = {
  Ready:            "#5bbfb5",
  Sent:             "#3da89d",
  "Future booking": "#1a4f78",
  "Missing phone":  "#a33030",
  "Needs review":   "#a33030",
  "Do not contact": "#7a5200",
  Waiting:          "#c8d4d0",
  "No valid booking": "#c8d4d0",
};

function badgeClass(status: string) {
  if (status === "Ready" || status === "Sent") return "ready";
  if (status === "Future booking") return "future";
  if (status === "Missing phone") return "missing";
  if (status === "Needs review") return "review";
  if (status === "Do not contact") return "ignored";
  return "waiting";
}

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
  const store = await readStore();
  const settings = store.reminder_settings[0];

  const search = q.trim().toLowerCase();

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
        .pt-row {
          display: grid;
          grid-template-columns: 4px 1fr;
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          transition: background 120ms;
        }
        .pt-row:last-child { border-bottom: 0; }
        .pt-row:nth-child(even) .pt-row-inner { background: var(--surface-sub); }
        .pt-row:hover .pt-row-inner { background: #edf7f6; }

        .pt-row-inner {
          display: grid;
          grid-template-columns: 200px 160px 160px 110px 70px 1fr 175px auto;
          align-items: center;
          gap: 0;
          padding: 0;
          transition: background 120ms;
        }

        .pt-cell {
          padding: 16px 18px;
          font-size: 14px;
          color: var(--text);
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .pt-cell-name {
          padding: 16px 20px;
        }

        .pt-name {
          font-weight: 700;
          font-size: 14.5px;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pt-email {
          font-size: 12.5px;
          color: var(--text-faint);
          margin-top: 3px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .pt-phone-main {
          font-size: 14px;
          color: var(--text);
          white-space: nowrap;
        }
        .pt-phone-norm {
          font-size: 12px;
          color: var(--text-faint);
          margin-top: 2px;
          font-variant-numeric: tabular-nums;
        }

        .pt-days {
          font-variant-numeric: tabular-nums;
          font-weight: 700;
          font-size: 17px;
          color: var(--text-mid);
        }
        .pt-days-label {
          font-size: 10.5px;
          color: var(--text-faint);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-top: 1px;
        }

        .pt-treatment {
          font-size: 13px;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .pt-date {
          font-size: 13.5px;
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }

        .pt-head {
          display: grid;
          grid-template-columns: 4px 1fr;
          background: var(--surface-sub);
          border: 1px solid var(--border);
          border-bottom: 2px solid var(--border-dark);
          position: sticky;
          top: 0;
          z-index: 10;
        }
        .pt-head-bar { background: transparent; }
        .pt-head-inner {
          display: grid;
          grid-template-columns: 200px 160px 160px 110px 70px 1fr 175px auto;
          align-items: center;
        }
        .pt-head-cell {
          padding: 12px 18px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .pt-head-cell:first-child { padding-left: 20px; }

        .pt-actions-cell {
          padding: 12px 18px 12px 8px;
        }

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
        .pt-sort-seg a:hover { background: var(--border); color: var(--text); }
        .pt-sort-seg a.active {
          background: #073B2C;
          color: #fff;
          font-weight: 600;
        }

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
          border-color: var(--border-dark);
          color: var(--text);
          background: var(--surface-sub);
        }
        .pt-filter-bar a.active {
          background: #073B2C;
          border-color: #073B2C;
          color: #fff;
          font-weight: 600;
        }

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
          <h2 className="page-title" style={{ marginBottom: 0 }}>Patienter</h2>
          <span id="pt-count-chip" className="pt-count-chip">{totalFiltered} / {store.patients.length}</span>
        </div>
        <AddPatientButton />
      </div>

      {/* Control bar */}
      <div className="pt-control-bar">
        {/* Status filters */}
        <div className="pt-filter-bar">
          {filters.map((filter) => (
            <Link
              className={active === filter ? "active" : undefined}
              href={buildHref(currentParams, { status: filter, page: "1" })}
              key={filter}
            >
              {filterLabels[filter] ?? filter}
            </Link>
          ))}
        </div>

        {/* Right: search + sort */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <form method="get" action="/app/patients" style={{ display: "contents" }}>
            {active !== "all" && <input type="hidden" name="status" value={active} />}
            {sort !== "oldest" && <input type="hidden" name="sort" value={sort} />}
            <PatientSearch defaultValue={q} />
          </form>

          <div className="pt-sort-seg">
            <Link
              className={sort === "oldest" ? "active" : undefined}
              href={buildHref(currentParams, { sort: "oldest", page: "1" })}
            >
              Äldst först
            </Link>
            <Link
              className={sort === "recent" ? "active" : undefined}
              href={buildHref(currentParams, { sort: "recent", page: "1" })}
            >
              Senast först
            </Link>
          </div>
        </div>
      </div>

      {/* Sticky column header — outside table-wrap so it sticks to page scroll */}
      <div className="pt-head" style={{ borderRadius: "var(--radius) var(--radius) 0 0" }}>
        <div className="pt-head-bar" />
        <div className="pt-head-inner">
          <div className="pt-head-cell">Namn</div>
          <div className="pt-head-cell">Telefon</div>
          <div className="pt-head-cell">E-post</div>
          <div className="pt-head-cell">Senaste bokning</div>
          <div className="pt-head-cell">Dagar</div>
          <div className="pt-head-cell">Behandling</div>
          <div className="pt-head-cell" style={{ borderLeft: "1px solid var(--border)" }}>Status</div>
          <div className="pt-head-cell" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span>Åtgärder</span>
            {totalPages > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {currentPage > 1 && (
                  <Link href={buildHref(currentParams, { page: String(currentPage - 1) })} style={{ padding: "2px 7px", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, fontSize: 12, color: "var(--text-muted)", background: "var(--surface)", lineHeight: 1.6 }}>←</Link>
                )}
                <span style={{ fontSize: 11.5, color: "var(--text-faint)", padding: "0 2px", whiteSpace: "nowrap" }}>
                  {currentPage}/{totalPages}
                </span>
                {currentPage < totalPages && (
                  <Link href={buildHref(currentParams, { page: String(currentPage + 1) })} style={{ padding: "2px 7px", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, fontSize: 12, color: "var(--text-muted)", background: "var(--surface)", lineHeight: 1.6 }}>→</Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="table-wrap" style={{ borderRadius: "0 0 var(--radius) var(--radius)", overflow: "hidden" }}>
        {/* Rows */}
        <div id="pt-empty" className="empty-state" style={{ display: paginated.length === 0 ? "" : "none" }}>
          Inga patienter matchar det valda filtret.
        </div>
        {paginated.map(({ patient, status }) => {
            const accent = statusAccent[status] ?? "#c8d4d0";
            const days = daysSince(patient.last_booking_at);
            const searchKey = [
              patientDisplayName(patient),
              patient.phone ?? "",
              patient.email ?? "",
            ].join(" ").toLowerCase();
            return (
              <div key={patient.id} className="pt-row" data-search={searchKey}>
                <div style={{ background: accent, flexShrink: 0 }} />
                <div className="pt-row-inner">
                  {/* Name + email stacked */}
                  <div className="pt-cell pt-cell-name">
                    <div className="pt-name">{patientDisplayName(patient)}</div>
                    {patient.email && (
                      <div className="pt-email">{patient.email}</div>
                    )}
                  </div>

                  {/* Phone */}
                  <div className="pt-cell">
                    {patient.phone ? (
                      <>
                        <div className="pt-phone-main">{patient.phone}</div>
                        {patient.normalized_phone && (
                          <div className="pt-phone-norm">{patient.normalized_phone}</div>
                        )}
                      </>
                    ) : (
                      <span style={{ color: "var(--text-faint)", fontSize: 13 }}>—</span>
                    )}
                  </div>

                  {/* Email (hidden — already in name cell) */}
                  <div className="pt-cell" style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
                    {patient.email ?? <span style={{ color: "var(--text-faint)" }}>—</span>}
                  </div>

                  {/* Last booking date */}
                  <div className="pt-cell">
                    <span className="pt-date">{formatDate(patient.last_booking_at)}</span>
                  </div>

                  {/* Days since */}
                  <div className="pt-cell">
                    {days != null ? (
                      <>
                        <div className="pt-days">{days}</div>
                        <div className="pt-days-label">dagar</div>
                      </>
                    ) : (
                      <span style={{ color: "var(--text-faint)", fontSize: 13 }}>—</span>
                    )}
                  </div>

                  {/* Treatment */}
                  <div className="pt-cell">
                    <span className="pt-treatment">{patient.latest_treatment ?? <span style={{ color: "var(--text-faint)" }}>—</span>}</span>
                  </div>

                  {/* Status badge */}
                  <div className="pt-cell" style={{ borderLeft: "1px solid var(--border)" }}>
                    <span className={`badge ${badgeClass(status)}`}>
                      {statusLabels[status] ?? status}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="pt-cell pt-actions-cell">
                    <PatientActions patientId={patient.id} />
                  </div>
                </div>
              </div>
            );
          })}
      </div>

    </>
  );
}
