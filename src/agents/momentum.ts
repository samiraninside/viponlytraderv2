/**
 * Momentum agent: opening-range breakout with VWAP and volume confirmation, intraday.
 * Long when a 5-min bar closes above the opening range with price above VWAP; short below.
 * Edit `settings` to change the rule. History uses the exact same rule.
 */
import type { Bar } from "../dhan";
import { minsOf, openingRange, relVolume, vwap } from "../history";
import type { Agent, Candidate, Ctx } from "./types";
import { fmt, inEntryWindow, intradayHistory, sqOff, startMin } from "./common";

export const settings = {
  rangeMinutes: 15,
  minRelVolume: 1.1,      // today's volume so far vs the 20-day average of the same window
  requireVwap: true,
  stop: "mid" as "mid" | "opposite",
  t1R: 1, t2R: 2,
  maxTriggerAgeBars: 2,   // older triggers are not shown as ENTER
  waitWithin: 0.3,        // show WAIT when price is within 30% of the range from a boundary
  maxRangePct: 0.02,      // skip days whose opening range is wider than 2% of price
};

function breakout(day: Bar[], start: number, dir: 1 | -1, inWindow: (m: number) => boolean) {
  const or = openingRange(day, start, settings.rangeMinutes);
  if (!or) return null;
  for (let j = 0; j < day.length; j++) {
    const b = day[j], m = minsOf(b.t);
    if (m < or.end) continue;
    const vw = vwap(day.slice(0, j + 1));
    const up = b.c > or.hi, dn = b.c < or.lo;
    if (up || dn) {
      if ((dir > 0 && !up) || (dir < 0 && !dn)) return null;   // the other side broke first
      if (settings.requireVwap && (dir > 0 ? b.c < vw : b.c > vw)) return null;
      if (!inWindow(m + 5)) return null;
      return { idx: j, or, bar: b };
    }
  }
  return null;
}

export const momentum: Agent = {
  name: "momentum",
  runs: ["cycle", "mcx"],
  async scan(ctx: Ctx) {
    const { inst: i, today, now } = ctx;
    const start = startMin(i, now.date);
    if (start === null || !today.length) return [];
    const or = openingRange(today, start, settings.rangeMinutes);
    if (!or || (or.hi - or.lo) / or.lo > settings.maxRangePct) return [];
    const out: Candidate[] = [];
    const end = sqOff(i, now.date)!;
    const rv = relVolume(today, ctx.hist, now.mins);
    for (const dir of [1, -1] as const) {
      const hit = breakout(today, start, dir, (m) => inEntryWindow(i, m));
      const lvl = dir > 0 ? or.hi : or.lo;
      const stop = settings.stop === "mid" ? (or.hi + or.lo) / 2 : dir > 0 ? or.lo : or.hi;
      let status: Candidate["status"] | null = null, entry = lvl, trigger = "";
      if (hit) {
        const age = today.length - 1 - hit.idx;
        if (age > settings.maxTriggerAgeBars || rv < settings.minRelVolume) continue;
        entry = hit.bar.c;
        const risk = Math.abs(entry - stop);
        if (Math.abs(ctx.futPx - entry) > 0.5 * risk || (ctx.futPx - stop) * dir <= 0) continue; // chased or already stopped
        status = "ENTER";
        trigger = `5-min close ${dir > 0 ? "above" : "below"} ${fmt(lvl)} at ${new Date((hit.bar.t + 5 * 60 + 19800) * 1000).toISOString().slice(11, 16)}`;
      } else {
        const last = today[today.length - 1].c, rng = or.hi - or.lo;
        const near = dir > 0 ? or.hi - last : last - or.lo;
        if (near < 0 || near > settings.waitWithin * rng || !inEntryWindow(i, now.mins)) continue;
        status = "WAIT";
        trigger = `Enter on a 5-min close ${dir > 0 ? "above" : "below"} ${fmt(lvl)}`;
      }
      const risk = Math.abs(entry - stop);
      const riskPct = risk / entry;
      const paths = intradayHistory(i, ctx.hist, riskPct, (day, d) => {
        const s = startMin(i, d);
        if (s === null) return null;
        const h = breakout(day, s, dir, (m) => inEntryWindow(i, m));
        if (!h) return null;
        const st = settings.stop === "mid" ? (h.or.hi + h.or.lo) / 2 : dir > 0 ? h.or.lo : h.or.hi;
        return { idx: h.idx, riskPct: Math.abs(h.bar.c - st) / h.bar.c };
      });
      out.push({
        agent: "momentum", setup: dir > 0 ? "orb_long" : "orb_short", dir, horizon: "intraday", status, trigger,
        entry, sl: stop, t1: entry + dir * settings.t1R * risk, t2: entry + dir * settings.t2R * risk,
        paths,
        rules: { kind: "directional", dir, sl: stop / entry, t1: 1 + dir * settings.t1R * riskPct, t2: 1 + dir * settings.t2R * riskPct, halfAtT1: true },
        structures: ["future", "long_option", "debit_spread"], minDaysToExpiry: 0,
        why: [
          `${settings.rangeMinutes}-min opening range ${fmt(or.lo)}–${fmt(or.hi)}`,
          `volume ${rv.toFixed(2)}× the usual for this time`,
          settings.requireVwap ? `price ${dir > 0 ? "above" : "below"} VWAP` : "",
          `same rule fired ${paths.length} times in the last ${ctx.hist.size} sessions`,
        ].filter(Boolean),
        validUntilMin: Math.min(end, now.mins + (status === "ENTER" ? 10 : 30)),
      });
    }
    return out;
  },
};
