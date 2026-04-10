import ExcelJS from "exceljs";
import path from "node:path";

export type EmployeeDirectoryRow = {
  employeeName: string;
  employeeEmail: string;
  managerName: string;
  location: string;
};

export type EmployeeManagerRecord = {
  employeeName: string;
  managerName: string;
  managerEmail: string;
};

let cache: { ts: number; rows: EmployeeDirectoryRow[] } | null = null;
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

const normalizeHeader = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

const parseString = (value: unknown) => String(value ?? "").trim();

const getWorkbookPaths = () => [
  path.join(process.cwd(), "app", "api", "data", "employees.xlsx"),
  path.join(process.cwd(), "app", "data", "employees.xlsx"),
];

const parseEmployeeSheet = async () => {
  const workbook = new ExcelJS.Workbook();
  let loaded = false;
  let lastError: unknown = null;

  for (const p of getWorkbookPaths()) {
    try {
      await workbook.xlsx.readFile(p);
      loaded = true;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!loaded) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "");
    throw new Error(
      `Could not load employees.xlsx from app/api/data or app/data. ${reason}`
    );
  }

  const ws = workbook.worksheets[0];
  if (!ws) return [];

  const headerRow = ws.getRow(1);
  const headerToCol = new Map<string, number>();

  headerRow.eachCell((cell, colNumber) => {
    const key = normalizeHeader(cell.value);
    if (key) headerToCol.set(key, colNumber);
  });

  const employeeNameCol = headerToCol.get("employee_name");
  const employeeEmailCol = headerToCol.get("employee_email");
  const managerNameCol = headerToCol.get("manager_name");
  const locationCol = headerToCol.get("location");

  if (!employeeNameCol || !employeeEmailCol || !managerNameCol || !locationCol) {
    throw new Error(
      "employees.xlsx must have headers: employee_name, employee_email, manager_name, location"
    );
  }

  const rows: EmployeeDirectoryRow[] = [];
  for (let rowNum = 2; rowNum <= ws.rowCount; rowNum += 1) {
    const row = ws.getRow(rowNum);
    const employeeName = parseString(row.getCell(employeeNameCol).value);
    if (!employeeName) continue;

    rows.push({
      employeeName,
      employeeEmail: parseString(row.getCell(employeeEmailCol).value),
      managerName: parseString(row.getCell(managerNameCol).value),
      location: parseString(row.getCell(locationCol).value),
    });
  }

  return rows;
};

export const getEmployeeRows = async () => {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.rows;
  const rows = await parseEmployeeSheet();
  cache = { ts: Date.now(), rows };
  return rows;
};

export const findEmployeeRecord = async (
  name: string
): Promise<EmployeeManagerRecord | null> => {
  const query = name.trim().toLowerCase();
  if (!query) return null;

  const rows = await getEmployeeRows();

  const employeeRow =
    rows.find((r) => r.employeeName.trim().toLowerCase() === query) ??
    rows.find((r) => r.employeeName.trim().toLowerCase().includes(query));

  if (!employeeRow) return null;

  const managerQuery = employeeRow.managerName.trim().toLowerCase();
  const managerRow = rows.find(
    (r) => r.employeeName.trim().toLowerCase() === managerQuery
  );

  // Per your rule: pick manager email from row where employee_name = manager_name
  const managerEmail = managerRow?.employeeEmail?.trim() ?? "";

  return {
    employeeName: employeeRow.employeeName,
    managerName: employeeRow.managerName,
    managerEmail,
  };
};

