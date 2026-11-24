/**
 * Turns agent candidates into per-profile cards: builds every allowed structure from the
 * live chain, scores each by replaying history, sizes lots for each profile, keeps the best.
 */
import type { Candidate } from "../agents/types";
import { nextTradingDay, squareOff, fromMins, type Seg } from "../calendar";
import { FREEZE_QTY, PROFILES, type Profile, type ProfileId, type Structure } from "../config";
import type { Inst } from "../universe";
import { type Eval, evaluate, type Rules } from "./evaluate";
import type { Chain } from "./options";
import { averagingPlan, type AvgPlan } from "./averaging";
import { build, type Built, entryValue, marginPerLot, repriceAt, value } from "./structures";

export interface Levels { basis: "underlying" | "premium" | "credit"; entry: number; sl: number; t1: number; t2: number; t3?: number }
export interface Card {
  id: string; profile: ProfileId; date: string; createdAt: number; updatedAt: number;
  agent: string; setup: string; key: string; root: string; kind: Inst["kind"];
  horizon: Candidate["horizon"]; dir: 1 | -1 | 0;
  status: "WAIT" | "ENTER" | "TRACKING" | "DONE" | "EXPIRED";
  trigger: string; structure: Structure; label: string; expiry: string | null;
  legs: { kind: string; side: number; strike?: number; price: number; id?: string; expiry?: string; iv?: number }[];
  spot0?: number;
  lots: number; units: number;
  margin: number; maxLoss: number; worstCase: number | null; ev: number; pWin: number; pT1?: number; n: number; thin: boolean; score: number;
  levels: Levels; underlying: { entry: number; sl: number; t1: number; t2: number; t3?: number };
  exitBy: string; gapLoss?: number; gapMovePct?: number; range?: [number, number]; why: string[]; validUntilMin: number;
  rules: Rules; entryAt?: number;
  agents?: string[]; rank?: number; confirm?: import("./confirm").Confirmation; maxHoldMin?: number; outcome?: { result: string; r: number; at: number }; pushed?: boolean;
  avg?: AvgPlan;
}

const unitsOf = (i: Inst) => (i.kind === "COMMODITY" ? i.pointValue : i.lot);

function breakevens(b: Built, S0: number): [number, number] {
  const e0 = entryValue(b);
  const pay = (S: number) => b.legs.reduce((a, l) => a + l.side * (l.kind === "FUT" ? S : Math.max(0, l.kind === "CE" ? S - l.strike! : l.strike! - S)), 0) - e0;
  let lo = 0, hi = S0 * 100;   // no breakeven on a side = no stop on that side
  for (let k = 0; k < 400; k++) {
    const s1 = S0 * (1 - k * 0.0005), s2 = S0 * (1 - (k + 1) * 0.0005);
    if (pay(s1) >= 0 && pay(s2) < 0) { lo = s2; break; }
  }
  for (let k = 0; k < 400; k++) {
    const s1 = S0 * (1 + k * 0.0005), s2 = S0 * (1 + (k + 1) * 0.0005);
    if (pay(s1) >= 0 && pay(s2) < 0) { hi = s2; break; }
  }
  return [lo, hi];
}

function variants(i: Inst, c: Chain | null, cand: Candidate, futPx: number, allowed: Set<Structure>): Built[] {
  const out: (Built | null)[] = [];
  const d = cand.dir as 1 | -1;
  const want = (s: Structure) => cand.structures.includes(s) && allowed.has(s);
  if (want("future") && cand.horizon === "intraday" && cand.dir) out.push(build.future(i, d, futPx));
  if (c) {
    const straddle = (c.ce.get(c.atm)?.ltp ?? 0) + (c.pe.get(c.atm)?.ltp ?? 0);
    if (cand.dir && !cand.premiumRange) {
      if (want("long_option")) out.push(build.longOption(i, c, d, 0), build.longOption(i, c, d, 1));
      if (want("debit_spread")) out.push(build.debitSpread(i, c, d, 2), build.debitSpread(i, c, d, 4));
      if (want("fut_hedge")) out.push(build.futHedge(i, c, d, futPx, 1));
      if (want("credit_spread")) out.push(build.creditSpread(i, c, d, 1, 2), build.creditSpread(i, c, d, 2, 2));
    }
    if (want("long_straddle")) out.push(build.longStraddle(i, c));
    if (cand.premiumRange) {
      if (cand.dir && want("long_option")) out.push(build.optionByPremium(i, c, d, cand.premiumRange));
      if (want("long_strangle")) out.push(build.strangleByPremium(i, c, cand.premiumRange));
      return out.filter((b): b is Built => !!b);
    }
    if (straddle > 0) {
      if (want("iron_fly")) out.push(build.ironFly(i, c, straddle * 1.1));
      if (want("iron_condor")) out.push(build.ironCondor(i, c, straddle * 0.8, c.step * 2));
      if (want("short_strangle")) out.push(build.shortStrangle(i, c, straddle * 1.1));
    }
  }
  return out.filter((b): b is Built => !!b);
}

function lotsFor(p: Profile, i: Inst, e: Eval, margin: number) {
  const byRisk = Math.floor(p.riskPerTrade / Math.max(1, e.maxLoss));
  const byMargin = margin > 0 ? Math.floor((p.capital * p.maxMarginShare) / margin) : p.maxLots;
  const fz = FREEZE_QTY[i.root] ? Math.floor((FREEZE_QTY[i.root] - 1) / i.lot) : Infinity;
  return Math.max(0, Math.min(byRisk, byMargin, p.maxLots, fz));
}

export interface Scored { b: Built; e: Eval; rules: Rules; S0: number; margin: number }

/** Score every structure for one candidate. `spot` = current price of the option underlying. */
export function scoreCandidate(i: Inst, cand: Candidate, c: Chain | null, futPx: number): Scored[] {
  const allowed = new Set(PROFILES.flatMap((p) => p.structures));
  const out: Scored[] = [];
  for (let b of variants(i, c, cand, futPx, allowed)) {
    const isFutOnly = b.structure === "future";
    // the underlying for options is the chain spot; levels were set on the future
    const spotNow = isFutOnly ? futPx : c!.spot;
    const S0 = spotNow * (cand.entry / futPx);
    if (Math.abs(S0 / spotNow - 1) > 1e-4) b = repriceAt(b, S0);   // WAIT: price the idea at its trigger level
    if (cand.ivMult) b.ivMult = cand.ivMult;
    let rules = cand.rules;
    if (rules.kind === "range") {
      const [lo, hi] = breakevens(b, S0);
      rules = { kind: "range", upStop: hi / S0, dnStop: lo / S0 };
    }
    const riskRef = isFutOnly ? Math.abs(cand.entry - cand.sl) * unitsOf(i) : undefined;
    const e = evaluate(b, i, cand.paths, rules, S0, riskRef);
    out.push({ b, e, rules, S0, margin: marginPerLot(b, i, futPx) });
  }
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function exitByText(i: Inst, cand: Candidate, date: string) {
  const seg = i.fut.seg as Seg;
  if (cand.horizon === "btst") return "next open";
  if (cand.horizon === "positional") return cand.rules.kind === "range" ? "expiry" : nextTradingDay(seg, date, 3).slice(5);
  if (cand.maxHoldMin) return `${cand.maxHoldMin} min`;
  const m = squareOff(seg, date, { expiringIndex: i.kind === "INDEX" && i.fut.expiry === date });
  return m === null ? "close" : fromMins(m);
}

function levelsFor(s: Scored, cand: Candidate, i: Inst): Levels {
  const { b, S0 } = s;
  if (b.structure === "future") return { basis: "underlying", entry: cand.entry, sl: cand.sl, t1: cand.t1, t2: cand.t2, t3: cand.t3 };
  if (s.rules.kind === "hold") { const p = entryValue(b); return { basis: "premium", entry: r2(p), sl: 0, t1: r2(p * 3), t2: r2(p * 5) }; }
  const k = S0 / cand.entry, dt = cand.horizon === "intraday" ? 1 / (365 * 24) : 1 / 365;
  const at = (u: number) => r2(value(b, u * k, b.T - dt));
  if (s.rules.kind === "range") {
    const credit = -entryValue(b);
    const rules = s.rules as Extract<Rules, { kind: "range" }>;
    const stopCost = Math.max(rules.upStop < 50 ? -value(b, S0 * rules.upStop, b.T - dt) : 0, rules.dnStop > 0 ? -value(b, S0 * rules.dnStop, b.T - dt) : 0);
    return { basis: "credit", entry: r2(credit), sl: r2(stopCost), t1: r2(credit * 0.5), t2: r2(credit * 0.25) };
  }
  return { basis: "premium", entry: r2(entryValue(b)), sl: at(cand.sl), t1: at(cand.t1), t2: at(cand.t2), t3: cand.t3 ? at(cand.t3) : undefined };
}

/** Pick, per profile, the best affordable structure for this candidate. */
export function cardsFor(i: Inst, cand: Candidate, scored: Scored[], date: string, now: number, gapMove?: number): Card[] {
  const out: Card[] = [];
  for (const p of PROFILES) {
    let best: { s: Scored; lots: number } | null = null;
    for (const s of scored) {
      if (!p.structures.includes(s.b.structure)) continue;
      if (cand.horizon !== "intraday" && p.overnightNeedsHedge && s.b.structure === "future") continue;
      const lots = lotsFor(p, i, s.e, s.margin);
      if (lots < 1) continue;
      if (!best || s.e.score > best.s.e.score || (s.e.score === best.s.e.score && s.e.ev * lots > best.s.e.ev * best.lots)) best = { s, lots };
    }
    if (!best) continue;
    const { s, lots } = best, u = unitsOf(i);
    let gapLoss: number | undefined;
    if (s.b.structure === "short_strangle" && gapMove) {
      const e0 = entryValue(s.b), dt = 1 / 365;
      const worst = Math.min(value(s.b, s.S0 * (1 + gapMove), s.b.T - dt), value(s.b, s.S0 * (1 - gapMove), s.b.T - dt)) - e0;
      gapLoss = Math.round(Math.max(0, -worst) * u * lots);
    }
    out.push({
      id: `${date}:${cand.agent}:${cand.setup}:${i.key}:${p.id}`, profile: p.id, date, createdAt: now, updatedAt: now,
      agent: cand.agent, setup: cand.setup, key: i.key, root: i.root, kind: i.kind, horizon: cand.horizon, dir: cand.dir,
      status: cand.status, trigger: cand.trigger ?? "", structure: s.b.structure, label: s.b.label,
      expiry: s.b.legs.find((l) => l.kind !== "FUT")?.expiry ?? i.fut.expiry,
      legs: s.b.legs.map((l) => ({ kind: l.kind, side: l.side, strike: l.strike, price: r2(l.price), id: l.id, expiry: l.expiry, iv: l.iv })),
      spot0: s.S0,
      lots, units: lots * i.lot,
      margin: Math.round(s.margin * lots), maxLoss: Math.round(s.e.maxLoss * lots), worstCase: s.e.worstCase !== null ? Math.round(s.e.worstCase * lots) : null, ev: Math.round(s.e.ev * lots),
      pWin: r2(s.e.pWin), pT1: s.e.pT1 !== undefined ? r2(s.e.pT1) : undefined, n: s.e.n, thin: s.e.thin, score: s.e.score,
      levels: levelsFor(s, cand, i),
      underlying: { entry: r2(cand.entry), sl: r2(cand.sl), t1: r2(cand.t1), t2: r2(cand.t2), t3: cand.t3 ? r2(cand.t3) : undefined },
      exitBy: exitByText(i, cand, date), gapLoss, gapMovePct: gapMove ? Math.round(gapMove * 1000) / 10 : undefined, why: cand.why,
      range: s.rules.kind === "range" ? [s.rules.dnStop > 0 ? r2(cand.entry * s.rules.dnStop) : 0, s.rules.upStop < 50 ? r2(cand.entry * s.rules.upStop) : 0] : undefined, validUntilMin: cand.validUntilMin, rules: s.rules,
      entryAt: cand.status === "ENTER" ? now : undefined, maxHoldMin: cand.maxHoldMin,
    });
    const last = out[out.length - 1];
    last.avg = averagingPlan(last, p);
  }
  return out;
}
