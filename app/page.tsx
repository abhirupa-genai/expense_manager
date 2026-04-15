"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";

type Report = {
  id: string;
  name: string;
  employeeName: string;
  submittedAt: string;
  status: "pending" | "approved" | "rejected";
  totalAmount: number;
  currency: string;
  expenses: { vendor: string }[];
};

export default function Dashboard() {
  const { data: session } = useSession();
  const [reports, setReports] = useState<Report[]>([]);

  useEffect(() => {
    fetch("/api/reports")
      .then((r) => r.json())
      .then((d: { reports?: Report[] }) => setReports(d.reports ?? []))
      .catch(() => {});
  }, []);

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

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950 text-white">

      {/* ── SIDEBAR ── */}
      <aside className="w-64 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col">
        <div className="px-6 py-5 border-b border-slate-800">
          <Image src="/Logo.png" alt="NStarX logo" width={100} height={38} priority className="brightness-110" />
          <p className="text-[10px] tracking-widest text-slate-500 mt-1 uppercase">Expense Intelligence</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 text-sm">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800 text-white font-medium">
            <span className="text-lime-400">▣</span> Dashboard
          </div>
          <Link href="/create-expense" className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <span>＋</span> My Expenses
          </Link>
          <Link href="/team-approvals" className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <span>👥</span> Team Approvals
          </Link>
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-default">
            <span>⚙</span> Settings
          </div>
        </nav>

        <div className="px-4 pb-6 space-y-3">
          <Link
            href="/create-expense"
            className="block w-full py-3 rounded-lg bg-lime-400 text-slate-900 font-bold text-sm tracking-wide hover:bg-lime-300 transition-colors text-center"
          >
            + New Expense Report
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

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar */}
        <header className="shrink-0 bg-slate-900 border-b border-slate-800 px-8 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Employee Dashboard</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Welcome back{session?.user?.name ? `, ${session.user.name.split(" ")[0]}` : ""}. Manage your expense lifecycle.
            </p>
          </div>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-auto px-8 py-8 space-y-8">

          {/* Welcome card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 flex items-center justify-between gap-8">
            <div className="max-w-lg">
              <p className="text-[10px] tracking-widest text-lime-400 uppercase mb-2">AI-Powered</p>
              <h2 className="text-2xl font-bold mb-3">Ready to submit your expenses?</h2>
              <p className="text-slate-400 text-sm leading-relaxed mb-6">
                Upload your invoices and receipts — our AI will instantly extract vendor, amount, date,
                city, and currency. Review, then submit directly to your manager.
              </p>
              <Link
                href="/create-expense"
                className="inline-flex items-center gap-2 bg-lime-400 text-slate-900 font-bold text-sm px-6 py-3 rounded-xl hover:bg-lime-300 transition-colors"
              >
                ⚡ Create New Expense Report
              </Link>
            </div>
            <div className="text-8xl opacity-10 select-none shrink-0">★</div>
          </div>

          {/* Quick action cards */}
          <div className="grid grid-cols-3 gap-5">
            <Link href="/create-expense" className="group bg-slate-900 border border-slate-800 hover:border-lime-400/40 rounded-xl p-6 transition-colors">
              <div className="bg-slate-800 rounded-lg p-3 text-xl w-fit mb-4 group-hover:bg-lime-400/10 transition-colors">⚡</div>
              <h3 className="font-semibold mb-1">Upload Invoices</h3>
              <p className="text-xs text-slate-400">AI extracts details from your receipts automatically.</p>
            </Link>
            <Link href="/team-approvals" className="group bg-slate-900 border border-slate-800 hover:border-lime-400/40 rounded-xl p-6 transition-colors">
              <div className="bg-slate-800 rounded-lg p-3 text-xl w-fit mb-4 group-hover:bg-lime-400/10 transition-colors">👥</div>
              <h3 className="font-semibold mb-1">Team Approvals</h3>
              <p className="text-xs text-slate-400">Review and approve submitted expense reports.</p>
            </Link>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 opacity-50 cursor-default">
              <div className="bg-slate-800 rounded-lg p-3 text-xl w-fit mb-4">📊</div>
              <h3 className="font-semibold mb-1">Global Dashboard</h3>
              <p className="text-xs text-slate-400">Company-wide expense analytics and reporting.</p>
            </div>
          </div>

          {/* Recent Reports */}
          {reports.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
                <h2 className="font-semibold text-sm">Recent Expense Reports</h2>
                <Link href="/team-approvals" className="text-xs text-lime-400 hover:underline">View all →</Link>
              </div>
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Report Name</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Employee</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Date</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Total</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {reports.slice(0, 5).map((r) => (
                    <tr key={r.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="px-6 py-4">
                        <p className="font-medium text-white">{r.name}</p>
                        <p className="text-xs text-slate-500">{r.expenses.length} item{r.expenses.length !== 1 ? "s" : ""}</p>
                      </td>
                      <td className="px-6 py-4 text-slate-300">{r.employeeName}</td>
                      <td className="px-6 py-4 text-slate-300">{formatDate(r.submittedAt)}</td>
                      <td className="px-6 py-4 font-medium text-lime-400">{formatMoney(r.totalAmount, r.currency)}</td>
                      <td className="px-6 py-4">
                        <span className={`text-[10px] font-medium px-2 py-1 rounded-full border ${
                          r.status === "approved" ? "bg-lime-900/50 text-lime-400 border-lime-700/50"
                          : r.status === "rejected" ? "bg-red-900/50 text-red-400 border-red-700/50"
                          : "bg-yellow-900/50 text-yellow-400 border-yellow-700/50"
                        }`}>
                          {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Info strip */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl px-6 py-4 flex items-center gap-6 text-sm">
            <span className="text-slate-500 text-xs">HOW IT WORKS</span>
            {[
              { icon: "📎", label: "Upload invoices" },
              { icon: "→", label: "" },
              { icon: "🤖", label: "AI extracts data" },
              { icon: "→", label: "" },
              { icon: "✅", label: "Review & submit" },
              { icon: "→", label: "" },
              { icon: "📧", label: "Manager notified" },
            ].map((step, i) => (
              <span key={i} className={step.icon === "→" ? "text-slate-700" : "flex items-center gap-2 text-slate-300"}>
                <span>{step.icon}</span>
                {step.label && <span className="text-xs">{step.label}</span>}
              </span>
            ))}
          </div>

        </div>
      </div>
    </div>
  );
}
