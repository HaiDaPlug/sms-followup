import { NextResponse } from "next/server";
import { importBokaDirektCsv } from "@/lib/import/bokadirekt";

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let csvText = "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("csv");
      csvText = file instanceof File ? await file.text() : String(form.get("csvText") ?? "");
    } else {
      const body = (await request.json()) as { csvText?: string };
      csvText = body.csvText ?? "";
    }

    if (!csvText.trim()) {
      return NextResponse.json({ error: "csvText is required" }, { status: 400 });
    }

    const summary = await importBokaDirektCsv(csvText);
    return NextResponse.json({ summary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed" },
      { status: 500 }
    );
  }
}
