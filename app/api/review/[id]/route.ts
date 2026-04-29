import { NextResponse } from "next/server";
import { updateReviewItem } from "@/lib/data/repository";
import type { ReviewStatus } from "@/types/clinic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as { status?: ReviewStatus };

  if (body.status !== "resolved" && body.status !== "ignored" && body.status !== "open") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const item = await updateReviewItem(id, { status: body.status });

  if (!item) {
    return NextResponse.json({ error: "Review item not found" }, { status: 404 });
  }

  return NextResponse.json({ status: "updated", item });
}
