import { getIncomingSms } from "@/lib/data/repository";
import { supabase } from "@/lib/supabase/client";
import { InboxClient } from "@/components/InboxClient";
import type { InboxRow } from "@/types/clinic";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const messages = await getIncomingSms(200);

  // Attach patient names in one shot
  const patientIds = [...new Set(messages.map((m) => m.patient_id).filter(Boolean))] as string[];
  const nameMap = new Map<string, string>();
  if (patientIds.length > 0) {
    const { data } = await supabase
      .from("patients")
      .select("id, full_name")
      .in("id", patientIds);
    for (const p of data ?? []) nameMap.set(p.id, p.full_name);
  }

  const rows: InboxRow[] = messages.map((m) => ({
    ...m,
    patient_name: m.patient_id ? (nameMap.get(m.patient_id) ?? null) : null,
  }));

  const unread = rows.filter((r) => !r.replied_at).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Inkorg</h2>
          <p className="page-subtitle">
            Inkommande SMS från patienter på det virtuella numret
            {unread > 0 && (
              <> · <span style={{ color: "var(--accent)", fontWeight: 600 }}>{unread} obesvarade</span></>
            )}
          </p>
        </div>
      </div>
      <InboxClient initialRows={rows} />
    </>
  );
}
