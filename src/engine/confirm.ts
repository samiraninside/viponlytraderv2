/**
 * Option Chain Confirmation: OI, OI change, PCR, IV and futures build-up checked against
 * the idea's direction. A heuristic layer (there is no history of option chains to score it),
 * so it changes the ranking a little and is shown as a badge, not mixed into the score.
 */
import type { Chain } from "./options";

export interface Vote { label: string; v: -1 | 0 | 1 }
export interface Confirmation { verdict: -1 | 0 | 1; votes: Vote[] }

export function confirmChain(c: Chain, dir: 1 | -1, fut: { pxChg: number; oiChg: number | null }, ivRank: number | null): Confirmation {
  const votes: Vote[] = [];
  let tce = 0, tpe = 0;
  for (const q of c.ce.values()) tce += q.oi;
  for (const q of c.pe.values()) tpe += q.oi;
  const pcr = tce ? tpe / tce : 1;
  const pv = pcr > 1.1 ? 1 : pcr < 0.8 ? -1 : 0;
  votes.push({ label: `PCR ${pcr.toFixed(2)}${pv > 0 ? " (put writing heavier)" : pv < 0 ? " (call writing heavier)" : ""}`, v: (pv * dir) as Vote["v"] });

  const i = c.strikes.indexOf(c.atm), near = c.strikes.slice(Math.max(0, i - 5), i + 6);
  let dCe = 0, dPe = 0;
  for (const k of near) { const a = c.ce.get(k), b = c.pe.get(k); if (a) dCe += a.oi - a.poi; if (b) dPe += b.oi - b.poi; }
  const tot = Math.abs(dCe) + Math.abs(dPe);
  const ov = tot && Math.abs(dPe - dCe) / tot > 0.2 ? Math.sign(dPe - dCe) : 0;
  votes.push({ label: `near-ATM OI change: puts ${dPe >= 0 ? "+" : ""}${Math.round(dPe)}, calls ${dCe >= 0 ? "+" : ""}${Math.round(dCe)}`, v: (ov * dir) as Vote["v"] });

  const wallUp = [...c.ce].filter(([k]) => k > c.spot).sort((a, b) => b[1].oi - a[1].oi)[0]?.[0];
  const wallDn = [...c.pe].filter(([k]) => k < c.spot).sort((a, b) => b[1].oi - a[1].oi)[0]?.[0];
  const wall = dir > 0 ? wallUp : wallDn;
  if (wall) {
    const room = Math.abs(wall - c.spot) / c.spot;
    votes.push({ label: `${dir > 0 ? "call" : "put"} OI wall at ${wall} (${(room * 100).toFixed(2)}% away)`, v: room < 0.003 ? -1 : 0 });
  }

  if (fut.oiChg !== null) {
    const type = fut.pxChg >= 0 ? (fut.oiChg >= 0 ? "long build-up" : "short covering") : fut.oiChg >= 0 ? "short build-up" : "long unwinding";
    const v = type === "long build-up" ? 1 : type === "short build-up" ? -1 : 0;
    votes.push({ label: `futures: ${type} (price ${(fut.pxChg * 100).toFixed(2)}%, OI ${(fut.oiChg * 100).toFixed(1)}%)`, v: (v * dir) as Vote["v"] });
  }
  if (ivRank !== null) votes.push({ label: `IV rank ${ivRank.toFixed(0)}${ivRank > 80 ? ": options expensive, prefer spreads" : ""}`, v: 0 });

  const net = votes.reduce((a, x) => a + x.v, 0);
  return { verdict: net >= 2 ? 1 : net <= -2 ? -1 : 0, votes };
}
