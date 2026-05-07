import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

// Ensure your .env.local has GEMINI_API_KEY
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const CANADIAN_CITY_HINTS = [
  "toronto",
  "montreal",
  "verdun",
  "vancouver",
  "ottawa",
  "calgary",
  "edmonton",
  "winnipeg",
  "quebec",
  "mississauga",
];

const CANADIAN_PROVINCE_WORD_HINTS = [
  "ontario",
  "quebec",
  "british columbia",
  "alberta",
  "manitoba",
  "saskatchewan",
  "nova scotia",
  "new brunswick",
  "newfoundland",
  "labrador",
  "prince edward island",
  "yukon",
  "northwest territories",
  "nunavut",
];

const CA_PROVINCE_CODE_RE = /\b(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU)\b/i;
const CA_POSTAL_CODE_RE = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/i;
const US_ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

const normalizeDetectedCurrency = (raw: Record<string, unknown>) => {
  const city = String(raw.city ?? "")
    .trim()
    .toLowerCase();
  const country = String(raw.country ?? "")
    .trim()
    .toLowerCase();
  const address = String(raw.address ?? "")
    .trim()
    .toLowerCase();
  const vendor = String(raw.vendor ?? "")
    .trim()
    .toLowerCase();
  const locationBlob = `${city} ${country} ${address} ${vendor}`;

  const currency = String(raw.currency ?? "")
    .trim()
    .toUpperCase();

  // Deterministic overrides to avoid "$" ambiguity.
  const looksCanadian =
    country.includes("canada") ||
    CANADIAN_CITY_HINTS.some((c) => locationBlob.includes(c)) ||
    CANADIAN_PROVINCE_WORD_HINTS.some((p) => locationBlob.includes(p)) ||
    CA_PROVINCE_CODE_RE.test(address.toUpperCase()) ||
    CA_POSTAL_CODE_RE.test(address.toUpperCase());

  if (looksCanadian) {
    return "CAD";
  }

  const looksUS =
    country.includes("united states") ||
    country.includes("usa") ||
    country.includes("u.s.") ||
    /(^|\s)us($|\s)/.test(locationBlob) ||
    US_ZIP_RE.test(address);

  if (looksUS) {
    return "USD";
  }
  if (country.includes("australia")) {
    return "AUD";
  }

  // If model returns a valid ISO code, keep it.
  if (/^[A-Z]{3}$/.test(currency)) {
    return currency;
  }

  // Never return UNKNOWN; use a concrete fallback.
  return "USD";
};

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const base64Data = Buffer.from(bytes).toString("base64");

    // CRITICAL: Ensure the model name is exactly as required by the latest SDK
    // If 'gemini-3-flash-preview' fails, try 'gemini-3-flash-preview' to verify the connection works
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

    const prompt =
      "Analyze this receipt. Return ONLY JSON with this exact shape: " +
      "{ \"vendor\": \"string\", \"amount\": 0.0, \"date\": \"YYYY-MM-DD\", \"city\": \"string\", \"country\": \"string\", \"address\": \"string\", \"currency\": \"string\", \"is_receipt\": true, \"reason\": \"string\" } . " +
      "If it is NOT a receipt, set \"is_receipt\" to false and fill \"reason\" with why it is not. " +
      "If it IS a receipt, fill \"vendor\", \"amount\", \"date\", \"city\" (city/locality if available), \"country\", \"address\" (best available full address line), and \"currency\" (ISO 4217 like USD, CAD, EUR) and set \"reason\" to \"\". " +
      "Important: locate the country from the invoice address and use that country's currency code. " +
      "For Canada use CAD even if amount is shown with '$'. " +
      "Do not return symbols like '$' or words; return a 3-letter ISO code only.";

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: base64Data, mimeType: file.type } }
    ]);

    const text = result.response.text();
    
    // Safety: Remove markdown blocks if Gemini includes them
    const cleanJson = text.replace(/```json|```/g, "").trim();

    const parsed = JSON.parse(cleanJson) as Record<string, unknown>;

    if (parsed.is_receipt) {
      parsed.currency = normalizeDetectedCurrency(parsed);
    }

    // Upload receipt to S3 if configured
    let s3Key: string | undefined;
    const bucket = process.env.AWS_S3_BUCKET;
    if (bucket) {
      const date = new Date().toISOString().slice(0, 10);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      s3Key = `receipts/${date}/${randomUUID()}-${safeName}`;
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: s3Key,
          Body: Buffer.from(bytes),
          ContentType: file.type,
        }));
      } catch (err) {
        console.error("S3 upload failed:", err);
        s3Key = undefined;
      }
    }

    return NextResponse.json({ ...parsed, s3Key });

  } catch (error: unknown) {
    console.error("DETAILED SERVER ERROR:", error);
    const message =
      error instanceof Error ? error.message : String(error);
    // This ensures the frontend gets JSON even on failure, preventing the "Unexpected Token S" error
    return NextResponse.json({ 
      error: "Server failed to process request", 
      details: message 
    }, { status: 500 });
  }
}