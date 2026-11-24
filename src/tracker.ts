/**
 * Tracks every card that reached ENTER to its outcome on the underlying (in R), so the app
 * can show how the scores hold up live. Hypothetical: assumes the trade was taken at the card's levels.
 */
import { type IST, nextTradingDay, type Seg, squareOff, toMins } from "./calendar";
import type { Bar } from "./dhan";
import type { Card } from "./engine/opportunities";
import type { Env } from "./env";
import { dayOf, load5m, minsOf } from "./history";
import { append } from "./ledger";
import type { Inst } from "./universe";

type Outcome = NonNullable<Card["outcome"]>;

export function judge(c: Card, bars: Bar[], segOf: Seg, nowMin: number, today: string): Outcome | null {
  const after = bars.filter((b) => b.t * 1000 >= (c.entryAt ?? 0) - 60_000).sort((a, b) => a.t - b.t);
  const u = c.underlying;
  if (c.rules?.kind === "hold") {
    // hero-zero style: hold to the square-off, value the options at expiry-day intrinsic
    const end = squareOff(segOf, c.date) ?? toMins("15:15");
    if (!(today > c.date || nowMin >= end) || !after.length) return null;
    const lastBar = [...after].reverse().find((b) => dayOf(b.t) === c.date && minsOf(b.t) + 5 <= end) ?? after.at(-1)!;
    const S = (c.spot0 ?? u.entry) * (lastBar.c / u.entry);
    const paid = c.legs.reduce((a, l) => a + l.side * l.price, 0);
    const worth = c.legs.reduce((a, l) => a + l.side * Math.max(0, l.kind === "CE" ? S - l.strike! : l.kind === "PE" ? l.strike! - S : 0), 0);
    const r = paid > 0 ? Math.round((worth / paid - 1) * 100) / 100 : 0;
    return { result: r > 0 ? `${(worth / paid).toFixed(1)}× the premium` : "expired near zero", r, at: lastBar.t };
  }
  if (c.range) {
    const [lo, hi] = c.range;
    for (const b of after) if ((hi > 0 && b.h >= hi) || (lo > 0 && b.l <= lo)) return { result: "stopped (breakeven breached)", r: -1, at: b.t };
    const endDay = c.horizon === "intraday" ? c.date : c.expiry ?? c.date;
    const end = squareOff(segOf, endDay) ?? toMins("15:15");
    if (today > endDay || (today === endDay && nowMin >= end)) return { result: "held to exit", r: 0.5, at: Date.now() / 1000 };
    return null;
  }
  const dir = c.dir as 1 | -1, risk = Math.abs(u.entry - u.sl);
  if (!risk) return null;
  const R = (px: number) => ((px - u.entry) * dir) / risk;
  if (c.horizon === "btst") {
    const nd = nextTradingDay(segOf, c.date);
    const first = after.find((b) => dayOf(b.t) === nd);
    if (!first) return null;
    const r = Math.max(-1, Math.min(R(first.o), R(u.t2)));
    return { result: r >= R(u.t1) ? "gap to target" : r <= -1 ? "gap to stop" : "exit at next open", r: Math.round(r * 100) / 100, at: first.t };
  }
  let booked = 0, open = 1, stop = u.sl, t1 = false;
  const lastDay = c.horizon === "intraday" ? c.date : nextTradingDay(segOf, c.date, 3);
  for (const b of after) {
    const d = dayOf(b.t), m = minsOf(b.t);
    const end = squareOff(segOf, d) ?? toMins("15:15");
    if (d > lastDay || (d === lastDay && m + 5 > end)) {
      return { result: t1 ? "T1, rest closed at time" : "closed at time", r: Math.round((booked + open * R(b.o)) * 100) / 100, at: b.t };
    }
    const hitStop = dir > 0 ? b.l <= stop : b.h >= stop;
    if (hitStop) return { result: t1 ? "T1, rest at breakeven" : "stop-loss", r: Math.round((booked + open * R(stop)) * 100) / 100, at: b.t };
    if (!t1 && (dir > 0 ? b.h >= u.t1 : b.l <= u.t1)) { t1 = true; booked += 0.5 * R(u.t1); open = 0.5; stop = u.entry; }
    if (t1 && (dir > 0 ? b.h >= u.t2 : b.l <= u.t2)) return { result: "T2", r: Math.round((booked + open * R(u.t2)) * 100) / 100, at: b.t };
  }
  const end = squareOff(segOf, lastDay) ?? 0;
  if (today > lastDay || (today === lastDay && nowMin >= end)) {
    const last = after.at(-1);
    if (last) return { result: "closed at time", r: Math.round((booked + open * R(last.c)) * 100) / 100, at: last.t };
  }
  return null;
}

export async function trackCards(env: Env, t: IST, kinds: Inst["kind"][], todayBars?: Map<string, Bar[]>) {
  const since = new Date(Date.parse(t.date) - 6 * 86400e3).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare("SELECT json FROM cards WHERE date>=? AND status IN ('ENTER','TRACKING')").bind(since).all<{ json: string }>();
  const cards = results.map((r) => JSON.parse(r.json) as Card).filter((c) => c.entryAt && kinds.includes(c.kind));
  const byOpp = new Map<string, Card[]>();
  for (const c of cards) { const k = c.id.slice(0, c.id.lastIndexOf(":")); (byOpp.get(k) ?? byOpp.set(k, []).get(k)!).push(c); }
  const st = env.DB.prepare("INSERT OR REPLACE INTO cards(id,profile,date,status,score,json,updated) VALUES(?,?,?,?,?,?,?)");
  const os = env.DB.prepare("INSERT OR IGNORE INTO outcomes(id,date,agent,setup,root,horizon,structure,score,result,r) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const writes: D1PreparedStatement[] = [];
  const ledger: Parameters<typeof append>[1] = [];
  const barsCache = new Map<string, Bar[]>();
  for (const [opp, group] of byOpp) {
    const c = group[0];
    if (!barsCache.has(c.key)) {
      const past = await load5m(env, c.key, 8);
      const all = [...past.values()].flat();
      const tb = todayBars?.get(c.key) ?? [];
      barsCache.set(c.key, [...all.filter((b) => dayOf(b.t) < t.date), ...tb]);
    }
    const seg: Seg = c.kind === "COMMODITY" ? "MCX_COMM" : "NSE_FNO";
    const out = judge(c, barsCache.get(c.key)!, seg, t.mins, t.date);
    if (!out) continue;
    for (const g of group) {
      g.status = "DONE"; g.outcome = out; g.updatedAt = Date.now();
      writes.push(st.bind(g.id, g.profile, g.date, g.status, g.score, JSON.stringify(g), Date.now()));
    }
    writes.push(os.bind(opp, c.date, c.agent, c.setup, c.root, c.horizon, c.structure, c.score, out.result, out.r));
    if (group.some((g) => g.ledgered)) ledger.push({ kind: "OUTCOME" as const, ref: opp, data: { opp, agent: c.agent, setup: c.setup, root: c.root, horizon: c.horizon, score: c.score, result: out.result, r: out.r, at: out.at, calls: group.filter((g) => g.ledgered).map((g) => g.ledgered) } });
  }
  if (ledger.length) await append(env, ledger);
  for (let k = 0; k < writes.length; k += 50) await env.DB.batch(writes.slice(k, k + 50));
}
