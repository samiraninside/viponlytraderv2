/**
 * Data health and the kill switch. A wrong ENTER built on stale or missing data costs more
 * trust than ten good calls earn, so while data is unhealthy (or you pull the manual switch)
 * the board shows no new ENTER, sends no push, and says why. Already-published calls keep
 * being tracked to their outcome.
 */
import { type IST, type Seg, sessions } from "./calendar";
import { HEALTH } from "./config";
import type { Bar } from "./dhan";
import type { Env } from "./env";
import { append } from "./ledger";
import { getKv, putKv } from "./universe";

export type Segment = "NSE" | "MCX";
export interface Health { ok: boolean; reasons: string[]; checkedAt: string; staleShare?: number; since?: string }
export interface Kill { on: boolean; reason: string; at: string }

/** Pure check, unit-tested: last closed bars per instrument + errors from this run. */
export function assess(seg: Seg, t: IST, lastBars: (Bar | undefined)[], errors: string[]): Health {
  const reasons: string[] = [];
  const ss = sessions(seg, t.date);
  const cur = ss.find((s) => t.mins >= s.start && t.mins < s.end);
  if (errors.some((e) => e.startsWith("quote:"))) reasons.push("live quotes failed");
  if (cur && t.mins - cur.start >= HEALTH.warmupMinutes && lastBars.length) {
    const stale = lastBars.filter((b) => !b || t.epoch / 1000 - (b.t + 300) > HEALTH.staleBarMinutes * 60).length;
    const share = stale / lastBars.length;
    if (share > HEALTH.maxStaleShare) reasons.push(`${stale} of ${lastBars.length} instruments have no 5-min bar in the last ${HEALTH.staleBarMinutes} minutes`);
    return { ok: !reasons.length, reasons, checkedAt: `${t.date} ${t.hhmm}`, staleShare: Math.round(share * 100) / 100 };
  }
  return { ok: !reasons.length, reasons, checkedAt: `${t.date} ${t.hhmm}` };
}

/** Store the segment's health; log changes (healthy ↔ unhealthy) in the ledger. */
export async function record(env: Env, segment: Segment, h: Health) {
  const old = await getKv<Health>(env, `health:${segment}`);
  if (!old || old.ok !== h.ok) {
    h.since = h.checkedAt;
    await append(env, [{ kind: "KILL", ref: `data:${segment}`, data: { segment, ok: h.ok, reasons: h.reasons, at: h.checkedAt } }]);
  } else h.since = old.since;
  await putKv(env, `health:${segment}`, h);
}

export const manualKill = (env: Env) => getKv<Kill>(env, "kill:manual");
export async function setManualKill(env: Env, on: boolean, reason: string, at: string) {
  const k: Kill = { on, reason: reason || (on ? "switched off by you" : ""), at };
  await putKv(env, "kill:manual", k);
  await append(env, [{ kind: "KILL", ref: "manual", data: k }]);
  return k;
}

/** Why new ENTERs are blocked for this segment right now, or null. */
export async function blockReason(env: Env, segment: Segment, h: Health): Promise<string | null> {
  const k = await manualKill(env);
  if (k?.on) return `kill switch on: ${k.reason}`;
  if (!h.ok) return `data check failed: ${h.reasons.join("; ")}`;
  return null;
}

/** For the site: per segment health + manual switch + whether scans are still arriving. */
export async function healthView(env: Env, t: IST, lastRuns: { nse: any; mcx: any }, open: { nse: boolean; mcx: boolean }) {
  const view: Record<string, unknown> = { manual: await manualKill(env) };
  for (const [seg, lr, isOpen] of [["NSE", lastRuns.nse, open.nse], ["MCX", lastRuns.mcx, open.mcx]] as const) {
    const h = await getKv<Health>(env, `health:${seg}`);
    let gap: number | null = null;
    if (lr?.at) { const [d, hm] = String(lr.at).split(" "); if (d === t.date) gap = t.mins - (+hm.slice(0, 2) * 60 + +hm.slice(3, 5)); }
    const scanLate = isOpen && (gap === null || gap > HEALTH.scanGapMinutes);
    view[seg] = { ...(h ?? { ok: true, reasons: [] }), scanLate, minutesSinceScan: gap };
  }
  return view;
}
