import { NextResponse } from "next/server";

type ConvertBody = {
  from?: string;
  to?: string;
  amount?: number;
};

type ConvertResponse =
  | { convertedAmount: number; from: string; to: string; rate: number }
  | { error: string };

const TTL_MS = 24 * 60 * 60 * 1000; // 24h

type RateCacheEntry = {
  ts: number;
  rates: Record<string, number>;
};

declare global {
  var __rateCache: Map<string, RateCacheEntry> | undefined;
}

export async function POST(request: Request) {
  const body = (await request.json()) as ConvertBody;
  const from = String(body.from ?? "").trim().toUpperCase();
  const to = String(body.to ?? "").trim().toUpperCase();
  const amountNum = Number(body.amount);

  if (!from || !to || !Number.isFinite(amountNum)) {
    return NextResponse.json(
      { error: "Invalid request payload. Expected {from, to, amount}" } satisfies ConvertResponse,
      { status: 400 }
    );
  }

  try {
    // Cache rates for each base currency
    const cache = (globalThis.__rateCache ??= new Map<string, RateCacheEntry>());
    const cached = cache.get(from);

    let rates: Record<string, number> | null = null;
    if (cached && Date.now() - cached.ts < TTL_MS) {
      rates = cached.rates;
    } else {
      const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
      const res = await fetch(url);
      const data = (await res.json()) as {
        result?: string;
        rates?: Record<string, number>;
      };

      if (data?.result !== "success" || !data?.rates) {
        return NextResponse.json(
          { error: "Failed to fetch FX rates" } satisfies ConvertResponse,
          { status: 502 }
        );
      }

      rates = data.rates;
      cache.set(from, { ts: Date.now(), rates });
    }

    const rate = rates[to];
    if (!rate) {
      return NextResponse.json(
        { error: `Missing FX rate for ${from} -> ${to}` } satisfies ConvertResponse,
        { status: 400 }
      );
    }

    const convertedAmount = amountNum * rate;

    return NextResponse.json(
      {
        convertedAmount,
        from,
        to,
        rate,
      } satisfies ConvertResponse,
      { status: 200 }
    );
  } catch {
    return NextResponse.json(
      { error: "Currency conversion failed" } satisfies ConvertResponse,
      { status: 500 }
    );
  }
}

