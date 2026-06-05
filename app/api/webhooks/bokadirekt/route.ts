import { NextResponse } from "next/server";
import { handleBokaDirektWebhook } from "@/lib/webhooks/bokadirekt";

function authorized(request: Request) {
  const secret = process.env.BOKADIREKT_WEBHOOK_SECRET;
  if (!secret) return true;
  return request.headers.get("webhook-secret") === secret;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eventType = request.headers.get("webhook-event") ?? "unknown";
  const payload = (await request.json()) as Record<string, unknown>;
  const result = await handleBokaDirektWebhook(payload, eventType);
  return NextResponse.json(result);
}
