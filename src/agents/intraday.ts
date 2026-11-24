/**
 * Intraday logic agents:
 *  vaSweep       Value Area Liquidity Sweep (liquidity and reversal)
 *  emaReclaim    EMA20 Pullback Reclaim (trend continuation)
 *  avwapReclaim  Anchored VWAP Reclaim (price and volume confirmation)
 *  indexScalp    Index Scalping Long (short-duration directional, 30-min time stop)
 */
import { dayOf } from "../history";
import { anchoredVwap, ema, maxHigh, minLow, valueArea, vwapSeries } from "../indicators";
import { type Cont, fmt, runRule } from "./rules";
import type { Agent } from "./types";

export const settings = {
  vaSweep: { sweepAtr: 0.15, reclaimWithin: 3, stopAtr: 0.15 },
  emaReclaim: { touchWithin: 3 },
  avwapReclaim: { anchorSessions: 3, volMult: 1.5 },
  indexScalp: { from: 9 * 60 + 30, to: 14 * 60 + 30, rsiMin: 55, rsiMax: 75, volMult: 1.2, stopAtr: 1.0, holdMinutes: 30 },
};

// ---------------------------------------------------------------- value area per session (from the previous session)
const vaCache = new WeakMap<Cont, Map<string, ReturnType<typeof valueArea>>>();
function prevVA(c: Cont, i5: number) {
  let m = vaCache.get(c);
  if (!m) { m = new Map(); vaCache.set(c, m); }
  const d = dayOf(c.b5[i5].t);
  if (m.has(d)) return m.get(d)!;
  let k = i5;
  while (k >= 0 && dayOf(c.b5[k].t) === d) k--;
  if (k < 0) { m.set(d, null); return null; }
  const pd = dayOf(c.b5[k].t);
  const bars = [];
  while (k >= 0 && dayOf(c.b5[k].t) === pd) bars.push(c.b5[k--]);
  const va = bars.length > 10 ? valueArea(bars) : null;
  m.set(d, va);
  return va;
}

export const vaSweep: Agent = {
  name: "vaSweep",
  runs: ["cycle", "mcx"],
  async scan(ctx) {
    const x = settings.vaSweep;
    return runRule({
      agent: "vaSweep", tf: 5, dirs: [1, -1],
      setup: (d) => (d > 0 ? "va_sweep_long" : "va_sweep_short"),
      fires: (c, s, b, i, d) => {
        const va = prevVA(c, i);
        if (!va || !Number.isFinite(s.atr14[i]) || dayOf(b[i - x.reclaimWithin]?.t ?? 0) !== dayOf(b[i].t)) return false;
        const lvl = d > 0 ? va.val : va.vah;
        // a sweep beyond the value-area edge in the last N bars, and this bar closes back inside
        let swept = false;
        for (let k = i - x.reclaimWithin; k < i; k++) if (d > 0 ? b[k].l < lvl - x.sweepAtr * s.atr14[i] : b[k].h > lvl + x.sweepAtr * s.atr14[i]) swept = true;
        const back = d > 0 ? b[i].c > lvl && b[i - 1].c <= lvl : b[i].c < lvl && b[i - 1].c >= lvl;
        return swept && back && (d > 0 ? b[i].c > b[i].o : b[i].c < b[i].o);
      },
      stop: (_c, s, b, i, d) => (d > 0 ? minLow(b, i, x.reclaimWithin + 1) - x.stopAtr * s.atr14[i] : maxHigh(b, i, x.reclaimWithin + 1) + x.stopAtr * s.atr14[i]),
      targets: (c, _s, _b, i, d, e, r) => {
        const va = prevVA(c, i)!;
        const t1 = d > 0 ? Math.max(va.poc, e + r) : Math.min(va.poc, e - r);
        const t2 = d > 0 ? Math.max(va.vah, e + 2 * r) : Math.min(va.val, e - 2 * r);
        return [t1, t2];
      },
      structures: ["future", "long_option", "debit_spread"],
      why: (c, _s, _b, i, d) => {
        const va = prevVA(c, i)!;
        return [
          `swept ${d > 0 ? "below yesterday's value-area low" : "above yesterday's value-area high"} ${fmt(d > 0 ? va.val : va.vah)} and closed back inside`,
          `yesterday's value area ${fmt(va.val)}–${fmt(va.vah)}, POC ${fmt(va.poc)} (targets)`,
        ];
      },
    }, ctx);
  },
};

export const emaReclaim: Agent = {
  name: "emaReclaim",
  runs: ["cycle", "mcx"],
  async scan(ctx) {
    const x = settings.emaReclaim;
    return runRule({
      agent: "emaReclaim", tf: 5, dirs: [1, -1],
      setup: (d) => (d > 0 ? "ema20_reclaim_long" : "ema20_reclaim_short"),
      fires: (c, s, b, i, d) => {
        const e = s.ema20[i], e50 = s.ema50[i];
        if (!Number.isFinite(e) || !Number.isFinite(e50)) return false;
        // trend on 15-min: EMA20 vs EMA50 of the 15-min bar containing this 5-min bar
        const i15 = c.i5to15[i];
        const t20 = c.s15.ema20[i15 - 1], t50 = c.s15.ema50[i15 - 1];
        if (!(i15 > 0 && Number.isFinite(t20) && Number.isFinite(t50))) return false;
        const trend = d > 0 ? t20 > t50 && b[i].c > t50 : t20 < t50 && b[i].c < t50;
        let touched = false;
        for (let k = i - x.touchWithin; k < i; k++) if (d > 0 ? b[k].l <= s.ema20[k] : b[k].h >= s.ema20[k]) touched = true;
        const reclaim = d > 0 ? b[i].c > e && b[i].c > b[i].o && b[i].c > b[i - 1].h : b[i].c < e && b[i].c < b[i].o && b[i].c < b[i - 1].l;
        return trend && touched && reclaim;
      },
      stop: (_c, s, b, i, d) => (d > 0 ? Math.min(minLow(b, i, x.touchWithin + 1), s.ema20[i] - 0.5 * s.atr14[i]) : Math.max(maxHigh(b, i, x.touchWithin + 1), s.ema20[i] + 0.5 * s.atr14[i])),
      structures: ["future", "long_option", "debit_spread"],
      why: (_c, s, b, i, d) => [
        `15-min trend ${d > 0 ? "up" : "down"} (EMA20 ${d > 0 ? ">" : "<"} EMA50)`,
        `pulled back to the 5-min EMA20 ${fmt(s.ema20[i])} and reclaimed it with a close ${d > 0 ? "above the previous high" : "below the previous low"}`,
      ],
    }, ctx);
  },
};

export const avwapReclaim: Agent = {
  name: "avwapReclaim",
  runs: ["cycle", "mcx"],
  async scan(ctx) {
    const x = settings.avwapReclaim;
    const anchorCache = new Map<string, number[]>();
    const avwapAt = (c: Cont, i: number, d: 1 | -1) => {
      // anchor: lowest low (long) / highest high (short) of the previous N sessions, fixed for the day
      const day = dayOf(c.b5[i].t), key = `${day}:${d}`;
      if (!anchorCache.has(key)) {
        let k = i; while (k > 0 && dayOf(c.b5[k - 1].t) === day) k--;
        const dayStart = k;
        let sessions = 0, j = k - 1, best = -1;
        while (j >= 0 && sessions < x.anchorSessions) {
          if (best < 0 || (d > 0 ? c.b5[j].l < c.b5[best].l : c.b5[j].h > c.b5[best].h)) best = j;
          if (j > 0 && dayOf(c.b5[j - 1].t) !== dayOf(c.b5[j].t)) sessions++;
          j--;
        }
        anchorCache.set(key, best >= 0 ? anchoredVwap(c.b5, best) : []);
        void dayStart;
      }
      return anchorCache.get(key)!;
    };
    return runRule({
      agent: "avwapReclaim", tf: 5, dirs: [1, -1],
      setup: (d) => (d > 0 ? "avwap_reclaim_long" : "avwap_reclaim_short"),
      fires: (c, s, b, i, d) => {
        const av = avwapAt(c, i, d);
        if (!Number.isFinite(av[i]) || !Number.isFinite(av[i - 1]) || !Number.isFinite(s.volSma20[i - 1])) return false;
        const cross = d > 0 ? b[i - 1].c < av[i - 1] && b[i].c > av[i] : b[i - 1].c > av[i - 1] && b[i].c < av[i];
        return cross && b[i].v > s.volSma20[i - 1] * x.volMult && (d > 0 ? b[i].c > b[i].o : b[i].c < b[i].o);
      },
      stop: (c, s, b, i, d) => {
        const av = avwapAt(c, i, d)[i];
        return d > 0 ? Math.min(minLow(b, i, 3), av - 0.5 * s.atr14[i]) : Math.max(maxHigh(b, i, 3), av + 0.5 * s.atr14[i]);
      },
      structures: ["future", "long_option", "debit_spread"],
      why: (c, s, b, i, d) => [
        `crossed back ${d > 0 ? "above" : "below"} the VWAP anchored at the ${d > 0 ? "lowest low" : "highest high"} of the last ${x.anchorSessions} sessions (${fmt(avwapAt(c, i, d)[i])})`,
        `volume ${(b[i].v / s.volSma20[i - 1]).toFixed(2)}× average confirms`,
      ],
    }, ctx);
  },
};

export const indexScalp: Agent = {
  name: "indexScalp",
  runs: ["cycle"],
  async scan(ctx) {
    const x = settings.indexScalp;
    const e9cache = new WeakMap<object, number[]>(), e21cache = new WeakMap<object, number[]>();
    const e = (c: Cont, n: 9 | 21) => {
      const m = n === 9 ? e9cache : e21cache;
      if (!m.has(c)) m.set(c, ema(c.s5.close, n));
      return m.get(c)!;
    };
    return runRule({
      agent: "indexScalp", tf: 5, dirs: [1], kinds: ["INDEX"], window: [x.from, x.to], holdMinutes: x.holdMinutes,
      setup: () => "index_scalp_long",
      fires: (c, s, b, i) => {
        const e9 = e(c, 9)[i], e21 = e(c, 21)[i], r = s.rsi14[i];
        return Number.isFinite(e9) && Number.isFinite(e21) && e9 > e21 && b[i].c > e9 && b[i].c > s.vwap[i] &&
          r > x.rsiMin && r < x.rsiMax && b[i].c > b[i - 1].h && b[i].v > s.volSma20[i - 1] * x.volMult;
      },
      stop: (_c, s, b, i) => Math.max(b[i - 1].l, b[i].c - x.stopAtr * s.atr14[i]),
      structures: ["future", "long_option"],
      why: (c, s, b, i) => [
        `EMA9 > EMA21, above VWAP, RSI ${s.rsi14[i].toFixed(1)}, close above the previous high`,
        `scalp: exit within ${x.holdMinutes} minutes if neither target nor stop is hit`,
      ],
    }, ctx);
  },
};

void vwapSeries;
