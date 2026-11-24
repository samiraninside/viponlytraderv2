/** Trade structures built from a live option chain, with payoff, charges and margin. */
import { CHARGES, MARGIN, type Structure } from "../config";
import type { Inst } from "../universe";
import { bs, type Chain, nearestStrike, strikeAt } from "./options";

export interface Leg {
  kind: "FUT" | "CE" | "PE";
  side: 1 | -1;          // +1 buy, -1 sell
  strike?: number;
  price: number;         // entry price (premium or future)
  iv?: number;
  id?: string;           // Dhan security id where known
  expiry?: string;
}

export interface Built {
  structure: Structure;
  legs: Leg[];
  label: string;          // "BUY NIFTY 24200 CE / SELL 24400 CE"
  net: number;            // entry net premium per unit: + debit paid, - credit received (futures excluded)
  maxLossUnit: number | null; // defined max loss per unit at expiry (null = undefined risk)
  maxGainUnit: number | null;
  T: number; r: number;   // years to option expiry and rate at entry
  ivMult?: number;
  basis?: number;         // future / spot, so FUT legs move with the option underlying
}

const legLabel = (root: string, l: Leg) =>
  `${l.side > 0 ? "BUY" : "SELL"} ${l.kind === "FUT" ? `${root} FUT` : `${root} ${l.strike} ${l.kind}`}`;

function opt(c: Chain, kind: "CE" | "PE", strike: number, side: 1 | -1): Leg | null {
  const q = (kind === "CE" ? c.ce : c.pe).get(strike);
  if (!q || q.ltp <= 0) return null;
  // cross the spread: buy at ask, sell at bid when quoted
  const px = side > 0 ? (q.ask > 0 ? q.ask : q.ltp) : q.bid > 0 ? q.bid : q.ltp;
  return { kind, side, strike, price: px, iv: q.iv || c.atmIv, id: q.id, expiry: c.expiry };
}

/** Value per unit of the whole structure at underlying S and years-to-expiry T. */
export function value(b: Built, S: number, Tleft: number): number {
  let v = 0;
  for (const l of b.legs) {
    if (l.kind === "FUT") v += l.side * S * (b.basis ?? 1);
    else v += l.side * bs(l.kind, S, l.strike!, Math.max(0, Tleft), (l.iv ?? 0.15) * (b.ivMult ?? 1), b.r);
  }
  return v;
}
export const entryValue = (b: Built) => b.legs.reduce((a, l) => a + l.side * l.price, 0);

/** Reprice a structure as if the underlying were at S (used for WAIT ideas entered at a trigger level). */
export function repriceAt(b: Built, S: number): Built {
  const legs = b.legs.map((l) => ({ ...l, price: l.kind === "FUT" ? S * (b.basis ?? 1) : Math.max(0.05, bs(l.kind, S, l.strike!, b.T, l.iv ?? 0.15, b.r)) }));
  const nb: Built = { ...b, legs };
  nb.net = legs.filter((l) => l.kind !== "FUT").reduce((a, l) => a + l.side * l.price, 0);
  const ex = expiryExtremes(nb, S);
  nb.maxLossUnit = ex.lo; nb.maxGainUnit = ex.hi;
  return nb;
}

/** Worst and best payoff at expiry per unit (scan of underlying prices). */
export function expiryExtremes(b: Built, S0: number): { lo: number | null; hi: number | null } {
  const ks = b.legs.filter((l) => l.strike).map((l) => l.strike!);
  const pts = [S0 * 0.01, S0 * 3, S0, ...ks];
  const e0 = entryValue(b);
  const pay = pts.map((S) => b.legs.reduce((a, l) => a + l.side * (l.kind === "FUT" ? S * (b.basis ?? 1) : Math.max(0, l.kind === "CE" ? S - l.strike! : l.strike! - S)), 0) - e0);
  // slopes of the expiry payoff far below / far above all strikes
  const slopeUp = b.legs.reduce((a, l) => a + (l.kind === "FUT" || l.kind === "CE" ? l.side : 0), 0);
  const slopeLow = b.legs.reduce((a, l) => a + (l.kind === "FUT" ? l.side : l.kind === "PE" ? -l.side : 0), 0);
  const riskUnbounded = slopeUp < 0 || slopeLow > 0;   // loses without limit (or to zero) on one side
  const gainUnbounded = slopeUp > 0 || slopeLow < 0;
  return { lo: riskUnbounded ? null : Math.max(0, -Math.min(...pay)), hi: gainUnbounded ? null : Math.max(...pay) };
}

function finish(structure: Structure, root: string, legs: (Leg | null)[], c: Chain | null, S0: number): Built | null {
  if (legs.some((l) => !l)) return null;
  const ls = legs as Leg[];
  const b: Built = { structure, legs: ls, label: ls.map((l) => legLabel(root, l)).join(" / "), net: 0, maxLossUnit: null, maxGainUnit: null, T: c?.T ?? 0, r: c?.r ?? 0 };
  b.net = ls.filter((l) => l.kind !== "FUT").reduce((a, l) => a + l.side * l.price, 0);
  const ex = expiryExtremes(b, S0);
  b.maxLossUnit = ex.lo; b.maxGainUnit = ex.hi;
  if (b.maxLossUnit !== null && b.maxLossUnit <= 0 && b.structure !== "future") return null; // mispriced quotes
  return b;
}

/** Builders. dir: +1 bullish, -1 bearish. */
export const build = {
  future(i: Inst, dir: 1 | -1, futPx: number): Built {
    return finish("future", i.root, [{ kind: "FUT", side: dir, price: futPx, id: i.fut.id, expiry: i.fut.expiry }], null, futPx)!;
  },
  longOption(i: Inst, c: Chain, dir: 1 | -1, n = 0): Built | null {
    const kind = dir > 0 ? "CE" : "PE";
    const k = strikeAt(c, dir > 0 ? n : -n);
    return finish("long_option", i.root, [opt(c, kind, k, 1)], c, c.spot);
  },
  debitSpread(i: Inst, c: Chain, dir: 1 | -1, width = 2): Built | null {
    const kind = dir > 0 ? "CE" : "PE";
    const k1 = c.atm, k2 = strikeAt(c, dir * width);
    if (k1 === k2) return null;
    return finish("debit_spread", i.root, [opt(c, kind, k1, 1), opt(c, kind, k2, -1)], c, c.spot);
  },
  creditSpread(i: Inst, c: Chain, dir: 1 | -1, away = 1, width = 2): Built | null {
    // bullish: sell OTM PE, buy further PE; bearish: sell OTM CE, buy further CE
    const kind = dir > 0 ? "PE" : "CE";
    const k1 = strikeAt(c, -dir * away), k2 = strikeAt(c, -dir * (away + width));
    if (k1 === k2) return null;
    return finish("credit_spread", i.root, [opt(c, kind, k1, -1), opt(c, kind, k2, 1)], c, c.spot);
  },
  ironFly(i: Inst, c: Chain, wings: number): Built | null {
    const k = c.atm, up = nearestStrike(c, k + wings), dn = nearestStrike(c, k - wings);
    if (up === k || dn === k) return null;
    return finish("iron_fly", i.root, [opt(c, "CE", k, -1), opt(c, "PE", k, -1), opt(c, "CE", up, 1), opt(c, "PE", dn, 1)], c, c.spot);
  },
  ironCondor(i: Inst, c: Chain, shortDist: number, width: number): Built | null {
    const sc = nearestStrike(c, c.spot + shortDist), sp = nearestStrike(c, c.spot - shortDist);
    const lc = nearestStrike(c, sc + width), lp = nearestStrike(c, sp - width);
    if (sc === lc || sp === lp) return null;
    return finish("iron_condor", i.root, [opt(c, "CE", sc, -1), opt(c, "PE", sp, -1), opt(c, "CE", lc, 1), opt(c, "PE", lp, 1)], c, c.spot);
  },
  shortStrangle(i: Inst, c: Chain, dist: number): Built | null {
    const sc = nearestStrike(c, c.spot + dist), sp = nearestStrike(c, c.spot - dist);
    return finish("short_strangle", i.root, [opt(c, "CE", sc, -1), opt(c, "PE", sp, -1)], c, c.spot);
  },
  futHedge(i: Inst, c: Chain, dir: 1 | -1, futPx: number, protectSteps = 1): Built | null {
    const kind = dir > 0 ? "PE" : "CE";
    const k = strikeAt(c, -dir * protectSteps);
    const b = finish("fut_hedge", i.root, [{ kind: "FUT", side: dir, price: futPx, id: i.fut.id, expiry: i.fut.expiry }, opt(c, kind, k, 1)], c, c.spot);
    if (b) { b.basis = futPx / c.spot; const ex = expiryExtremes(b, c.spot); b.maxLossUnit = ex.lo; b.maxGainUnit = ex.hi; }
    return b;
  },
  /** OTM option whose premium is inside [min, max], closest to the middle (hero-zero). */
  optionByPremium(i: Inst, c: Chain, dir: 1 | -1, [min, max]: [number, number], structure: "long_option" = "long_option"): Built | null {
    const kind = dir > 0 ? "CE" : "PE", side = dir > 0 ? (k: number) => k > c.spot : (k: number) => k < c.spot;
    const target = (min + max) / 2;
    const pick = [...(kind === "CE" ? c.ce : c.pe)].filter(([k, q]) => side(k) && q.ltp >= min && q.ltp <= max)
      .sort((a, b) => Math.abs(a[1].ltp - target) - Math.abs(b[1].ltp - target))[0];
    return pick ? finish(structure, i.root, [opt(c, kind, pick[0], 1)], c, c.spot) : null;
  },
  strangleByPremium(i: Inst, c: Chain, range: [number, number]): Built | null {
    const ce = build.optionByPremium(i, c, 1, range), pe = build.optionByPremium(i, c, -1, range);
    return ce && pe ? finish("long_strangle", i.root, [...ce.legs, ...pe.legs], c, c.spot) : null;
  },
  longStraddle(i: Inst, c: Chain): Built | null {
    return finish("long_straddle", i.root, [opt(c, "CE", c.atm, 1), opt(c, "PE", c.atm, 1)], c, c.spot);
  },
};

/** Round-trip charges per lot (approximate). */
export function chargesPerLot(b: Built, i: Inst): number {
  const units = i.kind === "COMMODITY" ? i.pointValue : i.lot;
  const mcx = i.kind === "COMMODITY";
  let total = 0;
  for (const l of b.legs) {
    const turn = l.price * units;              // one side
    const brok = CHARGES.brokeragePerOrder * 2;
    let stt = 0, exch = 0, stamp = 0;
    if (l.kind === "FUT") {
      stt = turn * (mcx ? CHARGES.ctlMcxFutureSellPct : CHARGES.sttFutureSellPct);
      exch = 2 * turn * (mcx ? CHARGES.exchMcxPct : CHARGES.exchFuturePct);
      stamp = turn * CHARGES.stampFutureBuyPct;
    } else {
      stt = turn * (mcx ? CHARGES.ctlMcxOptionSellPct : CHARGES.sttOptionSellPct);
      exch = 2 * turn * (mcx ? CHARGES.exchMcxPct * 20 : CHARGES.exchOptionPct);
      stamp = turn * CHARGES.stampOptionBuyPct;
    }
    const sebi = (2 * turn * CHARGES.sebiPerCrore) / 1e7;
    total += brok + stt + exch + stamp + sebi + CHARGES.gstPct * (brok + exch + sebi);
  }
  return total;
}

/** Approximate margin per lot (₹). */
export function marginPerLot(b: Built, i: Inst, futPx: number): number {
  const units = i.kind === "COMMODITY" ? i.pointValue : i.lot;
  const pct = i.kind === "INDEX" ? MARGIN.futurePctIndex : i.kind === "STOCK" ? MARGIN.futurePctStock : MARGIN.futurePctCommodity;
  const futM = futPx * units * pct;
  const debit = Math.max(0, b.net) * units;
  switch (b.structure) {
    case "future": return futM;
    case "fut_hedge": return futM * 0.55 + debit; // hedge benefit: roughly half the future margin plus the option cost
    case "long_option": case "debit_spread": case "long_straddle": return debit;
    case "short_strangle": return 2 * futM * MARGIN.shortOptionAsFuture * 0.75; // SPAN offsets the two sides partly
    default: return (b.maxLossUnit ?? 0) * units * MARGIN.hedgedBuffer + debit;
  }
}
