/**
 * Your own scanners: rules written on the website, stored in D1, run every cycle like the
 * built-in agents and scored the same way (the same rule replayed on each instrument's history).
 */
import { inEntryWindow, segOf, sqOff, startMin } from "../agents/common";
import type { Agent, Candidate, Ctx } from "../agents/types";
import { tradingDaysBetween } from "../calendar";
import type { Structure } from "../config";
import type { Bar } from "../dhan";
import { dailyPath, intradayPath, type Path } from "../engine/evaluate";
import { chainSummary, type Chain } from "../engine/options";
import type { Env } from "../env";
import { dayOf, minsOf } from "../history";
import { atrSeries } from "../indicators";
import { baseOf, parseRule, type Rule, ruleTrue } from "./dsl";
import { dailyEnv, intradayEnv } from "./series";

export interface ScannerDef {
  id: string; name: string; text: string; enabled: boolean;
  kinds: ("INDEX" | "STOCK" | "COMMODITY")[];
  dir: 1 | -1;                 // long or short idea when the rule passes
  stop: string;                // "atr:1.5" | "pct:1" | "swing:3"
  targets: number[];           // in R, e.g. [1, 2, 3]
  structures?: Structure[];
  holdDays?: number;           // daily scanners: 1 = BTST, 3 = swing
  created?: number;
}

export async function loadScanners(env: Env): Promise<ScannerDef[]> {
  const { results } = await env.DB.prepare("SELECT json FROM scanners ORDER BY created").all<{ json: string }>();
  return results.map((r) => JSON.parse(r.json));
}

function stopPrice(def: ScannerDef, bars: { h: number; l: number; c: number }[], k: number, dir: 1 | -1) {
  const [kind, raw] = def.stop.split(":"), x = Number(raw) || 1, c = bars[k].c;
  if (kind === "pct") return c * (1 - (dir * x) / 100);
  if (kind === "swing") {
    const w = bars.slice(Math.max(0, k - Math.max(1, x) + 1), k + 1);
    return dir > 0 ? Math.min(...w.map((b) => b.l)) : Math.max(...w.map((b) => b.h));
  }
  const a = atrSeries(bars.slice(Math.max(0, k - 40), k + 1), 14).at(-1)!;
  return c - dir * x * a;
}

const chainValue = (c: Chain | null, ivRank: number | null, greeks: { callVega: number; putVega: number } | null) => (fn: string) => {
  if (!c) return NaN;
  const s = chainSummary(c);
  switch (fn) {
    case "PCR": return s.pcr;
    case "MAX PAIN": return s.maxPain;
    case "ATM IV": return c.atmIv * 100;
    case "IV RANK": return ivRank ?? NaN;
    case "SPOT": return c.spot;
    case "CALL VEGA": return greeks?.callVega ?? NaN;
    case "PUT VEGA": return greeks?.putVega ?? NaN;
    case "VEGA DIFF": return greeks ? greeks.putVega - greeks.callVega : NaN;
  }
  return NaN;
};

export interface Hit { k: number; entry: number; sl: number; risk: number }

/** Evaluate a scanner on one instrument. Returns today's firing (if any) and the history. */
export async function evaluateScanner(def: ScannerDef, rule: Rule, ctx: Ctx, opts: { maxAgeBars?: number; anyTimeToday?: boolean } = {}) {
  const { inst: i, now } = ctx;
  const base = baseOf(rule);
  const needsChain = rule.tfs.includes("chain");
  const chain = needsChain ? await ctx.chain(0) : null;
  const ivr = chain ? await ctx.ivRank(chain) : null;
  const { vegaBySide } = await import("../greeks");
  const cv = chainValue(chain, ivr, chain ? vegaBySide(chain) : null);
  const dir = def.dir;
  if (base.mode === "intraday") {
    if (!ctx.today.length || startMin(i, now.date) === null) return null;
    const b5 = [...[...ctx.hist.values()].flat(), ...ctx.today];
    const { env, base: B, closeT } = intradayEnv(b5, base.tf, (t) => startMin(i, dayOf(t)) ?? 555, cv, now.epoch / 1000);
    const todayStart = B.findIndex((b) => dayOf(b.t) === now.date);
    if (todayStart < 0) return null;
    let today: Hit | null = null;
    const firstK = opts.anyTimeToday ? todayStart : Math.max(todayStart, B.length - (opts.maxAgeBars ?? 1));
    const todayFires: number[] = [];
    for (let k = B.length - 1; k >= firstK; k--) {
      if (!inEntryWindow(i, minsOf(closeT[k] - 300) + 5) || !ruleTrue(rule, env, k, false)) continue;
      todayFires.push(k);
      if (!today) { const sl = stopPrice(def, B, k, dir); today = { k, entry: B[k].c, sl, risk: (B[k].c - sl) * dir }; }
    }
    const paths: Path[] = [];
    const hits: Hit[] = [];
    let last = "";
    for (let k = 30; k < todayStart; k++) {
      const d = dayOf(B[k].t);
      if (d === last || !inEntryWindow(i, minsOf(closeT[k] - 300) + 5) || !ruleTrue(rule, env, k, true)) continue;
      const sl = stopPrice(def, B, k, dir), r = (B[k].c - sl) * dir;
      if (!(r > 0)) continue;
      const dayBars = ctx.hist.get(d);
      const jj = dayBars?.findIndex((x) => x.t + 300 === closeT[k]) ?? -1;
      if (!dayBars || jj < 0) continue;
      last = d;
      // rescale so each past day's stop distance equals today's (or a standard 1% when testing)
      const ref = (today?.risk && today.entry ? today.risk / today.entry : 0.01) / (r / B[k].c);
      const p = intradayPath(dayBars, jj, sqOff(i, d) ?? 0, minsOf, Math.min(3, Math.max(0.33, ref)));
      if (p.length) { paths.push(p); hits.push({ k, entry: B[k].c, sl, risk: r }); }
    }
    return { mode: "intraday" as const, today, todayFires: todayFires.map((k) => new Date((closeT[k] + 19800) * 1000).toISOString().slice(11, 16)).reverse(), paths, hits, bars: B };
  }
  // daily mode: spot daily bars (2 years) + today so far, basis-adjusted from the future
  const d = ctx.daily;
  if (d.length < 60) return null;
  const adj = ctx.prevClose ? d.at(-1)!.c / ctx.prevClose : 1;
  const bars: Bar[] = d.map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
  if (ctx.today.length) {
    const t0 = ctx.today;
    bars.push({ t: t0[0].t, o: t0[0].o * adj, h: Math.max(...t0.map((x) => x.h)) * adj, l: Math.min(...t0.map((x) => x.l)) * adj, c: ctx.futPx * adj, v: t0.reduce((a, x) => a + x.v, 0) });
  }
  const env = dailyEnv(bars, cv);
  const k = bars.length - 1, hold = def.holdDays ?? 3;
  let today: Hit | null = null;
  if (ctx.today.length && ruleTrue(rule, env, k, false)) {
    const sl = stopPrice(def, bars, k, dir) / adj;
    today = { k, entry: ctx.futPx, sl, risk: (ctx.futPx - sl) * dir };
  }
  const paths: Path[] = [], hits: Hit[] = [];
  for (let j = 60; j < d.length - hold; j++) {
    if (!ruleTrue(rule, env, j, true)) continue;
    const sl = stopPrice(def, bars, j, dir), r = (bars[j].c - sl) * dir;
    if (!(r > 0)) continue;
    const kk = Math.min(3, Math.max(0.33, (today?.risk ? today.risk / today.entry : 0.01) / (r / bars[j].c)));
    paths.push(dailyPath(d, j, hold, kk, hold === 1));
    hits.push({ k: j, entry: bars[j].c, sl, risk: r });
  }
  return { mode: "daily" as const, today, todayFires: today ? ["today"] : [], paths, hits, bars };
}

export function makeCustomAgent(def: ScannerDef): Agent | null {
  const { rule } = parseRule(def.text);
  if (!rule) return null;
  const mode = baseOf(rule).mode;
  return {
    name: `custom:${def.id}`,
    runs: mode === "intraday" ? ["cycle", "mcx"] : ["btst", "mcx"],
    async scan(ctx: Ctx): Promise<Candidate[]> {
      if (!def.kinds.includes(ctx.inst.kind)) return [];
      if (mode === "daily" && ctx.inst.kind === "COMMODITY" && (ctx.now.mins < 22 * 60 + 30 || ctx.now.mins > 23 * 60 + 15)) return [];
      const r = await evaluateScanner(def, rule, ctx);
      if (!r?.today || !(r.today.risk > 0)) return [];
      const { entry, sl, risk } = r.today, dir = def.dir;
      if ((ctx.futPx - sl) * dir <= 0) return [];
      if (mode === "daily" && tradingDaysBetween(segOf(ctx.inst), ctx.now.date, ctx.inst.fut.expiry) < (def.holdDays ?? 3)) return [];
      const ts = def.targets.length ? def.targets : [1, 2, 3];
      const t = ts.map((x) => entry + dir * x * risk);
      const rp = risk / entry;
      return [{
        agent: `custom:${def.id}`, setup: def.name, dir, horizon: mode === "intraday" ? "intraday" : (def.holdDays ?? 3) <= 1 ? "btst" : "positional",
        status: "ENTER", trigger: `Your scanner "${def.name}" passed${r.todayFires.length ? ` at ${r.todayFires.at(-1)}` : ""}`,
        entry, sl, t1: t[0], t2: t[1] ?? t[0], t3: t[2], paths: r.paths,
        rules: { kind: "directional", dir, sl: sl / entry, t1: 1 + dir * ts[0] * rp, t2: 1 + dir * (ts[1] ?? ts[0]) * rp, halfAtT1: true },
        structures: def.structures?.length ? def.structures : mode === "intraday" ? ["future", "long_option", "debit_spread"] : ["debit_spread", "fut_hedge", "long_option"],
        minDaysToExpiry: mode === "intraday" ? 0 : (def.holdDays ?? 3) + 1,
        why: [`custom scanner "${def.name}" (${rule.conds.length} conditions, ${rule.mode})`, `stop ${def.stop}, targets ${ts.join("R, ")}R`,
          `passed on ${r.paths.length} past ${mode === "intraday" ? "sessions" : "days"}`,
          ...(rule.tfs.includes("chain") ? ["option-chain conditions apply live only; history tests the price part"] : [])],
        validUntilMin: mode === "intraday" ? Math.min(sqOff(ctx.inst, ctx.now.date)!, ctx.now.mins + 10) : ctx.inst.kind === "COMMODITY" ? 23 * 60 + 20 : 15 * 60 + 25,
      }];
    },
  };
}
