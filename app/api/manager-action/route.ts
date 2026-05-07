import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { findEmployeeRecord } from "@/app/data/employees";

export const runtime = "nodejs";

const FINANCE_EMAIL = "abirupa.sen@nstarxinc.com";

type ActionPayload = {
  action?: string;
  reportName?: string;
  employeeName?: string;
  managerName?: string;
  totalUSD?: number;
  comment?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ActionPayload;
    const action      = String(body.action ?? "").trim();
    const reportName  = String(body.reportName ?? "").trim();
    const employeeName = String(body.employeeName ?? "").trim();
    const managerName  = String(body.managerName ?? "").trim();
    const totalUSD    = Number(body.totalUSD ?? 0);
    const comment     = String(body.comment ?? "").trim();

    if (!action || !employeeName) {
      return NextResponse.json({ error: "action and employeeName are required." }, { status: 400 });
    }

    const smtpHost  = process.env.SMTP_HOST;
    const smtpPort  = Number(process.env.SMTP_PORT ?? "587");
    const smtpUser  = process.env.SMTP_USER;
    const smtpPass  = process.env.SMTP_PASS;
    const fromEmail = process.env.FROM_EMAIL ?? smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass || !fromEmail) {
      return NextResponse.json({ error: "Missing SMTP configuration." }, { status: 500 });
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    // Look up employee's own email from the directory
    const record = await findEmployeeRecord(employeeName);
    const employeeEmail = record?.employeeEmail ?? "";

    if (action === "clarify") {
      // Send clarification request back to the employee
      if (!employeeEmail) {
        return NextResponse.json({ error: "Could not find employee email in directory." }, { status: 400 });
      }

      await transporter.sendMail({
        from: fromEmail,
        to: employeeEmail,
        subject: `Clarification Needed: "${reportName}"`,
        text:
          `Hi ${employeeName},\n\n` +
          `Your expense report "${reportName}" has been reviewed by ${managerName || "your manager"} ` +
          `and requires clarification before it can be approved.\n\n` +
          `Manager's note:\n${comment || "(No additional comments provided.)"}\n\n` +
          `Please review your report and resubmit with the necessary corrections.\n\n` +
          `Regards,\n${managerName || "Your Manager"}\nNStarX Expense Manager`,
      });

      return NextResponse.json({ ok: true });
    }

    if (action === "approve") {
      // Forward to finance for final approval
      await transporter.sendMail({
        from: fromEmail,
        to: FINANCE_EMAIL,
        subject: `Expense Report Approved for Finance Review: "${reportName}" — ${employeeName}`,
        text:
          `Hello Finance Team,\n\n` +
          `The following expense report has been approved by ${managerName || "the manager"} ` +
          `and is now pending your final review and reimbursement.\n\n` +
          `Report details:\n` +
          `  • Employee  : ${employeeName}\n` +
          `  • Report    : ${reportName}\n` +
          `  • Total     : USD ${totalUSD.toFixed(2)}\n` +
          `  • Approved by: ${managerName}\n\n` +
          `Please process the reimbursement at your earliest convenience.\n\n` +
          `Regards,\nNStarX Expense Manager`,
      });

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });

  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "Failed to process manager action.", details }, { status: 500 });
  }
}
