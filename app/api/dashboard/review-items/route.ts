import { NextResponse } from "next/server";
import { readStore } from "@/lib/data/repository";

export async function GET() {
  const store = await readStore();

  const items = store.review_items
    .filter((item) => item.status === "open")
    .map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      severity: item.severity,
    }));

  return NextResponse.json(items);
}
