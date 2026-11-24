/**
 * Your scanners, rule for rule (futures, all instruments):
 *  A  breakout15      15-minute confirmed bullish breakout
 *  D  breakout15      15-minute bearish breakdown (same agent, short side)
 *  B  trigger5        5-minute bullish entry trigger (+ mirror short, switchable)
 *  C  preBreakout     pre-breakout accumulation → WATCHLIST (WAIT) with the breakout level
 * Notation as in Chartink: [0] = latest closed bar, [-1] = the bar before.
 */
import type { Bar } from "../dhan";
import { intradayPath, type Path } from "../engine/evaluate";
import { dayOf, minsOf } from "../history";
import { maxHigh, minLow, type Series } from "../indicators";
import { inEntryWindow, sqOff, startMin } from "./common";
import { complete15, cont, fmt, runRule } from "./rules";
import type { Agent, Candidate, Ctx } from "./types";

export const settings = {
  A: { volMult: 1.5, rsiMin: 55, lookback: 10, stopAtr: 1.5 },
  D: { volMult: 1.5, rsiMax: 45, lookback: 10, stopAtr: 1.5 },
  B: { volMult: 1.5, rsiMin: 55, mirrorShort: true, stopAtr: 1.5 },
  C: { rsiMin: 50, rsiMax: 70, nearPct: 0.02, lookback: 10, confirmWithinBars: 4 },
};

const okNum = (...x: number[]) => x.every(Number.isFinite);

/** Scanner A (dir 1) and D (dir -1) exactly as specified. */
export function scannerAD(s: Series, b: Bar[], i: number, dir: 1 | -1) {
  if (i < 22) return false;
  const c0 = b[i].c, c1 = b[i - 1].c;
  if (!okNum(s.ema20[i], s.vwap[i], s.rsi14[i], s.volSma20[i - 1])) return false;
  if (dir > 0) {
    const a = settings.A;
    return c0 > s.ema20[i] && c0 > s.vwap[i] && c0 > b[i].o &&
      c0 > maxHigh(b, i - 1, a.lookback) && c1 <= maxHigh(b, i - 2, a.lookback) &&
      b[i - 1].v > s.volSma20[i - 1] * a.volMult && s.rsi14[i] > a.rsiMin;
  }
  const d = settings.D;
  return c0 < s.ema20[i] && c0 < s.vwap[i] && c0 < b[i].o &&
    c0 < minLow(b, i - 1, d.lookback) && c1 >= minLow(b, i - 2, d.lookback) &&
    b[i].v > s.volSma20[i - 1] * d.volMult && s.rsi14[i] < d.rsiMax;
}

/** Scanner B (dir 1) and its mirror (dir -1). */
export function scannerB(s: Series, b: Bar[], i: number, dir: 1 | -1) {
  if (i < 22 || !okNum(s.ema20[i], s.vwap[i], s.rsi14[i], s.volSma20[i - 1])) return false;
  const x = settings.B, c0 = b[i].c;
  if (dir > 0) return c0 > s.ema20[i] && c0 > s.vwap[i] && c0 > b[i - 1].h && c0 > b[i].o && b[i].v > s.volSma20[i - 1] * x.volMult && s.rsi14[i] > x.rsiMin;
  return c0 < s.ema20[i] && c0 < s.vwap[i] && c0 < b[i - 1].l && c0 < b[i].o && b[i].v > s.volSma20[i - 1] * x.volMult && s.rsi14[i] < 100 - x.rsiMin;
}

/** Scanner C: close above EMA20 and VWAP, within 2% below the 10-bar high, RSI 50–70, ATR contracting. */
export function scannerC(s: Series, b: Bar[], i: number) {
  if (i < 22 || !okNum(s.ema20[i], s.vwap[i], s.rsi14[i], s.atr14[i], s.atr14[i - 3])) return false;
  const x = settings.C, c0 = b[i].c, h10 = maxHigh(b, i - 1, x.lookback);
  return c0 > s.ema20[i] && c0 > s.vwap[i] && c0 < h10 && c0 > h10 * (1 - x.nearPct) &&
    s.rsi14[i] > x.rsiMin && s.rsi14[i] < x.rsiMax && s.atr14[i] < s.atr14[i - 3];
}

const stopAtr = (s: Series, b: Bar[], i: number, dir: 1 | -1, k: number) =>
  dir > 0 ? Math.max(b[i].l, b[i].c - k * s.atr14[i]) : Math.min(b[i].h, b[i].c + k * s.atr14[i]);

export const breakout15: Agent = {
  name: "breakout15",
  runs: ["cycle", "mcx"],
  async scan(ctx) {
    return runRule({
      agent: "breakout15", tf: 15, dirs: [1, -1],
      setup: (d) => (d > 0 ? "A_15m_breakout" : "D_15m_breakdown"),
      fires: (_c, s, b, i, d) => scannerAD(s, b, i, d),
      stop: (_c, s, b, i, d) => stopAtr(s, b, i, d, d > 0 ? settings.A.stopAtr : settings.D.stopAtr),
      structures: ["future", "long_option", "debit_spread"],
      why: (_c, s, b, i, d) => [
        d > 0 ? `Scanner A: 15-min close ${fmt(b[i].c)} above the 10-bar high ${fmt(maxHigh(b, i - 1, 10))}, first close above it`
              : `Scanner D: 15-min close ${fmt(b[i].c)} below the 10-bar low ${fmt(minLow(b, i - 1, 10))}, first close below it`,
        `${d > 0 ? "above" : "below"} 15-min EMA20 ${fmt(s.ema20[i])} and VWAP ${fmt(s.vwap[i])}, RSI ${s.rsi14[i].toFixed(1)}`,
        `volume ${(b[d > 0 ? i - 1 : i].v / s.volSma20[i - 1]).toFixed(2)}× its 20-bar average`,
      ],
    }, ctx);
  },
};

export const trigger5: Agent = {
  name: "trigger5",
  runs: ["cycle", "mcx"],
  async scan(ctx) {
    return runRule({
      agent: "trigger5", tf: 5, dirs: settings.B.mirrorShort ? [1, -1] : [1],
      setup: (d) => (d > 0 ? "B_5m_trigger_long" : "B_5m_trigger_short"),
      fires: (_c, s, b, i, d) => scannerB(s, b, i, d),
      stop: (_c, s, b, i, d) => (d > 0 ? Math.max(b[i - 1].l, b[i].c - settings.B.stopAtr * s.atr14[i]) : Math.min(b[i - 1].h, b[i].c + settings.B.stopAtr * s.atr14[i])),
      structures: ["future", "long_option", "debit_spread"],
      why: (_c, s, b, i, d) => [
        `Scanner B${d < 0 ? " (mirror)" : ""}: 5-min close ${fmt(b[i].c)} ${d > 0 ? "above the previous high" : "below the previous low"} ${fmt(d > 0 ? b[i - 1].h : b[i - 1].l)}`,
        `${d > 0 ? "above" : "below"} 5-min EMA20 and VWAP, RSI ${s.rsi14[i].toFixed(1)}, volume ${(b[i].v / s.volSma20[i - 1]).toFixed(2)}× average`,
      ],
    }, ctx);
  },
};

/** Scanner C → WAIT card: "enter on a 15-min close above X". History = days where C fired and a close above X followed within N bars. */
export const preBreakout: Agent = {
  name: "preBreakout",
  runs: ["cycle", "mcx"],
  async scan(ctx: Ctx) {
    const { inst: i, now } = ctx;
    if (!ctx.today.length || startMin(i, now.date) === null || !inEntryWindow(i, now.mins)) return [];
    const c = cont(ctx), s = c.s15, b = c.b15, n = complete15(c, now.epoch / 1000), k = n - 1;
    if (k < c.todayFrom15 || !scannerC(s, b, k)) return [];
    const level = maxHigh(b, k - 1, settings.C.lookback);
    const sl = Math.max(s.ema20[k], level - 1.5 * s.atr14[k]);
    const risk = level - sl;
    if (!(risk > 0)) return [];
    const paths: Path[] = [];
    let lastDay = "";
    for (let j = 30; j < c.todayFrom15; j++) {
      const d = dayOf(b[j].t);
      if (d === lastDay || !inEntryWindow(i, minsOf(b[j].t) + 15) || !scannerC(s, b, j)) continue;
      const lv = maxHigh(b, j - 1, settings.C.lookback);
      for (let q = j + 1; q <= j + settings.C.confirmWithinBars && q < c.todayFrom15 && dayOf(b[q].t) === d; q++) {
        if (b[q].c > lv) {
          const r = lv - Math.max(s.ema20[j], lv - 1.5 * s.atr14[j]);
          const dayBars = ctx.hist.get(d), j5 = c.map15to5(q);
          const jj = dayBars?.findIndex((x) => x.t === c.b5[j5]?.t) ?? -1;
          if (r > 0 && dayBars && jj >= 0) {
            const p = intradayPath(dayBars, jj, sqOff(i, d) ?? 0, minsOf, Math.min(3, Math.max(0.33, (risk / level) / (r / lv))));
            if (p.length) { paths.push(p); lastDay = d; }
          }
          break;
        }
      }
    }
    const cand: Candidate = {
      agent: "preBreakout", setup: "C_pre_breakout", dir: 1, horizon: "intraday", status: "WAIT",
      trigger: `Watchlist: enter on a 15-min close above ${fmt(level)}`,
      entry: level, sl, t1: level + risk, t2: level + 2 * risk, t3: level + 3 * risk, paths,
      rules: { kind: "directional", dir: 1, sl: sl / level, t1: 1 + risk / level, t2: 1 + (2 * risk) / level, halfAtT1: true },
      structures: ["future", "long_option", "debit_spread"], minDaysToExpiry: 0,
      why: [
        `Scanner C: within ${(settings.C.nearPct * 100).toFixed(0)}% of the 10-bar high, above EMA20 and VWAP`,
        `RSI ${s.rsi14[k].toFixed(1)} (50–70), 15-min ATR contracting (${fmt(s.atr14[k])} < ${fmt(s.atr14[k - 3])})`,
        `C fired and broke out within ${settings.C.confirmWithinBars} bars on ${paths.length} past days`,
      ],
      validUntilMin: Math.min(sqOff(i, now.date)!, now.mins + 30),
    };
    return [cand];
  },
};
