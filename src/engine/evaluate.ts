/**
 * Scenario evaluator: replays a structure along historical price paths of the same
 * instrument (scaled to today's volatility) and returns win rate, average win / loss
 * and expected value per lot after charges. This is where every score comes from.
 */
import { SCORE } from "../config";
import type { Inst } from "../universe";
import { chargesPerLot, entryValue, type Built, value } from "./structures";

/** One step of a path; prices are ratios to the entry price. dt = years elapsed at the end of the step. */
export interface Step { o: number; h: number; l: number; c: number; dt: number }
export type Path = Step[];

export type Rules =
  | { kind: "directional"; dir: 1 | -1; sl: number; t1: number; t2: number; halfAtT1: boolean }
  | { kind: "range"; upStop: number; dnStop: number }
  | { kind: "hold" };

export interface Eval {
  n: number; pWin: number; avgWin: number; avgLoss: number; ev: number;  // ₹ per lot, after charges
  maxLoss: number;       // ₹ per lot used for sizing: loss at the stop-loss (+15% slippage), capped by the defined max loss
  worstCase: number | null; // ₹ per lot if everything goes wrong (premium / spread width); null = no cap
  evR: number; score: number; thin: boolean; charges: number;
  pT1?: number;          // share of paths reaching T1 (directional)
}

const units = (i: Inst) => (i.kind === "COMMODITY" ? i.pointValue : i.lot);

/** Fill price for a stop/target level in a step: gaps through the level fill at the open. */
function fill(level: number, s: Step, above: boolean) {
  return above ? Math.max(level, s.o) : Math.min(level, s.o);
}

export function runPath(b: Built, path: Path, rules: Rules, S0: number): { pnl: number; t1: boolean } {
  const e0 = entryValue(b);
  const at = (ratio: number, dt: number) => value(b, S0 * ratio, b.T - dt) - e0;
  if (!path.length) return { pnl: 0, t1: false };
  const last = path[path.length - 1];
  if (rules.kind === "hold") return { pnl: at(last.c, last.dt), t1: false };
  if (rules.kind === "range") {
    for (const s of path) {
      if (s.h >= rules.upStop) return { pnl: at(fill(rules.upStop, s, true), s.dt), t1: false };
      if (s.l <= rules.dnStop) return { pnl: at(fill(rules.dnStop, s, false), s.dt), t1: false };
    }
    return { pnl: at(last.c, last.dt), t1: false };
  }
  const { dir, sl, t1, t2, halfAtT1 } = rules;
  const hitUp = (s: Step, x: number) => s.h >= x, hitDn = (s: Step, x: number) => s.l <= x;
  const reached = (s: Step, x: number) => (dir > 0 ? hitUp(s, x) : hitDn(s, x));
  const stopped = (s: Step, x: number) => (dir > 0 ? hitDn(s, x) : hitUp(s, x));
  let booked = 0, open = 1, stop = sl, gotT1 = false;
  for (const s of path) {
    if (stopped(s, stop)) {                         // stop first when both touch (conservative)
      booked += open * at(fill(stop, s, dir < 0), s.dt);
      return { pnl: booked, t1: gotT1 };
    }
    if (!gotT1 && reached(s, t1)) {
      gotT1 = true;
      if (halfAtT1) { booked += 0.5 * at(fill(t1, s, dir > 0), s.dt); open = 0.5; stop = 1; }
    }
    if (gotT1 && reached(s, t2)) {
      booked += open * at(fill(t2, s, dir > 0), s.dt);
      return { pnl: booked, t1: true };
    }
  }
  return { pnl: booked + open * at(last.c, last.dt), t1: gotT1 };
}

export function evaluate(b: Built, i: Inst, paths: Path[], rules: Rules, S0: number, riskRef?: number): Eval {
  const u = units(i);
  const charges = chargesPerLot(b, i) * (rules.kind === "directional" && rules.halfAtT1 ? 1.25 : 1);
  const res = paths.map((p) => runPath(b, p, rules, S0));
  const pnl = res.map((r) => r.pnl * u - charges);
  const wins = pnl.filter((x) => x > 0), losses = pnl.filter((x) => x <= 0);
  const n = pnl.length;
  const ev = n ? pnl.reduce((a, x) => a + x, 0) / n : 0;
  const defined = b.maxLossUnit !== null ? b.maxLossUnit * u + charges : null;
  const e0 = entryValue(b);
  const lossAt = (ratio: number) => Math.max(0, (e0 - value(b, S0 * ratio, b.T)) * u);
  let atStop = 0;
  if (rules.kind === "directional") atStop = lossAt(rules.sl) * 1.15 + charges;
  else if (rules.kind === "range") atStop = Math.max(lossAt(rules.upStop), lossAt(rules.dnStop)) * 1.15 + charges;
  if (riskRef) atStop = Math.max(atStop, riskRef * 1.15 + charges);
  if (rules.kind === "range" && defined === null) {
    const s = [...losses].sort((a, b) => a - b);
    atStop = Math.max(atStop, Math.abs(s[Math.floor(s.length * 0.1)] ?? 0));
  }
  let maxLoss = defined !== null ? (atStop > charges ? Math.min(defined, atStop) : defined) : atStop;
  if (!maxLoss) maxLoss = 1;
  const evR = maxLoss ? ev / maxLoss : 0;
  const shrunk = evR * (n / (n + SCORE.shrinkK));
  return {
    n, pWin: n ? wins.length / n : 0,
    avgWin: wins.length ? wins.reduce((a, x) => a + x, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((a, x) => a + x, 0) / losses.length : 0,
    ev, maxLoss, worstCase: defined, evR, charges,
    score: Math.min(99, Math.round(100 / (1 + Math.exp(-SCORE.steepness * shrunk)))),
    thin: n < SCORE.minSamples,
    pT1: rules.kind === "directional" && n ? res.filter((r) => r.t1).length / n : undefined,
  };
}

// ---------------------------------------------------------------- path builders
const YEAR_MIN = 365 * 24 * 60;

/** Scale a ratio around 1 by k (volatility adjustment). */
const sc = (x: number, k: number) => 1 + (x - 1) * k;

/** Intraday path from bar index `from` (exclusive start: entry at bars[from-1].c) to the last bar starting before endMin. */
export function intradayPath(bars: { t: number; o: number; h: number; l: number; c: number }[], entryIdx: number, endMin: number,
  minsOf: (t: number) => number, k = 1, ref?: number): Path {
  const base = ref ?? bars[entryIdx].c;
  const p: Path = [];
  let el = 0;
  for (let j = entryIdx + 1; j < bars.length && minsOf(bars[j].t) + 5 <= endMin; j++) {
    el += 5;
    const b = bars[j];
    p.push({ o: sc(b.o / base, k), h: sc(b.h / base, k), l: sc(b.l / base, k), c: sc(b.c / base, k), dt: el / YEAR_MIN });
  }
  return p;
}

/** Daily path from the close of day `idx` for `days` sessions. btst: only the next open is used. */
export function dailyPath(d: { o: number; h: number; l: number; c: number }[], idx: number, days: number, k = 1, btst = false): Path {
  const base = d[idx].c, p: Path = [];
  for (let j = 1; j <= days && idx + j < d.length; j++) {
    const b = d[idx + j];
    const dtOpen = ((j - 1) * 1.4 + 0.75) / 365;   // overnight to next open (calendar-ish)
    if (btst && j === days) { const o = sc(b.o / base, k); p.push({ o, h: o, l: o, c: o, dt: dtOpen }); break; }
    p.push({ o: sc(b.o / base, k), h: sc(b.h / base, k), l: sc(b.l / base, k), c: sc(b.c / base, k), dt: (j * 1.4) / 365 });
  }
  return p;
}

export const volScale = (now: number, then: number) => (then > 0 ? Math.min(2, Math.max(0.5, now / then)) : 1);
