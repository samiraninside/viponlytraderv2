/**
 * Calibration: do the scores hold up live? Joins every published CALL in the ledger with its
 * OUTCOME and compares what the board predicted (win %, EV in R) with what happened.
 * Also pauses agents whose live results are clearly negative (AUTOPAUSE in config).
 */
import { AUTOPAUSE } from "./config";
import type { Env } from "./env";
import { append, rows } from "./ledger";
import { getKv, putKv } from "./universe";

interface Call { opp: string; profile: string; agent: string; score: number; pWin: number; evR: number; horizon: string; root: string; chase?: unknown; overCap?: boolean }
interface Outcome { opp: string; agent: string; r: number; result: string }

const BANDS: [string, number, number][] = [["85+", 85, 101], ["75–84", 75, 85], ["65–74", 65, 75], ["55–64", 55, 65]];
const r2 = (x: number) => Math.round(x * 100) / 100;

function stats(list: { r: number; pWin?: number; evR?: number }[]) {
  const n = list.length;
  if (!n) return { n: 0 };
  const wins = list.filter((x) => x.r > 0).length;
  const withP = list.filter((x) => x.pWin != null);
  return {
    n, winPct: Math.round((wins / n) * 100), avgR: r2(list.reduce((a, x) => a + x.r, 0) / n),
    predictedWinPct: withP.length ? Math.round((withP.reduce((a, x) => a + x.pWin!, 0) / withP.length) * 100) : null,
    predictedEvR: withP.length ? r2(withP.reduce((a, x) => a + (x.evR ?? 0), 0) / withP.length) : null,
  };
}

export async function calibration(env: Env, profile: string, days = 30) {
  const since = Date.now() - days * 86400e3;
  const calls = (await rows(env, { kind: "CALL", since, limit: 20000 })).map((r) => r.data as Call).filter((c) => c.profile === profile);
  const outs = new Map((await rows(env, { kind: "OUTCOME", since, limit: 20000 })).map((r) => [(r.data as Outcome).opp, r.data as Outcome]));
  const joined = calls.filter((c) => outs.has(c.opp)).map((c) => ({ ...c, r: outs.get(c.opp)!.r }));
  const byAgent = new Map<string, typeof joined>();
  for (const j of joined) (byAgent.get(j.agent) ?? byAgent.set(j.agent, []).get(j.agent)!).push(j);
  const paused = (await getKv<Record<string, { at: string; reason: string }>>(env, "autopaused")) ?? {};
  return {
    days, profile, calls: calls.length, closed: joined.length, open: calls.length - joined.length,
    note: "Predicted win % is the option structure's replayed win rate; live R is measured on the future at the card's levels (½ at T1, stop to entry, rest at T2 or time). Treat gaps under ~30 trades as noise.",
    overall: stats(joined),
    byScore: BANDS.map(([band, lo, hi]) => ({ band, ...stats(joined.filter((j) => j.score >= lo && j.score < hi)) })),
    byAgent: [...byAgent].map(([agent, l]) => ({ agent, ...stats(l), paused: paused[agent] ?? null })).sort((a, b) => b.n - a.n),
    chased: stats(joined.filter((j) => j.chase)),
    notChased: stats(joined.filter((j) => !j.chase)),
  };
}

/** Pause agents with enough live trades and a clearly negative average. Logged in the ledger. */
export async function autoPause(env: Env, today: string) {
  if (!AUTOPAUSE.enabled) return [];
  const since = Date.now() - AUTOPAUSE.lookbackDays * 86400e3;
  const outs = (await rows(env, { kind: "OUTCOME", since, limit: 20000 })).map((r) => r.data as Outcome);
  const by = new Map<string, number[]>();
  for (const o of outs) (by.get(o.agent) ?? by.set(o.agent, []).get(o.agent)!).push(o.r);
  const overrides = (await getKv<Record<string, boolean>>(env, "agent_overrides")) ?? {};
  const paused = (await getKv<Record<string, { at: string; reason: string }>>(env, "autopaused")) ?? {};
  const now: string[] = [];
  for (const [agent, rs] of by) {
    if (rs.length < AUTOPAUSE.minTrades || overrides[agent] === false) continue;
    const avg = rs.reduce((a, x) => a + x, 0) / rs.length;
    if (avg >= AUTOPAUSE.pauseBelowAvgR) continue;
    const reason = `live average ${r2(avg)}R over ${rs.length} trades in ${AUTOPAUSE.lookbackDays} days`;
    overrides[agent] = false;
    paused[agent] = { at: today, reason };
    now.push(agent);
    await append(env, [{ kind: "CONFIG", ref: `agent:${agent}`, data: { change: "auto-paused", agent, reason } }]);
  }
  if (now.length) { await putKv(env, "agent_overrides", overrides); await putKv(env, "autopaused", paused); }
  return now;
}
