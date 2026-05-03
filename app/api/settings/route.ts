import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/data/repository";
import type { SmsStep } from "@/types/clinic";

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function POST(request: Request) {
  const body = await request.json() as Record<string, unknown>;

  // Validate sms_steps shape if provided
  if (body.sms_steps !== undefined && body.sms_steps !== null) {
    const steps = body.sms_steps as SmsStep[];
    if (!Array.isArray(steps) || steps.some((s) => typeof s.day !== "number" || typeof s.template !== "string")) {
      return NextResponse.json({ error: "Ogiltigt format för sms_steps" }, { status: 400 });
    }
  }

  return NextResponse.json(await updateSettings(body));
}
