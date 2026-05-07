import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import { findEmployeeRecord } from "@/app/data/employees";

export const runtime = "nodejs";

type SubmittedExpense = {
  filename: string;
  vendor: string;
  date: string;
  city: string;
  currency: string;
  amount: number;
  convertedAmount?: number;
  convertedCurrency?: string;
};

type SubmitPayload = {
  employeeName?: string;
  managerName?: string;
  managerEmail?: string;
  expenses?: SubmittedExpense[];
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SubmitPayload;
    const employeeName = String(body.employeeName ?? "").trim();
    let managerName = String(body.managerName ?? "").trim();
    let managerEmail = String(body.managerEmail ?? "").trim();
    const expenses = Array.isArray(body.expenses) ? body.expenses : [];

    if (!employeeName) {
      return NextResponse.json(
        { error: "Employee name is required." },
        { status: 400 }
      );
    }

    // Enforce manager lookup from employee directory.
    const employeeRecord = await findEmployeeRecord(employeeName);
    if (!employeeRecord) {
      return NextResponse.json(
        { error: "Employee not found in employee list." },
        { status: 400 }
      );
    }

    managerName = employeeRecord.managerName || managerName;
    managerEmail = employeeRecord.managerEmail || managerEmail;

    if (!managerName || !managerEmail) {
      return NextResponse.json(
        { error: "Manager details are missing for this employee in the employee list." },
        { status: 400 }
      );
    }

    if (expenses.length === 0) {
      return NextResponse.json(
        { error: "At least one expense is required." },
        { status: 400 }
      );
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Expenses");

    sheet.columns = [
      { header: "Employee Name", key: "employeeName", width: 24 },
      { header: "Manager Name", key: "managerName", width: 24 },
      { header: "Filename", key: "filename", width: 28 },
      { header: "Vendor", key: "vendor", width: 24 },
      { header: "Date", key: "date", width: 14 },
      { header: "City", key: "city", width: 18 },
      { header: "Original Amount", key: "amount", width: 16 },
      { header: "Original Currency", key: "currency", width: 16 },
      { header: "Converted Amount", key: "convertedAmount", width: 18 },
      { header: "Converted Currency", key: "convertedCurrency", width: 18 },
    ];

    for (const exp of expenses) {
      sheet.addRow({
        employeeName,
        managerName,
        filename: exp.filename,
        vendor: exp.vendor,
        date: exp.date,
        city: exp.city,
        amount: Number(exp.amount ?? 0),
        currency: String(exp.currency ?? ""),
        convertedAmount:
          typeof exp.convertedAmount === "number"
            ? exp.convertedAmount
            : Number(exp.amount ?? 0),
        convertedCurrency:
          String(exp.convertedCurrency ?? "").trim() || String(exp.currency ?? ""),
      });
    }

    sheet.getRow(1).font = { bold: true };

    const excelBuffer = await workbook.xlsx.writeBuffer();
    const attachment = Buffer.from(excelBuffer).toString("base64");

    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = Number(process.env.SMTP_PORT ?? "587");
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const fromEmail = process.env.FROM_EMAIL ?? smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass || !fromEmail) {
      return NextResponse.json(
        {
          error:
            "Missing SMTP configuration. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and FROM_EMAIL in .env.local.",
        },
        { status: 500 }
      );
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    const reportName = String((body as { reportName?: string }).reportName ?? "").trim();
    const now = new Date().toISOString().slice(0, 10);
    const subject = reportName
      ? `Expense Report Pending Approval: "${reportName}" — ${employeeName}`
      : `Expense Report Pending Approval — ${employeeName} — ${now}`;

    await transporter.sendMail({
      from: fromEmail,
      to: managerEmail,
      subject,
      text:
        `Hello ${managerName},\n\n` +
        `${employeeName} has submitted an expense report${reportName ? ` titled "${reportName}"` : ""} that requires your approval.\n\n` +
        `Report details:\n` +
        `  • Employee : ${employeeName}\n` +
        `  • Report   : ${reportName || "—"}\n` +
        `  • Items    : ${expenses.length} receipt(s)\n` +
        `  • Date     : ${now}\n\n` +
        `The full expense breakdown is attached as an Excel file.\n\n` +
        `Please log in to the NStarX Expense Manager to approve or request clarification.\n\n` +
        `Regards,\nNStarX Expense Manager`,
      attachments: [
        {
          filename: `expenses-${employeeName.replace(/\s+/g, "-").toLowerCase()}-${now}.xlsx`,
          content: attachment,
          encoding: "base64",
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
    });

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to submit expenses.", details },
      { status: 500 }
    );
  }
}

