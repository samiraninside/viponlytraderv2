/**
 * Option selling, defined risk only:
 *  premiumDecay  1–5 sessions to expiry: iron condor / iron fly, or a credit spread on the
 *                side of the 15-min trend. Needs rich premium (IV rank ≥ 50, or straddle ≥ 1.05×
 *                the move this instrument usually makes over the same time).
 *  expiryDecay   expiry day (0 DTE), 09:45–12:30: iron fly / condor with risk controls:
 *                no entry on a trend day (moved > 0.6× daily ATR from the open), stop at the
 *                breakevens, out by square-off.
 * Naked selling is off unless ALLOW_NAKED_SELLING is true in config (Big profile only).
 */
import { ALLOW_NAKED_SELLING } from "../config";
import { dailyPath, intradayPath, type Path, volScale } from "../engine/evaluate";
import { atr, minsOf } from "../history";
import { segOf, sqOff } from "./common";
import { cont, daysToExpiry, fmt } from "./rules";
import type { Agent, Candidate, Ctx } from "./types";
import { tradingDaysBetween } from "../calendar";

export const settings = {
  kinds: ["INDEX", "COMMODITY"] as string[],   // add "STOCK" for stock options (wider spreads)
  premiumDecay: { maxDays: 5, nseFrom: 13 * 60, nseTo: 15 * 60 + 15, mcxFrom: 18 * 60, mcxTo: 22 * 60, minIvRank: 50, minRichness: 1.05 },
  expiryDecay: { from: 9 * 60 + 45, to: 12 * 60 + 30, maxMoveAtr: 0.6, minRichness: 1.0 },
};

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const sellStructures = (extra: Candidate["structures"] = []): Candidate["structures"] =>
  [...extra, "iron_condor", "iron_fly", ...(ALLOW_NAKED_SELLING ? (["short_strangle"] as const) : [])];

function trendDir(ctx: Ctx): 1 | -1 | 0 {
  const c = cont(ctx), k = c.b15.length - 2;
  const e20 = c.s15.ema20[k], e50 = c.s15.ema50[k];
  if (!Number.isFinite(e20) || !Number.isFinite(e50)) return 0;
  return e20 > e50 * 1.001 ? 1 : e20 < e50 * 0.999 ? -1 : 0;
}

export const premiumDecay: Agent = {
  name: "premiumDecay",
  runs: ["cycle", "mcx"],
  async scan(ctx) {
    const { inst: i, now, daily } = ctx, S = settings.premiumDecay;
    if (!settings.kinds.includes(i.kind) || daily.length < 60) return [];
    const nse = i.kind !== "COMMODITY";
    if (nse ? now.mins < S.nseFrom || now.mins > S.nseTo : now.mins < S.mcxFrom || now.mins > S.mcxTo) return [];
    const c = await ctx.chain(1);
    if (!c) return [];
    const dte = daysToExpiry(i, now.date, c.expiry);
    if (dte < 1 || dte > S.maxDays) return [];
    const aNow = atr(daily.slice(-15)) / daily.at(-1)!.c;
    const paths: Path[] = [];
    for (let j = 20; j < daily.length - dte; j++) paths.push(dailyPath(daily, j, dte, volScale(aNow, atr(daily.slice(j - 15, j + 1)) / daily[j].c)));
    const straddle = (c.ce.get(c.atm)?.ltp ?? 0) + (c.pe.get(c.atm)?.ltp ?? 0);
    const realized = median(paths.map((p) => Math.abs(p.at(-1)!.c - 1))) * c.spot;
    const rich = realized ? straddle / realized : 0;
    const ivr = await ctx.ivRank(c);
    if (!(ivr !== null ? ivr >= S.minIvRank : rich >= S.minRichness)) return [];
    const tr = trendDir(ctx);
    const out: Candidate[] = [{
      agent: "premiumDecay", setup: `hold_${dte}d_neutral`, dir: 0, horizon: "positional", status: "ENTER",
      trigger: `Premium rich: straddle ${fmt(straddle)} vs typical ${dte}-session move ${fmt(realized)}`,
      entry: ctx.futPx, sl: 0, t1: 0, t2: 0, paths, rules: { kind: "range", upStop: 0, dnStop: 0 },
      structures: sellStructures(), minDaysToExpiry: 1, ivMult: 0.97,
      why: [
        ivr !== null ? `ATM IV ${(c.atmIv * 100).toFixed(1)}%, IV rank ${ivr.toFixed(0)}` : `ATM IV ${(c.atmIv * 100).toFixed(1)}% (IV rank needs 20 days of history)`,
        `premium ${rich.toFixed(2)}× the usual move to expiry ${c.expiry}`,
        "defined risk: every short option has a bought wing",
      ],
      validUntilMin: nse ? S.nseTo : S.mcxTo,
    }];
    if (tr) out.push({
      ...out[0], setup: `hold_${dte}d_${tr > 0 ? "bull_put" : "bear_call"}_spread`, dir: tr, structures: ["credit_spread"],
      why: [...out[0].why, `15-min trend ${tr > 0 ? "up" : "down"}: sell the ${tr > 0 ? "put" : "call"} side only`],
    });
    return out;
  },
};

export const expiryDecay: Agent = {
  name: "expiryDecay",
  runs: ["cycle", "mcx"],
  async scan(ctx) {
    const { inst: i, now, hist, daily, today } = ctx, S = settings.expiryDecay;
    if (!settings.kinds.includes(i.kind) || now.mins < S.from || now.mins > S.to || !today.length || daily.length < 20) return [];
    const c = await ctx.chain(0);
    if (!c || c.expiry !== now.date) return [];
    const aD = atr(daily.slice(-15));
    const moved = Math.abs(ctx.futPx - today[0].o);
    if (moved > S.maxMoveAtr * aD) return [];   // trend day: stand aside
    const end = sqOff(i, now.date)!;
    const paths: Path[] = [];
    for (const [, bars] of [...hist].slice(-40)) {
      const idx = bars.findIndex((b) => minsOf(b.t) >= now.mins - 5);
      if (idx > 0 && Math.abs(bars[idx].c - bars[0].o) <= S.maxMoveAtr * aD) {
        const p = intradayPath(bars, idx, end, minsOf);
        if (p.length) paths.push(p);
      }
    }
    if (paths.length < 10) return [];
    const straddle = (c.ce.get(c.atm)?.ltp ?? 0) + (c.pe.get(c.atm)?.ltp ?? 0);
    const realized = median(paths.map((p) => Math.abs(p.at(-1)!.c - 1))) * c.spot;
    if (!realized || straddle / realized < S.minRichness) return [];
    void tradingDaysBetween; void segOf;
    return [{
      agent: "expiryDecay", setup: "expiry_day_decay", dir: 0, horizon: "intraday", status: "ENTER",
      trigger: `Expiry day, range-bound so far (moved ${fmt(moved)} vs ATR ${fmt(aD)}): sell decay now`,
      entry: ctx.futPx, sl: 0, t1: 0, t2: 0, paths, rules: { kind: "range", upStop: 0, dnStop: 0 },
      structures: sellStructures(), minDaysToExpiry: 0, ivMult: 0.95,
      why: [
        `straddle ${fmt(straddle)} vs the usual rest-of-day move ${fmt(realized)} on calm expiry days`,
        `exit at the breakevens or by ${Math.floor(end / 60)}:${String(end % 60).padStart(2, "0")}`,
        "defined risk only",
      ],
      validUntilMin: S.to + 10,
    }];
  },
};
