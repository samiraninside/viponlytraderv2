/**
 * Swing / BTST screener (2–3 day holds), using your breakout filters on daily bars:
 *  price > ₹100 · 20-day avg traded value > ₹20 Cr (stocks) · close above the previous 20-day high ·
 *  volume ≥ 1.5× 20-day average · close above EMA20 and EMA50 · RSI(14) 55–75 ·
 *  weekly trend up (weekly close above 10-week EMA) · outperforming NIFTY 50 over 20 sessions ·
 *  reward:risk at least 1:2. The short side mirrors every rule.
 * Runs 14:50–15:20 (NSE) and 22:30–23:15 (MCX). Hedged structures only overnight.
 */
import { tradingDaysBetween } from "../calendar";
import { dailyPath, type Path, volScale } from "../engine/evaluate";
import { type DBar, relVolume } from "../history";
import { atrSeries, ema, rsi, sma } from "../indicators";
import { segOf } from "./common";
import { fmt } from "./rules";
import type { Agent, Candidate, Ctx } from "./types";

export const settings = {
  minPrice: 100, minTradedValueCr: 20, breakoutDays: 20, volMult: 1.5,
  rsiLong: [55, 75] as [number, number], rsiShort: [25, 45] as [number, number],
  rsDays: 20, holdDays: 3, stopAtr: 1.0, minRR: 2,
};

function weeklyUp(d: DBar[], k: number, dir: 1 | -1) {
  const wk: number[] = [];
  let cur = "";
  for (let j = 0; j <= k; j++) {
    const dt = new Date(`${d[j].d}T00:00:00Z`);
    const monday = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400e3).toISOString().slice(0, 10);
    if (monday !== cur) { wk.push(d[j].c); cur = monday; } else wk[wk.length - 1] = d[j].c;
  }
  const e = ema(wk, 10).at(-1)!;
  return Number.isFinite(e) && (dir > 0 ? wk.at(-1)! > e : wk.at(-1)! < e);
}

export function swingFires(d: DBar[], k: number, dir: 1 | -1, bench: Map<string, number>, isStock: boolean, volRatioToday?: number) {
  if (k < 60) return false;
  const close = d.map((b) => b.c), e20 = ema(close.slice(0, k + 1), 20).at(-1)!, e50 = ema(close.slice(0, k + 1), 50).at(-1)!;
  const r = rsi(close.slice(Math.max(0, k - 60), k + 1), 14).at(-1)!;
  const c = d[k].c, S = settings;
  if (isStock) {
    if (c < S.minPrice) return false;
    const tv = d.slice(k - 20, k).reduce((a, b) => a + b.c * b.v, 0) / 20;
    if (tv < S.minTradedValueCr * 1e7) return false;
  }
  const hi = Math.max(...d.slice(k - S.breakoutDays, k).map((b) => b.h)), lo = Math.min(...d.slice(k - S.breakoutDays, k).map((b) => b.l));
  const vr = volRatioToday ?? d[k].v / (sma(d.slice(k - 20, k).map((b) => b.v), 20).at(-1) || 1);
  const rng = dir > 0 ? S.rsiLong : S.rsiShort;
  const base = dir > 0 ? c > hi && c > e20 && c > e50 : c < lo && c < e20 && c < e50;
  if (!base || !(vr >= S.volMult) || !(r >= rng[0] && r <= rng[1]) || !weeklyUp(d, k, dir)) return false;
  if (isStock) {
    const b0 = bench.get(d[k - S.rsDays].d), b1 = bench.get(d[k].d);
    if (!b0 || !b1) return false;
    const rs = c / d[k - S.rsDays].c - b1 / b0;
    if (dir > 0 ? rs <= 0 : rs >= 0) return false;
  }
  return true;
}

export const swing: Agent = {
  name: "swing",
  runs: ["btst", "mcx"],
  async scan(ctx: Ctx) {
    const { inst: i, today, daily, now } = ctx;
    if (daily.length < 80 || today.length < 20) return [];
    if (i.kind === "COMMODITY" && (now.mins < 22 * 60 + 30 || now.mins > 23 * 60 + 15)) return [];
    const isStock = i.kind === "STOCK";
    const tb: DBar = { t: today[0].t, d: now.date, o: today[0].o, h: Math.max(...today.map((b) => b.h)), l: Math.min(...today.map((b) => b.l)), c: ctx.futPx, v: 0 };
    const d = [...daily, tb], k = d.length - 1;
    // today's volume vs normal: futures volume so far vs the same time on past days (spot daily volume is not known intraday)
    const vrToday = relVolume(today, ctx.hist, now.mins);
    const bench = new Map(ctx.benchmark.map((b) => [b.d, b.c]));
    bench.set(now.date, ctx.benchmark.at(-1)?.c ?? 0);
    const aD = atrSeries(d, 14)[k];
    const out: Candidate[] = [];
    for (const dir of [1, -1] as const) {
      if (!swingFires(d, k, dir, bench, isStock, vrToday)) continue;
      if (tradingDaysBetween(segOf(i), now.date, i.fut.expiry) < settings.holdDays) continue;
      const e = ctx.futPx;
      const pivot = dir > 0 ? Math.max(...d.slice(k - 20, k).map((b) => b.h)) : Math.min(...d.slice(k - 20, k).map((b) => b.l));
      const sl = dir > 0 ? Math.max(e - settings.stopAtr * aD, pivot - 0.5 * aD) : Math.min(e + settings.stopAtr * aD, pivot + 0.5 * aD);
      const risk = (e - sl) * dir;
      if (!(risk > 0)) continue;
      const paths: Path[] = [];
      for (let j = 61; j < daily.length - settings.holdDays; j++) {
        if (!swingFires(daily, j, dir, bench, isStock)) continue;
        const aT = atrSeries(daily.slice(j - 20, j + 1), 14).at(-1)!;
        paths.push(dailyPath(daily, j, settings.holdDays, volScale(aD / e, aT / daily[j].c)));
      }
      out.push({
        agent: "swing", setup: dir > 0 ? "swing_breakout_20d" : "swing_breakdown_20d", dir, horizon: "positional", status: "ENTER",
        trigger: `20-day ${dir > 0 ? "breakout" : "breakdown"} close near ${fmt(e)}: enter before the close`,
        entry: e, sl, t1: e + dir * risk, t2: e + dir * settings.minRR * risk, t3: e + dir * 3 * risk, paths,
        rules: { kind: "directional", dir, sl: sl / e, t1: 1 + (dir * risk) / e, t2: 1 + (dir * settings.minRR * risk) / e, halfAtT1: true },
        structures: ["debit_spread", "fut_hedge", "long_option"], minDaysToExpiry: settings.holdDays + 2,
        why: [
          `close ${dir > 0 ? "above" : "below"} the 20-day ${dir > 0 ? "high" : "low"} ${fmt(pivot)}, ${dir > 0 ? "above" : "below"} EMA20 and EMA50`,
          `volume ${vrToday.toFixed(2)}× normal for this time; weekly trend ${dir > 0 ? "up" : "down"}`,
          isStock ? `${dir > 0 ? "outperforming" : "underperforming"} NIFTY 50 over ${settings.rsDays} sessions` : "",
          `same screen passed ${paths.length} times in ~2 years; hold up to ${settings.holdDays} sessions`,
        ].filter(Boolean),
        validUntilMin: i.kind === "COMMODITY" ? 23 * 60 + 20 : 15 * 60 + 25,
      });
    }
    return out;
  },
};
