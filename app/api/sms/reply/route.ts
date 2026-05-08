import { NextResponse } from "next/server";
import { markIncomingSmsReplied, nowIso } from "@/lib/data/repository";
import { sendSms } from "@/lib/sms/provider";

// POST /api/sms/reply
// Body: { incoming_sms_id: string, to: string, message: string }
//
// Sends an outbound SMS to the patient and marks the incoming message as replied.

export async function POST(request: Request) {
  let body: { incoming_sms_id?: string; to?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { incoming_sms_id, to, message } = body;

  if (!incoming_sms_id || !to || !message?.trim()) {
    return NextResponse.json(
      { error: "incoming_sms_id, to och message krävs" },
      { status: 400 }
    );
  }

  const result = await sendSms({ to, message });

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "SMS send failed" }, { status: 502 });
  }

  await markIncomingSmsReplied(incoming_sms_id, {
    reply_message: message,
    reply_provider_id: result.providerMessageId ?? null,
    replied_at: nowIso(),
  });

  return NextResponse.json({ ok: true, providerMessageId: result.providerMessageId });
}
