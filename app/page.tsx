"use client"; // Required for interactive buttons and state

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

type ReceiptAnalysis = {
  vendor: string;
  amount: number;
  date: string;
  city: string;
  currency: string;
  is_receipt: boolean;
  // Optional field if the server returns a non-receipt response
  reason?: string;
};

type Expense = ReceiptAnalysis & {
  filename: string;
  mimeType: string;
  signature: string;
  contentHash: string;
  // Converted amount into the user's local currency (computed on Submit)
  convertedAmount?: number;
  convertedCurrency?: string;
};

export default function ExpenseManager() {
  // 1. STATE: This is our local "database" for the current session
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [employeeName, setEmployeeName] = useState("");
  const [managerName, setManagerName] = useState("");
  const [managerEmail, setManagerEmail] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reviewWarnings, setReviewWarnings] = useState<string[]>([]);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [localCurrency, setLocalCurrency] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isLookingUpManager, setIsLookingUpManager] = useState(false);

  const expensesRef = useRef<Expense[]>([]);

  useEffect(() => {
    expensesRef.current = expenses;
  }, [expenses]);

  useEffect(() => {
    // Best-effort detection of local currency from IP.
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

  // 2. UPLOAD HANDLER
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsAnalyzing(true);

    const getFileHash = async (file: File) => {
      // Browser-only SHA-256 hash for exact-content duplicate detection.
      const bytes = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    };

    try {
      for (const file of Array.from(files)) {
        let contentHash = "";

        // Basic Validation: Don't process the same filename twice in one session
        if (expensesRef.current.some((exp) => exp.filename === file.name)) {
          alert(`${file.name} is already in the list.`);
          continue;
        }

        // Exact duplicate check by file bytes, even if filename/type differ.
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
          // If hashing fails, continue with existing semantic duplicate checks.
        }

        const formData = new FormData();
        formData.append("file", file);

        try {
          // Send to our route.ts
          const response = await fetch("/api/analyze", {
            method: "POST",
            body: formData,
          });

          const data = (await response.json()) as Partial<ReceiptAnalysis> & {
            is_receipt?: boolean;
          };

          if (data.is_receipt) {
            // Build a stable fingerprint from extracted receipt data
            const vendorNorm = String(data.vendor ?? "")
              .trim()
              .toLowerCase();
            const dateNorm = String(data.date ?? "").trim();

            const amountNum = Number(data.amount);
            const amountNorm = Number.isFinite(amountNum)
              ? amountNum.toFixed(2)
              : "";

            const signature = `${vendorNorm}|${dateNorm}|${amountNorm}`;

            // Same info (signature) but different filename and/or MIME type
            const existing = expensesRef.current.find(
              (exp) =>
                exp.signature === signature &&
                (exp.filename !== file.name || exp.mimeType !== file.type)
            );

            if (existing) {
              const ok = window.confirm(
                `This receipt matches "${existing.filename}" (same vendor/date/amount), but your new file has a different name/type.\n\nAdd it anyway?`
              );
              if (!ok) continue; // user said "skip"
            }

            if (!Number.isFinite(amountNum)) {
              console.error("Invalid amount from receipt:", data.amount);
              continue;
            }

            if (!contentHash) {
              contentHash = await getFileHash(file);
            }

            setExpenses((prev) => [
              ...prev,
              {
                vendor: String(data.vendor ?? ""),
                date: String(data.date ?? ""),
                city: String(data.city ?? ""),
                currency: String(data.currency ?? "").trim().toUpperCase() || "USD",
                amount: amountNum,
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

  const parseReceiptDate = (value: string): Date | null => {
    // Expecting "YYYY-MM-DD" from the API prompt
    const v = String(value ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const [y, m, d] = v.split("-").map((x) => Number(x));
    if (!y || !m || !d) return null;
    // Use UTC to avoid timezone shifts changing the day
    const dt = new Date(Date.UTC(y, m - 1, d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  };

  const initialReview = (list: Expense[]) => {
    const warnings: string[] = [];

    if (list.length === 0) {
      return { warnings: ["No receipts submitted."], note: null };
    }

    // -------- Location / city sanity check --------
    const cities = list
      .map((x) => String(x.city ?? "").trim().toLowerCase())
      .filter(Boolean);

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
              `Possible location mismatch: "${exp.filename}" looks like "${exp.city}" while most receipts look like "${dominantCity}".`
            );
          }
        }
      }
    } else {
      warnings.push(
        "Could not detect cities from receipts (location review may be inaccurate)."
      );
    }

    // -------- Date sanity check --------
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
      const thresholdDays = 30; // "way before/after" heuristic

      for (const { exp, dt } of dates) {
        const diffDays = Math.abs(dt.getTime() - medianMs) / msPerDay;
        if (diffDays > thresholdDays) {
          warnings.push(
            `Possible date mismatch: "${exp.filename}" has date ${exp.date}, which is far from the rest of the submitted dates.`
          );
        }
      }
    } else if (dates.length === 1) {
      warnings.push(
        "Only one valid receipt date found; date outlier review may be inaccurate."
      );
    } else {
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
      const c = String(exp.currency ?? "")
        .trim()
        .toUpperCase();
      if (!c) continue;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return dominant || null;
  };

  const handleSubmit = async () => {
    setHasSubmitted(false);
    setIsSubmitting(true);
    setSubmitError(null);
    setReviewWarnings([]);
    setReviewNote(null);

    try {
      if (!employeeName.trim() || !managerName.trim() || !managerEmail.trim()) {
        setSubmitError(
          "Employee must exist in employee list with manager details before submitting."
        );
        return;
      }

      const { warnings, note } = initialReview(expensesRef.current);
      setReviewWarnings(warnings);
      setReviewNote(note);

      // If we have issues, we still let the user proceed, but we warn them first.
      const shouldProceed = warnings.length === 0
        ? true
        : window.confirm(
            `${note}\n\nDo you still want to proceed?`
          );

      if (!shouldProceed) return;

      // Convert amounts into the dominant currency detected from the submitted receipts.
      // This avoids IP-based mismatches (e.g., CAD invoices showing as USD because of your location).
      const dominantReceiptCurrency = getDominantReceiptCurrency(expensesRef.current);
      const toCurrency = dominantReceiptCurrency ?? localCurrency ?? "USD";
      const list = expensesRef.current;

      // Convert each expense; if conversion fails, keep the original amount.
      const converted = await Promise.all(
        list.map(async (exp) => {
          if (exp.currency === toCurrency) {
            return {
              filename: exp.filename,
              convertedAmount: exp.amount,
              convertedCurrency: toCurrency,
            };
          }

          try {
            const res = await fetch("/api/convert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                from: exp.currency,
                to: toCurrency,
                amount: exp.amount,
              }),
            });

            const data = (await res.json()) as
              | { convertedAmount?: number }
              | { error?: string };

            if (
              res.ok &&
              "convertedAmount" in data &&
              typeof data.convertedAmount === "number"
            ) {
              return {
                filename: exp.filename,
                convertedAmount: data.convertedAmount,
                convertedCurrency: toCurrency,
              };
            }
          } catch {
            // ignore and fallback to original
          }

          return {
            filename: exp.filename,
            convertedAmount: exp.amount,
            convertedCurrency: exp.currency,
          };
        })
      );

      const convertedByFile = new Map(
        converted.map((item) => [item.filename, item] as const)
      );

      const finalExpenses = list.map((exp) => {
        const match = convertedByFile.get(exp.filename);
        if (!match) return exp;
        return {
          ...exp,
          convertedAmount: match.convertedAmount,
          convertedCurrency: match.convertedCurrency,
        };
      });

      setExpenses(finalExpenses);

      const submitResponse = await fetch("/api/submit-expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeName: employeeName.trim(),
          managerName: managerName.trim(),
          managerEmail: managerEmail.trim(),
          expenses: finalExpenses,
        }),
      });

      if (!submitResponse.ok) {
        const errorData = (await submitResponse.json()) as {
          error?: string;
          details?: string;
        };
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

  // 3. REMOVE HANDLER (Instant sync)
  const removeExpense = (filename: string) => {
    setExpenses((prev) => prev.filter((exp) => exp.filename !== filename));
  };

  const totalAmount = expenses.reduce(
    (sum, exp) =>
      sum +
      (typeof exp.convertedAmount === "number" ? exp.convertedAmount : exp.amount),
    0
  );

  const displayCurrency =
    expenses.length > 0
      ? (expenses[0].convertedCurrency ?? expenses[0].currency ?? localCurrency ?? "USD")
      : (localCurrency ?? "USD");

  const canSubmit =
    !isAnalyzing &&
    !isSubmitting &&
    expenses.length > 0 &&
    !!employeeName.trim() &&
    !!managerName.trim() &&
    !!managerEmail.trim();

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950 text-white">

      {/* ── SIDEBAR ── */}
      <aside className="w-64 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col">
        {/* Logo */}
        <div className="px-6 py-5 border-b border-slate-800">
          <Image
            src="/nstarx-logo.png"
            alt="NStarX logo"
            width={100}
            height={38}
            priority
            className="brightness-110"
          />
          <p className="text-[10px] tracking-widest text-slate-500 mt-1 uppercase">
            Expense Intelligence
          </p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 text-sm">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800 text-white font-medium">
            <span className="text-lime-400">▣</span> Dashboard
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-default">
            <span>＋</span> New Expense
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-default">
            <span>👥</span> Team Approvals
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-default">
            <span>⚙</span> Settings
          </div>
        </nav>

        {/* Submit button */}
        <div className="px-4 pb-6 space-y-3">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full py-3 rounded-lg bg-lime-400 text-slate-900 font-bold text-sm tracking-wide disabled:opacity-40 disabled:cursor-not-allowed hover:bg-lime-300 transition-colors"
          >
            {isSubmitting ? "Submitting…" : "+ Submit Report"}
          </button>
          <div className="flex items-center gap-2 px-1 text-xs text-slate-500">
            <span>❓</span> Help Centre
          </div>
        </div>
      </aside>

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar */}
        <header className="shrink-0 bg-slate-900 border-b border-slate-800 px-8 py-4 flex items-center justify-between gap-6">
          <div>
            <h1 className="text-xl font-bold">Employee Dashboard</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Manage your expense lifecycle and tracking intelligence.
            </p>
          </div>

          {/* Employee name input */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <input
                type="text"
                value={employeeName}
                onChange={(e) => setEmployeeName(e.target.value)}
                placeholder="Your name…"
                className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-lime-400 w-48"
              />
              {isLookingUpManager && (
                <span className="absolute right-3 top-2.5 text-xs text-lime-400 animate-pulse">
                  ↻
                </span>
              )}
            </div>
            {managerName && (
              <div className="text-xs text-slate-400 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 whitespace-nowrap">
                Manager: <span className="text-white font-medium">{managerName}</span>
              </div>
            )}
          </div>
        </header>

        {/* Scrollable body */}
        <div className="flex-1 overflow-auto px-8 py-6 space-y-6">

          {/* ── STAT CARDS ── */}
          <div className="grid grid-cols-3 gap-5">
            {/* Total Spent */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-slate-800 rounded-lg p-2 text-lg">💳</div>
                <span className="text-[10px] tracking-widest text-slate-500 uppercase">Monthly</span>
              </div>
              <p className="text-xs text-slate-400 mb-1">Total Spent</p>
              <p className="text-2xl font-bold">
                {formatMoney(totalAmount, displayCurrency)}
              </p>
              <div className="mt-3 h-1 rounded-full bg-slate-800">
                <div className="h-1 rounded-full bg-lime-400 w-3/4" />
              </div>
            </div>

            {/* Total Receipts */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="bg-slate-800 rounded-lg p-2 text-lg">🧾</div>
                <span className="text-[10px] tracking-widest text-slate-500 uppercase">Session</span>
              </div>
              <p className="text-xs text-slate-400 mb-1">Total Receipts</p>
              <p className="text-2xl font-bold">{expenses.length}</p>
              <div className="mt-3 h-1 rounded-full bg-slate-800">
                <div className="h-1 rounded-full bg-blue-400" style={{ width: `${Math.min(expenses.length * 10, 100)}%` }} />
              </div>
            </div>

            {/* Status */}
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
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full ${
                      hasSubmitted ? "bg-lime-400" : i === 0 ? "bg-yellow-400" : "bg-slate-800"
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* ── REVIEW WARNINGS ── */}
          {reviewWarnings.length > 0 && (
            <div className="bg-yellow-950 border border-yellow-700 rounded-xl p-4">
              <p className="text-sm font-semibold text-yellow-400 mb-2">⚠ Initial Review Warnings</p>
              <ul className="space-y-1">
                {reviewWarnings.map((w, idx) => (
                  <li key={`${idx}-${w}`} className="text-xs text-yellow-300 flex gap-2">
                    <span>•</span>{w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Submit error / success */}
          {submitError && (
            <div className="bg-red-950 border border-red-700 rounded-xl px-4 py-3 text-sm text-red-400">
              ✕ {submitError}
            </div>
          )}
          {hasSubmitted && (
            <div className="bg-lime-950 border border-lime-700 rounded-xl px-4 py-3 text-sm text-lime-400">
              ✓ Submitted successfully. Excel report emailed to {managerName} ({managerEmail}).
            </div>
          )}
          {reviewNote && !hasSubmitted && (
            <p className="text-xs text-slate-400">{reviewNote}</p>
          )}

          {/* ── EXPENSE TABLE ── */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
              <h2 className="font-semibold text-sm">Recent Expense Reports</h2>
              <div className="flex items-center gap-3">
                {isAnalyzing && (
                  <span className="text-xs text-lime-400 animate-pulse">AI analysing…</span>
                )}
                <label className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-white px-3 py-2 rounded-lg cursor-pointer transition-colors">
                  <span>↑</span> Upload Receipt
                  <input
                    type="file"
                    multiple
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">Report Name</th>
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
                    <td colSpan={6} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No receipts yet. Upload one to get started.
                    </td>
                  </tr>
                ) : (
                  expenses.map((exp) => (
                    <tr key={exp.filename} className="hover:bg-slate-800/50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-medium text-white">{exp.vendor}</div>
                        <div className="text-xs text-slate-500 truncate max-w-[180px]">{exp.filename}</div>
                      </td>
                      <td className="px-6 py-4 text-slate-300">{exp.city || "—"}</td>
                      <td className="px-6 py-4 text-slate-300">{exp.date}</td>
                      <td className="px-6 py-4">
                        <div className="text-white font-medium">
                          {formatMoney(
                            typeof exp.convertedAmount === "number"
                              ? exp.convertedAmount
                              : exp.amount,
                            exp.convertedCurrency ?? exp.currency ?? localCurrency ?? "USD"
                          )}
                        </div>
                        {exp.convertedCurrency &&
                          exp.currency !== exp.convertedCurrency && (
                            <div className="text-xs text-slate-500">
                              {formatMoney(exp.amount, exp.currency)}
                            </div>
                          )}
                      </td>
                      <td className="px-6 py-4">
                        {hasSubmitted ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-lime-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 inline-block" />
                            Submitted
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-400 inline-block" />
                            Draft
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
                Showing {expenses.length} receipt{expenses.length !== 1 ? "s" : ""}
              </div>
            )}
          </div>

          {/* ── BOTTOM ROW ── */}
          <div className="grid grid-cols-3 gap-5">
            {/* Upload prompt card */}
            <div className="col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-6 flex items-center justify-between gap-6">
              <div>
                <h3 className="font-semibold mb-1">AI Receipt Analysis</h3>
                <p className="text-sm text-slate-400 mb-4">
                  Upload receipts and let AI automatically extract vendor, amount, date, city, and currency.
                </p>
                <label className="inline-flex items-center gap-2 bg-lime-400 text-slate-900 font-bold text-sm px-4 py-2.5 rounded-lg cursor-pointer hover:bg-lime-300 transition-colors">
                  ⚡ Upload Receipts
                  <input
                    type="file"
                    multiple
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
              <div className="text-5xl opacity-20 select-none">★</div>
            </div>

            {/* Quick insights */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <p className="text-[10px] tracking-widest text-slate-500 uppercase mb-4">Quick Insights</p>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-400">Currency</span>
                  <span className="text-white font-medium">{displayCurrency}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Manager</span>
                  <span className="text-white font-medium truncate max-w-[110px]">
                    {managerName || "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Receipts</span>
                  <span className="text-white font-medium">{expenses.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Total</span>
                  <span className="text-lime-400 font-bold">
                    {formatMoney(totalAmount, displayCurrency)}
                  </span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}