import { NextResponse } from "next/server";
import { confirmBookingMatch } from "@/lib/webhooks/bokadirekt";

export async function POST(request: Request) {
  let body: { reviewItemId?: string; patientId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Ogiltig JSON" }, { status: 400 });
  }

  if (!body.reviewItemId) {
    return NextResponse.json({ error: "reviewItemId krävs" }, { status: 400 });
  }

  try {
    const result = await confirmBookingMatch(
      body.reviewItemId,
      body.patientId ?? null
    );
    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : "Oväntat fel";
    return NextResponse.json({ error }, { status: 500 });
  }
}
