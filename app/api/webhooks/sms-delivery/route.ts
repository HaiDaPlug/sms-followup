import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

// 46elks POSTs URL-encoded delivery status updates here when an SMS status changes.
// Payload: id, status ("delivered"|"failed"|"undelivered"), delivered (ISO timestamp, unused —
// see the "delivered" branch below for why we don't record it onto sent_at)
function authorized(request: Request) {
  const secret = process.env.SMS_DELIVERY_WEBHOOK_SECRET;
  if (!secret) return false;
  const token = new URL(request.url).searchParams.get("token");
  return token === secret;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const body = await request.text();

  // Parse both form-encoded (46elks) and JSON payloads
  let id: string | null = null;
  let status: string | null = null;

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      id     = typeof parsed.id     === "string" ? parsed.id     : null;
      status = typeof parsed.status === "string" ? parsed.status : null;
    } catch {
      return NextResponse.json({ error: "Ogiltig JSON" }, { status: 400 });
    }
  } else {
    const params = new URLSearchParams(body);
    id     = params.get("id");
    status = params.get("status");
  }

  if (!id || !status) {
    return NextResponse.json({ error: "Fält saknas: id och status krävs" }, { status: 400 });
  }

  const patch: Record<string, string | null> = { error: null };

  if (status === "delivered") {
    // sent_at is already set at the moment of the actual send (process.ts);
    // don't overwrite it with the (possibly delayed) delivery timestamp, or
    // a slow delivery receipt could shift which day the SMS is bucketed into
    // for analytics and corrupt "days since SMS" on any linked conversion.
    patch.status = "delivered";
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
