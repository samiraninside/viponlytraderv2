/**
 * Exit watch for trades you journaled: stop / target levels plus reversal signals.
 * Pure functions (unit-tested); scan.ts feeds them each 5-minute run.
 */
import { EXITS } from "./config";
import type { Bar } from "./dhan";
import { ema, vwapSeries } from "./indicators";

export type Level = "OK" | "CAUTION" | "EXIT" | "STOP" | "T1" | "T2";
export interface Watch { level: Level; reasons: string[]; px: number; at: number }
export interface Plan { dir: 1 | -1 | 0; sl: number; t1: number; t2: number; range?: [number, number] }

export function watch(p: Plan, today: Bar[], px: number, opts: { oppositeEnter?: boolean; chainVerdict?: number | null; chainAtEntry?: number | null; t1Done?: boolean } = {}): Watch {
  const at = today.at(-1)?.t ?? 0;
  if (p.dir === 0) {
    const [lo, hi] = p.range ?? [0, 0];
    if ((lo > 0 && px <= lo) || (hi > 0 && px >= hi)) return { level: "EXIT", reasons: [`price ${px} left the range ${lo}–${hi}`], px, at };
    return { level: "OK", reasons: [], px, at };
  }
  const d = p.dir;
  if ((px - p.sl) * d <= 0) return { level: "STOP", reasons: [`stop-loss ${p.sl} reached (price ${px})`], px, at };
  if ((px - p.t2) * d >= 0) return { level: "T2", reasons: [`T2 ${p.t2} reached: book the rest`], px, at };
  if (!opts.t1Done && (px - p.t1) * d >= 0) return { level: "T1", reasons: [`T1 ${p.t1} reached: book half, move the stop to entry`], px, at };

  const reasons: string[] = [];
  if (today.length >= 3) {
    const vw = vwapSeries(today).at(-1)!, c = today.at(-1)!.c;
    if ((c - vw) * d < 0) reasons.push(`5-min close ${c.toFixed(2)} ${d > 0 ? "below" : "above"} VWAP ${vw.toFixed(2)}`);
  }
  if (today.length >= 20) {
    const e = ema(today.map((b) => b.c), 20).at(-1)!, c = today.at(-1)!.c;
    if ((c - e) * d < 0) reasons.push(`5-min close ${d > 0 ? "below" : "above"} EMA20 ${e.toFixed(2)}`);
  }
  if (opts.oppositeEnter) reasons.push("an opposite ENTER signal fired on this instrument");
  if (opts.chainVerdict != null && opts.chainVerdict < 0 && (opts.chainAtEntry ?? 0) >= 0) reasons.push("option chain flipped to conflicting");
  const n = EXITS.oiBars;
  if (today.length > n) {
    const a = today.at(-1 - n)!, b = today.at(-1)!;
    if (a.oi && b.oi && (b.c - a.c) * d < 0 && b.oi < a.oi) reasons.push(`${d > 0 ? "long unwinding" : "short covering"}: price against you with OI falling over ${n} bars`);
  }
  const level: Level = reasons.length >= EXITS.exitAt ? "EXIT" : reasons.length ? "CAUTION" : "OK";
  return { level, reasons, px, at };
}

/** Don't chase: how far (in R) price already ran past the entry, and where a retest would be. */
export function chase(dir: number, entry: number, sl: number, px: number, maxR: number, retestR: number) {
  const risk = Math.abs(entry - sl);
  if (!dir || !risk) return null;
  const movedR = ((px - entry) * dir) / risk;
  if (movedR <= maxR) return null;
  return { movedR: Math.round(movedR * 100) / 100, retestAt: Math.round((entry + dir * retestR * risk) * 100) / 100 };
}
