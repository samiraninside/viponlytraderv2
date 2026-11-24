import { entryWindow, type Seg, sessions, squareOff } from "../calendar";
import type { Bar } from "../dhan";
import { intradayPath, type Path } from "../engine/evaluate";
import { minsOf } from "../history";
import type { Inst } from "../universe";

export const segOf = (i: Inst): Seg => i.fut.seg as Seg;
export const startMin = (i: Inst, date: string) => sessions(segOf(i), date)[0]?.start ?? null;
export const sqOff = (i: Inst, date: string) =>
  squareOff(segOf(i), date, { expiringIndex: i.kind === "INDEX" && i.fut.expiry === date });
export const inEntryWindow = (i: Inst, mins: number) => { const [a, b] = entryWindow(segOf(i)); return mins >= a && mins <= b; };
export const round = (x: number, tick: number) => Math.round(x / tick) * tick;
export const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
export const fmt = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/**
 * Historical paths for an intraday rule. `find` returns, for one past day, the entry bar index
 * and the stop distance as a fraction of price (or null if the rule did not fire that day).
 * Paths are rescaled so each day's stop distance equals today's: outcomes are then in today's R.
 */
export function intradayHistory(i: Inst, hist: Map<string, Bar[]>, riskPctToday: number,
  find: (day: Bar[], date: string, prior: Map<string, Bar[]>) => { idx: number; riskPct: number } | null): Path[] {
  const out: Path[] = [];
  const days = [...hist.keys()];
  days.forEach((d, n) => {
    const bars = hist.get(d)!;
    const prior = new Map(days.slice(Math.max(0, n - 20), n).map((x) => [x, hist.get(x)!]));
    const hit = find(bars, d, prior);
    const end = sqOff(i, d);
    if (!hit || end === null || hit.riskPct <= 0) return;
    const k = Math.min(3, Math.max(0.33, riskPctToday / hit.riskPct));
    const p = intradayPath(bars, hit.idx, end, minsOf, k);
    if (p.length) out.push(p);
  });
  return out;
}
