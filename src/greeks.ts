/**
 * Greeks watch: every 15 minutes for each index and crude, the option chain's Greeks weighted
 * by open interest, near the money (ATM ± 10 strikes):
 *   call vega vs put vega (and the difference), ATM call/put IV, gamma and theta by side.
 * Put vega growing faster than call vega means money is paying up for downside protection.
 */
import type { IST } from "./calendar";
import { type Chain, greeks } from "./engine/options";
import type { Env } from "./env";

export function vegaBySide(c: Chain, width = 10) {
  const i = c.strikes.indexOf(c.atm), near = c.strikes.slice(Math.max(0, i - width), i + width + 1);
  let callVega = 0, putVega = 0, callGamma = 0, putGamma = 0, callTheta = 0, putTheta = 0, callOi = 0, putOi = 0;
  for (const k of near) {
    const ce = c.ce.get(k), pe = c.pe.get(k);
    if (ce) { const g = greeks("CE", c.spot, k, c.T, ce.iv || c.atmIv, c.r); callVega += g.vega * ce.oi; callGamma += g.gamma * ce.oi; callTheta += g.theta * ce.oi; callOi += ce.oi; }
    if (pe) { const g = greeks("PE", c.spot, k, c.T, pe.iv || c.atmIv, c.r); putVega += g.vega * pe.oi; putGamma += g.gamma * pe.oi; putTheta += g.theta * pe.oi; putOi += pe.oi; }
  }
  const atmCe = c.ce.get(c.atm), atmPe = c.pe.get(c.atm);
  return {
    spot: c.spot, expiry: c.expiry, atm: c.atm,
    callVega, putVega, vegaDiff: putVega - callVega, vegaRatio: callVega ? putVega / callVega : 0,
    callIv: (atmCe?.iv ?? 0) * 100, putIv: (atmPe?.iv ?? 0) * 100,
    atmCallVega: atmCe ? greeks("CE", c.spot, c.atm, c.T, atmCe.iv || c.atmIv, c.r).vega : 0,
    atmPutVega: atmPe ? greeks("PE", c.spot, c.atm, c.T, atmPe.iv || c.atmIv, c.r).vega : 0,
    callGamma, putGamma, callTheta, putTheta, callOi, putOi,
  };
}

export async function snapshotGreeks(env: Env, root: string, c: Chain, t: IST) {
  const g = vegaBySide(c);
  await env.DB.prepare("INSERT OR REPLACE INTO greeks(key,day,ts,json) VALUES(?,?,?,?)").bind(root, t.date, t.hhmm, JSON.stringify(g)).run();
  return g;
}

export async function greeksToday(env: Env, date: string) {
  const { results } = await env.DB.prepare("SELECT key, ts, json FROM greeks WHERE day=? ORDER BY key, ts").bind(date).all<{ key: string; ts: string; json: string }>();
  const out: Record<string, { ts: string; g: ReturnType<typeof vegaBySide> }[]> = {};
  for (const r of results) (out[r.key] ??= []).push({ ts: r.ts, g: JSON.parse(r.json) });
  return out;
}
