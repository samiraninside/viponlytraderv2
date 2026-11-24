/**
 * Fibonacci add-lot plan, ported from the old Python engine's averaging agent and made safe:
 * every add is checked against the profile's risk cap (stop unchanged) and the cash reserve.
 */
import { AVERAGING, type Profile } from "../config";
import type { Card } from "./opportunities";

export interface AvgAdd {
  fib: number;          // 0.382 / 0.5 / 0.618
  at: number;           // level in the card's basis (premium for options, price for futures)
  atUnderlying: number; // the same Fibonacci point on the underlying
  lots: number;         // always 1 per add
  avgAfter: number;     // weighted average after this add
  t1After: number; t2After: number;
  riskAfter: number;    // total loss at the stop after this add, ₹
  costAfter: number;    // reserve used so far, ₹
}
export interface AvgPlan {
  mode: "pyramid" | "average";
  adds: AvgAdd[];
  reserve: number;      // ₹ kept free for adds
  skipped?: string;     // why there are fewer adds than allowed
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const SLIP = 1.15;      // same cushion the board uses for max loss
const FEES_PER_ADD = 40; // two orders' brokerage

export function averagingPlan(c: Pick<Card, "agent" | "structure" | "levels" | "underlying" | "lots" | "units" | "maxLoss" | "margin">, p: Profile): AvgPlan | undefined {
  const mode = AVERAGING.mode[c.agent];
  if (!p.averaging || !mode || !AVERAGING.structures.includes(c.structure) || c.lots < 1) return;
  const L = c.levels, U = c.underlying;
  if (L.basis === "credit") return;
  const sign = L.t1 > L.entry ? 1 : -1;
  const upl = c.units / c.lots;                       // units per lot
  const toward = mode === "pyramid" ? L.t1 : L.sl;     // where the adds sit
  const towardU = mode === "pyramid" ? U.t1 : U.sl;
  const reserve = Math.round(p.capital * AVERAGING.reserveShare);
  const marginPerLot = c.margin / c.lots;

  let lots = c.lots, avg = L.entry, risk = c.maxLoss, cost = 0;
  const adds: AvgAdd[] = [];
  let skipped: string | undefined;
  for (const f of AVERAGING.fib) {
    if (adds.length >= AVERAGING.maxAdds) break;
    const at = L.entry + f * (toward - L.entry);
    const addRisk = Math.abs(at - L.sl) * upl * SLIP + FEES_PER_ADD;
    const addCost = L.basis === "premium" ? at * upl : marginPerLot;
    if (risk + addRisk > p.riskPerTrade) { skipped ??= `an add at ${r2(at)} would take the loss at the stop past ₹${p.riskPerTrade.toLocaleString("en-IN")}`; continue; }
    if (cost + addCost > reserve) { skipped ??= `an add at ${r2(at)} needs more than the ₹${reserve.toLocaleString("en-IN")} reserve`; continue; }
    avg = (avg * lots + at) / (lots + 1);
    lots += 1; risk += addRisk; cost += addCost;
    adds.push({
      fib: f, at: r2(at), atUnderlying: r2(U.entry + f * (towardU - U.entry)), lots: 1, avgAfter: r2(avg),
      t1After: r2(avg + sign * Math.abs(L.t1 - L.entry)), t2After: r2(avg + sign * Math.abs(L.t2 - L.entry)),
      riskAfter: Math.round(risk), costAfter: Math.round(cost),
    });
  }
  return { mode, adds, reserve, skipped: adds.length < AVERAGING.maxAdds ? skipped : undefined };
}
