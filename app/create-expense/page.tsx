"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession, signOut } from "next-auth/react";

type ReceiptAnalysis = {
  vendor: string;
  amount: number;
  date: string;
  city: string;
  currency: string;
  is_receipt: boolean;
  reason?: string;
};

type Expense = ReceiptAnalysis & {
  filename: string;
  mimeType: string;
  signature: string;
  contentHash: string;
  convertedAmount?: number;
  convertedCurrency?: string;
};

export default function CreateExpense() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [reportName, setReportName] = useState("");
  const [employeeName, setEmployeeName] = useState("");
  const [managerName, setManagerName] = useState("");
  const [managerEmail, setManagerEmail] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reviewWarnings, setReviewWarnings] = useState<string[]>([]);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [localCurrency, setLocalCurrency] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isLookingUpManager, setIsLookingUpManager] = useState(false);
  const [dismissedWarnings, setDismissedWarnings] = useState<Set<number>>(new Set());

  const expensesRef = useRef<Expense[]>([]);
  const { data: session } = useSession();

  useEffect(() => {
    if (session?.user?.name && !employeeName) {
      setEmployeeName(session.user.name);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    expensesRef.current = expenses;
  }, [expenses]);

  useEffect(() => {
    const loadLocalCurrency = async () => {
      try {
        const res = await fetch("/api/local-currency");
        const data = (await res.json()) as { currency?: string };
        const c = String(data.currency ?? "").trim().toUpperCase();
        setLocalCurrency(c || "USD");
      } catch {
        setLocalCurrency("USD");
      }
    };
    loadLocalCurrency();
  }, []);

  useEffect(() => {
    const employee = employeeName.trim();
    if (!employee) {
      setManagerName("");
      setManagerEmail("");
      return;
    }
    let cancelled = false;
    const timeoutId = setTimeout(async () => {
      try {
        setIsLookingUpManager(true);
        const res = await fetch(
          `/api/employee-lookup?employeeName=${encodeURIComponent(employee)}`
        );
        const data = (await res.json()) as {
          found?: boolean;
          managerName?: string;
          managerEmail?: string;
        };
        if (!cancelled && data.found) {
          setManagerName(String(data.managerName ?? ""));
          setManagerEmail(String(data.managerEmail ?? ""));
        }
      } catch {
        // keep manual values if lookup fails
      } finally {
        if (!cancelled) setIsLookingUpManager(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [employeeName]);

  // ── Run review whenever expenses change ───────────────────────────
  useEffect(() => {
    if (expenses.length === 0) {
      setReviewWarnings([]);
      setDismissedWarnings(new Set());
      return;
    }
    const { warnings } = initialReview(expenses);
    setReviewWarnings(warnings);
    setDismissedWarnings(new Set()); // reset dismissals when expenses change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenses]);

  const parseReceiptDate = (value: string): Date | null => {
    const v = String(value ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const [y, m, d] = v.split("-").map((x) => Number(x));
    if (!y || !m || !d) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  };

  const initialReview = (list: Expense[]) => {
    const warnings: string[] = [];
    if (list.length === 0) return { warnings: [], note: null };

    const cities = list.map((x) => String(x.city ?? "").trim().toLowerCase()).filter(Boolean);
    if (cities.length > 0) {
      const counts = new Map<string, number>();
      for (const c of cities) counts.set(c, (counts.get(c) ?? 0) + 1);
      const dominantCity = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (dominantCity) {
        for (const exp of list) {
          const cityNorm = String(exp.city ?? "").trim().toLowerCase();
          if (!cityNorm) continue;
          if (cityNorm !== dominantCity) {
            warnings.push(
              `Location mismatch: "${exp.vendor}" looks like ${exp.city} while most receipts are from ${dominantCity}.`
            );
          }
        }
      }
    } else {
      warnings.push("Could not detect cities from receipts — location review may be inaccurate.");
    }

    const dates = list
      .map((x) => ({ exp: x, dt: parseReceiptDate(x.date) }))
      .filter((x): x is { exp: Expense; dt: Date } => Boolean(x.dt));
    if (dates.length >= 2) {
      const sorted = [...dates].sort((a, b) => a.dt.getTime() - b.dt.getTime());
      const mid = Math.floor(sorted.length / 2);
      const medianMs =
        sorted.length % 2 === 0
          ? (sorted[mid - 1].dt.getTime() + sorted[mid].dt.getTime()) / 2
          : sorted[mid].dt.getTime();
      const msPerDay = 24 * 60 * 60 * 1000;
      for (const { exp, dt } of dates) {
        const diffDays = Math.abs(dt.getTime() - medianMs) / msPerDay;
        if (diffDays > 30) {
          warnings.push(
            `Date outlier: "${exp.vendor}" is dated ${exp.date}, far from the other receipts.`
          );
        }
      }
    } else if (dates.length === 1) {
      warnings.push("Only one receipt date found — outlier detection may be inaccurate.");
    } else if (list.length > 0) {
      warnings.push("Could not detect valid dates from receipts.");
    }

    const note =
      warnings.length === 0
        ? "Initial review looks good."
        : `Initial review found ${warnings.length} potential issue(s).`;
    return { warnings, note };
  };

  const formatMoney = (amount: number, currency: string) => {
    const c = String(currency ?? "").trim().toUpperCase() || "USD";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: c,
        currencyDisplay: "code",
      }).format(amount);
    } catch {
      return `${c} ${amount.toFixed(2)}`;
    }
  };

  const getDominantReceiptCurrency = (list: Expense[]) => {
    const counts = new Map<string, number>();
    for (const exp of list) {
      const c = String(exp.currency ?? "").trim().toUpperCase();
      if (!c) continue;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsAnalyzing(true);

    const getFileHash = async (file: File) => {
      const bytes = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    };

    try {
      for (const file of Array.from(files)) {
        let contentHash = "";
        if (expensesRef.current.some((exp) => exp.filename === file.name)) {
          alert(`${file.name} is already in the list.`);
          continue;
        }
        try {
          contentHash = await getFileHash(file);
          const existingByHash = expensesRef.current.find(
            (exp) =>
              exp.contentHash === contentHash &&
              (exp.filename !== file.name || exp.mimeType !== file.type)
          );
          if (existingByHash) {
            const ok = window.confirm(
              `This file appears to have the exact same content as "${existingByHash.filename}" but a different name/type.\n\nAdd it anyway?`
            );
            if (!ok) continue;
          }
        } catch {
          // If hashing fails, continue with semantic duplicate checks.
        }

        const formData = new FormData();
        formData.append("file", file);
        try {
          const response = await fetch("/api/analyze", { method: "POST", body: formData });
          const data = (await response.json()) as Partial<ReceiptAnalysis> & { is_receipt?: boolean };
          if (data.is_receipt) {
            const vendorNorm = String(data.vendor ?? "").trim().toLowerCase();
            const dateNorm = String(data.date ?? "").trim();
            const amountNum = Number(data.amount);
            const amountNorm = Number.isFinite(amountNum) ? amountNum.toFixed(2) : "";
            const signature = `${vendorNorm}|${dateNorm}|${amountNorm}`;
            const existing = expensesRef.current.find(
              (exp) => exp.signature === signature && (exp.filename !== file.name || exp.mimeType !== file.type)
            );
            if (existing) {
              const ok = window.confirm(
                `This receipt matches "${existing.filename}" (same vendor/date/amount).\n\nAdd it anyway?`
              );
              if (!ok) continue;
            }
            if (!Number.isFinite(amountNum)) { console.error("Invalid amount:", data.amount); continue; }
            if (!contentHash) contentHash = await getFileHash(file);
            const detectedCurrency = String(data.currency ?? "").trim().toUpperCase() || "USD";
            let convertedAmount: number | undefined;
            let convertedCurrency: string | undefined;
            if (detectedCurrency !== "USD") {
              try {
                const res = await fetch("/api/convert", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ from: detectedCurrency, to: "USD", amount: amountNum }),
                });
                const convData = (await res.json()) as { convertedAmount?: number } | { error?: string };
                if (res.ok && "convertedAmount" in convData && typeof convData.convertedAmount === "number") {
                  convertedAmount = convData.convertedAmount;
                  convertedCurrency = "USD";
                }
              } catch { /* fallback to original */ }
            }
            setExpenses((prev) => [
              ...prev,
              {
                vendor: String(data.vendor ?? ""),
                date: String(data.date ?? ""),
                city: String(data.city ?? ""),
                currency: detectedCurrency,
                amount: amountNum,
                convertedAmount,
                convertedCurrency,
                is_receipt: true,
                filename: file.name,
                mimeType: file.type,
                signature,
                contentHash,
              },
            ]);
          } else {
            console.error("Not a receipt:", data.reason);
          }
        } catch (error) {
          console.error("Upload failed:", error);
        }
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSubmit = async () => {
    setHasSubmitted(false);
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      if (!employeeName.trim() || !managerName.trim() || !managerEmail.trim()) {
        setSubmitError("Employee must exist in the employee list with manager details.");
        return;
      }
      const shouldProceed =
        activeWarnings.length === 0
          ? true
          : window.confirm(`${activeWarnings.length} issue(s) found.\n\nDo you still want to proceed?`);
      if (!shouldProceed) return;

      const toCurrency = "USD";
      const list = expensesRef.current;
      const converted = await Promise.all(
        list.map(async (exp) => {
          if (exp.convertedCurrency === "USD") return { filename: exp.filename, convertedAmount: exp.convertedAmount ?? exp.amount, convertedCurrency: "USD" };
          if (exp.currency === toCurrency) return { filename: exp.filename, convertedAmount: exp.amount, convertedCurrency: toCurrency };
          try {
            const res = await fetch("/api/convert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ from: exp.currency, to: toCurrency, amount: exp.amount }),
            });
            const data = (await res.json()) as { convertedAmount?: number } | { error?: string };
            if (res.ok && "convertedAmount" in data && typeof data.convertedAmount === "number") {
              return { filename: exp.filename, convertedAmount: data.convertedAmount, convertedCurrency: toCurrency };
            }
          } catch { /* fallback to original */ }
          return { filename: exp.filename, convertedAmount: exp.amount, convertedCurrency: exp.currency };
        })
      );
      const convertedByFile = new Map(converted.map((item) => [item.filename, item] as const));
      const finalExpenses = list.map((exp) => {
        const match = convertedByFile.get(exp.filename);
        return match ? { ...exp, convertedAmount: match.convertedAmount, convertedCurrency: match.convertedCurrency } : exp;
      });
      setExpenses(finalExpenses);

      const submitResponse = await fetch("/api/submit-expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportName: reportName.trim() || "Untitled Report",
          employeeName: employeeName.trim(),
          employeeEmail: session?.user?.email ?? "",
          managerName: managerName.trim(),
          managerEmail: managerEmail.trim(),
          expenses: finalExpenses,
        }),
      });
      if (!submitResponse.ok) {
        const errorData = (await submitResponse.json()) as { error?: string; details?: string };
        setSubmitError(
          errorData.error
            ? `${errorData.error}${errorData.details ? ` (${errorData.details})` : ""}`
            : "Failed to email expenses to manager."
        );
        return;
      }
      setHasSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const removeExpense = (filename: string) => {
    setExpenses((prev) => prev.filter((exp) => exp.filename !== filename));
  };

  const totalAmount = expenses.reduce(
    (sum, exp) => sum + (typeof exp.convertedAmount === "number" ? exp.convertedAmount : exp.amount),
    0
  );
  const displayCurrency =
    expenses.length > 0
      ? (expenses[0].convertedCurrency ?? expenses[0].currency ?? localCurrency ?? "USD")
      : (localCurrency ?? "USD");
  const activeWarnings = reviewWarnings.filter((_, i) => !dismissedWarnings.has(i));

  const canSubmit =
    !isAnalyzing && !isSubmitting && expenses.length > 0 &&
    !!employeeName.trim() && !!managerName.trim() && !!managerEmail.trim() &&
    activeWarnings.length === 0;

  const resolvedCount = dismissedWarnings.size;
  const totalIssues = reviewWarnings.length + (submitError ? 1 : 0);
  const resolvedTotal = resolvedCount + (hasSubmitted ? 1 : 0);
  const confidencePct = totalIssues === 0
    ? (expenses.length > 0 ? 100 : 0)
    : Math.round((resolvedTotal / totalIssues) * 100);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950 text-white">

      {/* ── LEFT SIDEBAR ── */}
      <aside className="w-64 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col">
        <div className="px-6 py-5 border-b border-slate-800">
          <Image src="/Logo.png" alt="NStarX logo" width={100} height={38} priority className="brightness-110" />
          <p className="text-[10px] tracking-widest text-slate-500 mt-1 uppercase">Expense Intelligence</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 text-sm">
          <Link href="/" className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <span className="text-lime-400">▣</span> Dashboard
          </Link>
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800 text-white font-medium">
            <span>＋</span> Create Expense
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-default">
            <span>👥</span> Team Approvals
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-default">
            <span>⚙</span> Settings
          </div>
        </nav>

        <div className="px-4 pb-6 space-y-3">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={
              activeWarnings.length > 0
                ? `Dismiss ${activeWarnings.length} issue${activeWarnings.length !== 1 ? "s" : ""} in the Smart Review Gate first`
                : undefined
            }
            className="w-full py-3 rounded-lg bg-lime-400 text-slate-900 font-bold text-sm tracking-wide disabled:opacity-40 disabled:cursor-not-allowed hover:bg-lime-300 transition-colors"
          >
            {isSubmitting ? "Submitting…" : "+ Submit Report"}
          </button>
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

      {/* ── MAIN + RIGHT PANEL ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar */}
        <header className="shrink-0 bg-slate-900 border-b border-slate-800 px-8 py-4 flex items-center justify-between gap-6">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold">AI Expense Creator</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Upload invoices and let AI extract expense details instantly.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {/* Report Name */}
            <input
              type="text"
              value={reportName}
              onChange={(e) => setReportName(e.target.value)}
              placeholder="Report name (e.g. Tokyo Client Visit)…"
              className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-lime-400 w-64"
            />
            {/* Employee Name */}
            <div className="relative">
              <input
                type="text"
                value={employeeName}
                onChange={(e) => setEmployeeName(e.target.value)}
                placeholder="Your name…"
                className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-lime-400 w-40"
              />
              {isLookingUpManager && (
                <span className="absolute right-3 top-2.5 text-xs text-lime-400 animate-pulse">↻</span>
              )}
            </div>
            {managerName && (
              <div className="text-xs text-slate-400 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 whitespace-nowrap">
                Manager: <span className="text-white font-medium">{managerName}</span>
              </div>
            )}
          </div>
        </header>

        {/* Content row: main + smart review gate */}
        <div className="flex flex-1 overflow-hidden">

          {/* Scrollable main area */}
          <div className="flex-1 overflow-auto px-8 py-6 space-y-6">

            {/* ── STAT CARDS ── */}
            <div className="grid grid-cols-3 gap-5">
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="bg-slate-800 rounded-lg p-2 text-lg">💳</div>
                  <span className="text-[10px] tracking-widest text-slate-500 uppercase">Monthly</span>
                </div>
                <p className="text-xs text-slate-400 mb-1">Total Spent</p>
                <p className="text-2xl font-bold">{formatMoney(totalAmount, displayCurrency)}</p>
                <div className="mt-3 h-1 rounded-full bg-slate-800">
                  <div className="h-1 rounded-full bg-lime-400 w-3/4" />
                </div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="bg-slate-800 rounded-lg p-2 text-lg">🧾</div>
                  <span className="text-[10px] tracking-widest text-slate-500 uppercase">Session</span>
                </div>
                <p className="text-xs text-slate-400 mb-1">Total Invoices</p>
                <p className="text-2xl font-bold">{expenses.length}</p>
                <div className="mt-3 h-1 rounded-full bg-slate-800">
                  <div className="h-1 rounded-full bg-blue-400" style={{ width: `${Math.min(expenses.length * 10, 100)}%` }} />
                </div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="bg-slate-800 rounded-lg p-2 text-lg">🕐</div>
                  <span className="text-[10px] tracking-widest text-slate-500 uppercase">
                    {hasSubmitted ? "Done" : "Processing"}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mb-1">Report Status</p>
                <p className="text-2xl font-bold">{hasSubmitted ? "Submitted" : "Draft"}</p>
                <div className="mt-3 flex gap-1">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className={`h-1 flex-1 rounded-full ${hasSubmitted ? "bg-lime-400" : i === 0 ? "bg-yellow-400" : "bg-slate-800"}`} />
                  ))}
                </div>
              </div>
            </div>

            {/* ── EXPENSE TABLE ── */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
                <h2 className="font-semibold text-sm">Uploaded Invoices</h2>
                <div className="flex items-center gap-3">
                  {isAnalyzing && (
                    <span className="text-xs text-lime-400 animate-pulse">AI analysing…</span>
                  )}
                  <label className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-white px-3 py-2 rounded-lg cursor-pointer transition-colors">
                    <span>↑</span> Upload Invoice
                    <input type="file" multiple onChange={handleFileUpload} className="hidden" />
                  </label>
                </div>
              </div>
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Vendor</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">City</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Date</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Amount</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Status</th>
                    <th className="px-6 py-3 text-right text-[10px] font-medium text-slate-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {expenses.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500 text-sm">
                        No invoices yet. Upload one to get started.
                      </td>
                    </tr>
                  ) : (
                    expenses.map((exp) => (
                      <tr key={exp.filename} className="hover:bg-slate-800/50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-medium text-white">{exp.vendor}</div>
                          <div className="text-xs text-slate-500 truncate max-w-[160px]">{exp.filename}</div>
                        </td>
                        <td className="px-6 py-4 text-slate-300">{exp.city || "—"}</td>
                        <td className="px-6 py-4 text-slate-300">{exp.date}</td>
                        <td className="px-6 py-4">
                          <div className="text-white font-medium">
                            {formatMoney(
                              typeof exp.convertedAmount === "number" ? exp.convertedAmount : exp.amount,
                              exp.convertedCurrency ?? exp.currency ?? localCurrency ?? "USD"
                            )}
                          </div>
                          {exp.convertedCurrency && exp.currency !== exp.convertedCurrency && (
                            <div className="text-xs text-slate-500">{formatMoney(exp.amount, exp.currency)}</div>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {hasSubmitted ? (
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-lime-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-lime-400 inline-block" /> Submitted
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 inline-block" /> Draft
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => removeExpense(exp.filename)}
                            className="text-slate-500 hover:text-red-400 transition-colors text-xs font-medium"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              {expenses.length > 0 && (
                <div className="px-6 py-3 border-t border-slate-800 text-xs text-slate-500">
                  Showing {expenses.length} invoice{expenses.length !== 1 ? "s" : ""}
                </div>
              )}
            </div>

            {/* ── BOTTOM UPLOAD CARD ── */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex items-center justify-between gap-6">
              <div>
                <h3 className="font-semibold mb-1">AI Receipt Analysis</h3>
                <p className="text-sm text-slate-400 mb-4">
                  Upload invoices and let AI automatically extract vendor, amount, date, city, and currency.
                </p>
                <label className="inline-flex items-center gap-2 bg-lime-400 text-slate-900 font-bold text-sm px-4 py-2.5 rounded-lg cursor-pointer hover:bg-lime-300 transition-colors">
                  ⚡ Upload Invoices
                  <input type="file" multiple onChange={handleFileUpload} className="hidden" />
                </label>
              </div>
              <div className="text-5xl opacity-20 select-none">★</div>
            </div>

          </div>

          {/* ── SMART REVIEW GATE (right panel) ── */}
          <aside className="w-72 shrink-0 bg-slate-900 border-l border-slate-800 flex flex-col overflow-hidden">

            {/* Panel header */}
            <div className="px-5 py-4 border-b border-slate-800">
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-bold text-sm">Smart Review Gate</h2>
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                  expenses.length > 0 ? "bg-lime-400/10 text-lime-400" : "bg-slate-800 text-slate-500"
                }`}>
                  {expenses.length > 0 ? "● ACTIVE" : "○ IDLE"}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                AI has analyzed your report. Address the flags below before final submission.
              </p>
            </div>

            {/* Issues list */}
            <div className="flex-1 overflow-auto px-4 py-4 space-y-3">

              {/* Success state */}
              {hasSubmitted && (
                <div className="bg-lime-950 border border-lime-700 rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <span className="text-lime-400 text-lg mt-0.5">✓</span>
                    <div>
                      <p className="text-xs font-semibold text-lime-400 mb-1">Report Submitted</p>
                      <p className="text-[11px] text-lime-300/70 leading-relaxed">
                        Excel report emailed to {managerName} ({managerEmail}).
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Submit error */}
              {submitError && (
                <div className="bg-red-950 border border-red-700 rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <span className="text-red-400 text-base mt-0.5">✕</span>
                    <div className="flex-1">
                      <p className="text-xs font-semibold text-red-400 mb-1">Submission Error</p>
                      <p className="text-[11px] text-red-300/70 leading-relaxed">{submitError}</p>
                      <button
                        onClick={() => setSubmitError(null)}
                        className="mt-2 text-[10px] font-medium text-red-400 border border-red-700 rounded-lg px-2 py-1 hover:bg-red-900 transition-colors"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* No issues */}
              {expenses.length > 0 && activeWarnings.length === 0 && !submitError && !hasSubmitted && (
                <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 text-center">
                  <p className="text-2xl mb-2">✅</p>
                  <p className="text-xs font-semibold text-slate-300 mb-1">All Clear</p>
                  <p className="text-[11px] text-slate-500">No issues detected. Ready to submit.</p>
                </div>
              )}

              {/* Idle state */}
              {expenses.length === 0 && !submitError && !hasSubmitted && (
                <div className="text-center py-8">
                  <p className="text-3xl mb-3 opacity-30">🔍</p>
                  <p className="text-xs text-slate-500">Upload invoices to activate AI review.</p>
                </div>
              )}

              {/* Warning cards */}
              {activeWarnings.map((warning, idx) => {
                const originalIdx = reviewWarnings.indexOf(warning);
                const isLocationIssue = warning.toLowerCase().includes("location") || warning.toLowerCase().includes("city");
                const isDateIssue = warning.toLowerCase().includes("date");
                return (
                  <div key={originalIdx} className="bg-yellow-950/60 border border-yellow-700/60 rounded-xl p-4">
                    <div className="flex items-start gap-3">
                      <span className="text-yellow-400 text-base mt-0.5 shrink-0">
                        {isLocationIssue ? "📍" : isDateIssue ? "📅" : "⚠"}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <p className="text-[11px] font-semibold text-yellow-400">
                            {isLocationIssue ? "Location Mismatch" : isDateIssue ? "Date Outlier" : "Review Flag"}
                          </p>
                          <span className="text-[9px] font-medium text-yellow-600 bg-yellow-900/50 px-1.5 py-0.5 rounded shrink-0">
                            ACTION NEEDED
                          </span>
                        </div>
                        <p className="text-[11px] text-yellow-300/70 leading-relaxed">{warning}</p>
                        <button
                          onClick={() => setDismissedWarnings((prev) => new Set([...prev, originalIdx]))}
                          className="mt-2 text-[10px] font-medium text-yellow-500 border border-yellow-700/50 rounded-lg px-2 py-1 hover:bg-yellow-900/30 transition-colors"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Submit gate notice */}
            {activeWarnings.length > 0 && (
              <div className="mx-4 mb-2 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-center">
                <p className="text-[11px] text-slate-400">
                  Dismiss <span className="text-yellow-400 font-semibold">{activeWarnings.length} issue{activeWarnings.length !== 1 ? "s" : ""}</span> to unlock submission
                </p>
              </div>
            )}

            {/* AI Confidence footer */}
            <div className="px-5 py-4 border-t border-slate-800 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Issues Resolved</span>
                <span className="font-medium text-white">{resolvedTotal}/{totalIssues || "—"}</span>
              </div>
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-slate-500">AI Confidence</span>
                  <span className={`font-bold ${confidencePct >= 80 ? "text-lime-400" : confidencePct >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                    {expenses.length > 0 ? `${confidencePct}%` : "—"}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-800">
                  <div
                    className={`h-1.5 rounded-full transition-all duration-500 ${
                      confidencePct >= 80 ? "bg-lime-400" : confidencePct >= 50 ? "bg-yellow-400" : "bg-red-400"
                    }`}
                    style={{ width: expenses.length > 0 ? `${confidencePct}%` : "0%" }}
                  />
                </div>
              </div>
            </div>

          </aside>

        </div>
      </div>
    </div>
  );
}
