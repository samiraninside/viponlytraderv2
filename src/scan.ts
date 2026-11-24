/** One scan run: data → agents → scored cards per profile → D1 → tracking → push. */
import { activeAgents } from "./agents";
import { loadScanners, makeCustomAgent } from "./custom/runner";
import { snapshotGreeks } from "./greeks";
import type { Agent, Candidate, Ctx } from "./agents/types";
import { addDays, type IST, istEpoch, toMins, tradingDaysBetween, type Seg } from "./calendar";
import { CHASE, EVENTS, FILTERS, RANKING, SCORE } from "./config";
import { confirmChain } from "./engine/confirm";
import { type Bar, Dhan } from "./dhan";
import { type Card, cardsFor, scoreCandidate } from "./engine/opportunities";
import { type Chain, parseChain } from "./engine/options";
import type { Env } from "./env";
import { dayOf, load5m, loadDaily } from "./history";
import { chase, watch } from "./exits";
import { assess, blockReason, record, type Segment } from "./health";
import { type Entry, openEntries } from "./journal";
import { append } from "./ledger";
import { publish } from "./publish";
import { pushAll, sendPushes } from "./push";
import { trackCards } from "./tracker";
import { getKv, type Inst, loadUniverse, putKv } from "./universe";

type Run = Agent["runs"][number];
const YEAR_S = 365 * 86400;

export interface RunReport { runs: Run[]; at: string; instruments: number; candidates: number; cards: number; calls: number; errors: string[]; ms: number }

export async function scan(env: Env, t: IST, runs: Run[], kinds: Inst["kind"][]): Promise<RunReport> {
  const t0 = Date.now(), errors: string[] = [];
  const dhan = new Dhan(env);
  await dhan.init();
  const insts = (await loadUniverse(env)).filter((i) => kinds.includes(i.kind));
  const overrides = (await getKv<Record<string, boolean>>(env, "agent_overrides")) ?? {};
  const custom = (await loadScanners(env)).filter((s) => s.enabled).map(makeCustomAgent).filter((a): a is Agent => !!a);
  const agents = [...new Set(runs.flatMap((r) => activeAgents(r, overrides, custom)))];
  const report: RunReport = { runs, at: `${t.date} ${t.hhmm}`, instruments: insts.length, candidates: 0, cards: 0, calls: 0, errors, ms: 0 };
  if (!insts.length || !agents.length) return report;

  // quotes for every future in one call
  const bySeg: Record<string, string[]> = {};
  for (const i of insts) (bySeg[i.fut.seg] ??= []).push(i.fut.id);
  let quotes: Record<string, any> = {};
  try { quotes = await dhan.quote(bySeg); } catch (e) { errors.push(`quote: ${(e as Error).message}`); }

  const benchmark = await loadDaily(env, "NIFTY");
  const ivRank = async (root: string, c: Chain) => {
    await env.DB.prepare("INSERT OR REPLACE INTO ivhist(key,day,iv) VALUES(?,?,?)").bind(root, t.date, c.atmIv).run();
    const { results } = await env.DB.prepare("SELECT iv FROM ivhist WHERE key=? ORDER BY day DESC LIMIT 252").bind(root).all<{ iv: number }>();
    if (results.length < 20) return null;
    const ivs = results.map((r) => r.iv), lo = Math.min(...ivs), hi = Math.max(...ivs);
    return hi > lo ? ((c.atmIv - lo) / (hi - lo)) * 100 : 50;
  };
  const cards: Card[] = [];
  const todayBars = new Map<string, Bar[]>();
  const lastBars: (Bar | undefined)[] = [];
  const lastPx: Record<string, { px: number; at: string }> = (await getKv(env, "lastpx")) ?? {};
  const journaled = (await openEntries(env)).filter((e) => insts.some((i) => i.key === e.key));
  const watched: Entry[] = [];
  let chainCalls = 0;
  for (const i of insts) {
    try {
      const q = quotes[`${i.fut.seg}:${i.fut.id}`] ?? null;
      let today: Bar[] = [];
      if (runs.some((r) => r !== "preopen")) {
        today = await dhan.intraday(i.fut.id, i.fut.seg, i.fut.instrument, 5, t.date, addDays(t.date, 1), true);
        today = today.filter((b) => dayOf(b.t) === t.date && b.t + 300 <= t.epoch / 1000);
        todayBars.set(i.key, today);
      }
      const hist = await load5m(env, i.key, 60);
      const daily = await loadDaily(env, i.key);
      const prevClose = +(q?.ohlc?.close || 0) || [...hist.values()].at(-1)?.at(-1)?.c || daily.at(-1)?.c || 0;
      const futPx = +(q?.last_price || 0) || today.at(-1)?.c || prevClose;
      if (!futPx) continue;
      if (runs.some((r) => r !== "preopen")) lastBars.push(today.at(-1));
      lastPx[i.key] = { px: futPx, at: `${t.date} ${t.hhmm}` };
      const chains = new Map<number, Chain | null>();
      const getChain = async (minDays: number) => {
        if (chains.has(minDays)) return chains.get(minDays)!;
        if (chainCalls >= 30) return null;
        let exps = await getKv<string[]>(env, `exp:${i.root}:${t.date}`);
        if (!exps) { chainCalls++; exps = await dhan.expiries(i.chain.scrip, i.chain.seg); await putKv(env, `exp:${i.root}:${t.date}`, exps); }
        const seg = i.fut.seg as Seg;
        const exp = exps.find((e) => e >= t.date && tradingDaysBetween(seg, t.date, e) >= minDays && !(e === t.date && t.mins > toMins("14:30")));
        if (!exp) { chains.set(minDays, null); return null; }
        chainCalls++;
        const data = await dhan.chain(i.chain.scrip, i.chain.seg, exp);
        const expMin = i.kind === "COMMODITY" ? toMins("23:30") : toMins("15:30");
        const T = Math.max(60, istEpoch(exp, expMin) - t.epoch / 1000) / YEAR_S;
        const c = parseChain(i.root, exp, data, T, i.kind === "COMMODITY" ? 0 : 0.06);
        chains.set(minDays, c);
        return c;
      };
      const ctx: Ctx = {
        now: t, inst: i, today, hist, daily, quote: q, futPx, prevClose, chain: getChain,
        event: EVENTS.some((e) => e === `ALL:${t.date}` || e === `${i.root}:${t.date}`),
        benchmark, ivRank: (c) => ivRank(i.root, c),
      };
      // Greeks watch: every 15 minutes for indices and crude
      if ((i.kind === "INDEX" || i.kind === "COMMODITY") && t.mins % 15 < 5 && !runs.includes("preopen")) {
        try { const gc = await getChain(0); if (gc) await snapshotGreeks(env, i.root, gc, t); } catch (e) { errors.push(`greeks ${i.key}: ${(e as Error).message}`); }
      }
      const cands: Candidate[] = [];
      for (const a of agents) {
        try { cands.push(...(await a.scan(ctx))); } catch (e) { errors.push(`${a.name} ${i.key}: ${(e as Error).message}`); }
      }
      report.candidates += cands.length;
      // stress move for naked selling: the largest overnight gap of the last year (min 2% index / 3% others)
      const gaps = daily.slice(-250).map((b, k, arr) => (k ? Math.abs(b.o / arr[k - 1].c - 1) : 0));
      const gapMove = Math.max(i.kind === "INDEX" ? 0.02 : 0.03, ...gaps);
      // stock filters: price and liquidity (20-day average traded value)
      const tv20 = daily.slice(-20).reduce((a, b) => a + b.c * b.v, 0) / Math.max(1, Math.min(20, daily.length));
      const stockOk = i.kind !== "STOCK" || (futPx >= FILTERS.stockMinPrice && tv20 >= FILTERS.stockMinTradedValueCr * 1e7);
      const prevOi = [...hist.values()].at(-1)?.at(-1)?.oi;
      const curOi = +(q?.oi || 0) || today.at(-1)?.oi;
      const fut = { pxChg: prevClose ? futPx / prevClose - 1 : 0, oiChg: prevOi && curOi ? curOi / prevOi - 1 : null };
      for (const cand of cands) {
        if (!cand.paths.length) continue;
        if (cand.dir !== 0 && cand.rules.kind === "directional") {
          if (!stockOk) continue;
          const rr = Math.abs(cand.t2 - cand.entry) / Math.abs(cand.entry - cand.sl);
          if (!(rr >= FILTERS.minRewardRisk - 1e-9)) continue;
        }
        const needsChain = cand.structures.some((s) => s !== "future");
        const c = needsChain ? await getChain(cand.minDaysToExpiry) : null;
        const scored = scoreCandidate(i, cand, c, futPx);
        const made = cardsFor(i, cand, scored, t.date, Date.now(), gapMove);
        if (cand.dir !== 0 && cand.status === "ENTER") {
          const ch = chase(cand.dir, cand.entry, cand.sl, futPx, CHASE.maxR, CHASE.retestR);
          if (ch) for (const m of made) { m.chase = ch; m.trigger = `Don't chase: price is ${ch.movedR}R past entry. Wait for a retracement towards ${ch.retestAt}. ${m.trigger}`; }
        }
        if (c && cand.dir !== 0 && cand.rules.kind === "directional") {
          const conf = confirmChain(c, cand.dir as 1 | -1, fut, await ivRank(i.root, c));
          for (const m of made) m.confirm = conf;
        }
        cards.push(...made);
      }
      // exit watch on the trades you journaled for this instrument
      for (const e of journaled.filter((x) => x.key === i.key)) {
        const opposite = cards.some((c) => c.key === i.key && c.status === "ENTER" && e.dir !== 0 && c.dir === -e.dir);
        let verdict: number | null = null;
        if (e.dir !== 0 && e.structure !== "future") {
          const ch = await getChain(0).catch(() => null);
          if (ch) verdict = confirmChain(ch, e.dir as 1 | -1, fut, null).verdict;
        }
        const t1Done = (e.watch?.alerted ?? []).includes("T1");
        const w = watch({ dir: e.dir, ...e.signal.und, range: e.signal.range }, today, futPx, { oppositeEnter: opposite, chainVerdict: verdict, chainAtEntry: e.signal.confirm, t1Done });
        e.watch = { ...w, alerted: e.watch?.alerted ?? [] };
        watched.push(e);
      }
    } catch (e) {
      errors.push(`${i.key}: ${(e as Error).message}`);
    }
  }
  report.calls = dhan.calls;
  // Better Opportunity Finder: one card per profile + instrument + direction + (intraday | overnight),
  // the best-scoring one, credited with every agent that agreed; rank = score + chain + confluence.
  const groups = new Map<string, Card[]>();
  for (const c of cards) {
    const k = `${c.profile}:${c.key}:${c.dir}:${c.horizon === "intraday" ? "i" : "o"}:${c.dir === 0 ? c.structure : ""}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  const kept: Card[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => b.score - a.score);
    const best = g[0];
    const agents = [...new Set(g.filter((c) => c.score >= SCORE.minShow || c === best).map((c) => c.agent))];
    best.agents = agents;
    const conf = best.confirm?.verdict ?? 0;
    best.rank = best.score + RANKING.chainConfirm * conf + Math.min(RANKING.maxConfluence, RANKING.perExtraAgent * (agents.length - 1));
    if (agents.length > 1) best.why = [...best.why, `also flagged by: ${agents.filter((a) => a !== best.agent).join(", ")}`];
    kept.push(best);
  }
  // data health → kill switch for new ENTERs
  const segment: Segment = kinds.includes("COMMODITY") ? "MCX" : "NSE";
  const health = assess(segment === "MCX" ? "MCX_COMM" : "NSE_FNO", t, lastBars, errors);
  await record(env, segment, health);
  const block = await blockReason(env, segment, health);
  await putKv(env, "lastpx", lastPx);
  await saveCards(env, kept, t, kinds, block, errors);
  await exitAlerts(env, watched, t).catch((e) => errors.push(`exits: ${(e as Error).message}`));
  await trackCards(env, t, kinds, todayBars);
  await sendPushes(env, t).catch((e) => errors.push(`push: ${(e as Error).message}`));
  report.ms = Date.now() - t0;
  await putKv(env, `last_run:${kinds.join(",")}`, report);
  return report;
}

/** Store each journaled trade's exit watch; push when it reaches STOP / T1 / T2 / EXIT (once each). */
async function exitAlerts(env: Env, watched: Entry[], t: IST) {
  const st = env.DB.prepare("UPDATE journal SET json=?, updated=? WHERE id=? AND status='OPEN'");
  const msgs: { title: string; body: string; tag: string }[] = [];
  for (const e of watched) {
    const w = e.watch!;
    if (w.level !== "OK" && w.level !== "CAUTION" && !w.alerted!.includes(w.level)) {
      w.alerted!.push(w.level);
      msgs.push({ title: `${w.level === "STOP" ? "STOP-LOSS" : w.level} · ${e.root} · your trade`, body: `${e.label}\n${w.reasons.join("; ")}`, tag: `exit:${e.id}:${w.level}` });
    }
    await st.bind(JSON.stringify(e), Date.now(), e.id).run();
  }
  if (msgs.length) await pushAll(env, t, msgs);
}

async function saveCards(env: Env, fresh: Card[], t: IST, kinds: Inst["kind"][], block: string | null = null, errors: string[] = []) {
  const { results } = await env.DB.prepare("SELECT id, json FROM cards WHERE date=?").bind(t.date).all<{ id: string; json: string }>();
  const old = new Map(results.map((r) => [r.id, JSON.parse(r.json) as Card]));
  const st = env.DB.prepare("INSERT OR REPLACE INTO cards(id,profile,date,status,score,json,updated) VALUES(?,?,?,?,?,?,?)");
  const writes: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const c of fresh) {
    seen.add(c.id);
    const o = old.get(c.id);
    if (o && (o.status === "TRACKING" || o.status === "DONE")) continue;   // already entered: tracker owns it
    if (o) { c.createdAt = o.createdAt; c.pushed = o.pushed; c.ledgered = o.ledgered; if (o.entryAt && c.status === "ENTER") c.entryAt = o.entryAt; }
    const alreadyLive = o?.status === "ENTER";
    // kill switch: no NEW ENTER while data is unhealthy or you switched it off (published calls keep tracking)
    if (c.status === "ENTER" && !alreadyLive && block) {
      c.status = "WAIT"; c.blocked = block; c.entryAt = undefined; c.trigger = `Held: ${block}. ${c.trigger}`;
    }
    // publish: the first time a board-quality ENTER appears, it goes through the publish gate into the ledger
    if (c.status === "ENTER" && !c.ledgered && c.score >= SCORE.minShow && c.ev > 0) {
      const g = publish(c);
      c.disclosure = g.disclosure;
      if (!g.ok) { c.status = "WAIT"; c.blocked = `compliance: ${g.problems.join(", ")}`; c.entryAt = undefined; }
      else {
        try {
          const [seq] = await append(env, [{ kind: "CALL", ref: c.id, data: callRecord(c, t, g.problems) }]);
          c.ledgered = seq;
        } catch (e) { errors.push(`ledger: ${(e as Error).message}`); }
      }
    }
    writes.push(st.bind(c.id, c.profile, c.date, c.status, c.score, JSON.stringify(c), Date.now()));
  }
  // cards not refreshed this run
  for (const [id, o] of old) {
    if (seen.has(id) || !kinds.includes(o.kind)) continue;
    if (o.status === "ENTER") { o.status = "TRACKING"; }
    else if (o.status === "WAIT" && t.mins > o.validUntilMin) o.status = "EXPIRED";
    else continue;
    o.updatedAt = Date.now();
    writes.push(st.bind(o.id, o.profile, o.date, o.status, o.score, JSON.stringify(o), Date.now()));
  }
  for (let k = 0; k < writes.length; k += 50) await env.DB.batch(writes.slice(k, k + 50));
}

/** What the ledger keeps for each published call: enough to judge it later without the cards table. */
export function callRecord(c: Card, t: IST, notes: string[] = []) {
  return {
    opp: c.id.slice(0, c.id.lastIndexOf(":")), cardId: c.id, profile: c.profile, publishedAt: `${t.date} ${t.hhmm}`,
    root: c.root, key: c.key, kind: c.kind, agent: c.agent, agents: c.agents ?? [c.agent], setup: c.setup, dir: c.dir, horizon: c.horizon,
    structure: c.structure, label: c.label, expiry: c.expiry, legs: c.legs, levels: c.levels, underlying: c.underlying, range: c.range, exitBy: c.exitBy,
    lots: c.lots, perLot: c.perLot, maxLoss: c.maxLoss, ev: c.ev, evR: c.maxLoss ? Math.round((c.ev / c.maxLoss) * 100) / 100 : 0,
    pWin: c.pWin, n: c.n, score: c.score, rank: c.rank, confirm: c.confirm?.verdict ?? null, trigger: c.trigger,
    chase: c.chase ?? null, overCap: !!c.overCap, notes,
  };
}

export const PUSH_SCORE = SCORE.pushAt;
