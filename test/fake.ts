/** Test doubles: a D1 shim on node:sqlite and a fake Dhan API with seeded synthetic data. */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { istEpoch, sessions, type Seg } from "../src/calendar";
import { bs } from "../src/engine/options";

export function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    sql, args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async (col?: string) => { const r: any = db.prepare(sql).get(...(args as any[])); return r ? (col ? r[col] : { ...r }) : null; },
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])).map((r: any) => ({ ...r })), success: true }),
    run: async () => { db.prepare(sql).run(...(args as any[])); return { success: true }; },
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return []; }, exec: async (q: string) => db.exec(q) } as any;
}

// ---------------------------------------------------------------- seeded RNG
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

interface Spec { id: string; seg: Seg; root: string; px: number; vol5: number; lot: number }
export const SPECS: Spec[] = [
  { id: "35001", seg: "NSE_FNO", root: "NIFTY", px: 24000, vol5: 0.0009, lot: 65 },
  { id: "35002", seg: "NSE_FNO", root: "BANKNIFTY", px: 52000, vol5: 0.0011, lot: 30 },
  { id: "60001", seg: "NSE_FNO", root: "RELIANCE", px: 1450, vol5: 0.0014, lot: 500 },
  { id: "472780", seg: "MCX_COMM", root: "CRUDEOIL", px: 5400, vol5: 0.0016, lot: 100 },
];
const SPOT: Record<string, string> = { "13": "NIFTY", "25": "BANKNIFTY", "2885": "RELIANCE" };

/** 5-min bars for every trading day in [from, to); the breakout day gets an ORB move up with rising OI. */
export function genBars(spec: Spec, from: string, to: string, breakoutDay?: string) {
  const r = rng(Number(spec.id) % 9973);
  const out = { open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[], timestamp: [] as number[], open_interest: [] as number[] };
  let px = spec.px, oi = 1e6;
  for (let d = from; d < to; d = new Date(Date.parse(d) + 86400e3).toISOString().slice(0, 10)) {
    const ss = sessions(spec.seg, d);
    if (!ss.length) continue;
    px *= 1 + gauss(r) * spec.vol5 * 3; // overnight gap
    const dayOi0 = oi;
    const trend = d === breakoutDay ? 1 : r() < 0.3 ? (r() < 0.5 ? 1 : -1) : 0;  // some past days trend with OI build-up
    let k = 0;
    for (const s of ss) for (let m = s.start; m + 5 <= s.end; m += 5, k++) {
      const o = px;
      let drift = 0;
      if (trend) drift = trend * (k < 3 ? -0.0002 : k === 3 ? 0.004 : k < 12 ? 0.0006 : 0);
      const c = o * (1 + drift + gauss(r) * spec.vol5);
      const h = Math.max(o, c) * (1 + Math.abs(gauss(r)) * spec.vol5 * 0.4);
      const l = Math.min(o, c) * (1 - Math.abs(gauss(r)) * spec.vol5 * 0.4);
      oi = trend && k >= 3 ? oi * 1.006 : dayOi0 * (1 + gauss(r) * 0.002);
      out.timestamp.push(istEpoch(d, m)); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c);
      out.volume.push(Math.round((trend && k >= 3 ? 3 : 1) * (5000 + r() * 4000))); out.open_interest.push(Math.round(oi));
      px = c;
    }
  }
  return out;
}

export function instrumentCsv(seg: string): string {
  const head = "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME";
  const rows: Record<string, string[]> = {
    NSE_FNO: [
      "NSE,D,35001,FUTIDX,0,NIFTY-Dec2026-FUT,65,NIFTY DEC FUT,2026-12-29 14:30:00,-0.01,XX,10,M,FUTIDX,,",
      "NSE,D,35000,FUTIDX,0,NIFTY-Nov2026-FUT,65,NIFTY NOV FUT,2026-11-24 14:30:00,-0.01,XX,10,M,FUTIDX,,",
      "NSE,D,35002,FUTIDX,0,BANKNIFTY-Dec2026-FUT,30,BANKNIFTY DEC FUT,2026-12-29 14:30:00,-0.01,XX,20,M,FUTIDX,,",
      "NSE,D,60001,FUTSTK,0,RELIANCE-Dec2026-FUT,500,RELIANCE DEC FUT,2026-12-29 14:30:00,-0.01,XX,10,M,FUTSTK,,",
      "NSE,D,40111,OPTIDX,0,NIFTY-Nov2026-24200-CE,65,NIFTY 24 NOV 24200 CALL,2026-11-24 14:30:00,24200,CE,5,W,OP,,",
    ],
    BSE_FNO: [], MCX_COMM: ["MCX,M,472780,FUTCOM,0,CRUDEOIL-17Dec2026-FUT,100,CRUDEOIL DEC FUT,2026-12-17 23:30:00,-0.01,XX,100,M,FUTCOM,,"],
    IDX_I: ["NSE,I,13,INDEX,,NIFTY,1,Nifty 50,,,,5,,INDEX,X,NIFTY", "NSE,I,25,INDEX,,BANKNIFTY,1,Nifty Bank,,,,5,,INDEX,X,BANKNIFTY"],
    NSE_EQ: ['NSE,E,2885,EQUITY,,RELIANCE,1,"Reliance Industries, Ltd",,,,10,,,EQ,'],
  };
  return [head, ...(rows[seg] ?? [])].join("\n");
}

function chainFor(root: string, spot: number, expiry: string, nowEpoch: number) {
  const step = root === "BANKNIFTY" ? 100 : root === "CRUDEOIL" ? 50 : root === "RELIANCE" ? 10 : 50;
  const T = Math.max(3600, istEpoch(expiry, 930) - nowEpoch) / (365 * 86400);
  const atm = Math.round(spot / step) * step, oc: Record<string, any> = {};
  for (let k = -12; k <= 12; k++) {
    const K = atm + k * step, iv = 0.14 + Math.abs(k) * 0.004;
    const leg = (t: "CE" | "PE", id: number) => {
      const p = Math.max(0.05, bs(t, spot, K, T, iv, 0.06));
      return { last_price: +p.toFixed(2), implied_volatility: iv * 100, oi: 100000 + Math.abs(k) * 5000, previous_oi: 95000, volume: 50000,
        top_bid_price: +(p * 0.995).toFixed(2), top_ask_price: +(p * 1.005).toFixed(2), security_id: id, greeks: { delta: 0 } };
    };
    oc[`${K}.000000`] = { ce: leg("CE", 40000 + k + 100), pe: leg("PE", 50000 + k + 100) };
  }
  return { last_price: spot, oc };
}

/** Installs a fetch mock. `nowEpoch` (s) bounds the data the fake API returns. */
export function mockFetch(opts: { nowEpoch: () => number; breakoutDay?: string }) {
  const calls: string[] = [];
  const last: Record<string, number> = {};
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input), body = init?.body ? JSON.parse(init.body) : {};
    calls.push(url.replace(/\?.*/, ""));
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("generateAccessToken")) return ok({ accessToken: "fake-token", expiryTime: "x" });
    const m = url.match(/\/v2\/instrument\/(\w+)/);
    if (m) return new Response(instrumentCsv(m[1]), { status: 200 });
    if (url.endsWith("/charts/intraday") || url.endsWith("/charts/historical")) {
      const sid = String(body.securityId);
      const spec = SPECS.find((s) => s.id === (sid === "35000" ? "35001" : sid)) ?? SPECS.find((s) => s.root === SPOT[sid])!;
      const all = genBars(spec, "2026-08-01", body.toDate, opts.breakoutDay);
      const fromE = istEpoch(body.fromDate, 0), now = opts.nowEpoch();
      const keep = all.timestamp.map((t, i) => (t >= fromE && t <= now ? i : -1)).filter((i) => i >= 0);
      const pick = (a: number[]) => keep.map((i) => a[i]);
      if (url.endsWith("/historical")) {
        // daily aggregation
        const days = new Map<string, number[]>();
        for (const i of keep) { const d = new Date((all.timestamp[i] + 19800) * 1000).toISOString().slice(0, 10); (days.get(d) ?? days.set(d, []).get(d)!).push(i); }
        const D = { open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[], timestamp: [] as number[] };
        for (const [d, ix] of days) {
          D.timestamp.push(istEpoch(d, 0)); D.open.push(all.open[ix[0]]); D.close.push(all.close[ix.at(-1)!]);
          D.high.push(Math.max(...ix.map((i) => all.high[i]))); D.low.push(Math.min(...ix.map((i) => all.low[i]))); D.volume.push(1);
        }
        return ok(D);
      }
      return ok({ open: pick(all.open), high: pick(all.high), low: pick(all.low), close: pick(all.close), volume: pick(all.volume), timestamp: pick(all.timestamp), open_interest: pick(all.open_interest) });
    }
    if (url.endsWith("/marketfeed/quote")) {
      const data: Record<string, any> = {};
      for (const [seg, ids] of Object.entries<number[]>(body)) {
        data[seg] = {};
        for (const id of ids) {
          const spec = SPECS.find((s) => s.id === (String(id) === "35000" ? "35001" : String(id))) ?? SPECS.find((s) => s.root === SPOT[String(id)]);
          if (!spec) continue;
          const all = genBars(spec, "2026-08-01", "2027-01-01", opts.breakoutDay);
          const now = opts.nowEpoch();
          const idx = all.timestamp.findLastIndex((t) => t <= now);
          const today = new Date((now + 19800) * 1000).toISOString().slice(0, 10);
          const prevIdx = all.timestamp.findLastIndex((t) => new Date((t + 19800) * 1000).toISOString().slice(0, 10) < today);
          data[seg][String(id)] = { last_price: all.close[idx], ohlc: { close: all.close[prevIdx] }, volume: 100000 + Number(id) % 1000, average_price: all.close[idx], oi: all.open_interest[idx] };
        }
      }
      return ok({ status: "success", data });
    }
    if (url.endsWith("/optionchain/expirylist")) {
      const k = String(body.UnderlyingScrip);
      last.chain = Date.now();
      return ok({ status: "success", data: k === "472780" ? ["2026-12-16"] : ["2026-11-24", "2026-12-01", "2026-12-29"] });
    }
    if (url.endsWith("/optionchain")) {
      const k = String(body.UnderlyingScrip);
      const root = SPOT[k] ?? "CRUDEOIL";
      const spec = SPECS.find((s) => s.root === root)!;
      const all = genBars(spec, "2026-08-01", "2027-01-01", opts.breakoutDay);
      const idx = all.timestamp.findLastIndex((t) => t <= opts.nowEpoch());
      const spot = all.close[idx] * (root === "CRUDEOIL" ? 1 : 0.997);
      return ok({ status: "success", data: chainFor(root, spot, body.Expiry, opts.nowEpoch()) });
    }
    if (url.endsWith("/v2/positions")) return ok([
      { tradingSymbol: "NIFTY-Nov2026-FUT", securityId: "35000", exchangeSegment: "NSE_FNO", netQty: 650, positionType: "LONG", costPrice: 24000, drvExpiryDate: "2026-11-24", drvOptionType: null, drvStrikePrice: 0, multiplier: 1 },
      { tradingSymbol: "TCS", securityId: "11536", exchangeSegment: "NSE_EQ", netQty: 10, positionType: "LONG" },
    ]);
    if (url.includes("fcm.googleapis.com")) return new Response("", { status: 201 });
    return new Response("not mocked: " + url, { status: 404 });
  }) as any;
  return calls;
}
