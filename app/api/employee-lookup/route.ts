import { NextResponse } from "next/server";
import { findEmployeeRecord } from "@/app/data/employees";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const employeeName = String(url.searchParams.get("employeeName") ?? "").trim();

  if (!employeeName) {
    return NextResponse.json(
      { error: "employeeName query param is required." },
      { status: 400 }
    );
  }

  const record = await findEmployeeRecord(employeeName);
  if (!record) {
    return NextResponse.json({ found: false });
  }

  return NextResponse.json({
    found: true,
    employeeName: record.employeeName,
    managerName: record.managerName,
    managerEmail: record.managerEmail,
  });
}

