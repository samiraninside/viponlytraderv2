/**
 * BTST / positional agent (runs ~14:50–15:20 for NSE, ~22:30–23:15 for MCX crude).
 * Strong close → long into tomorrow's open (BTST) or 2–3 days (positional); weak close → short.
 * Always hedged: the engine picks the best structure per profile (spread, future + protective
 * option, or straddle on event days). Naked futures are never shown overnight.
 */
import { tradingDaysBetween } from "../calendar";
import { dailyPath, type Path, volScale } from "../engine/evaluate";
import { atr, type DBar, vwap } from "../history";
import { fmt, segOf } from "./common";
import type { Agent, Candidate, Ctx, Horizon } from "./types";

export const settings = {
  strongClose: 0.75,      // close in the top 25% of today's range
  minMoveAtr: 0.5,        // today's move ≥ 0.5 × daily ATR
  btst: { slAtr: 0.6, t1Atr: 0.5, t2Atr: 1.0 },
  positional: { days: 3, slAtr: 1.0, t1Atr: 1.0, t2Atr: 1.8, t3Atr: 2.5 },
};

function cond(d: DBar[], k: number, dir: 1 | -1) {
  const b = d[k], p = d[k - 1];
  if (!p || b.h <= b.l) return false;
  const loc = (b.c - b.l) / (b.h - b.l);
  const a = atr(d.slice(Math.max(0, k - 15), k + 1));
  const mv = (b.c - p.c) / (a || 1);
  return dir > 0 ? loc >= settings.strongClose && mv >= settings.minMoveAtr : loc <= 1 - settings.strongClose && mv <= -settings.minMoveAtr;
}

export const btst: Agent = {
  name: "btst",
  runs: ["btst", "mcx"],
  async scan(ctx: Ctx) {
    const { inst: i, today, daily, now } = ctx;
    if (daily.length < 60 || today.length < 20) return [];
    if (i.kind === "COMMODITY" && (now.mins < 22 * 60 + 30 || now.mins > 23 * 60 + 15)) return [];
    // today's bar so far, as a daily bar
    const tb: DBar = { t: today[0].t, d: now.date, o: today[0].o, h: Math.max(...today.map((b) => b.h)), l: Math.min(...today.map((b) => b.l)), c: ctx.futPx, v: 0 };
    const d = [...daily, tb];
    const k = d.length - 1;
    const aD = atr(d.slice(-16));
    const vw = vwap(today);
    const out: Candidate[] = [];
    for (const dir of [1, -1] as const) {
      if (!cond(d, k, dir) || (dir > 0 ? ctx.futPx < vw : ctx.futPx > vw)) continue;
      for (const horizon of ["btst", "positional"] as Horizon[]) {
        const s = horizon === "btst" ? settings.btst : settings.positional;
        const days = horizon === "btst" ? 1 : settings.positional.days;
        const paths: Path[] = [];
        for (let j = 20; j < daily.length - days; j++) {
          if (!cond(daily, j, dir)) continue;
          const aThen = atr(daily.slice(j - 15, j + 1));
          paths.push(dailyPath(daily, j, days, volScale(aD / d[k].c, aThen / daily[j].c), horizon === "btst"));
        }
        const e = ctx.futPx, slPx = e - dir * s.slAtr * aD;
        const t1 = e + dir * s.t1Atr * aD, t2 = e + dir * s.t2Atr * aD;
        const t3 = horizon === "positional" ? e + dir * settings.positional.t3Atr * aD : undefined;
        const expDays = tradingDaysBetween(segOf(i), now.date, i.fut.expiry);
        if (expDays < days) continue; // the future would expire inside the hold
        out.push({
          agent: "btst", setup: `${dir > 0 ? "strong" : "weak"}_close_${horizon}`, dir, horizon, status: "ENTER",
          trigger: `${dir > 0 ? "Strong" : "Weak"} close near ${fmt(e)}: enter before the close`,
          entry: e, sl: slPx, t1, t2, t3, paths,
          rules: { kind: "directional", dir, sl: slPx / e, t1: t1 / e, t2: t2 / e, halfAtT1: horizon === "positional" },
          structures: ctx.event ? ["debit_spread", "fut_hedge", "long_option", "long_straddle"] : ["debit_spread", "fut_hedge", "long_option"],
          minDaysToExpiry: horizon === "btst" ? 2 : days + 2,
          why: [
            `closing in the ${dir > 0 ? "top" : "bottom"} ${Math.round((1 - settings.strongClose) * 100)}% of the day's range, ${dir > 0 ? "above" : "below"} VWAP`,
            `move ${((ctx.futPx / ctx.prevClose - 1) * 100).toFixed(2)}% today; daily ATR ${fmt(aD)}`,
            horizon === "btst" ? "exit at tomorrow's open move (gap)" : `hold up to ${days} sessions`,
            `this close pattern appeared ${paths.length} times in ~2 years`,
            ctx.event ? "event day: a straddle is also considered" : "",
          ].filter(Boolean),
          validUntilMin: i.kind === "COMMODITY" ? 23 * 60 + 20 : 15 * 60 + 25,
          riskRefPerUnit: s.slAtr * aD,
        });
      }
    }
    return out;
  },
};
