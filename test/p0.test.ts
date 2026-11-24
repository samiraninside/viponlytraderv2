import assert from "node:assert/strict";
import { test } from "node:test";
import { ist, istEpoch } from "../src/calendar";
import type { Bar } from "../src/dhan";
import { chase, watch } from "../src/exits";
import { assess } from "../src/health";
import { type Entry, progress, stats, summary } from "../src/journal";
import { append, verify } from "../src/ledger";
import { CHECKS, publish } from "../src/publish";
import { fakeD1 } from "./fake";

const D = "2026-11-19";
const at = (m: number) => ist(istEpoch(D, m) * 1000);
const bar = (m: number, c: number, oi = 1000, v = 100): Bar => ({ t: istEpoch(D, m), o: c, h: c + 1, l: c - 1, c, v, oi });

test("ledger: chained appends, verify, and tamper detection (edit and delete)", async () => {
  const env: any = { DB: fakeD1() };
  const seqs = await append(env, [{ kind: "CALL", ref: "a", data: { x: 1 } }, { kind: "OUTCOME", ref: "a", data: { r: 1.5 } }, { kind: "KILL", ref: "manual", data: { on: true } }]);
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.deepEqual((await verify(env)).ok, true);
  await env.DB.prepare("UPDATE ledger SET json='{\"r\":3}' WHERE seq=2").run();
  assert.deepEqual(await verify(env).then((v) => [v.ok, v.brokenAt, v.reason]), [false, 2, "row content was changed"]);
  const env2: any = { DB: fakeD1() };
  await append(env2, [1, 2, 3].map((k) => ({ kind: "CALL" as const, ref: `c${k}`, data: { k } })));
  await env2.DB.prepare("DELETE FROM ledger WHERE seq=2").run();
  assert.deepEqual(await verify(env2).then((v) => [v.ok, v.brokenAt, v.reason]), [false, 2, "row missing"]);
});

test("data health: stale bars trip the check only after warm-up, quote failure always does", () => {
  const fresh = [bar(10 * 60, 1), bar(10 * 60, 1), bar(10 * 60, 1)];
  assert.equal(assess("NSE_FNO", at(10 * 60 + 5), fresh, []).ok, true);
  const stale = [bar(9 * 60 + 30, 1), bar(9 * 60 + 30, 1), bar(10 * 60, 1)];
  const h = assess("NSE_FNO", at(10 * 60 + 5), stale, []);
  assert.equal(h.ok, false); assert.match(h.reasons[0], /2 of 3 instruments/);
  assert.equal(assess("NSE_FNO", at(9 * 60 + 25), [undefined, undefined], []).ok, true, "inside the 20-minute warm-up");
  assert.equal(assess("NSE_FNO", at(9 * 60 + 25), [], ["quote: HTTP 500"]).ok, false);
  assert.equal(assess("NSE_FNO", at(16 * 60), stale, []).ok, true, "market closed: nothing to judge");
});

test("exit watch: stop and targets first, then reversal signals (1 = caution, 2+ = exit)", () => {
  const plan = { dir: 1 as const, sl: 95, t1: 110, t2: 120 };
  const up = Array.from({ length: 25 }, (_, k) => bar(9 * 60 + 15 + 5 * k, 100 + k * 0.2));
  assert.equal(watch(plan, up, 94).level, "STOP");
  assert.equal(watch(plan, up, 111).level, "T1");
  assert.equal(watch(plan, up, 111, { t1Done: true }).level, "OK", "T1 alerts once");
  assert.equal(watch(plan, up, 121).level, "T2");
  assert.equal(watch(plan, up, 104).level, "OK");
  assert.equal(watch(plan, up, 104, { oppositeEnter: true }).level, "CAUTION");
  // a sharp drop below VWAP and EMA20 with OI falling = several signals
  const drop = [...up, bar(11 * 60 + 20, 100, 900), bar(11 * 60 + 25, 99, 850), bar(11 * 60 + 30, 98, 800)];
  const w = watch(plan, drop, 98, { chainVerdict: -1, chainAtEntry: 1 });
  assert.equal(w.level, "EXIT");
  assert.ok(w.reasons.some((r) => /VWAP/.test(r)) && w.reasons.some((r) => /EMA20/.test(r)) && w.reasons.some((r) => /unwinding/.test(r)) && w.reasons.some((r) => /chain/.test(r)), w.reasons.join(" | "));
  // range trades exit only on a range breach
  assert.equal(watch({ dir: 0, sl: 0, t1: 0, t2: 0, range: [90, 110] }, up, 111).level, "EXIT");
  assert.equal(watch({ dir: 0, sl: 0, t1: 0, t2: 0, range: [90, 110] }, up, 100).level, "OK");
});

test("don't chase: flags entries price already ran away from", () => {
  assert.equal(chase(1, 100, 98, 100.8, 0.5, 0.25), null);
  assert.deepEqual(chase(1, 100, 98, 101.4, 0.5, 0.25), { movedR: 0.7, retestAt: 100.5 });
  assert.deepEqual(chase(-1, 100, 102, 98.6, 0.5, 0.25), { movedR: 0.7, retestAt: 99.5 });
});

const entry = (over: Partial<Entry>): Entry => ({
  id: "j1", cardId: "c", opp: "o", key: "NIFTY", root: "NIFTY", kind: "INDEX", profile: "mid", agent: "momentum", setup: "s", dir: 1, horizon: "intraday",
  structure: "long_option", label: "NIFTY CE", basis: "premium", unitsPerLot: 65,
  signal: { entry: 100, sl: 70, t1: 160, t2: 220, und: { entry: 24000, sl: 23900, t1: 24150, t2: 24300 }, score: 70, confirm: 1, maxLossPerLot: 2200 },
  undAtEntry: 24010, fills: [{ side: "in", lots: 1, price: 102, at: 1 }], status: "OPEN", created: 1, updated: 1, ...over,
});

test("journal maths: slippage, partial exits, R, credit trades, progress", () => {
  const e = entry({ fills: [{ side: "in", lots: 2, price: 102, at: 1 }, { side: "out", lots: 1, price: 160, at: 2 }] });
  const s = summary(e);
  assert.equal(s.openLots, 1);
  assert.equal(s.realised, Math.round((160 - 102) * 65));
  assert.deepEqual(s.slippage, { perUnit: 2, rupees: 260, pctOfRisk: 6 });       // paid 2 more than the signal: ₹260 of ₹4,160 planned risk (32 × 2 lots × 65)
  assert.equal(s.r, Math.round(((58 * 65) / (32 * 2 * 65)) * 100) / 100);
  // a credit spread: profit when the buy-back is cheaper
  const cr = summary(entry({ basis: "credit", dir: 0, signal: { ...e.signal, entry: 40, sl: 80, t1: 20, t2: 10 }, fills: [{ side: "in", lots: 1, price: 40, at: 1 }, { side: "out", lots: 1, price: 15, at: 2 }] }));
  assert.equal(cr.realised, 25 * 65);
  // a short future
  const sh = summary(entry({ basis: "underlying", dir: -1, unitsPerLot: 65, signal: { ...e.signal, entry: 24000, sl: 24100 }, fills: [{ side: "in", lots: 1, price: 24000, at: 1 }, { side: "out", lots: 1, price: 23800, at: 2 }] }));
  assert.equal(sh.realised, 200 * 65); assert.equal(sh.r, 2);
  const pr = progress(e, 24155)!;
  assert.equal(pr.pct, 50); assert.equal(pr.t2Pct, 100); assert.ok(pr.slPct < 0 && pr.t1Pct > 0 && pr.t1Pct < 100);
  const st = stats([{ ...e, status: "CLOSED", fills: [{ side: "in", lots: 1, price: 100, at: 1 }, { side: "out", lots: 1, price: 70, at: 2 }] }, entry({})]);
  assert.deepEqual([st.trades, st.open, st.winPct, st.avgR, st.lostMoreThanPlanned], [1, 1, 0, -1, 0]);
});

test("publish gate: personal mode never blocks, but flags banned wording", () => {
  const card: any = { trigger: "Sure-shot breakout, guaranteed", why: [], levels: { sl: 1 }, maxLoss: 100, structure: "long_option" };
  const g = publish(card);
  assert.equal(g.ok, true, "personal mode: requireCompliance is off");
  assert.ok(g.problems.length >= 1 && /banned wording/.test(g.problems[0]));
  assert.ok(CHECKS.length >= 3);
  assert.match(g.disclosure, /Not investment advice/);
});

test("1-lot money and the red row: a future whose 1-lot loss is over Mid's cap is shown red, never sized up", async () => {
  const { cardsFor } = await import("../src/engine/opportunities");
  const inst: any = { key: "RELIANCE", root: "RELIANCE", kind: "STOCK", lot: 500, pointValue: 500, fut: { expiry: "2026-11-24", lot: 500 } };
  const cand: any = { agent: "momentum", setup: "orb", dir: 1, horizon: "intraday", status: "ENTER", trigger: "t", entry: 1450, sl: 1438, t1: 1474, t2: 1486, why: [], validUntilMin: 900, structures: ["future"], rules: { kind: "directional" } };
  const e = (maxLoss: number): any => ({ n: 30, pWin: 0.6, avgWin: 1, avgLoss: 1, ev: 1500, maxLoss, worstCase: null, evR: 0.25, score: 70, thin: false, charges: 50 });
  const fut: any = { structure: "future", legs: [{ kind: "FUT", side: 1, price: 1450 }], label: "BUY RELIANCE FUT", net: 0, maxLossUnit: null, maxGainUnit: null, T: 0.01, r: 0.06 };
  const cards = cardsFor(inst, cand, [{ b: fut, e: e(6900), rules: cand.rules, S0: 1450, margin: 145000 }], "2026-11-19", 1);
  const mid = cards.find((c) => c.profile === "mid")!, big = cards.find((c) => c.profile === "big")!;
  assert.ok(mid.overCap && mid.lots === 1 && !mid.avg, "Mid: 1 lot loses ₹6,900 > ₹5,000 → red row, no averaging plan");
  assert.ok(!big.overCap && big.lots === 1, "Big: fits its ₹10,000 cap");
  assert.deepEqual(mid.perLot, { capital: 145000, risk: 6900, reward: (1486 - 1450) * 500 });
  assert.equal(cards.find((c) => c.profile === "basic"), undefined, "Basic never gets futures");
});
