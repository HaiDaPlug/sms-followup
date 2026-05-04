import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

// 46elks POSTs URL-encoded delivery status updates here when an SMS status changes.
// Payload: id, status ("delivered"|"failed"|"undelivered"), delivered (ISO timestamp)
export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const body = await request.text();

  // Parse both form-encoded (46elks) and JSON payloads
  let id: string | null = null;
  let status: string | null = null;
  let delivered: string | null = null;

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      id        = typeof parsed.id        === "string" ? parsed.id        : null;
      status    = typeof parsed.status    === "string" ? parsed.status    : null;
      delivered = typeof parsed.delivered === "string" ? parsed.delivered : null;
    } catch {
      return NextResponse.json({ error: "Ogiltig JSON" }, { status: 400 });
    }
  } else {
    const params = new URLSearchParams(body);
    id        = params.get("id");
    status    = params.get("status");
    delivered = params.get("delivered");
  }

  if (!id || !status) {
    return NextResponse.json({ error: "Fält saknas: id och status krävs" }, { status: 400 });
  }

  const patch: Record<string, string | null> = { error: null };

  if (status === "delivered") {
    patch.status  = "delivered";
    patch.sent_at = delivered ?? new Date().toISOString();
  } else if (status === "failed" || status === "undelivered") {
    patch.status = "failed";
    patch.error  = `Leverans misslyckades: ${status}`;
  } else {
    // Unknown status from provider — log it but don't corrupt the row
    console.warn(`[sms-delivery webhook] Okänd status "${status}" för meddelande ${id}`);
    return NextResponse.json({ ok: true, ignored: true, reason: `Okänd status: ${status}` });
  }

  const { data, error } = await supabase
    .from("reminder_logs")
    .update(patch)
    .eq("provider_message_id", id)
    .select("id");

  if (error) {
    console.error("[sms-delivery webhook] Databasfel:", error.message);
    return NextResponse.json({ error: "Databasfel" }, { status: 500 });
  }

  if (!data || data.length === 0) {
    // Not finding the row is possible if the log was already deleted or ID mismatched
    console.warn(`[sms-delivery webhook] Ingen logg hittades för provider_message_id=${id}`);
  }

  return NextResponse.json({ ok: true, updated: data?.length ?? 0 });
}
