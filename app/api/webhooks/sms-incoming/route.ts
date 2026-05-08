import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { insertIncomingSms, nowIso } from "@/lib/data/repository";

// 46elks POSTs application/x-www-form-urlencoded when an SMS is received on
// our virtual number. Fields: id, from, to, message, direction, created.
//
// Wire up: set this URL in 46elks dashboard → Numbers → your virtual number → SMS URL
//   https://yourdomain.com/api/webhooks/sms-incoming
//
// Responding with 200 and an empty body acknowledges receipt.
// (To auto-reply, respond with plain text — we handle replies explicitly via /api/sms/reply instead.)

export async function POST(request: Request) {
  const body = await request.text();
  const params = new URLSearchParams(body);

  const id        = params.get("id");
  const from      = params.get("from");
  const to        = params.get("to");
  const message   = params.get("message");
  const created   = params.get("created");
  const direction = params.get("direction");

  // Ignore outbound echo-backs (46elks sometimes sends direction=outgoing)
  if (direction === "outgoing") {
    return new Response("", { status: 200 });
  }

  // Validate this was sent to our virtual number (reject stray deliveries)
  const virtualNumber = process.env.FORTYSIX_ELKS_VIRTUAL_NUMBER;
  if (virtualNumber && to && to !== virtualNumber) {
    console.warn(`[sms-incoming] Ignoring message to unexpected number: ${to}`);
    return new Response("", { status: 200 });
  }

  if (!id || !from || !to || !message) {
    return NextResponse.json({ error: "Missing required fields: id, from, to, message" }, { status: 400 });
  }

  // Match sender to a patient by normalized phone number.
  // Normalize: strip leading +, convert Swedish 07x → 467x
  const normalized = normalizePhone(from);
  let patientId: string | null = null;

  if (normalized) {
    const { data } = await supabase
      .from("patients")
      .select("id")
      .eq("normalized_phone", normalized)
      .limit(1)
      .maybeSingle();
    patientId = data?.id ?? null;
  }

  try {
    await insertIncomingSms({
      id,
      from_number: from,
      to_number: to,
      message,
      received_at: created ?? nowIso(),
      patient_id: patientId,
      replied_at: null,
      reply_message: null,
      reply_provider_id: null,
    });
  } catch (err) {
    console.error("[sms-incoming webhook] DB insert failed:", err);
    // Still return 200 so 46elks doesn't retry — we logged the error
  }

  return new Response("", { status: 200 });
}

function normalizePhone(phone: string): string | null {
  let digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `46${digits.slice(1)}`;
  const onlyDigits = digits.replace(/\D/g, "");
  return onlyDigits.length >= 8 ? onlyDigits : null;
}
