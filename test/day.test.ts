/**
 * Full-day simulation: the real Worker code (scheduler, universe, history, agents, engine,
 * tracker, push, API) runs every 5 minutes from 08:00 to 23:45 IST against a fake Dhan API.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { istEpoch } from "../src/calendar";
import worker, { tick } from "../src/index";
import { ist } from "../src/calendar";
import { fakeD1, mockFetch } from "./fake";

const DAY = "2026-11-19";

test("a full trading day end to end", async () => {
  (globalThis as any).__DHAN_GAP_SCALE = 0;
  let nowS = istEpoch(DAY, 8 * 60);
  const realNow = Date.now;
  Date.now = () => nowS * 1000;
  mockFetch({ nowEpoch: () => nowS, breakoutDay: DAY });
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const pub = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
  const env: any = {
    DB: fakeD1(), ASSETS: { fetch: async () => new Response("asset") },
    DHAN_CLIENT_ID: "1000000001", DHAN_PIN: "123456", DHAN_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)),
    APP_PASSWORD: "pw",
  };
  const call = async (path: string, init: RequestInit = {}, cookie = "") =>
    worker.fetch(new Request("https://scanner.test" + path, { ...init, headers: { ...(init.headers ?? {}), Cookie: cookie } }), env, {} as any);

  // API is locked without login
  assert.equal((await call("/api/cards")).status, 401);
  const lr = await call("/api/login", { method: "POST", body: JSON.stringify({ password: "pw" }) });
  const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];

  // subscribe a fake push endpoint
  await call("/api/subscribe", { method: "POST", body: JSON.stringify({ subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: {} }, profile: "mid" }) }, cookie);

  // a custom scanner: your Scanner B text, saved through the website API
  const B = "[0] 5 minute Close > [0] 5 minute EMA(Close,20)\n[0] 5 minute Close > [0] 5 minute VWAP\n[0] 5 minute Close > [-1] 5 minute High\n[0] 5 minute Close > [0] 5 minute Open\n[0] 5 minute Volume > [-1] 5 minute SMA(Volume,20) * 1.5\n[0] 5 minute RSI(14) > 55";
  const bad: any = await (await call("/api/scanners", { method: "POST", body: JSON.stringify({ name: "typo", text: "[0] 5 minute Clsoe > 1" }) }, cookie)).json();
  assert.ok(bad.errors?.length, "syntax errors are reported, nothing saved");
  const saved: any = await (await call("/api/scanners", { method: "POST", body: JSON.stringify({ name: "My 5-min trigger", text: B, dir: 1, stop: "atr:1.5", targets: [1, 2] }) }, cookie)).json();
  assert.ok(saved.ok);
  const seen = new Map<string, any>();
  for (let m = 8 * 60; m <= 23 * 60 + 45; m += 5) {
    nowS = istEpoch(DAY, m);
    await tick(env, ist(nowS * 1000));
    if (m % 30 === 0 || (m >= 9 * 60 + 15 && m <= 10 * 60 + 30)) {
      for (const p of ["basic", "mid", "big"]) {
        const d: any = await (await call(`/api/cards?profile=${p}`, {}, cookie)).json();
        for (const c of [...d.top, ...d.open, ...d.done]) seen.set(c.id, c);
      }
    }
  }
  // scanner test button, Greeks, settings and the Dhan connection test, at 14:00
  nowS = istEpoch(DAY, 14 * 60);
  const tr: any = await (await call("/api/scanners/test", { method: "POST", body: JSON.stringify({ text: B, dir: 1 }) }, cookie)).json();
  console.log("scanner test", JSON.stringify(tr.rows?.slice(0, 4)));
  assert.equal(tr.mode, "intraday"); assert.ok(tr.rows.length === 4 && tr.rows.some((r: any) => r.n > 0), "history tested");
  const gk: any = await (await call("/api/greeks", {}, cookie)).json();
  assert.ok(gk.roots.NIFTY?.length >= 10, "NIFTY Greeks snapshots every 15 minutes");
  const g0 = gk.roots.NIFTY.at(-1).g;
  assert.ok(g0.callVega > 0 && g0.putVega > 0 && Math.abs(g0.vegaDiff - (g0.putVega - g0.callVega)) < 1e-6);
  const st: any = await (await call("/api/settings", {}, cookie)).json();
  assert.ok(st.dhan.clientId && st.dhan.totpSecret && st.dhan.tokenAgeMinutes !== null);
  const dt: any = await (await call("/api/dhan-test", { method: "POST" }, cookie)).json();
  assert.ok(dt.steps.every((s: any) => s.ok), JSON.stringify(dt.steps));
  Date.now = realNow;

  const status: any = await (await call("/api/status", {}, cookie)).json();
  assert.deepEqual(status.universe.sort(), ["BANKNIFTY", "CRUDEOIL", "NIFTY", "RELIANCE"]);
  for (const j of ["token", "universe", "history"]) assert.equal(status.jobs[j].error, null, `${j}: ${status.jobs[j].error}`);

  const cards = [...seen.values()];
  console.log(`cards seen: ${cards.length}`);
  const by = (k: string) => cards.reduce((a: any, c: any) => ((a[c[k]] = (a[c[k]] ?? 0) + 1), a), {});
  console.log("by agent", by("agent"), "\nby structure", by("structure"), "\nby profile", by("profile"), "\nby status", by("status"));
  assert.ok(cards.length > 0, "the day produced opportunities");
  assert.ok(cards.some((c) => c.agent === "momentum" && c.root === "NIFTY"), "NIFTY breakout found by the momentum agent");
  assert.ok(cards.some((c) => c.agent === "oiBuildup"), "OI build-up found on the breakout day");
  assert.ok(cards.some((c) => c.agent.startsWith("custom:") || (c.agents ?? []).some((a: string) => a.startsWith("custom:"))), "your saved scanner produced ideas");
  for (const c of cards) {
    assert.ok(c.lots >= 1 && c.score >= 0 && c.score <= 100);
    assert.ok(c.maxLoss > 0, `${c.id} has a max loss`);
    const prof = { basic: 2000, mid: 5000, big: 10000 }[c.profile as string]!;
    assert.ok(c.maxLoss <= prof * 1.001, `${c.id} max loss ${c.maxLoss} within the ${c.profile} risk ${prof}`);
    if (c.profile === "basic") assert.ok(["long_option", "debit_spread", "long_straddle"].includes(c.structure), `basic got ${c.structure}`);
    if (c.structure === "short_strangle") { assert.equal(c.profile, "big"); assert.ok(c.gapLoss > 0); }
    if (c.horizon !== "intraday") assert.notEqual(c.structure, "future", "no naked futures overnight");
  }
  const sample = cards.sort((a, b) => b.score - a.score)[0];
  console.log("top card:", JSON.stringify({ ...sample, rules: undefined, legs: sample.legs }, null, 1).slice(0, 1800));
  const perf: any = await (await call("/api/perf", {}, cookie)).json();
  console.log("perf", JSON.stringify(perf));
  const done = cards.filter((c) => c.status === "DONE");
  console.log(`DONE cards: ${done.length}`, done.slice(0, 4).map((c) => `${c.root} ${c.setup} ${c.outcome.result} ${c.outcome.r}R`));
  const board: any = await (await call("/api/cards?profile=big", {}, cookie)).json();
  assert.ok(board.hedges?.book?.[0]?.root === "NIFTY", "hedge optimizer read the NIFTY futures position");
  assert.ok(board.hedges.suggestions.big[0].ideas.length > 0, "hedge ideas proposed for a 10-lot naked long");
  const best = board.hedges.suggestions.big[0].ideas[0];
  assert.ok(best.worstAfter > best.worstBefore, `hedge reduces the stress loss: ${best.worstBefore} -> ${best.worstAfter}`);
  console.log("hedge", JSON.stringify(board.hedges.book[0]), JSON.stringify(best));
  const latest: any = await (await call("/api/push-latest", {}, cookie)).json();
  assert.ok(latest.title);
});
