import { NextResponse } from "next/server";
import { processScheduledSms } from "@/lib/reminders/process";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await processScheduledSms());
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unexpected scheduled SMS error";
    return NextResponse.json({ error }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
