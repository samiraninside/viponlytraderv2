/**
 * Hero-Zero (expiry day): cheap out-of-the-money options bought in the last hours of an
 * expiry, when the index is coiled (narrow range, ATR contracting) and could break hard
 * before the close. Most expire worthless; the few that run pay many times the premium.
 * The score replays the same time window on this index's history, so it is shown only when
 * the payoff has actually been worth it; expect few cards and a low win rate.
 *  - Near the day's high and above VWAP → OTM call; near the low and below VWAP → OTM put;
 *    otherwise an OTM strangle (both).
 *  - Premium targeted per contract (e.g. ₹5–25 on NIFTY); max loss = premium paid.
 */
import { intradayPath, type Path, volScale } from "../engine/evaluate";
import { atr, minsOf, vwap } from "../history";
import { sqOff } from "./common";
import { fmt } from "./rules";
import type { Agent, Candidate, Ctx } from "./types";

export const settings = {
  kinds: ["INDEX"] as string[],
  from: 13 * 60 + 30, to: 14 * 60 + 45,
  premium: { NIFTY: [4, 25], BANKNIFTY: [10, 60], FINNIFTY: [4, 25], SENSEX: [10, 60] } as Record<string, [number, number]>,
  coiledRangeAtr: 0.7,   // day's range so far < 0.7 × daily ATR
  nearExtreme: 0.25,     // within the top/bottom 25% of the day's range for a one-sided bet
};

export const heroZero: Agent = {
  name: "heroZero",
  runs: ["cycle"],
  async scan(ctx: Ctx) {
    const { inst: i, now, today, hist, daily } = ctx;
    if (!settings.kinds.includes(i.kind) || now.mins < settings.from || now.mins > settings.to || today.length < 20 || daily.length < 20) return [];
    const c = await ctx.chain(0);
    if (!c || c.expiry !== now.date) return [];
    const hi = Math.max(...today.map((b) => b.h)), lo = Math.min(...today.map((b) => b.l)), aD = atr(daily.slice(-15));
    if (hi - lo > settings.coiledRangeAtr * aD) return [];
    const loc = (ctx.futPx - lo) / (hi - lo || 1), vw = vwap(today);
    const dir: 1 | -1 | 0 = loc >= 1 - settings.nearExtreme && ctx.futPx > vw ? 1 : loc <= settings.nearExtreme && ctx.futPx < vw ? -1 : 0;
    const end = sqOff(i, now.date)!;
    const aNow = aD / daily.at(-1)!.c;
    const paths: Path[] = [];
    for (const [d, bars] of [...hist].slice(-60)) {
      const idx = bars.findIndex((b) => minsOf(b.t) >= now.mins - 5);
      if (idx <= 0) continue;
      const dd = daily.findIndex((x) => x.d === d);
      const aThen = dd > 15 ? atr(daily.slice(dd - 15, dd)) / daily[dd].c : aNow;
      const p = intradayPath(bars, idx, end, minsOf, volScale(aNow, aThen));
      if (p.length) paths.push(p);
    }
    if (paths.length < 15) return [];
    const [pmin, pmax] = settings.premium[i.root] ?? [5, 30];
    const cand: Candidate = {
      agent: "heroZero", setup: dir > 0 ? "hero_zero_call" : dir < 0 ? "hero_zero_put" : "hero_zero_strangle", dir, horizon: "intraday", status: "ENTER",
      trigger: `Expiry day, coiled: range ${fmt(hi - lo)} vs daily ATR ${fmt(aD)}${dir ? `, near the day's ${dir > 0 ? "high" : "low"}` : ""}`,
      entry: ctx.futPx, sl: 0, t1: 0, t2: 0, paths, rules: { kind: "hold" },
      structures: dir ? ["long_option"] : ["long_strangle"], minDaysToExpiry: 0,
      premiumRange: [pmin, pmax],
      why: [
        `${i.root} expires today; day's range so far ${((hi - lo) / aD).toFixed(2)}× its daily ATR`,
        dir ? `price ${dir > 0 ? "near the high, above" : "near the low, below"} VWAP: one-sided ${dir > 0 ? "call" : "put"}` : "no side: OTM call + put",
        `premium ₹${pmin}–${pmax}: the whole premium can go to zero; book half at 3× if it runs`,
        `replayed on ${paths.length} past sessions from ${Math.floor(now.mins / 60)}:${String(now.mins % 60).padStart(2, "0")} to the square-off`,
      ],
      validUntilMin: settings.to + 10,
    };
    return [cand];
  },
};
