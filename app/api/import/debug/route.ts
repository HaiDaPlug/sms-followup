import { NextResponse } from "next/server";
import { parseDelimited } from "@/lib/import/csv";

export async function POST(request: Request) {
  const body = (await request.json()) as { csvText?: string };
  const csvText = body.csvText ?? "";
  if (!csvText.trim()) {
    return NextResponse.json({ error: "csvText is required" }, { status: 400 });
  }

  const rows = parseDelimited(csvText, ";");
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const sample = rows.slice(0, 2);

  return NextResponse.json({ headers, sample, totalRows: rows.length });
}
