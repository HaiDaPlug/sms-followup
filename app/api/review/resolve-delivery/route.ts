import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const reviewId = typeof body.reviewId === "string" ? body.reviewId : "";
  const reminderLogId = typeof body.reminderLogId === "string" ? body.reminderLogId : "";
  const outcome = body.outcome === "sent" || body.outcome === "failed"
    ? body.outcome
    : null;

  if (!reviewId || !reminderLogId || !outcome) {
    return NextResponse.json(
      { error: "reviewId, reminderLogId och giltigt outcome krävs" },
      { status: 400 }
    );
  }

  const { error } = await supabase.rpc("resolve_delivery_unknown", {
    p_review_item_id: reviewId,
    p_log_id: reminderLogId,
    p_outcome: outcome,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  return NextResponse.json({ status: "resolved", outcome });
}
