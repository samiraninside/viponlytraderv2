/**
 * OI build-up agent (intraday, futures). Price up + open interest up = long build-up;
 * price down + OI up = short build-up. Needs OI in the 5-min futures bars.
 */
import type { Bar } from "../dhan";
import { atr, minsOf, vwap } from "../history";
import { fmt, inEntryWindow, intradayHistory, sqOff, startMin } from "./common";
import type { Agent, Candidate, Ctx } from "./types";

export const settings = {
  notBefore: "10:00",
  minPriceMove: { INDEX: 0.003, STOCK: 0.006, COMMODITY: 0.006 },  // vs previous close
  minOiChange: { INDEX: 0.03, STOCK: 0.05, COMMODITY: 0.04 },      // vs first bar of the day
  stopAtr: 1.5,          // stop = max(distance to VWAP, 1.5 × 5-min ATR)
  t1R: 1, t2R: 2,
};

const toMin = (s: string) => +s.slice(0, 2) * 60 + +s.slice(3);

function signal(day: Bar[], j: number, prevClose: number, kind: keyof typeof settings.minPriceMove) {
  const b = day[j], first = day[0];
  if (!b.oi || !first.oi) return 0;
  const pm = b.c / prevClose - 1, om = b.oi / first.oi - 1;
  if (om < settings.minOiChange[kind]) return 0;
  const vw = vwap(day.slice(0, j + 1));
  if (pm >= settings.minPriceMove[kind] && b.c > vw) return 1;
  if (pm <= -settings.minPriceMove[kind] && b.c < vw) return -1;
  return 0;
}

export const oiBuildup: Agent = {
  name: "oiBuildup",
  runs: ["cycle", "mcx"],
  async scan(ctx: Ctx) {
    const { inst: i, today, now } = ctx;
    if (today.length < 6 || !today.at(-1)!.oi || now.mins < toMin(settings.notBefore) || !inEntryWindow(i, now.mins)) return [];
    const j = today.length - 1;
    const dir = signal(today, j, ctx.prevClose, i.kind);
    if (!dir) return [];
    // fresh: the first qualifying bar after `notBefore` is the latest or the one before it
    const firstK = today.findIndex((b, k) => minsOf(b.t) >= toMin(settings.notBefore) && signal(today, k, ctx.prevClose, i.kind) === dir);
    if (firstK < 0 || j - firstK > 1) return [];
    const entry = today[j].c, vw = vwap(today), a = atr(today);
    const risk = Math.max(Math.abs(entry - vw), settings.stopAtr * a);
    const sl = entry - dir * risk, riskPct = risk / entry;
    const paths = intradayHistory(i, ctx.hist, riskPct, (day, d, prior) => {
      const prev = [...prior.values()].at(-1)?.at(-1)?.c;
      if (!prev) return null;
      for (let k = 1; k < day.length; k++) {
        const m = minsOf(day[k].t);
        if (m < toMin(settings.notBefore) || !inEntryWindow(i, m + 5)) continue;
        if (signal(day, k, prev, i.kind) === dir) {
          const r = Math.max(Math.abs(day[k].c - vwap(day.slice(0, k + 1))), settings.stopAtr * atr(day.slice(0, k + 1)));
          return { idx: k, riskPct: r / day[k].c };
        }
      }
      return null;
    });
    const oiChg = today[j].oi! / today[0].oi! - 1;
    const c: Candidate = {
      agent: "oiBuildup", setup: dir > 0 ? "long_buildup" : "short_buildup", dir, horizon: "intraday", status: "ENTER",
      trigger: `${dir > 0 ? "Long" : "Short"} build-up confirmed at ${fmt(entry)}`,
      entry, sl, t1: entry + dir * settings.t1R * risk, t2: entry + dir * settings.t2R * risk, paths,
      rules: { kind: "directional", dir, sl: sl / entry, t1: 1 + dir * settings.t1R * riskPct, t2: 1 + dir * settings.t2R * riskPct, halfAtT1: true },
      structures: ["future", "long_option", "debit_spread"], minDaysToExpiry: 0,
      why: [
        `price ${((entry / ctx.prevClose - 1) * 100).toFixed(2)}% vs yesterday, futures OI ${(oiChg * 100).toFixed(1)}% since the open`,
        `${dir > 0 ? "above" : "below"} VWAP ${fmt(vw)}`,
        `same signal fired ${paths.length} times in the last ${ctx.hist.size} sessions`,
      ],
      validUntilMin: Math.min(sqOff(i, now.date)!, now.mins + 10),
    };
    return startMin(i, now.date) === null ? [] : [c];
  },
};
