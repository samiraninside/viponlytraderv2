/**
 * Rule-agent kit. Build continuous 5-min / 15-min series over history + today, compute
 * indicators once, and scan the SAME rule on today's latest bar and on every past day.
 */
import { tradingDaysBetween } from "../calendar";
import type { Bar } from "../dhan";
import { intradayPath, type Path } from "../engine/evaluate";
import { dayOf, minsOf } from "../history";
import { resample, type Series, series } from "../indicators";
import type { Inst } from "../universe";
import { inEntryWindow, segOf, sqOff, startMin } from "./common";
import type { Candidate, Ctx } from "./types";

export interface Cont { b5: Bar[]; s5: Series; b15: Bar[]; s15: Series; todayFrom5: number; todayFrom15: number; map15to5: (i15: number) => number; i5to15: Int32Array }

const cache = new WeakMap<Bar[], Cont>();

/** Continuous series. Cached per ctx.today array, so many agents share one computation. */
export function cont(ctx: Ctx): Cont {
  const hit = cache.get(ctx.today);
  if (hit) return hit;
  const past = [...ctx.hist.values()].flat();
  const b5 = [...past, ...ctx.today];
  const ss = (t: number) => startMin(ctx.inst, dayOf(t)) ?? 555;
  const b15 = resample(b5, 15, ss);
  const todayFrom5 = past.length;
  const todayFrom15 = b15.findIndex((b) => dayOf(b.t) === ctx.now.date);
  const end5 = new Map(b5.map((b, i) => [b.t + 300, i]));
  const i5to15 = new Int32Array(b5.length).fill(-1);
  for (let i = 0, j = 0; i < b5.length; i++) {
    while (j < b15.length - 1 && b15[j + 1].t <= b5[i].t) j++;
    if (b15[j] && b15[j].t <= b5[i].t && b5[i].t < b15[j].t + 900) i5to15[i] = j;
  }
  const c: Cont = {
    b5, s5: series(b5), b15, s15: series(b15), todayFrom5, todayFrom15: todayFrom15 < 0 ? b15.length : todayFrom15,
    // the 5-min bar that closes when the 15-min bar closes
    map15to5: (i15) => end5.get(b15[i15].t + 900) ?? -1,
    i5to15,
  };
  cache.set(ctx.today, c);
  return c;
}

/** Only complete 15-min bars: the last one may still be forming. */
export const complete15 = (c: Cont, nowEpochS: number) => {
  let n = c.b15.length;
  while (n > 0 && c.b15[n - 1].t + 900 > nowEpochS) n--;
  return n;
};

export interface RuleSpec {
  agent: string;
  tf: 5 | 15;
  dirs: (1 | -1)[];
  setup: (dir: 1 | -1) => string;
  /** does the rule fire at closed bar i (index in the tf series)? */
  fires: (c: Cont, s: Series, b: Bar[], i: number, dir: 1 | -1, ctx: Ctx) => boolean;
  /** stop price for a signal at bar i */
  stop: (c: Cont, s: Series, b: Bar[], i: number, dir: 1 | -1) => number;
  /** targets in R (default 1R, 2R, 3R) or absolute prices */
  targets?: (c: Cont, s: Series, b: Bar[], i: number, dir: 1 | -1, entry: number, risk: number) => [number, number, number?];
  structures: Candidate["structures"];
  why: (c: Cont, s: Series, b: Bar[], i: number, dir: 1 | -1) => string[];
  maxAgeBars?: number;
  holdMinutes?: number;                 // time stop (scalps)
  window?: [number, number];            // entry window override (IST minutes)
  kinds?: Inst["kind"][];
}

const inWin = (spec: RuleSpec, i: Inst, m: number) => (spec.window ? m >= spec.window[0] && m <= spec.window[1] : inEntryWindow(i, m));

/** Run a rule: today's ENTER candidates plus the same rule's history for scoring. */
export function runRule(spec: RuleSpec, ctx: Ctx): Candidate[] {
  const { inst: i, now } = ctx;
  if (spec.kinds && !spec.kinds.includes(i.kind)) return [];
  if (!ctx.today.length || startMin(i, now.date) === null) return [];
  const c = cont(ctx);
  const tf = spec.tf, s = tf === 5 ? c.s5 : c.s15, b = tf === 5 ? c.b5 : c.b15;
  const n = tf === 5 ? b.length : complete15(c, now.epoch / 1000);
  const from = tf === 5 ? c.todayFrom5 : c.todayFrom15;
  const closeMin = (k: number) => minsOf(b[k].t) + tf;
  const to5 = (k: number) => (tf === 5 ? k : c.map15to5(k));
  const out: Candidate[] = [];
  for (const dir of spec.dirs) {
    // today: latest closed bar(s)
    let hit = -1;
    for (let k = n - 1; k >= Math.max(from, n - (spec.maxAgeBars ?? 1)); k--)
      if (inWin(spec, i, closeMin(k)) && spec.fires(c, s, b, k, dir, ctx)) { hit = k; break; }
    if (hit < 0) continue;
    const entry = b[hit].c, sl = spec.stop(c, s, b, hit, dir), risk = (entry - sl) * dir;
    if (!(risk > 0)) continue;
    if ((ctx.futPx - sl) * dir <= 0 || (ctx.futPx - entry) * dir > 0.5 * risk) continue; // stopped or chased
    const [t1, t2, t3] = spec.targets?.(c, s, b, hit, dir, entry, risk) ?? [entry + dir * risk, entry + dir * 2 * risk, entry + dir * 3 * risk];
    // history: first firing per past day, same rule
    const paths: Path[] = [];
    let lastDay = "";
    for (let k = 30; k < from; k++) {
      const d = dayOf(b[k].t);
      if (d === lastDay || !inWin(spec, i, closeMin(k)) || !spec.fires(c, s, b, k, dir, ctx)) continue;
      const e = b[k].c, st = spec.stop(c, s, b, k, dir), r = (e - st) * dir;
      const j = to5(k);
      if (!(r > 0) || j < 0) continue;
      lastDay = d;
      const end = spec.holdMinutes ? Math.min(sqOff(i, d) ?? 0, minsOf(c.b5[j].t) + 5 + spec.holdMinutes) : sqOff(i, d) ?? 0;
      const dayBars = ctx.hist.get(d);
      if (!dayBars) continue;
      const jj = dayBars.findIndex((x) => x.t === c.b5[j].t);
      if (jj < 0) continue;
      const p = intradayPath(dayBars, jj, end, minsOf, Math.min(3, Math.max(0.33, (risk / entry) / (r / e))));
      if (p.length) paths.push(p);
    }
    const riskPct = risk / entry;
    out.push({
      agent: spec.agent, setup: spec.setup(dir), dir, horizon: "intraday", status: "ENTER",
      trigger: `${tf}-min close ${fmt(entry)} at ${hhmm(b[hit].t + tf * 60)}`,
      entry, sl, t1, t2, t3, paths,
      rules: { kind: "directional", dir, sl: sl / entry, t1: t1 / entry, t2: t2 / entry, halfAtT1: true },
      structures: spec.structures, minDaysToExpiry: 0,
      why: [...spec.why(c, s, b, hit, dir), `same rule fired on ${paths.length} of the last ${ctx.hist.size} sessions`],
      validUntilMin: Math.min(sqOff(i, now.date)!, now.mins + 10),
      maxHoldMin: spec.holdMinutes,
    });
  }
  return out;
}

export const fmt = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
export const hhmm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
export const daysToExpiry = (i: Inst, from: string, exp: string) => tradingDaysBetween(segOf(i), from, exp);
