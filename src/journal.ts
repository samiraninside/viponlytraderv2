/**
 * Your real-trade journal. Each entry is linked to the board card (the signal) you acted on,
 * so the track record can compare the signal with what you actually got: fill vs signal entry
 * (slippage), exits, P&L in ₹ and in R. Entries are never deleted; a mistake is voided with a
 * reason. Every change is also written to the ledger.
 */
import type { Card } from "./engine/opportunities";
import type { Env } from "./env";
import type { Watch } from "./exits";
import { append } from "./ledger";

export interface Fill { side: "in" | "out"; lots: number; price: number; at: number; note?: string }
export interface Entry {
  id: string; cardId: string; opp: string; key: string; root: string; kind: Card["kind"]; profile: string;
  agent: string; setup: string; dir: 1 | -1 | 0; horizon: Card["horizon"]; structure: Card["structure"]; label: string;
  basis: Card["levels"]["basis"]; unitsPerLot: number;
  signal: { entry: number; sl: number; t1: number; t2: number; und: Card["underlying"]; range?: [number, number]; score: number; confirm: number | null; maxLossPerLot: number };
  undAtEntry: number | null;
  fills: Fill[]; status: "OPEN" | "CLOSED" | "VOID"; voidReason?: string; notes?: string;
  watch?: Watch & { alerted?: string[] }; created: number; updated: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
/** + for a profit per unit when price goes up in the card's basis. */
const sideSign = (e: Pick<Entry, "basis" | "dir">) => (e.basis === "credit" ? -1 : e.basis === "underlying" ? (e.dir || 1) : 1);

export function summary(e: Entry) {
  const ins = e.fills.filter((f) => f.side === "in"), outs = e.fills.filter((f) => f.side === "out");
  const inLots = ins.reduce((a, f) => a + f.lots, 0), outLots = outs.reduce((a, f) => a + f.lots, 0);
  const avgIn = inLots ? ins.reduce((a, f) => a + f.price * f.lots, 0) / inLots : 0;
  const avgOut = outLots ? outs.reduce((a, f) => a + f.price * f.lots, 0) / outLots : 0;
  const s = sideSign(e), u = e.unitsPerLot;
  const realised = outLots ? (avgOut - avgIn) * s * outLots * u : 0;
  const first = ins[0];
  const plannedRisk = first ? Math.abs(first.price - e.signal.sl) * first.lots * u : 0;
  const slip = first ? (first.price - e.signal.entry) * s : 0;  // + = you paid worse than the signal
  return {
    openLots: inLots - outLots, avgIn: r2(avgIn), avgOut: r2(avgOut), realised: Math.round(realised),
    r: plannedRisk ? r2(realised / plannedRisk) : null,
    slippage: first ? { perUnit: r2(slip), rupees: Math.round(slip * first.lots * u), pctOfRisk: plannedRisk ? Math.round((slip * first.lots * u / plannedRisk) * 100) : null } : null,
    orders: e.fills.length,
    note: "Gross: before brokerage, STT and other charges.",
  };
}

/** Progress on the underlying from your entry towards T2, with the stop and T1 marked (−100…100+). */
export function progress(e: Entry, px: number | null) {
  if (px == null || !e.undAtEntry || e.dir === 0) return null;
  const d = e.dir, u = e.signal.und, base = e.undAtEntry, span = Math.abs(u.t2 - base) || 1;
  const pct = (x: number) => Math.round((((x - base) * d) / span) * 100);
  return { px, pct: pct(px), slPct: pct(u.sl), t1Pct: pct(u.t1), t2Pct: 100 };
}

export function fromCard(c: Card, lots: number, price: number, at: number, undPx: number | null, note?: string): Entry {
  const id = crypto.randomUUID().slice(0, 12);
  return {
    id, cardId: c.id, opp: c.id.slice(0, c.id.lastIndexOf(":")), key: c.key, root: c.root, kind: c.kind, profile: c.profile,
    agent: c.agent, setup: c.setup, dir: c.dir, horizon: c.horizon, structure: c.structure, label: c.label,
    basis: c.levels.basis, unitsPerLot: c.units / Math.max(1, c.lots),
    signal: { entry: c.levels.entry, sl: c.levels.sl, t1: c.levels.t1, t2: c.levels.t2, und: c.underlying, range: c.range, score: c.score, confirm: c.confirm?.verdict ?? null, maxLossPerLot: Math.round(c.maxLoss / Math.max(1, c.lots)) },
    undAtEntry: undPx, fills: [{ side: "in", lots, price, at, note }], status: "OPEN", notes: note, created: at, updated: at,
  };
}

export async function save(env: Env, e: Entry, change: string) {
  e.updated = Date.now();
  await env.DB.prepare("INSERT OR REPLACE INTO journal(id,card_id,key,status,created,updated,json) VALUES(?,?,?,?,?,?,?)")
    .bind(e.id, e.cardId, e.key, e.status, e.created, e.updated, JSON.stringify(e)).run();
  await append(env, [{ kind: "JOURNAL", ref: e.id, data: { change, id: e.id, cardId: e.cardId, opp: e.opp, status: e.status, fills: e.fills, voidReason: e.voidReason, summary: summary(e) } }]);
}

export async function load(env: Env, id: string) {
  const r = await env.DB.prepare("SELECT json FROM journal WHERE id=?").bind(id).first<{ json: string }>();
  return r ? (JSON.parse(r.json) as Entry) : null;
}
export async function openEntries(env: Env) {
  const { results } = await env.DB.prepare("SELECT json FROM journal WHERE status='OPEN'").all<{ json: string }>();
  return results.map((r) => JSON.parse(r.json) as Entry);
}
export async function list(env: Env, days = 30) {
  const { results } = await env.DB.prepare("SELECT json FROM journal WHERE created>=? ORDER BY created DESC").bind(Date.now() - days * 86400e3).all<{ json: string }>();
  return results.map((r) => JSON.parse(r.json) as Entry);
}

/** Your real results vs the signals you took. */
export function stats(entries: Entry[]) {
  const closed = entries.filter((e) => e.status === "CLOSED").map((e) => ({ e, s: summary(e) }));
  const n = closed.length;
  const wins = closed.filter((x) => x.s.realised > 0).length;
  const rs = closed.map((x) => x.s.r).filter((x): x is number => x != null);
  const slips = closed.map((x) => x.s.slippage?.pctOfRisk).filter((x): x is number => x != null);
  return {
    trades: n, open: entries.filter((e) => e.status === "OPEN").length,
    winPct: n ? Math.round((wins / n) * 100) : null,
    pnl: closed.reduce((a, x) => a + x.s.realised, 0),
    avgR: rs.length ? r2(rs.reduce((a, x) => a + x, 0) / rs.length) : null,
    avgSlippagePctOfRisk: slips.length ? Math.round(slips.reduce((a, x) => a + x, 0) / slips.length) : null,
    exitedAtStopOrBetter: closed.filter((x) => (x.s.r ?? 0) >= -1.1).length,
    lostMoreThanPlanned: closed.filter((x) => (x.s.r ?? 0) < -1.1).length,
  };
}
