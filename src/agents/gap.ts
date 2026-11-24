/**
 * Gap agent: gap-up / gap-down at the open (NSE 09:15, MCX 09:00).
 * Two ideas per gap, scored separately: "go" (continuation) and "fade" (gap fill).
 * Pre-open run shows WAIT; the first 5-min bar decides ENTER.
 */
import { atr, minsOf } from "../history";
import { fmt, intradayHistory, sqOff, startMin } from "./common";
import type { Agent, Candidate, Ctx } from "./types";

export const settings = {
  minGapAtr: 0.35,       // |gap| ≥ 0.35 × daily ATR
  enterUntilMin: 30,     // minutes after the open to still show ENTER
  t1R: 1, t2R: 2,
};

export const gap: Agent = {
  name: "gap",
  runs: ["preopen", "cycle", "mcx"],
  async scan(ctx: Ctx) {
    const { inst: i, today, now, daily } = ctx;
    const start = startMin(i, now.date);
    if (start === null || daily.length < 30 || !ctx.prevClose) return [];
    if (now.mins > start + settings.enterUntilMin) return [];
    const dAtr = atr(daily) / daily.at(-1)!.c;
    const openPx = today[0]?.o ?? ctx.futPx;           // pre-open: indicative price from the quote
    const g = openPx / ctx.prevClose - 1;
    if (Math.abs(g) < settings.minGapAtr * dAtr) return [];
    const first = today.find((b) => minsOf(b.t) === start);
    const out: Candidate[] = [];
    for (const kind of ["go", "fade"] as const) {
      const dir = ((kind === "go" ? 1 : -1) * Math.sign(g)) as 1 | -1;
      let status: Candidate["status"] = "WAIT", entry: number, sl: number, trigger: string;
      if (!first) {
        // pre-open: plan around the open
        entry = openPx; sl = openPx * (1 - dir * 0.5 * dAtr);
        trigger = `Wait for the first 5-min bar: it must close ${dir > 0 ? "up" : "down"}; enter on a break of its ${dir > 0 ? "high" : "low"}`;
      } else {
        const ok = dir > 0 ? first.c > first.o : first.c < first.o;
        if (!ok) continue;
        entry = dir > 0 ? first.h : first.l; sl = dir > 0 ? first.l : first.h;
        const last = today.at(-1)!;
        const broke = dir > 0 ? last.c > entry : last.c < entry;
        status = broke ? "ENTER" : "WAIT";
        trigger = broke ? `Broke the first bar's ${dir > 0 ? "high" : "low"} ${fmt(entry)}` : `Enter on a break of ${fmt(entry)}`;
        if (broke) entry = last.c;
      }
      const risk = Math.abs(entry - sl), riskPct = risk / entry;
      if (riskPct <= 0) continue;
      const paths = intradayHistory(i, ctx.hist, riskPct, (day, d, prior) => {
        const prevC = [...prior.values()].at(-1)?.at(-1)?.c, s = startMin(i, d);
        if (!prevC || s === null || !day.length) return null;
        const gg = day[0].o / prevC - 1;
        if (Math.sign(gg) !== Math.sign(g) || Math.abs(gg) < settings.minGapAtr * dAtr) return null;
        const f = day[0];
        if (!(dir > 0 ? f.c > f.o : f.c < f.o)) return null;
        const lvl = dir > 0 ? f.h : f.l;
        for (let k = 1; k < day.length && minsOf(day[k].t) < s + settings.enterUntilMin; k++)
          if (dir > 0 ? day[k].c > lvl : day[k].c < lvl) return { idx: k, riskPct: Math.abs(day[k].c - (dir > 0 ? f.l : f.h)) / day[k].c };
        return null;
      });
      out.push({
        agent: "gap", setup: `gap_${kind}_${g > 0 ? "up" : "down"}`, dir, horizon: "intraday", status, trigger,
        entry, sl, t1: entry + dir * settings.t1R * risk, t2: entry + dir * settings.t2R * risk, paths,
        rules: { kind: "directional", dir, sl: sl / entry, t1: 1 + dir * settings.t1R * riskPct, t2: 1 + dir * settings.t2R * riskPct, halfAtT1: true },
        structures: ["future", "long_option", "debit_spread"], minDaysToExpiry: 0,
        why: [
          `gap ${(g * 100).toFixed(2)}% (${(Math.abs(g) / dAtr).toFixed(2)}× daily ATR)`,
          kind === "go" ? "continuation setup" : "gap-fill setup",
          `similar gaps: ${paths.length} in the last ${ctx.hist.size} sessions`,
        ],
        validUntilMin: Math.min(sqOff(i, now.date)!, start + settings.enterUntilMin + 5),
      });
    }
    return out;
  },
};
