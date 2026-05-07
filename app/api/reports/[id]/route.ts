import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { updateReportStatus, type ReportStatus } from "@/lib/reports-store";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { status?: string; reason?: string };
    const status = String(body.status ?? "").trim() as ReportStatus;
    const reason = String(body.reason ?? "").trim();

    if (!["approved", "rejected"].includes(status)) {
      return NextResponse.json(
        { error: "Status must be 'approved' or 'rejected'." },
        { status: 400 }
      );
    }

    if (status === "rejected" && !reason) {
      return NextResponse.json(
        { error: "A reason is required when rejecting a report." },
        { status: 400 }
      );
    }

    const updated = updateReportStatus(id, status, reason || undefined);
    if (!updated) {
      return NextResponse.json({ error: "Report not found." }, { status: 404 });
    }

    // ── Send notification email to employee ───────────────────────────
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = Number(process.env.SMTP_PORT ?? "587");
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const fromEmail = process.env.FROM_EMAIL ?? smtpUser;

    if (!updated.employeeEmail) {
      return NextResponse.json({
        ok: true,
        report: updated,
        warning: "Report updated but employee email is missing — no notification sent.",
      });
    }

    if (!smtpHost || !smtpUser || !smtpPass || !fromEmail) {
      return NextResponse.json({
        ok: true,
        report: updated,
        warning: "Report updated but SMTP is not configured — no notification sent.",
      });
    }

    if (smtpHost && smtpUser && smtpPass && fromEmail && updated.employeeEmail) {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass },
      });

      const isApproved = status === "approved";
      const subject = isApproved
        ? `Your expense report "${updated.name}" has been approved`
        : `Action Required: "${updated.name}" was rejected`;

      const formatMoney = (amount: number, currency: string) => {
        try {
          return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: currency || "USD",
            currencyDisplay: "code",
          }).format(amount);
        } catch {
          return `${currency} ${amount.toFixed(2)}`;
        }
      };

      const accentColor = isApproved ? "#a3e635" : "#f87171";
      const bannerBg = isApproved ? "#1a2e1a" : "#2e1a1a";
      const bannerBorder = isApproved ? "#166534" : "#991b1b";
      const statusLabel = isApproved ? "✓ Approved" : "✕ Rejected";

      const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;overflow:hidden;border:1px solid #334155">

        <tr>
          <td style="background:#0f172a;padding:24px 32px;border-bottom:1px solid #334155">
            <p style="margin:0;font-size:11px;letter-spacing:3px;color:#64748b;text-transform:uppercase">NStarX</p>
            <p style="margin:2px 0 0;font-size:10px;letter-spacing:2px;color:#475569;text-transform:uppercase">Expense Intelligence</p>
          </td>
        </tr>

        <tr>
          <td style="background:${bannerBg};padding:20px 32px;border-bottom:1px solid ${bannerBorder}">
            <p style="margin:0;font-size:13px;color:${accentColor}">
              <strong>${statusLabel}</strong> &nbsp;·&nbsp; ${isApproved ? "Your expense report has been approved." : "Your expense report requires attention."}
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:32px">
            <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#f8fafc">${updated.name}</p>
            <p style="margin:0 0 28px;font-size:13px;color:#64748b">
              Reviewed by <strong style="color:#e2e8f0">${updated.managerName}</strong>
            </p>

            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:28px">
              <tr>
                <td style="width:50%;padding-right:8px">
                  <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px 16px">
                    <p style="margin:0 0 4px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Decision</p>
                    <p style="margin:0;font-size:14px;font-weight:700;color:${accentColor}">${statusLabel}</p>
                  </div>
                </td>
                <td style="width:50%;padding-left:8px">
                  <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px 16px">
                    <p style="margin:0 0 4px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Total Amount</p>
                    <p style="margin:0;font-size:14px;font-weight:700;color:#a3e635">${formatMoney(updated.totalAmount, updated.currency)}</p>
                  </div>
                </td>
              </tr>
            </table>

            ${!isApproved && reason ? `
            <div style="background:#2e1a1a;border:1px solid #991b1b;border-radius:10px;padding:16px 20px;margin-bottom:24px">
              <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#f87171;text-transform:uppercase;letter-spacing:1px">Reason for Rejection</p>
              <p style="margin:0;font-size:13px;color:#fca5a5;line-height:1.6">${reason}</p>
            </div>
            <p style="margin:0 0 8px;font-size:13px;color:#94a3b8">
              Please review the reason above, make the necessary corrections, and resubmit your expense report.
            </p>
            ` : `
            <p style="margin:0;font-size:13px;color:#94a3b8">
              Your expense report has been approved. No further action is required.
            </p>
            `}
          </td>
        </tr>

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

      const plainText = isApproved
        ? `Hello ${updated.employeeName},\n\nYour expense report "${updated.name}" has been approved by ${updated.managerName}.\n\nTotal: ${formatMoney(updated.totalAmount, updated.currency)}\n\nRegards,\nNStarX Expense Manager`
        : `Hello ${updated.employeeName},\n\nYour expense report "${updated.name}" has been rejected by ${updated.managerName}.\n\nReason: ${reason}\n\nPlease correct your submission and resubmit.\n\nRegards,\nNStarX Expense Manager`;

      await transporter.sendMail({
        from: `"NStarX Expense Manager" <${fromEmail}>`,
        to: updated.employeeEmail,
        subject,
        text: plainText,
        html: htmlBody,
      });
    }

    return NextResponse.json({ ok: true, report: updated });
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "Failed to update report.", details }, { status: 500 });
  }
}
