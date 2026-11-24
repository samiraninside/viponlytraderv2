/**
 * Indicator library used by the agents. Series functions return arrays aligned with the input
 * (NaN until warmed up). Conventions match TradingView / Chartink: EMA seeded with SMA,
 * RSI and ATR with Wilder smoothing, VWAP reset each session.
 */
import type { Bar } from "./dhan";
import { dayOf, minsOf } from "./history";

export const last = <T>(a: T[], k = 0) => a[a.length - 1 - k];

export function ema(xs: number[], n: number): number[] {
  const out = new Array(xs.length).fill(NaN);
  if (xs.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += xs[i];
  out[n - 1] = s / n;
  const k = 2 / (n + 1);
  for (let i = n; i < xs.length; i++) out[i] = xs[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function sma(xs: number[], n: number): number[] {
  const out = new Array(xs.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i];
    if (i >= n) s -= xs[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function rsi(xs: number[], n = 14): number[] {
  const out = new Array(xs.length).fill(NaN);
  if (xs.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i] - xs[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function atrSeries(b: { h: number; l: number; c: number }[], n = 14): number[] {
  const out = new Array(b.length).fill(NaN);
  if (b.length <= n) return out;
  const tr = b.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l));
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr[i];
  a /= n; out[n] = a;
  for (let i = n + 1; i < b.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}

/** Session VWAP (resets each IST day). */
export function vwapSeries(b: Bar[]): number[] {
  const out: number[] = [];
  let day = "", pv = 0, v = 0;
  for (const x of b) {
    const d = dayOf(x.t);
    if (d !== day) { day = d; pv = 0; v = 0; }
    const vol = x.v || 1;
    pv += ((x.h + x.l + x.c) / 3) * vol; v += vol;
    out.push(pv / v);
  }
  return out;
}

/** VWAP anchored at bar index `from`. */
export function anchoredVwap(b: Bar[], from: number): number[] {
  const out = new Array(b.length).fill(NaN);
  let pv = 0, v = 0;
  for (let i = Math.max(0, from); i < b.length; i++) {
    const vol = b[i].v || 1;
    pv += ((b[i].h + b[i].l + b[i].c) / 3) * vol; v += vol;
    out[i] = pv / v;
  }
  return out;
}

/** Highest high of `n` bars ending at index i (inclusive). */
export const maxHigh = (b: { h: number }[], i: number, n: number) => { let m = -Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.max(m, b[k].h); return m; };
export const minLow = (b: { l: number }[], i: number, n: number) => { let m = Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.min(m, b[k].l); return m; };

/** Resample 5-min bars to N-minute bars aligned to the session start (09:15 NSE, 09:00 MCX). */
export function resample(b: Bar[], minutes: number, sessionStart = (t: number) => 555): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null, key = "";
  for (const x of b) {
    const m = minsOf(x.t), s = sessionStart(x.t);
    const slot = Math.floor((m - s) / minutes);
    const k = `${dayOf(x.t)}:${slot}`;
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { t: x.t - (m - s - slot * minutes) * 60, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, oi: x.oi };
    } else if (cur) {
      cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; cur.v += x.v; cur.oi = x.oi ?? cur.oi;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Volume profile of a set of bars: POC and the 70% value area. */
export function valueArea(b: Bar[], bins = 40, share = 0.7) {
  const hi = Math.max(...b.map((x) => x.h)), lo = Math.min(...b.map((x) => x.l));
  if (!(hi > lo)) return null;
  const w = (hi - lo) / bins, vol = new Array(bins).fill(0);
  for (const x of b) {
    const a = Math.max(0, Math.floor((x.l - lo) / w)), z = Math.min(bins - 1, Math.floor((x.h - lo) / w));
    for (let k = a; k <= z; k++) vol[k] += (x.v || 1) / (z - a + 1);
  }
  const total = vol.reduce((s, x) => s + x, 0);
  let poc = vol.indexOf(Math.max(...vol)), up = poc, dn = poc, acc = vol[poc];
  while (acc < share * total && (up < bins - 1 || dn > 0)) {
    const nu = up < bins - 1 ? vol[up + 1] : -1, nd = dn > 0 ? vol[dn - 1] : -1;
    if (nu >= nd) acc += vol[++up]; else acc += vol[--dn];
  }
  return { poc: lo + (poc + 0.5) * w, vah: lo + (up + 1) * w, val: lo + dn * w, hi, lo };
}

/** Everything an intraday agent usually needs, computed once over history + today. */
export interface Series { bars: Bar[]; close: number[]; ema20: number[]; ema50: number[]; rsi14: number[]; atr14: number[]; vwap: number[]; volSma20: number[] }
export function series(bars: Bar[]): Series {
  const close = bars.map((b) => b.c);
  return { bars, close, ema20: ema(close, 20), ema50: ema(close, 50), rsi14: rsi(close, 14), atr14: atrSeries(bars, 14), vwap: vwapSeries(bars), volSma20: sma(bars.map((b) => b.v), 20) };
}
