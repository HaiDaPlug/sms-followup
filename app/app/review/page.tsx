import Link from "next/link";
import { ReviewActions } from "@/components/ReviewActions";
import { FailedSmsActions } from "@/components/FailedSmsActions";
import { BookingMatchActions } from "@/components/BookingMatchActions";
import { DeliveryUnknownActions } from "@/components/DeliveryUnknownActions";
import { PageHeader } from "@/components/ui/PageHeader";
import { IconCheck, IconSparkle } from "@/components/ui/icons";
import { readStoreForUi } from "@/lib/data/repository";
import { formatDate } from "@/lib/patients/status";

export const dynamic = "force-dynamic";

const severityLabels: Record<string, string> = {
  high: "Hög",
  medium: "Medel",
  low: "Låg"
};

const severityChip: Record<string, string> = {
  high: "danger",
  medium: "warn",
  low: "neutral",
};

const statusLabels: Record<string, string> = {
  open: "Öppen",
  resolved: "Löst",
  ignored: "Ignorerad"
};

// Readable names for the item types the importer, webhook and sender create.
// Anything unlisted falls back to its raw type so nothing is hidden.
const typeLabels: Record<string, string> = {
  failed_sms: "Misslyckat SMS",
  delivery_unknown: "Okänd leverans",
  pending_booking_match: "Bokning att matcha",
  bokadirekt_auto_match: "Automatisk matchning",
  uncertain_match: "Osäker matchning",
  missing_phone: "Saknar telefon",
  missing_name: "Saknar namn",
  missing_contact_key: "Saknar kontaktuppgift",
  invalid_date: "Ogiltigt datum",
};

function extractCandidates(
  rawData: Record<string, unknown>,
  patients: Array<{ id: string; full_name: string }>
): Array<{ id: string; name: string | null; tier: string }> {
  const rawLookups = rawData.identity_lookups;
  if (!Array.isArray(rawLookups)) return [];

  const seenIds = new Set<string>();
  const result: Array<{ id: string; name: string | null; tier: string }> = [];

  for (const lookup of rawLookups) {
    if (typeof lookup !== "object" || lookup === null) continue;
    const tier = typeof (lookup as Record<string, unknown>).tier === "string"
      ? String((lookup as Record<string, unknown>).tier)
      : "";
    const rawPatients = (lookup as Record<string, unknown>).patients;
    if (!Array.isArray(rawPatients)) continue;

    for (const p of rawPatients) {
      if (typeof p !== "object" || p === null) continue;
      const id = typeof (p as Record<string, unknown>).id === "string"
        ? String((p as Record<string, unknown>).id)
        : "";
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      result.push({
        id,
        name: patients.find((sp) => sp.id === id)?.full_name ?? null,
        tier,
      });
    }
  }

  return result;
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ visa?: string }>;
}) {
  const { visa } = await searchParams;
  const store = await readStoreForUi();
  const all = store.review_items;
  const openItems = all.filter((item) => item.status === "open");
  const showAll = visa === "alla";
  const items = showAll ? all : openItems;

  return (
    <div className="page">
      <PageHeader
        title="Granskning"
        count={`${openItems.length} öppna`}
        subtitle="Osäkra matchningar, misslyckade utskick, saknade telefonnummer och importproblem — ärenden som behöver ett mänskligt beslut."
      />

      <div className="panel rise" style={{ ["--i" as string]: 1 }}>
        <nav className="tabs" style={{ padding: "0 12px" }} aria-label="Filtrera ärenden">
          <Link href="/app/review" className={`tab${!showAll ? " active" : ""}`} aria-current={!showAll ? "page" : undefined}>
            Öppna <span className="tab-count">{openItems.length}</span>
          </Link>
          <Link href="/app/review?visa=alla" className={`tab${showAll ? " active" : ""}`} aria-current={showAll ? "page" : undefined}>
            Alla <span className="tab-count">{all.length}</span>
          </Link>
        </nav>

        {items.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><IconCheck /></span>
            <span className="empty-title">{showAll ? "Inga granskningsärenden ännu" : "Allt är granskat"}</span>
            <span>{showAll ? "Ärenden skapas vid import, matchning och utskick." : "Inga öppna ärenden väntar på ett beslut."}</span>
          </div>
        ) : (
          <ul className="review-list">
            {items.map((item) => (
              <li key={item.id} className={`review-item${item.status !== "open" ? " is-closed" : ""}`}>
                <div className="review-main">
                  <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
                    <span className="tag">{typeLabels[item.type] ?? item.type}</span>
                    <span className={`chip sm ${severityChip[item.severity] ?? "neutral"}`}>
                      {severityLabels[item.severity] ?? item.severity}
                    </span>
                    {item.status !== "open" && (
                      <span className={`badge sm ${item.status}`}>{statusLabels[item.status] ?? item.status}</span>
                    )}
                    <span className="muted tnum" style={{ marginLeft: "auto" }}>{formatDate(item.created_at)}</span>
                  </div>
                  <p className="review-title">{item.title}</p>
                  <p className="review-desc">{item.description}</p>
                  {item.suggested_action && (
                    <p className="review-suggest">
                      <IconSparkle size={14} />
                      <span><strong>Förslag:</strong> {item.suggested_action}</span>
                    </p>
                  )}
                </div>

                <div className="review-actions">
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
                      candidates={extractCandidates(item.raw_data, store.patients)}
                    />
                  ) : item.status === "open" && item.type === "failed_sms" ? (
                    <FailedSmsActions
                      reviewId={item.id}
                      patientId={String(item.raw_data.patient_id ?? "")}
                      phone={String(item.raw_data.phone ?? "")}
                      sequenceNumber={typeof item.raw_data.sequence_number === "number" ? item.raw_data.sequence_number : null}
                      initialMessage={String(item.raw_data.rendered_message ?? "")}
                    />
                  ) : item.status === "open" && item.type === "delivery_unknown" ? (
                    <DeliveryUnknownActions
                      reviewId={item.id}
                      reminderLogId={String(item.raw_data.reminder_log_id ?? "")}
                    />
                  ) : item.status === "open" ? (
                    <ReviewActions reviewId={item.id} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
