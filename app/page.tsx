"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";

// ─── Types ───────────────────────────────────────────────────────────────────

type ReceiptAnalysis = {
  vendor: string;
  amount: number;
  date: string;
  city: string;
  currency: string;
  is_receipt: boolean;
  reason?: string;
};

type Receipt = ReceiptAnalysis & {
  filename: string;
  mimeType: string;
  signature: string;
  contentHash: string;
  convertedAmount?: number;
  convertedCurrency?: string;
  s3Key?: string;
};

type ReportStatus = "Pending" | "Approved" | "Awaiting Clarification";

type ExpenseReport = {
  id: string;
  reportName: string;
  employeeName: string;
  managerName: string;
  managerEmail: string;
  receipts: Receipt[];
  status: ReportStatus;
  submittedAt: string;
  totalLocalCurrency: number;
  localCurrency: string;
  totalUSD: number;
};

type Issue = {
  id: string;
  type: "duplicate_content" | "semantic_duplicate" | "location_mismatch" | "date_outlier";
  message: string;
  affectedFiles: string[];
};

type Tab = "reports" | "new" | "approvals";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const parseReceiptDate = (value: string): Date | null => {
  const v = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(dt.getTime()) ? null : dt;
};

const extractDateFromReportName = (name: string): Date | null => {
  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const monthShort = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const lower = name.toLowerCase();

  for (let i = 0; i < monthNames.length; i++) {
    for (const ms of [monthNames[i], monthShort[i]]) {
      const idx = lower.indexOf(ms);
      if (idx === -1) continue;
      const after = lower.slice(idx + ms.length);
      const m = after.match(/^\s*,?\s*(\d{4})/);
      if (m) {
        const year = parseInt(m[1]);
        if (year >= 2000 && year <= 2100) return new Date(Date.UTC(year, i, 15));
      }
    }
  }

  const iso = name.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (iso) return new Date(Date.UTC(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3])));

  return null;
};

const computeIssues = (receipts: Receipt[], reportName: string): Issue[] => {
  const issues: Issue[] = [];
  const MS_PER_DAY = 86_400_000;

  // 1. Identical content (same bytes, different file name)
  const hashGroups = new Map<string, string[]>();
  for (const r of receipts) {
    if (!r.contentHash) continue;
    const g = hashGroups.get(r.contentHash) ?? [];
    g.push(r.filename);
    hashGroups.set(r.contentHash, g);
  }
  for (const [, files] of hashGroups) {
    if (files.length > 1) {
      issues.push({
        id: `dup_content_${files.sort().join("|")}`,
        type: "duplicate_content",
        message: `Identical file content: ${files.join(", ")}`,
        affectedFiles: files,
      });
    }
  }

  // 2. Same receipt data (vendor / date / amount), different files
  const sigGroups = new Map<string, string[]>();
  for (const r of receipts) {
    if (!r.signature) continue;
    const g = sigGroups.get(r.signature) ?? [];
    g.push(r.filename);
    sigGroups.set(r.signature, g);
  }
  for (const [sig, files] of sigGroups) {
    if (files.length > 1) {
      // Skip if already caught as content duplicate
      const contentDup = files.every((f) => {
        for (const [, g] of hashGroups) if (g.length > 1 && g.includes(f)) return true;
        return false;
      });
      if (!contentDup) {
        issues.push({
          id: `dup_sem_${sig}`,
          type: "semantic_duplicate",
          message: `Same receipt data (vendor / date / amount) across multiple files: ${files.join(", ")}`,
          affectedFiles: files,
        });
      }
    }
  }

  // 3. Location mismatch
  if (receipts.length > 1) {
    const counts = new Map<string, number>();
    for (const r of receipts) {
      const c = String(r.city ?? "").trim().toLowerCase();
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    if (counts.size > 1) {
      const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (dominant) {
        for (const r of receipts) {
          const c = String(r.city ?? "").trim().toLowerCase();
          if (c && c !== dominant) {
            issues.push({
              id: `loc_${r.filename}`,
              type: "location_mismatch",
              message: `Location mismatch: "${r.filename}" is from ${r.city} while most receipts are from ${dominant}`,
              affectedFiles: [r.filename],
            });
          }
        }
      }
    }
  }

  // 4. Date outliers — compare against report name date, or fall back to median
  const reportDate = extractDateFromReportName(reportName);
  const datedReceipts = receipts
    .map((r) => ({ r, dt: parseReceiptDate(r.date) }))
    .filter((x): x is { r: Receipt; dt: Date } => Boolean(x.dt));

  if (reportDate && datedReceipts.length > 0) {
    for (const { r, dt } of datedReceipts) {
      const diffDays = Math.abs(dt.getTime() - reportDate.getTime()) / MS_PER_DAY;
      if (diffDays > 30) {
        issues.push({
          id: `date_outlier_${r.filename}`,
          type: "date_outlier",
          message: `Date outlier: "${r.filename}" (${r.date}) is ${Math.round(diffDays)} days from the report event date`,
          affectedFiles: [r.filename],
        });
      }
    }
  } else if (!reportDate && datedReceipts.length >= 2) {
    const sorted = [...datedReceipts].sort((a, b) => a.dt.getTime() - b.dt.getTime());
    const mid = Math.floor(sorted.length / 2);
    const medianMs =
      sorted.length % 2 === 0
        ? (sorted[mid - 1].dt.getTime() + sorted[mid].dt.getTime()) / 2
        : sorted[mid].dt.getTime();
    for (const { r, dt } of datedReceipts) {
      const diffDays = Math.abs(dt.getTime() - medianMs) / MS_PER_DAY;
      if (diffDays > 30) {
        issues.push({
          id: `date_outlier_${r.filename}`,
          type: "date_outlier",
          message: `Date outlier: "${r.filename}" (${r.date}) is far from the other receipt dates`,
          affectedFiles: [r.filename],
        });
      }
    }
  }

  return issues;
};

const formatMoney = (amount: number, currency: string) => {
  const c = String(currency ?? "").trim().toUpperCase() || "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: c, currencyDisplay: "code" }).format(amount);
  } catch {
    return `${c} ${amount.toFixed(2)}`;
  }
};

const getDominantCurrency = (receipts: Receipt[]): string => {
  const counts = new Map<string, number>();
  for (const r of receipts) {
    const c = String(r.currency ?? "").trim().toUpperCase();
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
};

const getFileHash = async (file: File): Promise<string> => {
  const bytes = await file.arrayBuffer();
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const STORAGE_KEY = "nstarx_expense_reports";

const loadReports = (): ExpenseReport[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ExpenseReport[]) : [];
  } catch {
    return [];
  }
};

const saveReports = (reports: ExpenseReport[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
  } catch { /* ignore */ }
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const StatusBadge = ({ status }: { status: ReportStatus }) => {
  const styles: Record<ReportStatus, string> = {
    Pending: "bg-yellow-950 text-yellow-400 border border-yellow-700",
    Approved: "bg-lime-950 text-lime-400 border border-lime-700",
    "Awaiting Clarification": "bg-red-950 text-red-400 border border-red-700",
  };
  const dots: Record<ReportStatus, string> = {
    Pending: "bg-yellow-400",
    Approved: "bg-lime-400",
    "Awaiting Clarification": "bg-red-400",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dots[status]}`} />
      {status}
    </span>
  );
};

const issueIcon = (type: Issue["type"]) =>
  ({ duplicate_content: "🔁", semantic_duplicate: "🔄", location_mismatch: "📍", date_outlier: "📅" })[type];

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ExpenseManager() {
  // Shared state
  const { data: session } = useSession();
  const [activeTab, setActiveTab] = useState<Tab>("reports");
  const [employeeName, setEmployeeName] = useState(session?.user?.name ?? "");
  const [managerName, setManagerName] = useState("");
  const [managerEmail, setManagerEmail] = useState("");
  const [isLookingUpManager, setIsLookingUpManager] = useState(false);
  const [localCurrency, setLocalCurrency] = useState("USD");
  const [allReports, setAllReports] = useState<ExpenseReport[]>([]);

  // New Report tab state
  const [reportName, setReportName] = useState("");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [dismissedIssueIds, setDismissedIssueIds] = useState<Set<string>>(new Set());
  const [editingCell, setEditingCell] = useState<{ filename: string; field: string; value: string } | null>(null);

  // Approvals tab state
  const [approverName, setApproverName] = useState("");
  const [managerComments, setManagerComments] = useState<Record<string, string>>({});
  const [actionLoading, setActionLoading] = useState<string | null>(null); // reportId being processed
  const [actionError, setActionError] = useState<Record<string, string>>({});

  const receiptsRef = useRef<Receipt[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { receiptsRef.current = receipts; }, [receipts]);

  // Bootstrap
  useEffect(() => { setAllReports(loadReports()); }, []);

  // Pre-fill employee name from session
  useEffect(() => {
    if (session?.user?.name) setEmployeeName(session.user.name);
  }, [session?.user?.name]);

  useEffect(() => {
    fetch("/api/local-currency")
      .then((r) => r.json() as Promise<{ currency?: string }>)
      .then((d) => setLocalCurrency(String(d.currency ?? "USD").trim().toUpperCase() || "USD"))
      .catch(() => setLocalCurrency("USD"));
  }, []);

  // Manager lookup
  useEffect(() => {
    const name = employeeName.trim();
    if (!name) { setManagerName(""); setManagerEmail(""); return; }
    let cancelled = false;
    const tid = setTimeout(async () => {
      setIsLookingUpManager(true);
      try {
        const res = await fetch(`/api/employee-lookup?employeeName=${encodeURIComponent(name)}`);
        const data = (await res.json()) as { found?: boolean; managerName?: string; managerEmail?: string };
        if (!cancelled) {
          setManagerName(data.found ? String(data.managerName ?? "") : "");
          setManagerEmail(data.found ? String(data.managerEmail ?? "") : "");
        }
      } catch { /* keep existing */ } finally {
        if (!cancelled) setIsLookingUpManager(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(tid); };
  }, [employeeName]);

  // Live issue computation
  const issues = useMemo(() => computeIssues(receipts, reportName), [receipts, reportName]);

  const activeIssues = issues.filter((iss) => !dismissedIssueIds.has(iss.id));

  const dismissIssue = (id: string) =>
    setDismissedIssueIds((prev) => new Set([...prev, id]));

  const canSubmit =
    !isAnalyzing &&
    !isSubmitting &&
    receipts.length > 0 &&
    activeIssues.length === 0;

  // ── Upload handler ───────────────────────────────────────────────────────────
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Snapshot into a real array BEFORE resetting the input — FileList is live
    // and clearing e.target.value empties it immediately.
    const filesArray = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (filesArray.length === 0) return;
    setIsAnalyzing(true);
    setUploadErrors([]);
    const errors: string[] = [];
    try {
      for (const file of filesArray) {
        // Skip exact filename duplicates silently
        if (receiptsRef.current.some((r) => r.filename === file.name)) {
          errors.push(`"${file.name}" is already in the list.`);
          continue;
        }

        let contentHash = "";
        try { contentHash = await getFileHash(file); } catch { /* */ }

        const formData = new FormData();
        formData.append("file", file);
        try {
          const res = await fetch("/api/analyze", { method: "POST", body: formData });
          const data = (await res.json()) as Partial<ReceiptAnalysis> & { is_receipt?: boolean; s3Key?: string };
          if (!data.is_receipt) {
            errors.push(`"${file.name}" was not recognised as a receipt${data.reason ? `: ${data.reason}` : "."}`);
            continue;
          }

          const amountNum = Number(data.amount);
          if (!Number.isFinite(amountNum)) {
            errors.push(`"${file.name}" has an unreadable amount.`);
            continue;
          }

          const detectedCurrency = String(data.currency ?? "").trim().toUpperCase() || "USD";
          const vendorNorm = String(data.vendor ?? "").trim().toLowerCase();
          const dateNorm = String(data.date ?? "").trim();
          const signature = `${vendorNorm}|${dateNorm}|${amountNum.toFixed(2)}`;

          if (!contentHash) {
            try { contentHash = await getFileHash(file); } catch { /* */ }
          }

          // Convert to USD immediately so the table always shows USD
          let usdAmount: number | undefined;
          if (detectedCurrency === "USD") {
            usdAmount = amountNum;
          } else {
            try {
              const cvRes = await fetch("/api/convert", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ from: detectedCurrency, to: "USD", amount: amountNum }),
              });
              const cvData = (await cvRes.json()) as { convertedAmount?: number };
              if (cvRes.ok && typeof cvData.convertedAmount === "number") {
                usdAmount = cvData.convertedAmount;
              }
            } catch { /* show original if conversion fails */ }
          }

          setReceipts((prev) => [
            ...prev,
            {
              vendor: String(data.vendor ?? ""),
              date: String(data.date ?? ""),
              city: String(data.city ?? ""),
              currency: detectedCurrency,
              amount: amountNum,
              is_receipt: true,
              filename: file.name,
              mimeType: file.type,
              signature,
              contentHash,
              convertedAmount: usdAmount,
              convertedCurrency: usdAmount !== undefined ? "USD" : undefined,
              s3Key: data.s3Key,
            },
          ]);
        } catch (err) {
          console.error("Analyze failed:", err);
          errors.push(`"${file.name}" failed to upload. Check your connection and try again.`);
        }
      }
    } finally {
      setIsAnalyzing(false);
      if (errors.length > 0) setUploadErrors(errors);
    }
  };

  const removeReceipt = (filename: string) => {
    setReceipts((prev) => prev.filter((r) => r.filename !== filename));
    setDismissedIssueIds(new Set());
  };

  const updateReceipt = async (filename: string, field: string, raw: string) => {
    setReceipts((prev) =>
      prev.map((r) => {
        if (r.filename !== filename) return r;
        if (field === "vendor") return { ...r, vendor: raw };
        if (field === "city")   return { ...r, city: raw };
        if (field === "date")   return { ...r, date: raw };
        if (field === "amount") {
          const n = parseFloat(raw);
          return Number.isFinite(n) ? { ...r, amount: n } : r;
        }
        if (field === "currency") return { ...r, currency: raw.trim().toUpperCase() || r.currency };
        return r;
      })
    );

    // Re-convert to USD when amount or currency changes
    if (field === "amount" || field === "currency") {
      const target = receiptsRef.current.find((r) => r.filename === filename);
      if (!target) return;
      const amount  = field === "amount"   ? parseFloat(raw) : target.amount;
      const from    = field === "currency" ? raw.trim().toUpperCase() || target.currency : target.currency;
      if (!Number.isFinite(amount)) return;
      if (from === "USD") {
        setReceipts((prev) =>
          prev.map((r) => r.filename === filename ? { ...r, convertedAmount: amount, convertedCurrency: "USD" } : r)
        );
        return;
      }
      try {
        const res = await fetch("/api/convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: "USD", amount }),
        });
        const data = (await res.json()) as { convertedAmount?: number };
        if (res.ok && typeof data.convertedAmount === "number") {
          setReceipts((prev) =>
            prev.map((r) => r.filename === filename ? { ...r, convertedAmount: data.convertedAmount, convertedCurrency: "USD" } : r)
          );
        }
      } catch { /* keep existing converted value */ }
    }
  };

  const startEdit = (filename: string, field: string, value: string) =>
    setEditingCell({ filename, field, value });

  const commitEdit = () => {
    if (!editingCell) return;
    updateReceipt(editingCell.filename, editingCell.field, editingCell.value);
    setEditingCell(null);
    setDismissedIssueIds(new Set());
  };

  // ── Submit handler ───────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    setSubmitError(null);
    if (!reportName.trim()) { setSubmitError("Please give this report a name."); return; }
    if (!employeeName.trim()) { setSubmitError("Please enter your employee name."); return; }
    if (!managerEmail.trim()) { setSubmitError("Manager could not be resolved. Check your name matches the employee directory."); return; }
    setIsSubmitting(true);
    try {
      const list = receiptsRef.current;
      const toCurrency = getDominantCurrency(list);

      // Convert receipts to dominant currency
      const converted = await Promise.all(
        list.map(async (r) => {
          if (r.currency === toCurrency) return { ...r, convertedAmount: r.amount, convertedCurrency: toCurrency };
          try {
            const res = await fetch("/api/convert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ from: r.currency, to: toCurrency, amount: r.amount }),
            });
            const data = (await res.json()) as { convertedAmount?: number };
            if (res.ok && typeof data.convertedAmount === "number")
              return { ...r, convertedAmount: data.convertedAmount, convertedCurrency: toCurrency };
          } catch { /* fallback */ }
          return { ...r, convertedAmount: r.amount, convertedCurrency: r.currency };
        })
      );

      const totalLocal = converted.reduce((s, r) => s + (r.convertedAmount ?? r.amount), 0);

      // Convert total to USD
      let totalUSD = totalLocal;
      if (toCurrency !== "USD") {
        try {
          const res = await fetch("/api/convert", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: toCurrency, to: "USD", amount: totalLocal }),
          });
          const data = (await res.json()) as { convertedAmount?: number };
          if (res.ok && typeof data.convertedAmount === "number") totalUSD = data.convertedAmount;
        } catch { /* ignore */ }
      }

      // Send email notification to manager
      const emailRes = await fetch("/api/submit-expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportName: reportName.trim(),
          employeeName: employeeName.trim(),
          managerName: managerName.trim(),
          managerEmail: managerEmail.trim(),
          expenses: converted,
        }),
      });

      if (!emailRes.ok) {
        const err = (await emailRes.json()) as { error?: string };
        setSubmitError(err.error ?? "Failed to submit report.");
        return;
      }

      // Save to persistent store
      const report: ExpenseReport = {
        id: crypto.randomUUID(),
        reportName: reportName.trim(),
        employeeName: employeeName.trim(),
        managerName: managerName.trim(),
        managerEmail: managerEmail.trim(),
        receipts: converted,
        status: "Pending",
        submittedAt: new Date().toISOString(),
        totalLocalCurrency: totalLocal,
        localCurrency: toCurrency,
        totalUSD,
      };

      const updated = [...loadReports(), report];
      saveReports(updated);
      setAllReports(updated);

      // Reset and navigate
      setReportName("");
      setReceipts([]);
      setActiveTab("reports");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Approver actions ─────────────────────────────────────────────────────────
  const handleManagerAction = async (report: ExpenseReport, action: "approve" | "clarify") => {
    const comment = managerComments[report.id] ?? "";
    setActionLoading(report.id);
    setActionError((prev) => ({ ...prev, [report.id]: "" }));
    try {
      const res = await fetch("/api/manager-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          reportName: report.reportName,
          employeeName: report.employeeName,
          managerName: report.managerName,
          totalUSD: report.totalUSD,
          comment,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActionError((prev) => ({ ...prev, [report.id]: data.error ?? "Action failed." }));
        return;
      }
      const newStatus: ReportStatus = action === "approve" ? "Approved" : "Awaiting Clarification";
      const updated = allReports.map((r) => r.id === report.id ? { ...r, status: newStatus } : r);
      setAllReports(updated);
      saveReports(updated);
    } finally {
      setActionLoading(null);
    }
  };

  // ── Derived data ─────────────────────────────────────────────────────────────
  const myReports = allReports.filter(
    (r) => r.employeeName.toLowerCase() === employeeName.trim().toLowerCase()
  );
  const approvalReports = allReports.filter(
    (r) => r.managerName.toLowerCase() === approverName.trim().toLowerCase()
  );
  const receiptTotal = receipts.reduce(
    (s, r) => s + (r.convertedCurrency === "USD" && r.convertedAmount !== undefined ? r.convertedAmount : r.amount),
    0
  );
  const receiptDisplayCurrency = receipts.some((r) => r.convertedCurrency === "USD") ? "USD" : (receipts[0]?.currency ?? localCurrency);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen overflow-hidden bg-slate-950 text-white">

      {/* ── SIDEBAR ── */}
      <aside className="w-64 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col">
        <div className="px-6 py-5 border-b border-slate-800">
          <Image src="/nstarx-logo.png" alt="NStarX" width={100} height={38} priority className="brightness-110" />
          <p className="text-[10px] tracking-widest text-slate-500 mt-1 uppercase">Expense Intelligence</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 text-sm">
          {(
            [
              { id: "reports", label: "My Reports", icon: "▣" },
              { id: "new", label: "New Report", icon: "＋" },
              { id: "approvals", label: "Approvals", icon: "✓" },
            ] as { id: Tab; label: string; icon: string }[]
          ).map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                activeTab === id
                  ? "bg-slate-800 text-white font-medium"
                  : "text-slate-400 hover:text-white hover:bg-slate-800"
              }`}
            >
              <span className={activeTab === id ? "text-lime-400" : ""}>{icon}</span>
              {label}
            </button>
          ))}
        </nav>

        <div className="px-4 pb-6">
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
            <h1 className="text-xl font-bold">
              {activeTab === "reports" && "My Reports"}
              {activeTab === "new" && "New Expense Report"}
              {activeTab === "approvals" && "Approval Queue"}
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {activeTab === "reports" && "View all your submitted expense reports and their status."}
              {activeTab === "new" && "Create and submit a new expense report for manager approval."}
              {activeTab === "approvals" && "Review and act on expense reports submitted to you."}
            </p>
          </div>

          {activeTab !== "approvals" && (
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
                  <span className="absolute right-3 top-2.5 text-xs text-lime-400 animate-pulse">↻</span>
                )}
              </div>
              {managerName && (
                <div className="text-xs text-slate-400 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 whitespace-nowrap">
                  Manager: <span className="text-white font-medium">{managerName}</span>
                </div>
              )}
            </div>
          )}

          {activeTab === "approvals" && (
            <div className="relative">
              <input
                type="text"
                value={approverName}
                onChange={(e) => setApproverName(e.target.value)}
                placeholder="Your manager name…"
                className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-lime-400 w-56"
              />
            </div>
          )}

          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="ml-2 px-3 py-2 text-xs text-slate-400 hover:text-white border border-slate-700 hover:border-slate-500 rounded-lg transition-colors whitespace-nowrap"
          >
            Sign out
          </button>
        </header>

        {/* ── Tab Body ── */}
        <div className="flex-1 overflow-auto">

          {/* ══════════════════════════════════════════════════════════════════
              TAB 1 — MY REPORTS
          ══════════════════════════════════════════════════════════════════ */}
          {activeTab === "reports" && (
            <div className="px-8 py-6">
              {!employeeName.trim() ? (
                <div className="text-center py-24 text-slate-500">
                  <p className="text-4xl mb-4 opacity-20">▣</p>
                  <p className="text-base">Enter your name in the header to see your reports.</p>
                </div>
              ) : myReports.length === 0 ? (
                <div className="text-center py-24 text-slate-500">
                  <p className="text-4xl mb-4 opacity-20">📄</p>
                  <p className="text-base mb-4">No expense reports yet for <span className="text-white">{employeeName}</span>.</p>
                  <button
                    onClick={() => setActiveTab("new")}
                    className="px-5 py-2.5 bg-lime-400 text-slate-900 font-bold rounded-lg text-sm hover:bg-lime-300 transition-colors"
                  >
                    + Create New Report
                  </button>
                </div>
              ) : (
                <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
                    <h2 className="font-semibold text-sm">
                      Reports for <span className="text-lime-400">{employeeName}</span>
                    </h2>
                    <button
                      onClick={() => setActiveTab("new")}
                      className="px-3 py-1.5 bg-lime-400 text-slate-900 font-bold rounded-lg text-xs hover:bg-lime-300 transition-colors"
                    >
                      + New Report
                    </button>
                  </div>
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800">
                        {["Report Name", "Receipts", "Total (Local)", "Total (USD)", "Submitted", "Status"].map((h) => (
                          <th key={h} className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {myReports.map((report) => (
                        <tr key={report.id} className="hover:bg-slate-800/50 transition-colors">
                          <td className="px-6 py-4">
                            <div className="font-medium text-white">{report.reportName}</div>
                            <div className="text-xs text-slate-500">Manager: {report.managerName}</div>
                          </td>
                          <td className="px-6 py-4 text-slate-300">{report.receipts.length}</td>
                          <td className="px-6 py-4 font-medium text-white">
                            {formatMoney(report.totalLocalCurrency, report.localCurrency)}
                          </td>
                          <td className="px-6 py-4 font-medium text-white">
                            {formatMoney(report.totalUSD, "USD")}
                          </td>
                          <td className="px-6 py-4 text-slate-400 text-xs">
                            {new Date(report.submittedAt).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4">
                            <StatusBadge status={report.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              TAB 2 — NEW REPORT
          ══════════════════════════════════════════════════════════════════ */}
          {activeTab === "new" && (
            <div className="px-8 py-6 flex flex-col gap-5 h-full">

              {/* Report name row */}
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Report Name</label>
                <input
                  type="text"
                  value={reportName}
                  onChange={(e) => setReportName(e.target.value)}
                  placeholder="e.g. Client Visit to Texas — March 2025"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-lime-400"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Include a month/year in the name (e.g. &quot;March 2025&quot;) to enable date validation.
                </p>
              </div>

              {/* Two-column area */}
              <div className="flex gap-5 flex-1 min-h-0">

                {/* Left — receipt list */}
                <div className="flex-1 min-w-0 flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                  {uploadErrors.length > 0 && (
                    <div className="px-4 py-3 bg-red-950 border-b border-red-800">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-semibold text-red-400 mb-1">Upload issues:</p>
                          <ul className="space-y-0.5">
                            {uploadErrors.map((e, i) => (
                              <li key={i} className="text-xs text-red-300">• {e}</li>
                            ))}
                          </ul>
                        </div>
                        <button onClick={() => setUploadErrors([])} className="text-red-500 hover:text-red-300 text-xs shrink-0">✕</button>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
                    <h2 className="font-semibold text-sm">Receipts</h2>
                    <div className="flex items-center gap-3">
                      {isAnalyzing && (
                        <span className="text-xs text-lime-400 animate-pulse">AI analysing…</span>
                      )}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isAnalyzing}
                        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-white px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
                      >
                        <span>↑</span> Upload Files
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept="image/*,.pdf"
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </div>
                  </div>

                  <div className="flex-1 overflow-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-800">
                          {["Vendor / File", "City", "Date", "Amount", ""].map((h, i) => (
                            <th
                              key={i}
                              className={`px-6 py-3 text-[10px] font-medium text-slate-500 uppercase tracking-wider ${
                                i === 4 ? "text-right" : "text-left"
                              }`}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {receipts.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-6 py-12 text-center text-slate-500 text-sm">
                              Upload receipts to get started.
                            </td>
                          </tr>
                        ) : (
                          receipts.map((r) => {
                            const hasIssue = issues.some((iss) => iss.affectedFiles.includes(r.filename));
                            return (
                              <tr
                                key={r.filename}
                                className={`transition-colors ${hasIssue ? "bg-red-950/25" : "hover:bg-slate-800/50"}`}
                              >
                                {/* Vendor */}
                                <td className="px-6 py-4">
                                  {editingCell?.filename === r.filename && editingCell.field === "vendor" ? (
                                    <input
                                      autoFocus
                                      value={editingCell.value}
                                      onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                                      onBlur={commitEdit}
                                      onKeyDown={(e) => e.key === "Enter" && commitEdit()}
                                      className="w-full bg-slate-700 border border-lime-500 rounded px-2 py-1 text-sm text-white focus:outline-none"
                                    />
                                  ) : (
                                    <div
                                      onClick={() => startEdit(r.filename, "vendor", r.vendor)}
                                      className={`font-medium cursor-text hover:text-lime-300 transition-colors ${hasIssue ? "text-red-300" : "text-white"}`}
                                      title="Click to edit"
                                    >
                                      {r.vendor || <span className="text-slate-500 italic">—</span>}
                                    </div>
                                  )}
                                  <div className="text-xs text-slate-500 truncate max-w-[160px] mt-0.5">{r.filename}</div>
                                </td>

                                {/* City */}
                                <td className="px-6 py-4">
                                  {editingCell?.filename === r.filename && editingCell.field === "city" ? (
                                    <input
                                      autoFocus
                                      value={editingCell.value}
                                      onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                                      onBlur={commitEdit}
                                      onKeyDown={(e) => e.key === "Enter" && commitEdit()}
                                      className="w-full bg-slate-700 border border-lime-500 rounded px-2 py-1 text-sm text-white focus:outline-none"
                                    />
                                  ) : (
                                    <span
                                      onClick={() => startEdit(r.filename, "city", r.city)}
                                      className="text-slate-300 cursor-text hover:text-lime-300 transition-colors"
                                      title="Click to edit"
                                    >
                                      {r.city || <span className="text-slate-500 italic">—</span>}
                                    </span>
                                  )}
                                </td>

                                {/* Date */}
                                <td className="px-6 py-4">
                                  {editingCell?.filename === r.filename && editingCell.field === "date" ? (
                                    <input
                                      autoFocus
                                      value={editingCell.value}
                                      onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                                      onBlur={commitEdit}
                                      onKeyDown={(e) => e.key === "Enter" && commitEdit()}
                                      placeholder="YYYY-MM-DD"
                                      className="w-32 bg-slate-700 border border-lime-500 rounded px-2 py-1 text-sm text-white focus:outline-none"
                                    />
                                  ) : (
                                    <span
                                      onClick={() => startEdit(r.filename, "date", r.date)}
                                      className="text-slate-300 cursor-text hover:text-lime-300 transition-colors"
                                      title="Click to edit"
                                    >
                                      {r.date || <span className="text-slate-500 italic">—</span>}
                                    </span>
                                  )}
                                </td>

                                {/* Amount + Currency */}
                                <td className="px-6 py-4">
                                  <div className="flex items-center gap-1.5">
                                    {editingCell?.filename === r.filename && editingCell.field === "amount" ? (
                                      <input
                                        autoFocus
                                        type="number"
                                        step="0.01"
                                        value={editingCell.value}
                                        onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                                        onBlur={commitEdit}
                                        onKeyDown={(e) => e.key === "Enter" && commitEdit()}
                                        className="w-24 bg-slate-700 border border-lime-500 rounded px-2 py-1 text-sm text-white focus:outline-none"
                                      />
                                    ) : (
                                      <span
                                        onClick={() => startEdit(r.filename, "amount", String(r.amount))}
                                        className="font-medium text-white cursor-text hover:text-lime-300 transition-colors"
                                        title="Click to edit amount"
                                      >
                                        {r.amount.toFixed(2)}
                                      </span>
                                    )}
                                    {editingCell?.filename === r.filename && editingCell.field === "currency" ? (
                                      <input
                                        autoFocus
                                        value={editingCell.value}
                                        maxLength={3}
                                        onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value.toUpperCase() })}
                                        onBlur={commitEdit}
                                        onKeyDown={(e) => e.key === "Enter" && commitEdit()}
                                        className="w-14 bg-slate-700 border border-lime-500 rounded px-2 py-1 text-sm text-white focus:outline-none uppercase"
                                      />
                                    ) : (
                                      <span
                                        onClick={() => startEdit(r.filename, "currency", r.currency)}
                                        className="text-xs text-slate-400 cursor-text hover:text-lime-300 transition-colors"
                                        title="Click to edit currency"
                                      >
                                        {r.currency}
                                      </span>
                                    )}
                                  </div>
                                  {r.convertedCurrency === "USD" && r.currency !== "USD" && (
                                    <div className="text-xs text-slate-500 mt-0.5">
                                      = {formatMoney(r.convertedAmount ?? r.amount, "USD")}
                                    </div>
                                  )}
                                  {r.convertedCurrency === "USD" && r.currency === "USD" && (
                                    <div className="text-xs text-slate-500 mt-0.5">USD</div>
                                  )}
                                </td>

                                <td className="px-6 py-4 text-right">
                                  <button
                                    onClick={() => removeReceipt(r.filename)}
                                    className="text-slate-500 hover:text-red-400 transition-colors text-xs"
                                  >
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {receipts.length > 0 && (
                    <div className="px-6 py-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-500 shrink-0">
                      <span>
                        {receipts.length} receipt{receipts.length !== 1 ? "s" : ""}
                      </span>
                      <span className="font-medium text-white">
                        {formatMoney(receiptTotal, receiptDisplayCurrency)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Right — issues pane + submit */}
                <div className="w-80 shrink-0 flex flex-col gap-4">

                  {/* Issues pane */}
                  <div
                    className={`rounded-xl border flex flex-col ${
                      activeIssues.length > 0
                        ? "bg-red-950/20 border-red-800"
                        : "bg-slate-900 border-slate-800"
                    }`}
                  >
                    <div className="px-4 py-3 border-b border-slate-800 shrink-0 flex items-center justify-between">
                      <h3 className="text-sm font-semibold">
                        {activeIssues.length > 0 ? (
                          <span className="text-red-400">
                            ⚠ {activeIssues.length} Issue{activeIssues.length !== 1 ? "s" : ""} Found
                          </span>
                        ) : (
                          <span className="text-lime-400">✓ No Issues</span>
                        )}
                      </h3>
                      {dismissedIssueIds.size > 0 && (
                        <span className="text-xs text-slate-500">
                          {dismissedIssueIds.size} dismissed
                        </span>
                      )}
                    </div>
                    <div className="p-4 overflow-auto" style={{ maxHeight: "320px" }}>
                      {activeIssues.length === 0 ? (
                        <p className="text-xs text-slate-400">
                          {receipts.length === 0
                            ? "Upload receipts to begin validation."
                            : "All checks passed. The report is ready to submit."}
                        </p>
                      ) : (
                        <ul className="space-y-3">
                          {activeIssues.map((issue) => (
                            <li key={issue.id} className="flex gap-2 text-xs">
                              <span className="mt-0.5 shrink-0">{issueIcon(issue.type)}</span>
                              <div className="flex-1 min-w-0">
                                <p className="text-red-300">{issue.message}</p>
                                <div className="flex items-center gap-3 mt-1.5">
                                  <button
                                    onClick={() => dismissIssue(issue.id)}
                                    className="text-slate-400 hover:text-white underline underline-offset-2 transition-colors"
                                  >
                                    Dismiss
                                  </button>
                                  <span className="text-slate-600">·</span>
                                  <span className="text-slate-500">or remove the file</span>
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  {/* Submit panel */}
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
                    {submitError && (
                      <div className="text-xs text-red-400 bg-red-950 border border-red-700 rounded-lg px-3 py-2">
                        ✕ {submitError}
                      </div>
                    )}
                    {employeeName.trim() && !managerEmail && !isLookingUpManager && (
                      <div className="text-xs text-yellow-400 bg-yellow-950 border border-yellow-700 rounded-lg px-3 py-2">
                        ⚠ Employee not found in directory — manager required to submit.
                      </div>
                    )}

                    <button
                      onClick={handleSubmit}
                      disabled={!canSubmit}
                      className="w-full py-3 rounded-lg bg-lime-400 text-slate-900 font-bold text-sm tracking-wide disabled:opacity-40 disabled:cursor-not-allowed hover:bg-lime-300 transition-colors"
                    >
                      {isSubmitting ? "Submitting…" : "Submit Report"}
                    </button>

                    {!canSubmit && receipts.length === 0 && (
                      <p className="text-xs text-center text-slate-500">Upload at least one receipt.</p>
                    )}
                    {!canSubmit && receipts.length > 0 && activeIssues.length > 0 && (
                      <p className="text-xs text-center text-slate-500">Dismiss or resolve all issues before submitting.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              TAB 3 — APPROVALS
          ══════════════════════════════════════════════════════════════════ */}
          {activeTab === "approvals" && (
            <div className="px-8 py-6">
              {!approverName.trim() ? (
                <div className="text-center py-24 text-slate-500">
                  <p className="text-4xl mb-4 opacity-20">✓</p>
                  <p className="text-base">Enter your manager name in the header to see pending approvals.</p>
                </div>
              ) : approvalReports.length === 0 ? (
                <div className="text-center py-24 text-slate-500">
                  <p className="text-4xl mb-4 opacity-20">📋</p>
                  <p className="text-base">
                    No reports pending approval for <span className="text-white">{approverName}</span>.
                  </p>
                </div>
              ) : (
                <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-800">
                    <h2 className="font-semibold text-sm">
                      Reports for <span className="text-lime-400">{approverName}</span>
                    </h2>
                  </div>
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800">
                        {["Employee", "Report Name", "Receipts", "Total (USD)", "Submitted", "Status", "Comment & Actions"].map(
                          (h, i) => (
                            <th
                              key={h}
                              className={`px-6 py-3 text-[10px] font-medium text-slate-500 uppercase tracking-wider ${
                                i === 6 ? "text-left" : "text-left"
                              }`}
                            >
                              {h}
                            </th>
                          )
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {approvalReports.map((report) => {
                        const isLoading = actionLoading === report.id;
                        const isDone = report.status === "Approved" || report.status === "Awaiting Clarification";
                        const err = actionError[report.id];
                        return (
                          <tr key={report.id} className="hover:bg-slate-800/50 transition-colors align-top">
                            <td className="px-6 py-4 font-medium text-white">{report.employeeName}</td>
                            <td className="px-6 py-4 text-slate-300">{report.reportName}</td>
                            <td className="px-6 py-4 text-slate-300">{report.receipts.length}</td>
                            <td className="px-6 py-4 font-medium text-white">
                              {formatMoney(report.totalUSD, "USD")}
                            </td>
                            <td className="px-6 py-4 text-slate-400 text-xs">
                              {new Date(report.submittedAt).toLocaleDateString()}
                            </td>
                            <td className="px-6 py-4">
                              <StatusBadge status={report.status} />
                            </td>
                            <td className="px-6 py-4">
                              {isDone ? (
                                <span className="text-xs text-slate-500">
                                  {report.status === "Approved"
                                    ? "Forwarded to Finance."
                                    : "Clarification requested."}
                                </span>
                              ) : (
                                <div className="flex flex-col gap-2 min-w-[260px]">
                                  <textarea
                                    rows={2}
                                    value={managerComments[report.id] ?? ""}
                                    onChange={(e) =>
                                      setManagerComments((prev) => ({ ...prev, [report.id]: e.target.value }))
                                    }
                                    placeholder="Add a comment (required for clarification)…"
                                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-lime-400 resize-none"
                                  />
                                  {err && (
                                    <p className="text-xs text-red-400">✕ {err}</p>
                                  )}
                                  <div className="flex gap-2">
                                    <button
                                      onClick={() => handleManagerAction(report, "approve")}
                                      disabled={isLoading}
                                      className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-lime-950 text-lime-400 border border-lime-700 hover:bg-lime-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                    >
                                      {isLoading ? "…" : "✓ Approve"}
                                    </button>
                                    <button
                                      onClick={() => handleManagerAction(report, "clarify")}
                                      disabled={isLoading || !(managerComments[report.id] ?? "").trim()}
                                      className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-red-950 text-red-400 border border-red-700 hover:bg-red-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                    >
                                      {isLoading ? "…" : "↩ Request Clarification"}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
