import fs from "fs";
import path from "path";

const STORE_PATH = path.join(process.cwd(), "data", "reports.json");

export type ReportStatus = "pending" | "approved" | "rejected";

export type ExpenseItem = {
  filename: string;
  vendor: string;
  date: string;
  city: string;
  currency: string;
  amount: number;
  convertedAmount?: number;
  convertedCurrency?: string;
};

export type Report = {
  id: string;
  name: string;
  employeeName: string;
  employeeEmail: string;
  managerName: string;
  managerEmail: string;
  submittedAt: string;
  status: ReportStatus;
  rejectionReason?: string;
  expenses: ExpenseItem[];
  totalAmount: number;
  currency: string;
};

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readStore(): { reports: Report[] } {
  try {
    ensureDir();
    if (!fs.existsSync(STORE_PATH)) return { reports: [] };
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as { reports: Report[] };
  } catch {
    return { reports: [] };
  }
}

function writeStore(data: { reports: Report[] }) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getReports(): Report[] {
  return readStore().reports;
}

export function saveReport(report: Report): void {
  const store = readStore();
  store.reports.unshift(report);
  writeStore(store);
}

export function updateReportStatus(
  id: string,
  status: ReportStatus,
  reason?: string
): Report | null {
  const store = readStore();
  const report = store.reports.find((r) => r.id === id);
  if (!report) return null;
  report.status = status;
  if (reason) report.rejectionReason = reason;
  writeStore(store);
  return report;
}
