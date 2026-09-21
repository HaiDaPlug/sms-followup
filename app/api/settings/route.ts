import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/data/repository";
import { normalizeAndValidateSmsSteps } from "@/lib/reminders/validateSteps";

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function POST(request: Request) {
  const body = await request.json() as Record<string, unknown>;

  if (body.sms_steps !== undefined && body.sms_steps !== null) {
    // Validated against the stored steps, not in isolation: once ids exist they
    // must never be stripped by a save from an older tab.
    const current = await getSettings();
    const result = normalizeAndValidateSmsSteps(body.sms_steps, current.sms_steps);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    body.sms_steps = result.steps;
  }

  return NextResponse.json(await updateSettings(body));
}
