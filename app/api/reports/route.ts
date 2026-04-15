import { NextResponse } from "next/server";
import { getReports } from "@/lib/reports-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const reports = getReports();
    return NextResponse.json({ reports });
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "Failed to load reports.", details }, { status: 500 });
  }
}
