/** Indicator values for the rule language, on any timeframe, aligned to a base timeframe. */
import type { Bar } from "../dhan";
import { dayOf } from "../history";
import { atrSeries, ema, resample, rsi, sma, vwapSeries } from "../indicators";
import type { Env as DslEnv, Node, TF } from "./dsl";

type Ref = Extract<Node, { k: "ref" }>;

const field = (b: Bar[], f: string): number[] => {
  switch (f) {
    case "OPEN": return b.map((x) => x.o);
    case "HIGH": return b.map((x) => x.h);
    case "LOW": return b.map((x) => x.l);
    case "CLOSE": return b.map((x) => x.c);
    case "VOLUME": return b.map((x) => x.v);
    case "OI": return b.map((x) => x.oi ?? NaN);
    default: throw new Error(`"${f}" is not a price field`);
  }
};
const rolling = (xs: number[], n: number, f: (a: number, b: number) => number) => {
  const out = new Array(xs.length).fill(NaN);
  for (let i = n - 1; i < xs.length; i++) { let m = xs[i]; for (let k = i - n + 1; k < i; k++) m = f(m, xs[k]); out[i] = m; }
  return out;
};
function supertrend(b: Bar[], n: number, mult: number): number[] {
  const atr = atrSeries(b, n), out = new Array(b.length).fill(NaN);
  let up = 0, dn = 0, trend = 1;
  for (let i = 0; i < b.length; i++) {
    if (!Number.isFinite(atr[i])) continue;
    const mid = (b[i].h + b[i].l) / 2, bu = mid + mult * atr[i], bl = mid - mult * atr[i];
    const pc = i ? b[i - 1].c : b[i].c;
    up = !Number.isFinite(out[i - 1]) || bu < up || pc > up ? bu : up;
    dn = !Number.isFinite(out[i - 1]) || bl > dn || pc < dn ? bl : dn;
    if (trend > 0 && b[i].c < dn) trend = -1; else if (trend < 0 && b[i].c > up) trend = 1;
    out[i] = trend > 0 ? dn : up;
  }
  return out;
}

/** Full indicator series for a bar array. */
export function fnSeries(b: Bar[], r: { fn: string; args: (string | number)[] }, intraday: boolean): number[] {
  const a = r.args, num = (k: number, d: number) => (typeof a[k] === "number" ? (a[k] as number) : d);
  const src = (k: number, d = "CLOSE") => field(b, typeof a[k] === "string" ? (a[k] as string) : d);
  switch (r.fn) {
    case "OPEN": case "HIGH": case "LOW": case "CLOSE": case "VOLUME": case "OI": return field(b, r.fn);
    case "VWAP": return intraday ? vwapSeries(b) : b.map((x) => (x.h + x.l + x.c) / 3);
    case "EMA": return ema(src(0), num(1, 20));
    case "SMA": return sma(src(0), num(1, 20));
    case "RSI": return rsi(field(b, "CLOSE"), num(0, 14));
    case "ATR": return atrSeries(b, num(0, 14));
    case "MAX": return rolling(src(1, "HIGH"), num(0, 10), Math.max);
    case "MIN": return rolling(src(1, "LOW"), num(0, 10), Math.min);
    case "SUPERTREND": return supertrend(b, num(0, 7), num(1, 3));
    case "MACD LINE": case "MACD SIGNAL": {
      const c = field(b, "CLOSE"), slow = num(0, 26), fast = num(1, 12), sig = num(2, 9);
      const ef = ema(c, fast), es = ema(c, slow), line = ef.map((x, i) => x - es[i]);
      if (r.fn === "MACD LINE") return line;
      const first = line.findIndex(Number.isFinite);
      const s = first < 0 ? [] : ema(line.slice(first), sig);
      return line.map((_, i) => (i < first ? NaN : s[i - first]));
    }
  }
  throw new Error(`unknown function ${r.fn}`);
}

export const tfMinutes = (tf: TF) => (typeof tf === "number" ? tf : 0);

function byDay(b5: Bar[]): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null, d = "";
  for (const x of b5) {
    const dd = dayOf(x.t);
    if (dd !== d) { if (cur) out.push(cur); d = dd; cur = { ...x }; }
    else if (cur) { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; cur.v += x.v; cur.oi = x.oi ?? cur.oi; }
  }
  if (cur) out.push(cur);
  return out;
}
export function byWeek(d: Bar[]): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null, wk = "";
  for (const x of d) {
    const dt = new Date((x.t + 19800) * 1000), mon = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400e3).toISOString().slice(0, 10);
    if (mon !== wk) { if (cur) out.push(cur); wk = mon; cur = { ...x }; }
    else if (cur) { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; cur.v += x.v; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Intraday evaluation context. Base positions are complete bars of `baseTf`.
 * Each other timeframe uses its last COMPLETE bar at the base bar's close; daily/weekly [0] is the
 * day/week so far (from 5-minute futures bars).
 */
export function intradayEnv(b5: Bar[], baseTf: 5 | 15 | 30 | 60, sessionStart: (t: number) => number, chainVal: (fn: string) => number, nowS: number) {
  const tfBars = new Map<number, Bar[]>([[5, b5]]);
  const bars = (tf: number) => { if (!tfBars.has(tf)) tfBars.set(tf, resample(b5, tf, sessionStart)); return tfBars.get(tf)!; };
  const base = bars(baseTf).filter((b) => b.t + baseTf * 60 <= nowS);
  const closeT = base.map((b) => b.t + baseTf * 60);
  const maps = new Map<number, Int32Array>();
  const mapFor = (tf: number) => {
    if (maps.has(tf)) return maps.get(tf)!;
    const B = bars(tf), m = new Int32Array(base.length).fill(-1);
    for (let i = 0, j = -1; i < base.length; i++) { while (j + 1 < B.length && B[j + 1].t + tf * 60 <= closeT[i]) j++; m[i] = j; }
    maps.set(tf, m);
    return m;
  };
  const cache = new Map<string, number[]>();
  // daily: complete days before + the day so far
  const days = byDay(b5);
  const dayIdx = new Map(days.map((d, k) => [dayOf(d.t), k]));
  // the day so far at each base close, built once with a single pass
  let partials: (Bar | null)[] | null = null;
  const buildPartials = () => {
    partials = new Array(base.length).fill(null);
    let q = 0, d = "";
    let cur = null as Bar | null;
    for (let i = 0; i < base.length; i++) {
      while (q < b5.length && b5[q].t + 300 <= closeT[i]) {
        const x = b5[q++], dd = dayOf(x.t);
        if (dd !== d) { d = dd; cur = { ...x }; }
        else if (cur) { const c0: Bar = cur; cur = { t: c0.t, o: c0.o, h: Math.max(c0.h, x.h), l: Math.min(c0.l, x.l), c: x.c, v: c0.v + x.v, oi: x.oi ?? c0.oi }; }
      }
      partials[i] = cur && dayOf(cur.t) === dayOf(base[i].t) ? cur : null;
    }
  };
  const partialDay = (i: number): Bar[] => {
    if (!partials) buildPartials();
    const d = dayOf(base[i].t), k = dayIdx.get(d) ?? days.length;
    const p = partials![i];
    return p ? [...days.slice(Math.max(0, k - 120), k), p] : days.slice(Math.max(0, k - 120), k);
  };
  const env: DslEnv = {
    ref: (r: Ref, i: number) => {
      if (r.tf === "chain") return chainVal(r.fn);
      if (r.tf === "D" || r.tf === "W") {
        let arr = partialDay(i);
        if (r.tf === "W") arr = byWeek(arr);
        const s = fnSeries(arr, r, false);
        return s[s.length - 1 - r.off] ?? NaN;
      }
      const key = `${r.tf}:${r.fn}:${r.args.join(",")}`;
      if (!cache.has(key)) cache.set(key, fnSeries(bars(r.tf), r, true));
      const j = (r.tf === baseTf ? i : mapFor(r.tf)[i]) - r.off;
      return j >= 0 ? cache.get(key)![j] : NaN;
    },
  };
  return { env, base, closeT, bars };
}

/** Daily evaluation context: base positions are daily bars (the last one may be today so far). */
export function dailyEnv(daily: Bar[], chainVal: (fn: string) => number) {
  const cache = new Map<string, number[]>();
  const weekly = byWeek(daily);
  const wkIndex = new Int32Array(daily.length);
  for (let i = 0, j = 0; i < daily.length; i++) {
    while (j + 1 < weekly.length && weekly[j + 1].t <= daily[i].t) j++;
    wkIndex[i] = j;
  }
  const env: DslEnv = {
    ref: (r: Ref, i: number) => {
      if (r.tf === "chain") return chainVal(r.fn);
      if (typeof r.tf === "number") return NaN;
      if (r.tf === "W") {
        // the week so far up to day i
        const wk = byWeek(daily.slice(Math.max(0, i - 400), i + 1));
        const s = fnSeries(wk, r, false);
        return s[s.length - 1 - r.off] ?? NaN;
      }
      const key = `D:${r.fn}:${r.args.join(",")}`;
      if (!cache.has(key)) cache.set(key, fnSeries(daily, r, false));
      return cache.get(key)![i - r.off] ?? NaN;
    },
  };
  void wkIndex;
  return env;
}
