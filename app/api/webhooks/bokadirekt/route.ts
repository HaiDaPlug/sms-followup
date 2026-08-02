import { NextResponse } from "next/server";
import { handleBokaDirektWebhook } from "@/lib/webhooks/bokadirekt";

function authorized(request: Request) {
  const secret = process.env.BOKADIREKT_WEBHOOK_SECRET;
  if (!secret) return false;
  return request.headers.get("webhook-secret") === secret;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eventType = request.headers.get("webhook-event") ?? "unknown";

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Ogiltig JSON" }, { status: 400 });
  }

  try {
    const result = await handleBokaDirektWebhook(payload, eventType);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Okänt fel";
    console.error("[bokadirekt webhook] handler failed", { eventType, error: message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
