import assert from "node:assert/strict";
import { test } from "node:test";
import { expiryDecay } from "../src/agents/selling";
import { swingFires } from "../src/agents/swing";
import { ist, istEpoch } from "../src/calendar";
import { confirmChain } from "../src/engine/confirm";
import { bs, parseChain } from "../src/engine/options";
import { bookGreeks, parsePosition } from "../src/hedge";

function chain(spot: number, T: number, putOi = 1, putAdd = 0) {
  const oc: Record<string, any> = {};
  for (let k = -10; k <= 10; k++) {
    const K = 24000 + k * 50;
    oc[`${K}.000000`] = {
      ce: { last_price: bs("CE", spot, K, T, 0.13, 0.06), implied_volatility: 13, oi: 100000, previous_oi: 100000, security_id: 1 },
      pe: { last_price: bs("PE", spot, K, T, 0.13, 0.06), implied_volatility: 13, oi: 100000 * putOi, previous_oi: 100000 * putOi - putAdd, security_id: 2 },
    };
  }
  return parseChain("NIFTY", "2026-11-24", { last_price: spot, oc }, T, 0.06);
}

test("swing screen: breakout, trend, RSI band, RS vs NIFTY, price and liquidity filters", () => {
  const mkDays = (n: number, px: (k: number) => number, vol = 3e6) => Array.from({ length: n }, (_, k) => {
    const d = new Date(Date.UTC(2025, 0, 1) + k * 86400e3).toISOString().slice(0, 10), c = px(k);
    return { d, t: 0, o: c * 0.995, h: c * 1.004, l: c * 0.99, c, v: vol };
  });
  // gentle uptrend, a 20-day base, then a breakout day on 2× volume
  const px = (k: number) => (k < 250 ? 400 + k * 0.8 : k < 279 ? 600 + (k % 2 ? 2 : -2) : 612);
  const d = mkDays(280, px); d[279].v = 6e6;
  const flatBench = new Map(d.map((b) => [b.d, 20000]));
  assert.ok(swingFires(d, 279, 1, flatBench, true), "fires on a liquid 20-day breakout that beats a flat NIFTY");
  const strongBench = new Map(d.map((b, k) => [b.d, 20000 * (1 + k * 0.01)]));
  assert.equal(swingFires(d, 279, 1, strongBench, true), false, "must outperform NIFTY over 20 sessions");
  const cheap = d.map((b) => ({ ...b, c: b.c / 10, o: b.o / 10, h: b.h / 10, l: b.l / 10, v: b.v * 10 }));
  assert.equal(swingFires(cheap, 279, 1, flatBench, true), false, "price ≥ ₹100");
  const thin = d.map((b) => ({ ...b, v: 1e5 })); thin[279].v = 2e5;
  assert.equal(swingFires(thin, 279, 1, flatBench, true), false, "20-day traded value ≥ ₹20 Cr");
  const quiet = d.map((b) => ({ ...b })); quiet[279].v = 3.2e6;
  assert.equal(swingFires(quiet, 279, 1, flatBench, true), false, "volume ≥ 1.5× average");
});

test("option chain confirmation: put writing + long build-up confirms a long, conflicts with a short", () => {
  const c = chain(24010, 5 / 365, 1.4, 30000);
  const up = confirmChain(c, 1, { pxChg: 0.006, oiChg: 0.04 }, 40);
  assert.equal(up.verdict, 1, JSON.stringify(up.votes));
  assert.equal(confirmChain(c, -1, { pxChg: 0.006, oiChg: 0.04 }, 40).verdict, -1);
});

test("expiry decay stands aside on a trend day", async () => {
  const today = "2026-11-24".replace("24", "26"); // Thursday 26 Nov 2026 used as an expiry day below
  const c = chain(24000, 4 / (365 * 24));
  c.expiry = today;
  const hist = new Map<string, any[]>();
  for (let n = 0; n < 40; n++) {
    const d = new Date(Date.UTC(2026, 8, 1) + n * 86400e3).toISOString().slice(0, 10);
    hist.set(d, Array.from({ length: 70 }, (_, k) => ({ t: istEpoch(d, 555 + k * 5), o: 24000, h: 24010, l: 23990, c: 24000 + (k % 3) - 1, v: 1 })));
  }
  const daily = Array.from({ length: 30 }, (_, k) => ({ d: `2026-10-${String(k + 1).padStart(2, "0")}`, t: 0, o: 24000, h: 24150, l: 23850, c: 24000, v: 1 }));
  const inst: any = { key: "NIFTY", root: "NIFTY", kind: "INDEX", fut: { seg: "NSE_FNO", expiry: today }, lot: 65 };
  const base: any = { inst, hist, daily, quote: null, prevClose: 24000, chain: async () => c, event: false, benchmark: [], ivRank: async () => null, now: ist(istEpoch(today, 630) * 1000) };
  const calm = await expiryDecay.scan({ ...base, today: [{ t: istEpoch(today, 555), o: 24000, h: 24010, l: 23990, c: 24005, v: 1 }], futPx: 24005 });
  const trend = await expiryDecay.scan({ ...base, today: [{ t: istEpoch(today, 555), o: 24000, h: 24300, l: 23990, c: 24290, v: 1 }], futPx: 24290 });
  assert.equal(trend.length, 0, "moved > 0.6× daily ATR from the open: no selling");
  assert.ok(calm.length === 0 || calm[0].structures.every((s) => s !== "short_strangle"), "defined risk only");
});

test("hedge optimizer: positions parsed, book delta right", () => {
  const inst: any = { root: "NIFTY", kind: "INDEX", lot: 65, pointValue: 65, fut: { expiry: "2026-12-29" } };
  const fut = parsePosition({ tradingSymbol: "NIFTY-Dec2026-FUT", exchangeSegment: "NSE_FNO", netQty: 130, drvExpiryDate: "2026-12-29", drvOptionType: null, drvStrikePrice: 0, costPrice: 24000 }, inst)!;
  const ce = parsePosition({ tradingSymbol: "NIFTY-Nov2026-24000-CE", exchangeSegment: "NSE_FNO", netQty: -65, drvExpiryDate: "0001-01-01", drvOptionType: null, drvStrikePrice: 0 }, inst)!;
  assert.equal(fut.kind, "FUT"); assert.equal(fut.units, 130);
  assert.equal(ce.kind, "CE"); assert.equal(ce.strike, 24000); assert.equal(ce.units, -65);
  assert.equal(parsePosition({ tradingSymbol: "TCS", exchangeSegment: "NSE_EQ", netQty: 10 }), null, "cash equity ignored");
  const c = chain(24000, 5 / 365);
  const g = bookGreeks([fut, { ...ce, expiry: "2026-11-24" }], c, ist(istEpoch("2026-11-19", 600) * 1000), false);
  assert.ok(g.delta > 130 - 65 * 0.6 && g.delta < 130 - 65 * 0.4, `delta ${g.delta}: 130 long futures minus ~0.5 × 65 short ATM call`);
  assert.ok(g.pnlDown < 0 && g.pnlUp > 0);
});

test("hero-zero: expiry-day coiled index → cheap OTM option, max loss = premium", async () => {
  const { heroZero } = await import("../src/agents/heroZero");
  const { scoreCandidate, cardsFor } = await import("../src/engine/opportunities");
  const day = "2026-11-19";
  const c = chain(24000, 8 / (365 * 24));   // a realistic expiry-day afternoon: OTM strikes still cost ₹5–20
  c.expiry = day;
  const hist = new Map<string, any[]>();
  for (let n = 0; n < 40; n++) {
    const d = new Date(Date.UTC(2026, 8, 1) + n * 86400e3).toISOString().slice(0, 10);
    const swing = n % 5 === 0 ? 0.004 : 0.0005;     // some afternoons break out hard
    hist.set(d, Array.from({ length: 75 }, (_, k) => { const px = 24000 * (1 + (k > 50 ? swing * (k - 50) / 10 : 0)); return { t: istEpoch(d, 555 + k * 5), o: px, h: px * 1.0003, l: px * 0.9997, c: px, v: 1 }; }));
  }
  const daily = Array.from({ length: 30 }, (_, k) => ({ d: `2026-10-${String(k + 1).padStart(2, "0")}`, t: 0, o: 24000, h: 24200, l: 23800, c: 24000, v: 1 }));
  const today = Array.from({ length: 50 }, (_, k) => ({ t: istEpoch(day, 555 + k * 5), o: 24000, h: 24030, l: 23980, c: 24000 + (k % 3), v: 1 }));
  const inst: any = { key: "NIFTY", root: "NIFTY", kind: "INDEX", fut: { seg: "NSE_FNO", expiry: day, id: "1" }, lot: 65, pointValue: 65 };
  const ctx: any = { inst, hist, daily, today, quote: null, prevClose: 24000, futPx: 24001, chain: async () => c, event: false, benchmark: [], ivRank: async () => null, now: ist(istEpoch(day, 14 * 60) * 1000) };
  const cands = await heroZero.scan(ctx);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].setup, "hero_zero_strangle");
  const scored = scoreCandidate(inst, cands[0], c, 24001);
  assert.ok(scored.length >= 1, "an OTM strangle in the premium range was built");
  for (const s of scored) {
    for (const l of s.b.legs) assert.ok(l.price >= 4 && l.price <= 25.2, `premium ${l.price} within ₹4–25`);
    assert.ok(Math.abs(s.e.worstCase! - (s.b.net * 65 + s.e.charges)) < 1, "worst case = premium + charges");
  }
  const cards = cardsFor(inst, cands[0], scored, day, 0);
  for (const k of cards) assert.ok(k.levels.t1 > k.levels.entry && k.levels.sl === 0);
});
