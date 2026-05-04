import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

// 46elks POSTs delivery status updates here when an SMS status changes.
// Payload fields: id, status ("delivered"|"failed"|"undelivered"), delivered (timestamp)
export async function POST(request: Request) {
  const body = await request.text();
  const params = new URLSearchParams(body);

  const id = params.get("id");
  const status = params.get("status");
  const delivered = params.get("delivered");

  if (!id || !status) {
    return NextResponse.json({ error: "Missing id or status" }, { status: 400 });
  }

  const patch: Record<string, string | null> = { error: null };

  if (status === "delivered") {
    patch.status = "delivered";
    patch.sent_at = delivered ?? new Date().toISOString();
  } else if (status === "failed" || status === "undelivered") {
    patch.status = "failed";
    patch.error = `Delivery failed: ${status}`;
  }

  await supabase
    .from("reminder_logs")
    .update(patch)
    .eq("provider_message_id", id);

  return NextResponse.json({ ok: true });
}
