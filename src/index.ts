/** Worker entry: scheduler (every 5 minutes) + API + tablet app. */
import { ALL_AGENTS, activeAgents, isEnabled } from "./agents";
import { parseRule } from "./custom/dsl";
import { loadScanners, type ScannerDef } from "./custom/runner";
import { testScanner } from "./custom/test";
import { greeksToday } from "./greeks";
import { authorised, login } from "./auth";
import { type IST, isOpen, ist, mcxClose, NSE_HOLIDAYS, toMins, tradingDay, yearKnown } from "./calendar";
import { HEDGE, PROFILES, RANKING, SCHEDULE, SCORE } from "./config";
import { Dhan } from "./dhan";
import type { Card } from "./engine/opportunities";
import type { Env } from "./env";
import { refreshHistory } from "./history";
import { hedgeScan } from "./hedge";
import { pushOne } from "./push";
import { scan } from "./scan";
import { buildUniverse, getKv, loadUniverse, putKv, rankLiquidity } from "./universe";

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const inWin = (t: IST, [a, b]: [string, string]) => t.mins >= toMins(a) && t.mins <= toMins(b);

async function once(env: Env, t: IST, name: string, at: string, fn: () => Promise<unknown>) {
  if (t.mins < toMins(at)) return;
  const key = `job:${name}`;
  if ((await getKv<string>(env, key)) === t.date) return;
  await putKv(env, key, t.date);
  try { await fn(); } catch (e) { await putKv(env, `${key}:error`, `${t.date} ${t.hhmm} ${(e as Error).message}`); }
}

async function lock(env: Env): Promise<boolean> {
  const r = await env.DB.prepare("SELECT updated FROM kv WHERE key='lock'").first<{ updated: number }>();
  if (r && Date.now() - r.updated < 4.5 * 60e3) return false;
  await env.DB.prepare("INSERT OR REPLACE INTO kv(key,value,updated) VALUES('lock','1',?)").bind(Date.now()).run();
  return true;
}
const unlock = (env: Env) => env.DB.prepare("DELETE FROM kv WHERE key='lock'").run();

export async function tick(env: Env, t = ist()) {
  const nse = tradingDay("NSE_FNO", t.date), mcx = tradingDay("MCX_COMM", t.date);
  if (!nse && !mcx) return;
  if (!(await lock(env))) return;
  try {
    const dhan = new Dhan(env);
    await once(env, t, "token", SCHEDULE.tokenRefresh, () => dhan.refreshToken());
    await once(env, t, "universe", SCHEDULE.universe, async () => { await dhan.init(); await buildUniverse(env, dhan, t.date); });
    await once(env, t, "history", SCHEDULE.history, async () => { await dhan.init(); await refreshHistory(env, dhan, await loadUniverse(env), t.date); });
    if (nse && t.mins >= toMins(SCHEDULE.preopen) && t.mins < toMins(SCHEDULE.preopen) + 5)
      await scan(env, t, ["preopen"], ["INDEX", "STOCK"]);
    else if (nse && inWin(t, SCHEDULE.nseCycle)) {
      const runs: ("cycle" | "btst")[] = ["cycle"];
      if (inWin(t, SCHEDULE.btst)) runs.push("btst");
      await scan(env, t, runs, ["INDEX", "STOCK"]);
    }
    if (mcx && isOpen("MCX_COMM", t) && inWin(t, SCHEDULE.mcxCycle)) await scan(env, t, ["mcx"], ["COMMODITY"]);
    const nseOpen = nse && isOpen("NSE_FNO", t), mcxOpen = mcx && isOpen("MCX_COMM", t);
    if ((nseOpen || mcxOpen) && t.mins % HEDGE.everyMinutes < 5) {
      await dhan.init();
      await hedgeScan(env, dhan, t).catch((e) => putKv(env, "hedges_error", `${t.hhmm} ${(e as Error).message}`));
    }
    if (nse) await once(env, t, "liquidity", SCHEDULE.liquidity, async () => { await dhan.init(); await rankLiquidity(env, dhan); });
  } finally {
    await unlock(env);
  }
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  if (p === "/api/login" && req.method === "POST") return login(req, env);
  if (p === "/api/vapid") return json({ key: env.VAPID_PUBLIC_KEY ?? null });
  if (!(await authorised(req, env))) return json({ error: "login" }, 401);
  const t = ist();
  if (p === "/api/cards") {
    const profile = url.searchParams.get("profile") ?? "basic";
    const { results } = await env.DB.prepare("SELECT json FROM cards WHERE profile=? AND date>=? ORDER BY score DESC")
      .bind(profile, new Date(Date.parse(t.date) - 5 * 86400e3).toISOString().slice(0, 10)).all<{ json: string }>();
    const all = results.map((r) => JSON.parse(r.json) as Card);
    const live = all.filter((c) => c.date === t.date && (c.status === "ENTER" || c.status === "WAIT") && c.score >= SCORE.minShow && c.ev > 0);
    live.sort((a, b) => (b.rank ?? b.score) - (a.rank ?? a.score));
    // diversity: at most N cards per underlying
    const per = new Map<string, number>();
    const top = live.filter((c) => { const n = (per.get(c.root) ?? 0) + 1; per.set(c.root, n); return n <= RANKING.maxPerUnderlying; });
    const open = all.filter((c) => c.status === "TRACKING" || (c.status === "ENTER" && c.horizon !== "intraday" && c.date < t.date));
    const done = all.filter((c) => c.status === "DONE" && c.date === t.date);
    return json({
      now: `${t.date} ${t.hhmm}`, profile, profiles: PROFILES.map(({ id, label, capital, riskPerTrade }) => ({ id, label, capital, riskPerTrade })),
      market: {
        nse: isOpen("NSE_FNO", t) ? "open" : NSE_HOLIDAYS[t.date] ?? "closed",
        mcx: isOpen("MCX_COMM", t) ? `open till ${Math.floor(mcxClose(t.date) / 60)}:${String(mcxClose(t.date) % 60).padStart(2, "0")}` : "closed",
        calendarKnown: yearKnown(t.date),
      },
      top: top.slice(0, SCORE.topN), open, done, hedges: await getKv(env, "hedges"), hedgesError: await getKv(env, "hedges_error"),
      lastRun: { nse: await getKv(env, "last_run:INDEX,STOCK"), mcx: await getKv(env, "last_run:COMMODITY") },
    });
  }
  if (p === "/api/perf") {
    const since = new Date(Date.parse(t.date) - 30 * 86400e3).toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      "SELECT agent, horizon, COUNT(*) n, SUM(CASE WHEN r>0 THEN 1 ELSE 0 END) wins, ROUND(AVG(r),2) avgR, ROUND(AVG(score),0) avgScore FROM outcomes WHERE date>=? GROUP BY agent, horizon ORDER BY n DESC").bind(since).all();
    const { results: bands } = await env.DB.prepare(
      "SELECT CASE WHEN score>=80 THEN '80+' WHEN score>=65 THEN '65-79' ELSE '<65' END band, COUNT(*) n, ROUND(AVG(r),2) avgR, SUM(CASE WHEN r>0 THEN 1 ELSE 0 END) wins FROM outcomes WHERE date>=? GROUP BY band").bind(since).all();
    return json({ since, byAgent: results, byScore: bands });
  }
  if (p === "/api/subscribe" && req.method === "POST") {
    const { subscription, profile } = (await req.json()) as any;
    if (!subscription?.endpoint) return json({ error: "bad subscription" }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO subs(endpoint,json,profile,created) VALUES(?,?,?,?)")
      .bind(subscription.endpoint, JSON.stringify(subscription), profile ?? "basic", Date.now()).run();
    return json({ ok: true });
  }
  if (p === "/api/test-push" && req.method === "POST") {
    const subs = (await env.DB.prepare("SELECT endpoint FROM subs").all<{ endpoint: string }>()).results;
    await putKv(env, "test_push", Date.now());
    const codes = await Promise.all(subs.map((s) => pushOne(env, s.endpoint).catch(() => 0)));
    return json({ sent: codes });
  }
  if (p === "/api/push-latest") {
    const test = await getKv<number>(env, "test_push");
    const r = await env.DB.prepare("SELECT json FROM cards WHERE date=? AND status='ENTER' ORDER BY updated DESC, score DESC LIMIT 1").bind(t.date).first<{ json: string }>();
    if (test && Date.now() - test < 120e3) { await putKv(env, "test_push", 0); return json({ title: "VIPONLYTRADER", body: "Test notification: alerts are working." }); }
    if (!r) return json({ title: "VIPONLYTRADER", body: "New opportunities are on the board." });
    const c = JSON.parse(r.json) as Card;
    return json({ title: `${c.status} · ${c.root} · score ${c.score}`, body: `${c.label}\n${c.trigger}`, tag: c.id });
  }
  if (p === "/api/run" && req.method === "POST") {
    const job = url.searchParams.get("job");
    const dhan = new Dhan(env);
    if (job === "token") { await dhan.refreshToken(); return json({ ok: true }); }
    await dhan.init();
    if (job === "universe") return json({ instruments: (await buildUniverse(env, dhan, t.date)).length });
    if (job === "history") { await refreshHistory(env, dhan, await loadUniverse(env), t.date); return json({ ok: true, calls: dhan.calls }); }
    if (job === "liquidity") return json({ top: (await rankLiquidity(env, dhan)).slice(0, 50) });
    if (job === "scan") {
      const kinds = (url.searchParams.get("kinds") ?? "INDEX,STOCK").split(",") as any;
      const runs = (url.searchParams.get("runs") ?? "cycle").split(",") as any;
      return json(await scan(env, t, runs, kinds));
    }
    return json({ error: "job must be token|universe|history|liquidity|scan" }, 400);
  }
  if (p === "/api/greeks") return json({ now: `${t.date} ${t.hhmm}`, roots: await greeksToday(env, url.searchParams.get("date") ?? t.date) });

  if (p === "/api/scanners" && req.method === "GET") {
    const overrides = (await getKv<Record<string, boolean>>(env, "agent_overrides")) ?? {};
    return json({ builtin: ALL_AGENTS.map((a) => ({ name: a.name, runs: a.runs, enabled: isEnabled(a.name, overrides) })), custom: await loadScanners(env) });
  }
  if (p === "/api/scanners" && req.method === "POST") {
    const d = (await req.json()) as Partial<ScannerDef>;
    if (!d.name?.trim() || !d.text?.trim()) return json({ error: "name and rules are required" }, 400);
    const { errors } = parseRule(d.text);
    if (errors.length) return json({ errors }, 400);
    const def: ScannerDef = {
      id: d.id || crypto.randomUUID().slice(0, 8), name: d.name.trim().slice(0, 60), text: d.text, enabled: d.enabled !== false,
      kinds: d.kinds?.length ? d.kinds : ["INDEX", "STOCK", "COMMODITY"], dir: d.dir === -1 ? -1 : 1,
      stop: /^(atr|pct|swing):\d+(\.\d+)?$/.test(d.stop ?? "") ? d.stop! : "atr:1.5",
      targets: (d.targets ?? [1, 2, 3]).map(Number).filter((x) => x > 0).slice(0, 3), structures: d.structures, holdDays: d.holdDays ?? 3,
      created: d.created ?? Date.now(),
    };
    await env.DB.prepare("INSERT OR REPLACE INTO scanners(id,json,created) VALUES(?,?,?)").bind(def.id, JSON.stringify(def), def.created).run();
    return json({ ok: true, scanner: def });
  }
  if (p === "/api/scanners" && req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM scanners WHERE id=?").bind(url.searchParams.get("id")).run();
    return json({ ok: true });
  }
  if (p === "/api/scanners/parse" && req.method === "POST") {
    const { text } = (await req.json()) as { text: string };
    const r = parseRule(text ?? "");
    return json({ errors: r.errors, conditions: r.rule?.conds.map((c) => c.text) ?? [], logic: r.rule?.mode, timeframes: r.rule?.tfs });
  }
  if (p === "/api/scanners/test" && req.method === "POST") {
    const d = (await req.json()) as Partial<ScannerDef>;
    const def: ScannerDef = { id: "test", name: d.name ?? "test", text: d.text ?? "", enabled: true, targets: d.targets?.length ? d.targets : [1, 2, 3],
      stop: d.stop || "atr:1.5", kinds: d.kinds?.length ? d.kinds : ["INDEX", "STOCK", "COMMODITY"], dir: d.dir === -1 ? -1 : 1, holdDays: d.holdDays ?? 3 };
    return json(await testScanner(env, def, t));
  }
  if (p === "/api/agents" && req.method === "POST") {
    const { name, enabled } = (await req.json()) as { name: string; enabled: boolean };
    const o = (await getKv<Record<string, boolean>>(env, "agent_overrides")) ?? {};
    o[name] = !!enabled;
    await putKv(env, "agent_overrides", o);
    return json({ ok: true, overrides: o });
  }
  if (p === "/api/settings") {
    const tok = await env.DB.prepare("SELECT updated FROM kv WHERE key='dhan_token'").first<{ updated: number }>();
    return json({
      dhan: { clientId: !!env.DHAN_CLIENT_ID, pin: !!env.DHAN_PIN, totpSecret: !!env.DHAN_TOTP_SECRET,
        tokenAgeMinutes: tok ? Math.round((Date.now() - tok.updated) / 60000) : null, lastTokenError: await getKv(env, "job:token:error") },
      push: { vapid: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK) },
      login: env.ACCESS_TEAM_DOMAIN ? "Cloudflare Access" : env.APP_PASSWORD ? "password" : "not configured",
      universe: (await loadUniverse(env)).length,
    });
  }
  if (p === "/api/dhan-test" && req.method === "POST") {
    const steps: { step: string; ok: boolean; detail: string }[] = [];
    const dhan = new Dhan(env);
    try { await dhan.refreshToken(); steps.push({ step: "login with PIN + TOTP", ok: true, detail: "access token received" }); }
    catch (e) { steps.push({ step: "login with PIN + TOTP", ok: false, detail: (e as Error).message }); return json({ steps }); }
    try {
      const q = await dhan.quote({ IDX_I: ["13"] });
      const px = q["IDX_I:13"]?.last_price;
      steps.push({ step: "market quote (Data API)", ok: !!px, detail: px ? `NIFTY ${px}` : "no price returned: is the Data API subscription active?" });
    } catch (e) { steps.push({ step: "market quote (Data API)", ok: false, detail: (e as Error).message }); }
    try {
      const pos = await dhan.positions();
      steps.push({ step: "positions (read-only)", ok: true, detail: `${pos.length} positions` });
    } catch (e) { steps.push({ step: "positions (read-only)", ok: false, detail: (e as Error).message }); }
    return json({ steps });
  }
  if (p === "/api/status") {
    const jobs: Record<string, unknown> = {};
    for (const j of ["token", "universe", "history", "liquidity"]) jobs[j] = { last: await getKv(env, `job:${j}`), error: await getKv(env, `job:${j}:error`) };
    return json({ now: `${t.date} ${t.hhmm}`, jobs, agents: activeAgents("cycle").map((a) => a.name), universe: (await loadUniverse(env)).map((i) => i.key) });
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); } catch (e) { return json({ error: (e as Error).message }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env));
  },
} satisfies ExportedHandler<Env>;
