"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";

type ExpenseItem = {
  filename: string;
  vendor: string;
  date: string;
  city: string;
  currency: string;
  amount: number;
  convertedAmount?: number;
  convertedCurrency?: string;
};

type Report = {
  id: string;
  name: string;
  employeeName: string;
  employeeEmail: string;
  managerName: string;
  managerEmail: string;
  submittedAt: string;
  status: "pending" | "approved" | "rejected";
  rejectionReason?: string;
  expenses: ExpenseItem[];
  totalAmount: number;
  currency: string;
};

export default function TeamApprovals() {
  const { data: session } = useSession();
  const [allReports, setAllReports] = useState<Report[]>([]);
  const [selected, setSelected] = useState<Report | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: "success" | "warning"; text: string } | null>(null);

  // Rejection modal state
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [reasonError, setReasonError] = useState("");

  // Filter to only this manager's reports
  const reports = allReports.filter(
    (r) => r.managerEmail.toLowerCase() === (session?.user?.email ?? "").toLowerCase()
  );

  useEffect(() => {
    fetchReports();
  }, []);

  // Auto-select first report when list loads
  useEffect(() => {
    if (reports.length > 0 && !selected) setSelected(reports[0]);
  }, [reports.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchReports = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/reports");
      const data = (await res.json()) as { reports?: Report[] };
      setAllReports(data.reports ?? []);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!selected) return;
    setActionLoading(true);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/reports/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      const data = (await res.json()) as { ok?: boolean; warning?: string; report?: Report };
      if (res.ok) {
        const updated = { ...selected, status: "approved" as const };
        setAllReports((prev) => prev.map((r) => (r.id === selected.id ? updated : r)));
        setSelected(updated);
        setActionMessage(
          data.warning
            ? { type: "warning", text: data.warning }
            : { type: "success", text: "Report approved. Employee has been notified by email." }
        );
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectSubmit = async () => {
    if (!selected) return;
    if (!rejectionReason.trim()) {
      setReasonError("Please provide a reason for rejection.");
      return;
    }
    setActionLoading(true);
    setReasonError("");
    setActionMessage(null);
    try {
      const res = await fetch(`/api/reports/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "rejected", reason: rejectionReason.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; warning?: string; report?: Report };
      if (res.ok) {
        const updated = { ...selected, status: "rejected" as const, rejectionReason: rejectionReason.trim() };
        setAllReports((prev) => prev.map((r) => (r.id === selected.id ? updated : r)));
        setSelected(updated);
        setShowRejectModal(false);
        setRejectionReason("");
        setActionMessage(
          data.warning
            ? { type: "warning", text: data.warning }
            : { type: "success", text: `Report rejected. ${selected.employeeName} has been notified by email with your reason.` }
        );
      }
    } finally {
      setActionLoading(false);
    }
  };

  const formatMoney = (amount: number, currency: string) => {
    const c = String(currency ?? "").trim().toUpperCase() || "USD";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: c, currencyDisplay: "code" }).format(amount);
    } catch {
      return `${c} ${amount.toFixed(2)}`;
    }
  };

  const formatDate = (iso: string) => {
    try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
    catch { return iso; }
  };

  const pending = reports.filter((r) => r.status === "pending");
  const totalSpend = reports.reduce((s, r) => s + r.totalAmount, 0);
  const rejected = reports.filter((r) => r.status === "rejected").length;

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950 text-white">

      {/* ── Rejection Reason Modal ── */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-8 w-full max-w-md shadow-2xl">
            <h2 className="text-lg font-bold text-white mb-1">Reject Report</h2>
            <p className="text-sm text-slate-400 mb-6">
              Provide a reason for rejecting <span className="text-white font-medium">"{selected?.name}"</span>.
              An email will be sent to <span className="text-white font-medium">{selected?.employeeName}</span> with your feedback.
            </p>
            <textarea
              value={rejectionReason}
              onChange={(e) => { setRejectionReason(e.target.value); setReasonError(""); }}
              placeholder="e.g. Missing receipt for the hotel stay on Oct 14. Please attach and resubmit."
              rows={4}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-red-500 resize-none"
              autoFocus
            />
            {reasonError && <p className="text-xs text-red-400 mt-2">{reasonError}</p>}
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowRejectModal(false); setRejectionReason(""); setReasonError(""); }}
                className="flex-1 py-2.5 rounded-xl border border-slate-700 text-slate-400 text-sm hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRejectSubmit}
                disabled={actionLoading}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                {actionLoading ? "Sending…" : "✕ Reject & Notify Employee"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SIDEBAR ── */}
      <aside className="w-64 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col">
        <div className="px-6 py-5 border-b border-slate-800">
          <Image src="/Logo.png" alt="NStarX logo" width={100} height={38} priority className="brightness-110" />
          <p className="text-[10px] tracking-widest text-slate-500 mt-1 uppercase">Expense Intelligence</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 text-sm">
          <Link href="/" className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <span className="text-lime-400">▣</span> Dashboard
          </Link>
          <Link href="/create-expense" className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <span>＋</span> My Expenses
          </Link>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-800 text-white font-medium">
            <div className="flex items-center gap-3">
              <span>👥</span> Team Approvals
            </div>
            {pending.length > 0 && (
              <span className="bg-yellow-400 text-slate-900 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {pending.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-default">
            <span>⚙</span> Settings
          </div>
        </nav>

        <div className="px-4 pb-6 space-y-3">
          <Link
            href="/create-expense"
            className="block w-full py-3 rounded-lg bg-lime-400 text-slate-900 font-bold text-sm tracking-wide hover:bg-lime-300 transition-colors text-center"
          >
            + New Report
          </Link>
          {session?.user && (
            <div className="flex items-center gap-3 px-1">
              {session.user.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={session.user.image} alt="" className="w-7 h-7 rounded-full shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-white font-medium truncate leading-tight">{session.user.name}</p>
                <p className="text-[10px] text-slate-500 truncate leading-tight">{session.user.email}</p>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                className="text-slate-500 hover:text-red-400 transition-colors text-xs shrink-0"
                title="Sign out"
              >
                ⏻
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 px-1 text-xs text-slate-500">
            <span>❓</span> Help Centre
          </div>
        </div>
      </aside>

      {/* ── MAIN ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Header */}
        <header className="shrink-0 bg-slate-900 border-b border-slate-800 px-8 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Manager Approval Hub</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Expense reports submitted by your direct reports for your review.
            </p>
          </div>
          <button
            onClick={fetchReports}
            className="text-xs text-slate-400 hover:text-white border border-slate-700 rounded-lg px-3 py-2 transition-colors"
          >
            ↻ Refresh
          </button>
        </header>

        {/* Action feedback banner */}
        {actionMessage && (
          <div className={`shrink-0 flex items-center justify-between px-8 py-3 text-sm border-b ${
            actionMessage.type === "success"
              ? "bg-lime-950 border-lime-800 text-lime-400"
              : "bg-yellow-950 border-yellow-800 text-yellow-400"
          }`}>
            <span>{actionMessage.type === "success" ? "✓" : "⚠"} {actionMessage.text}</span>
            <button onClick={() => setActionMessage(null)} className="text-xs opacity-60 hover:opacity-100 ml-4">✕</button>
          </div>
        )}

        {/* Stats bar */}
        <div className="shrink-0 grid grid-cols-4 divide-x divide-slate-800 border-b border-slate-800 bg-slate-900">
          {[
            { label: "Pending Approval", value: String(pending.length), sub: "reports", color: "text-yellow-400" },
            { label: "Total Submitted", value: String(reports.length), sub: "all time", color: "text-blue-400" },
            { label: "Total Team Spend", value: reports.length > 0 ? formatMoney(totalSpend, reports[0]?.currency ?? "USD") : "—", sub: "", color: "text-lime-400" },
            { label: "Rejected", value: String(rejected), sub: "reports", color: "text-red-400" },
          ].map((stat) => (
            <div key={stat.label} className="px-6 py-4">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">{stat.label}</p>
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
              {stat.sub && <p className="text-[10px] text-slate-500 mt-0.5">{stat.sub}</p>}
            </div>
          ))}
        </div>

        {/* Body: queue + detail */}
        <div className="flex flex-1 overflow-hidden">

          {/* Report Queue */}
          <div className="w-72 shrink-0 border-r border-slate-800 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Report Queue</span>
              <span className="text-[10px] text-slate-500">{reports.length} total</span>
            </div>
            <div className="flex-1 overflow-auto">
              {isLoading ? (
                <div className="flex items-center justify-center py-16 text-slate-500 text-sm">Loading…</div>
              ) : reports.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-500 text-sm px-6 text-center">
                  <p className="text-3xl mb-3">📭</p>
                  <p className="font-medium text-slate-400 mb-1">No reports yet</p>
                  <p className="text-xs">Expense reports submitted to you will appear here.</p>
                </div>
              ) : (
                reports.map((report) => (
                  <button
                    key={report.id}
                    onClick={() => setSelected(report)}
                    className={`w-full text-left px-4 py-4 border-b border-slate-800 hover:bg-slate-800/50 transition-colors ${
                      selected?.id === report.id ? "bg-slate-800 border-l-2 border-l-lime-400" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <p className="text-sm font-medium text-white leading-tight truncate">{report.name}</p>
                      <StatusBadge status={report.status} />
                    </div>
                    <p className="text-[11px] text-slate-400 mb-1">
                      {report.employeeName} · {formatDate(report.submittedAt)}
                    </p>
                    <p className="text-sm font-bold text-lime-400">
                      {formatMoney(report.totalAmount, report.currency)}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Report Detail */}
          <div className="flex-1 overflow-auto">
            {!selected ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500">
                <p className="text-4xl mb-4">📋</p>
                <p className="text-sm">Select a report from the queue to review</p>
              </div>
            ) : (
              <div className="px-8 py-6 space-y-6">

                {/* Report header + action buttons */}
                <div className="flex items-start justify-between gap-6">
                  <div>
                    <h2 className="text-2xl font-bold mb-1">{selected.name}</h2>
                    <div className="flex items-center gap-3 text-xs text-slate-400 flex-wrap">
                      <span>Submitted by <span className="text-white font-medium">{selected.employeeName}</span></span>
                      <span>·</span>
                      <span>{formatDate(selected.submittedAt)}</span>
                      <span>·</span>
                      <StatusBadge status={selected.status} />
                    </div>
                  </div>

                  {selected.status === "pending" && (
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        onClick={() => { setShowRejectModal(true); setRejectionReason(""); setReasonError(""); }}
                        disabled={actionLoading}
                        className="px-4 py-2 rounded-lg border border-red-700 text-red-400 text-sm font-medium hover:bg-red-900/30 transition-colors disabled:opacity-50"
                      >
                        ✕ Reject
                      </button>
                      <button
                        onClick={handleApprove}
                        disabled={actionLoading}
                        className="px-5 py-2 rounded-lg bg-lime-400 text-slate-900 text-sm font-bold hover:bg-lime-300 transition-colors disabled:opacity-50"
                      >
                        {actionLoading ? "Processing…" : "✓ Approve Report"}
                      </button>
                    </div>
                  )}
                  {selected.status === "approved" && (
                    <div className="px-4 py-2 rounded-lg bg-lime-950 border border-lime-700 text-lime-400 text-sm font-medium shrink-0">
                      ✓ Approved — employee notified
                    </div>
                  )}
                  {selected.status === "rejected" && (
                    <div className="px-4 py-2 rounded-lg bg-red-950 border border-red-700 text-red-400 text-sm font-medium shrink-0">
                      ✕ Rejected — employee notified
                    </div>
                  )}
                </div>

                {/* Rejection reason banner */}
                {selected.status === "rejected" && selected.rejectionReason && (
                  <div className="bg-red-950 border border-red-800 rounded-xl p-5">
                    <p className="text-xs font-semibold text-red-400 uppercase tracking-widest mb-2">Rejection Reason Sent to Employee</p>
                    <p className="text-sm text-red-300/80 leading-relaxed">{selected.rejectionReason}</p>
                  </div>
                )}

                {/* Summary cards */}
                <div className="grid grid-cols-4 gap-4">
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <p className="text-xs text-slate-400 mb-1">Employee</p>
                    <p className="font-semibold truncate">{selected.employeeName}</p>
                    <p className="text-[11px] text-slate-500 truncate">{selected.employeeEmail}</p>
                  </div>
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <p className="text-xs text-slate-400 mb-1">Submitted</p>
                    <p className="font-semibold">{formatDate(selected.submittedAt)}</p>
                  </div>
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <p className="text-xs text-slate-400 mb-1">Items</p>
                    <p className="font-semibold">{selected.expenses.length} receipt{selected.expenses.length !== 1 ? "s" : ""}</p>
                  </div>
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <p className="text-xs text-slate-400 mb-1">Total Amount</p>
                    <p className="font-bold text-lime-400">{formatMoney(selected.totalAmount, selected.currency)}</p>
                  </div>
                </div>

                {/* Line-item breakdown */}
                <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-800">
                    <h3 className="font-semibold text-sm">Line-Item Breakdown</h3>
                  </div>
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800">
                        <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Vendor</th>
                        <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">City</th>
                        <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Date</th>
                        <th className="px-6 py-3 text-right text-[10px] font-medium text-slate-500 uppercase tracking-wider">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {selected.expenses.map((exp, i) => (
                        <tr key={i} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-6 py-4">
                            <p className="font-medium text-white">{exp.vendor}</p>
                            <p className="text-xs text-slate-500 truncate max-w-[180px]">{exp.filename}</p>
                          </td>
                          <td className="px-6 py-4 text-slate-300">{exp.city || "—"}</td>
                          <td className="px-6 py-4 text-slate-300">{exp.date}</td>
                          <td className="px-6 py-4 text-right">
                            <p className="font-medium text-white">
                              {formatMoney(
                                typeof exp.convertedAmount === "number" ? exp.convertedAmount : exp.amount,
                                exp.convertedCurrency ?? exp.currency
                              )}
                            </p>
                            {exp.convertedCurrency && exp.currency !== exp.convertedCurrency && (
                              <p className="text-xs text-slate-500">{formatMoney(exp.amount, exp.currency)}</p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-700 bg-slate-900">
                        <td colSpan={3} className="px-6 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Total</td>
                        <td className="px-6 py-3 text-right font-bold text-lime-400">
                          {formatMoney(selected.totalAmount, selected.currency)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Report["status"] }) {
  const styles = {
    pending: "bg-yellow-900/50 text-yellow-400 border-yellow-700/50",
    approved: "bg-lime-900/50 text-lime-400 border-lime-700/50",
    rejected: "bg-red-900/50 text-red-400 border-red-700/50",
  };
  const labels = { pending: "Pending", approved: "Approved", rejected: "Rejected" };
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}
