import { NextResponse } from "next/server";
import { cancelScheduledSms } from "@/lib/data/repository";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const cancelled = await cancelScheduledSms(id);
    if (!cancelled) {
      return NextResponse.json(
        { error: "SMS:et bearbetas redan, är avslutat eller finns inte" },
        { status: 409 }
      );
    }
    return NextResponse.json(cancelled);
  } catch (err) {
    const error = err instanceof Error ? err.message : "Oväntat fel";
    return NextResponse.json({ error }, { status: 500 });
  }
}
