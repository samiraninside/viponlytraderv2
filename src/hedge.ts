/**
 * Hedge Optimizer: reads your open F&O positions from Dhan (read-only), measures the book's
 * delta, gamma, vega and theta per underlying and the loss on a stress move, and when the
 * exposure is large for the profile, proposes protective hedges ranked by risk removed per rupee.
 * It never places anything.
 */
import { addDays, type IST, istEpoch, toMins, tradingDaysBetween, type Seg } from "./calendar";
import { HEDGE, PROFILES } from "./config";
import type { Dhan } from "./dhan";
import { bs, type Chain, greeks, parseChain } from "./engine/options";
import type { Env } from "./env";
import { type Inst, loadUniverse, putKv } from "./universe";

export interface Pos { root: string; kind: "FUT" | "CE" | "PE"; strike?: number; expiry: string; units: number; avg: number; symbol: string }

export function parsePosition(p: any, inst?: Inst): Pos | null {
  const qty = +p.netQty;
  if (!qty || !/FNO|MCX/.test(p.exchangeSegment ?? "")) return null;
  const sym = String(p.tradingSymbol ?? "").toUpperCase();
  const parts = sym.split("-");
  const root = parts[0].replace(/\s+/g, "");
  const ot = String(p.drvOptionType ?? "").toUpperCase();
  let kind: Pos["kind"] = ot.startsWith("C") ? "CE" : ot.startsWith("P") ? "PE" : "FUT";
  if (kind === "FUT" && /(CE|PE)$/.test(sym)) kind = sym.endsWith("CE") ? "CE" : "PE";
  let strike = +p.drvStrikePrice || undefined;
  if (!strike && kind !== "FUT") strike = +parts[parts.length - 2] || undefined;
  const expiry = p.drvExpiryDate && !String(p.drvExpiryDate).startsWith("0001") ? String(p.drvExpiryDate).slice(0, 10) : inst?.fut.expiry ?? "";
  const mcx = String(p.exchangeSegment).startsWith("MCX");
  const units = mcx && inst ? qty * (inst.pointValue / Math.max(1, inst.lot)) * Math.max(1, +p.multiplier || 1) : qty;
  return { root, kind, strike, expiry, units, avg: +(p.costPrice || p.buyAvg || p.sellAvg || 0), symbol: sym };
}

const T = (exp: string, now: IST, mcx: boolean) => Math.max(60, istEpoch(exp, mcx ? toMins("23:30") : toMins("15:30")) - now.epoch / 1000) / (365 * 86400);

export function bookGreeks(pos: Pos[], c: Chain, now: IST, mcx: boolean) {
  let delta = 0, gamma = 0, vega = 0, theta = 0;
  const value = (S: number, dtYears: number) => pos.reduce((a, p) => {
    if (p.kind === "FUT") return a + p.units * S;
    const t = Math.max(0, T(p.expiry, now, mcx) - dtYears), q = (p.kind === "CE" ? c.ce : c.pe).get(p.strike!);
    return a + p.units * bs(p.kind, S, p.strike!, t, q?.iv || c.atmIv, c.r);
  }, 0);
  for (const p of pos) {
    if (p.kind === "FUT") { delta += p.units; continue; }
    const q = (p.kind === "CE" ? c.ce : c.pe).get(p.strike!);
    const g = greeks(p.kind, c.spot, p.strike!, T(p.expiry, now, mcx), q?.iv || c.atmIv, c.r);
    delta += p.units * g.delta; gamma += p.units * g.gamma; vega += p.units * g.vega; theta += p.units * g.theta;
  }
  const v0 = value(c.spot, 0), m = HEDGE.stressMovePct, day = 1 / 365;
  return { delta, gamma, vega, theta, deltaRupees: delta * c.spot, pnlUp: value(c.spot * (1 + m), day) - v0, pnlDown: value(c.spot * (1 - m), day) - v0, value };
}

export async function hedgeScan(env: Env, dhan: Dhan, t: IST) {
  const raw = await dhan.positions();
  const insts = await loadUniverse(env);
  const byRoot = new Map<string, { inst: Inst; pos: Pos[] }>();
  const skipped: string[] = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    const root = String(p.tradingSymbol ?? "").toUpperCase().split("-")[0].replace(/\s+/g, "");
    const inst = insts.find((i) => i.root === root);
    const pos = parsePosition(p, inst);
    if (!pos) continue;
    if (!inst) { skipped.push(pos.symbol); continue; }
    (byRoot.get(root) ?? byRoot.set(root, { inst, pos: [] }).get(root)!).pos.push(pos);
  }
  const book: any[] = [], suggestions: Record<string, any[]> = { basic: [], mid: [], big: [] };
  for (const [root, { inst, pos }] of byRoot) {
    const seg = inst.fut.seg as Seg, mcx = inst.kind === "COMMODITY";
    const exps = await dhan.expiries(inst.chain.scrip, inst.chain.seg);
    const exp = exps.find((e) => e >= t.date && tradingDaysBetween(seg, t.date, e) >= 2) ?? exps[0];
    if (!exp) continue;
    const c = parseChain(root, exp, await dhan.chain(inst.chain.scrip, inst.chain.seg, exp), T(exp, t, mcx), mcx ? 0 : 0.06);
    const g = bookGreeks(pos, c, t, mcx);
    book.push({ root, spot: c.spot, positions: pos.map((p) => p.symbol), delta: Math.round(g.delta), deltaRupees: Math.round(g.deltaRupees),
      gamma: +g.gamma.toFixed(4), vega: Math.round(g.vega), thetaPerDay: Math.round(g.theta), pnlUp2: Math.round(g.pnlUp), pnlDown2: Math.round(g.pnlDown) });
    const unitsPerLot = mcx ? inst.pointValue : inst.lot;
    for (const prof of PROFILES) {
      if (Math.abs(g.deltaRupees) < HEDGE.deltaShareOfCapital * prof.capital) continue;
      const dir = g.delta > 0 ? -1 : 1;                 // hedge direction
      const target = Math.abs(g.delta) * 0.5;            // remove about half the delta
      const ideas: any[] = [];
      const kind = dir < 0 ? "PE" : "CE";
      const i0 = c.strikes.indexOf(c.atm);
      for (const step of [0, 1]) {
        const k = c.strikes[Math.max(0, Math.min(c.strikes.length - 1, i0 + (dir < 0 ? -step : step)))];
        const q = (kind === "CE" ? c.ce : c.pe).get(k);
        if (!q) continue;
        const d = Math.abs(greeks(kind, c.spot, k, c.T, q.iv || c.atmIv, c.r).delta);
        const lots = Math.max(1, Math.round(target / (d * unitsPerLot)));
        const hedgePos: Pos = { root, kind, strike: k, expiry: exp, units: lots * unitsPerLot, avg: q.ltp, symbol: `${root} ${k} ${kind}` };
        ideas.push({ label: `BUY ${lots} lot${lots > 1 ? "s" : ""} ${root} ${k} ${kind} (${exp})`, cost: Math.round(q.ltp * lots * unitsPerLot), pos: [hedgePos] });
      }
      const futLots = Math.max(1, Math.round(target / unitsPerLot));
      ideas.push({ label: `${dir < 0 ? "SELL" : "BUY"} ${futLots} lot${futLots > 1 ? "s" : ""} ${root} FUT`, cost: Math.round(c.spot * futLots * unitsPerLot * 0.12),
        pos: [{ root, kind: "FUT", expiry: inst.fut.expiry, units: dir * futLots * unitsPerLot, avg: c.spot, symbol: `${root} FUT` }], costIsMargin: true });
      for (const h of ideas) {
        const after = bookGreeks([...pos, ...h.pos.map((p: Pos) => (p.kind === "FUT" ? p : { ...p, units: p.units }))], c, t, mcx);
        const worstBefore = Math.min(g.pnlUp, g.pnlDown), worstAfter = Math.min(after.pnlUp, after.pnlDown) - (h.costIsMargin ? 0 : 0);
        h.deltaAfter = Math.round(after.delta);
        h.worstBefore = Math.round(worstBefore); h.worstAfter = Math.round(worstAfter);
        h.riskRemoved = Math.round(worstAfter - worstBefore);
        h.removedPerRupee = h.cost ? +(h.riskRemoved / h.cost).toFixed(2) : 0;
        delete h.pos;
      }
      ideas.sort((a, b) => b.removedPerRupee - a.removedPerRupee);
      suggestions[prof.id].push({ root, exposure: Math.round(g.deltaRupees), ideas: ideas.slice(0, 3) });
    }
  }
  const out = { asOf: `${t.date} ${t.hhmm}`, book, suggestions, skipped, stressMovePct: HEDGE.stressMovePct * 100 };
  await putKv(env, "hedges", out);
  void addDays;
  return out;
}
