import { NextResponse } from "next/server";
import { processScheduledSms } from "@/lib/reminders/process";

// Triggered by the Supabase pg_cron job "scheduled-sms-worker" (migration 020),
// NOT by vercel.json — Vercel's Hobby plan rejects sub-daily crons at deploy
// time, and a scheduled send needs a tick every few minutes to be meaningful.
// See docs/scheduled-sms-setup.md for the Vault secrets the trigger requires.

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
