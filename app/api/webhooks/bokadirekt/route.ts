import { NextResponse } from "next/server";
import { handleBokaDirektWebhook } from "@/lib/webhooks/bokadirekt";

function authorized(request: Request) {
  const secret = process.env.BOKADIREKT_WEBHOOK_SECRET;
  if (!secret) return true;
  return request.headers.get("x-webhook-secret") === secret;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  console.log("[bokadirekt webhook] headers:", JSON.stringify(headers, null, 2));

  const payload = (await request.json()) as Record<string, unknown>;
  console.log("[bokadirekt webhook] raw payload:", JSON.stringify(payload, null, 2));
  const result = await handleBokaDirektWebhook(payload);
  return NextResponse.json(result);
}
