import { NextResponse } from "next/server";

type LocalCurrencyResponse = {
  currency?: string;
  currency_code?: string;
};

export async function POST() {
  try {
    // IP-based country/currency detection. No API key required.
    const res = await fetch("https://ipapi.co/json/");
    const data = (await res.json()) as LocalCurrencyResponse & {
      country_code?: string;
    };

    const currency =
      String(data.currency_code ?? data.currency ?? "")
        .trim()
        .toUpperCase() || "USD";

    return NextResponse.json({ currency });
  } catch {
    return NextResponse.json({ currency: "USD" });
  }
}

// Support GET as well since the frontend uses `fetch("/api/local-currency")`.
export const GET = POST;

