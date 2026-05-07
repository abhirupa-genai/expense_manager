import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import { findEmployeeRecord } from "@/app/data/employees";
import { saveReport, type Report } from "@/lib/reports-store";
import { randomUUID } from "crypto";

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
  reportName?: string;
  employeeName?: string;
  employeeEmail?: string;
  managerName?: string;
  managerEmail?: string;
  expenses?: SubmittedExpense[];
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SubmitPayload;
    const reportName = String(body.reportName ?? "").trim() || "Untitled Report";
    const employeeName = String(body.employeeName ?? "").trim();
    const employeeEmail = String(body.employeeEmail ?? "").trim();
    let managerName = String(body.managerName ?? "").trim();
    let managerEmail = String(body.managerEmail ?? "").trim();
    const expenses = Array.isArray(body.expenses) ? body.expenses : [];

    if (!employeeName) {
      return NextResponse.json({ error: "Employee name is required." }, { status: 400 });
    }

    const employeeRecord = await findEmployeeRecord(employeeName);
    if (!employeeRecord) {
      return NextResponse.json({ error: "Employee not found in employee list." }, { status: 400 });
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
      return NextResponse.json({ error: "At least one expense is required." }, { status: 400 });
    }

    // ── Determine display currency ────────────────────────────────────
    const counts = new Map<string, number>();
    for (const exp of expenses) {
      const c = String(exp.convertedCurrency ?? exp.currency ?? "").trim().toUpperCase();
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const displayCurrency =
      [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";

    const totalAmount = expenses.reduce((sum, exp) => {
      return sum + (typeof exp.convertedAmount === "number" ? exp.convertedAmount : exp.amount);
    }, 0);

    // ── Save report to persistent store ──────────────────────────────
    const report: Report = {
      id: randomUUID(),
      name: reportName,
      employeeName,
      employeeEmail,
      managerName,
      managerEmail,
      submittedAt: new Date().toISOString(),
      status: "pending",
      expenses,
      totalAmount,
      currency: displayCurrency,
    };
    saveReport(report);

    // ── Build Excel ───────────────────────────────────────────────────
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Expenses");

    sheet.columns = [
      { header: "Report Name", key: "reportName", width: 28 },
      { header: "Employee Name", key: "employeeName", width: 24 },
      { header: "Manager Name", key: "managerName", width: 24 },
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
        reportName,
        employeeName,
        managerName,
        vendor: exp.vendor,
        date: exp.date,
        city: exp.city,
        amount: Number(exp.amount ?? 0),
        currency: String(exp.currency ?? ""),
        convertedAmount:
          typeof exp.convertedAmount === "number" ? exp.convertedAmount : Number(exp.amount ?? 0),
        convertedCurrency:
          String(exp.convertedCurrency ?? "").trim() || String(exp.currency ?? ""),
      });
    }
    sheet.getRow(1).font = { bold: true };

    const excelBuffer = await workbook.xlsx.writeBuffer();
    const attachment = Buffer.from(excelBuffer).toString("base64");

    // ── Send email ────────────────────────────────────────────────────
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = Number(process.env.SMTP_PORT ?? "587");
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const fromEmail = process.env.FROM_EMAIL ?? smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass || !fromEmail) {
      return NextResponse.json(
        { error: "Missing SMTP configuration. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and FROM_EMAIL in .env.local." },
        { status: 500 }
      );
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const now = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

    // Plain-text fallback
    const lineItemsText = expenses
      .map((exp) => {
        const amt = typeof exp.convertedAmount === "number" ? exp.convertedAmount : exp.amount;
        const cur = String(exp.convertedCurrency ?? exp.currency ?? "").trim();
        return `  • ${exp.vendor} | ${exp.city || "—"} | ${exp.date} | ${cur} ${amt.toFixed(2)}`;
      })
      .join("\n");

    // HTML line-item rows
    const lineItemsHtml = expenses
      .map((exp) => {
        const amt = typeof exp.convertedAmount === "number" ? exp.convertedAmount : exp.amount;
        const cur = String(exp.convertedCurrency ?? exp.currency ?? "").trim();
        return `
          <tr>
            <td style="padding:10px 16px;border-bottom:1px solid #1e293b;color:#e2e8f0">${exp.vendor}</td>
            <td style="padding:10px 16px;border-bottom:1px solid #1e293b;color:#94a3b8">${exp.city || "—"}</td>
            <td style="padding:10px 16px;border-bottom:1px solid #1e293b;color:#94a3b8">${exp.date}</td>
            <td style="padding:10px 16px;border-bottom:1px solid #1e293b;color:#a3e635;text-align:right;font-weight:600">${cur} ${amt.toFixed(2)}</td>
          </tr>`;
      })
      .join("");

    const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;overflow:hidden;border:1px solid #334155">

        <!-- Header -->
        <tr>
          <td style="background:#0f172a;padding:24px 32px;border-bottom:1px solid #334155">
            <p style="margin:0;font-size:11px;letter-spacing:3px;color:#64748b;text-transform:uppercase">NStarX</p>
            <p style="margin:2px 0 0;font-size:10px;letter-spacing:2px;color:#475569;text-transform:uppercase">Expense Intelligence</p>
          </td>
        </tr>

        <!-- Alert banner -->
        <tr>
          <td style="background:#1a2e1a;padding:20px 32px;border-bottom:1px solid #166534">
            <p style="margin:0;font-size:13px;color:#86efac">
              <strong style="color:#a3e635">Action Required</strong> &nbsp;·&nbsp; A new expense report is pending your approval.
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px">
            <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#f8fafc">${reportName}</p>
            <p style="margin:0 0 28px;font-size:13px;color:#64748b">Submitted by <strong style="color:#e2e8f0">${employeeName}</strong> &nbsp;·&nbsp; ${now}</p>

            <!-- Summary pills -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:28px">
              <tr>
                <td style="width:33%;padding-right:8px">
                  <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px 16px">
                    <p style="margin:0 0 4px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Employee</p>
                    <p style="margin:0;font-size:14px;font-weight:600;color:#e2e8f0">${employeeName}</p>
                  </div>
                </td>
                <td style="width:33%;padding:0 4px">
                  <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px 16px">
                    <p style="margin:0 0 4px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Total Amount</p>
                    <p style="margin:0;font-size:14px;font-weight:700;color:#a3e635">${displayCurrency} ${totalAmount.toFixed(2)}</p>
                  </div>
                </td>
                <td style="width:33%;padding-left:8px">
                  <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px 16px">
                    <p style="margin:0 0 4px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Items</p>
                    <p style="margin:0;font-size:14px;font-weight:600;color:#e2e8f0">${expenses.length} receipt${expenses.length !== 1 ? "s" : ""}</p>
                  </div>
                </td>
              </tr>
            </table>

            <!-- Line items table -->
            <p style="margin:0 0 10px;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:1px">Line-Item Breakdown</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:10px;overflow:hidden;margin-bottom:28px">
              <thead>
                <tr style="background:#1e293b">
                  <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:1px">Vendor</th>
                  <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:1px">City</th>
                  <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:1px">Date</th>
                  <th style="padding:10px 16px;text-align:right;font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:1px">Amount</th>
                </tr>
              </thead>
              <tbody>${lineItemsHtml}</tbody>
              <tfoot>
                <tr style="background:#1e293b;border-top:1px solid #334155">
                  <td colspan="3" style="padding:12px 16px;font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase">Total</td>
                  <td style="padding:12px 16px;text-align:right;font-size:14px;font-weight:700;color:#a3e635">${displayCurrency} ${totalAmount.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>

            <p style="margin:0;font-size:13px;color:#64748b">
              The full Excel report is attached. Please log in to the NStarX Expense Manager to approve or reject this report.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#0f172a;padding:20px 32px;border-top:1px solid #334155">
            <p style="margin:0;font-size:11px;color:#475569">NStarX Expense Manager &nbsp;·&nbsp; This is an automated notification.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await transporter.sendMail({
      from: `"NStarX Expense Manager" <${fromEmail}>`,
      to: managerEmail,
      subject: `Action Required: "${reportName}" submitted by ${employeeName}`,
      text:
        `Hello ${managerName},\n\n` +
        `${employeeName} has submitted an expense report for your approval.\n\n` +
        `Report: ${reportName}\n` +
        `Date: ${now}\n` +
        `Items: ${expenses.length}\n` +
        `Total: ${displayCurrency} ${totalAmount.toFixed(2)}\n\n` +
        `Line Items:\n${lineItemsText}\n\n` +
        `The full Excel report is attached.\n\n` +
        `Regards,\nNStarX Expense Manager`,
      html: htmlBody,
      attachments: [
        {
          filename: `${reportName.replace(/\s+/g, "-").toLowerCase()}-${now}.xlsx`,
          content: attachment,
          encoding: "base64",
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
    });

    return NextResponse.json({ ok: true, reportId: report.id });
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "Failed to submit expenses.", details }, { status: 500 });
  }
}
