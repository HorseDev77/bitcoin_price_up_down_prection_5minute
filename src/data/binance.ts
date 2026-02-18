/**
 * Binance USDT-M Futures public REST — trades, depth, klines, open interest
 */

import {
  Trade,
  OrderBookSnapshot,
  BookLevel,
  OIDataPoint,
  OHLCV1m,
  Side,
} from "../types";

interface BinanceTradeRow {
  time: number;
  price: string;
  qty: string;
  isBuyerMaker: boolean;
}

const BASE = "https://fapi.binance.com";

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const url = new URL(path, BASE);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Binance ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function fetchTrades(symbol: string = "BTCUSDT", limit: number = 1000): Promise<Trade[]> {
  const raw = await get<BinanceTradeRow[]>("fapi/v1/trades", { symbol, limit });
  return raw.map(({ time, price, qty, isBuyerMaker }) => ({
    ts: time,
    price: parseFloat(price),
    size: parseFloat(qty),
    side: (isBuyerMaker ? "sell" : "buy") as Side,
  }));
}

export async function fetchDepth(symbol: string = "BTCUSDT", limit: number = 20): Promise<OrderBookSnapshot> {
  const raw = await get<{ lastUpdateId: number; E?: number; bids: [string, string][]; asks: [string, string][] }>(
    "fapi/v1/depth",
    { symbol, limit }
  );
  const ts = (raw as { E?: number }).E ?? raw.lastUpdateId ?? Date.now();
  const bids: BookLevel[] = (raw.bids || []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }));
  const asks: BookLevel[] = (raw.asks || []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }));
  return { ts, bids, asks };
}

/** Kline: [openTime, o, h, l, c, v, closeTime, ...] */
export async function fetchKlines(
  symbol: string = "BTCUSDT",
  interval: string = "1m",
  limit: number = 400
): Promise<OHLCV1m[]> {
  const raw = await get<[number, string, string, string, string, string, number, ...unknown[]][]>(
    "fapi/v1/klines",
    { symbol, interval, limit }
  );
  return raw.map(([openTime, o, h, l, c, v]) => ({
    ts: openTime,
    open: parseFloat(o),
    high: parseFloat(h),
    low: parseFloat(l),
    close: parseFloat(c),
    volume: parseFloat(v),
  }));
}

/** Current open interest */
export async function fetchOpenInterest(symbol: string = "BTCUSDT"): Promise<number> {
  const raw = await get<{ openInterest: string }>("fapi/v1/openInterest", { symbol });
  return parseFloat(raw.openInterest);
}

/** Historical OI (5m buckets). Used to build OI series for 1m delta. */
export async function fetchOpenInterestHist(
  symbol: string = "BTCUSDT",
  period: string = "5m",
  limit: number = 60
): Promise<OIDataPoint[]> {
  try {
    const raw = await get<{ timestamp: number; sumOpenInterest: string }[]>(
      "futures/data/openInterestHist",
      { symbol, period, limit }
    );
    return raw.map(({ timestamp, sumOpenInterest }) => ({
      ts: timestamp,
      oi: parseFloat(sumOpenInterest),
    }));
  } catch {
    return [];
  }
}

/**
 * Build feature inputs from Binance: fetch all, map to our types.
 * Uses current OI and OI hist to approximate 1m delta (we use last 2–3 points).
 */
export async function fetchFeatureInputs(symbol: string = "BTCUSDT"): Promise<{
  trades: Trade[];
  orderBook: OrderBookSnapshot;
  oiSeries: OIDataPoint[];
  candles1m: OHLCV1m[];
  currentPrice: number;
  now: number;
}> {
  const now = Date.now();
  const [trades, orderBook, candles1m, oiNow, oiHist] = await Promise.all([
    fetchTrades(symbol, 1000),
    fetchDepth(symbol, 20),
    fetchKlines(symbol, "1m", 400),
    fetchOpenInterest(symbol),
    fetchOpenInterestHist(symbol, "5m", 30),
  ]);

  const oiSeries: OIDataPoint[] = [...oiHist];
  if (oiSeries.length === 0) {
    oiSeries.push({ ts: now - 60000, oi: oiNow }, { ts: now, oi: oiNow });
  } else {
    oiSeries.push({ ts: now, oi: oiNow });
    oiSeries.sort((a, b) => a.ts - b.ts);
  }

  const currentPrice =
    (orderBook.bids[0]?.price && orderBook.asks[0]?.price)
      ? (orderBook.bids[0].price + orderBook.asks[0].price) / 2
      : candles1m[candles1m.length - 1]?.close ?? 0;

  return {
    trades,
    orderBook: { ...orderBook, ts: now },
    oiSeries,
    candles1m,
    currentPrice,
    now,
  };
}
