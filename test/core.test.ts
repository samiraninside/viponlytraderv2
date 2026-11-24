import assert from "node:assert/strict";
import { test } from "node:test";
import { ist, istEpoch, mcxClose, sessions, squareOff, tradingDaysBetween } from "../src/calendar";
import { totp } from "../src/dhan";
import { evaluate, type Path } from "../src/engine/evaluate";
import { bs, parseChain } from "../src/engine/options";
import { build, chargesPerLot } from "../src/engine/structures";
import { judge } from "../src/tracker";
import { readRows, splitCsv, type Inst } from "../src/universe";
import { instrumentCsv } from "./fake";

test("TOTP matches RFC 6238 test vector", async () => {
  // secret "12345678901234567890" in base32; T=59s -> 94287082 (8 digits)
  assert.equal(await totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000, 30, 8), "94287082");
  assert.equal(await totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1111111109_000, 30, 8), "07081804");
});

test("calendar: holidays, F&O close phases, MCX DST, partial holidays", () => {
  assert.deepEqual(sessions("NSE_FNO", "2026-11-24"), []);
  assert.equal(sessions("NSE_FNO", "2026-07-31")[0].end, 15 * 60 + 30);
  assert.equal(sessions("NSE_FNO", "2026-11-19")[0].end, 15 * 60 + 40);
  assert.equal(sessions("NSE_FNO", "2026-12-08")[0].end, 15 * 60 + 45);
  assert.equal(sessions("NSE_FNO", "2026-12-08", { expiringIndex: true })[0].end, 15 * 60 + 30);
  assert.equal(mcxClose("2026-10-30"), 23 * 60 + 30);
  assert.equal(mcxClose("2026-11-02"), 23 * 60 + 55);
  const s = sessions("MCX_COMM", "2026-11-24");
  assert.equal(s.length, 1); assert.equal(s[0].start, 17 * 60);
  assert.equal(squareOff("NSE_FNO", "2026-11-19"), 15 * 60 + 15);
  assert.equal(squareOff("MCX_COMM", "2026-11-19"), 23 * 60 + 30);
  assert.equal(tradingDaysBetween("NSE_FNO", "2026-11-19", "2026-11-26"), 4); // 20, 23, 25, 26 (24 is a holiday)
  const t = ist(istEpoch("2026-11-19", 600) * 1000);
  assert.equal(t.hhmm, "10:00"); assert.equal(t.date, "2026-11-19");
});

test("CSV: quoted commas and Dhan column names", async () => {
  assert.deepEqual(splitCsv('a,"b, c",d'), ["a", "b, c", "d"]);
  const stream = new Blob([instrumentCsv("NSE_FNO")]).stream();
  const rows = await readRows(stream, (r) => r.inst === "FUTIDX");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].root, "NIFTY"); assert.equal(rows[0].lot, 65); assert.equal(rows[0].tick, 0.1);
});

const NIFTY: Inst = {
  key: "NIFTY", root: "NIFTY", kind: "INDEX", spot: { id: "13", seg: "IDX_I", instrument: "INDEX" },
  fut: { id: "35001", seg: "NSE_FNO", instrument: "FUTIDX", expiry: "2026-12-29", lot: 65 }, lot: 65, tick: 0.1, pointValue: 65,
  optSeg: "NSE_FNO", chain: { scrip: "13", seg: "IDX_I" },
};

function chain(spot = 24000, T = 5 / 365) {
  const oc: Record<string, any> = {};
  for (let k = -10; k <= 10; k++) {
    const K = 24000 + k * 50;
    oc[`${K}.000000`] = {
      ce: { last_price: bs("CE", spot, K, T, 0.14, 0.06), implied_volatility: 14, oi: 1e5, previous_oi: 9e4, security_id: 1 },
      pe: { last_price: bs("PE", spot, K, T, 0.14, 0.06), implied_volatility: 14, oi: 1e5, previous_oi: 9e4, security_id: 2 },
    };
  }
  return parseChain("NIFTY", "2026-11-24", { last_price: spot, oc }, T, 0.06);
}

test("Black-Scholes put-call parity", () => {
  const S = 24000, K = 24100, T = 0.02, r = 0.06;
  assert.ok(Math.abs(bs("CE", S, K, T, 0.15, r) - bs("PE", S, K, T, 0.15, r) - (S - K * Math.exp(-r * T))) < 1e-6);
});

test("structures: defined vs undefined risk", () => {
  const c = chain();
  const ds = build.debitSpread(NIFTY, c, 1, 2)!;
  assert.ok(Math.abs(ds.maxLossUnit! - ds.net) < 1e-9, "debit spread max loss = debit");
  const fly = build.ironFly(NIFTY, c, 200)!;
  assert.ok(fly.maxLossUnit! > 0 && fly.maxLossUnit! < 200);
  assert.equal(build.shortStrangle(NIFTY, c, 200)!.maxLossUnit, null);
  const fh = build.futHedge(NIFTY, c, 1, 24060, 1)!;
  assert.ok(fh.maxLossUnit !== null && fh.maxLossUnit > 0, "future + protective put has a floor");
  assert.equal(build.future(NIFTY, 1, 24000).maxLossUnit, null);
  assert.ok(chargesPerLot(fly, NIFTY) > 80, "4 legs x 2 orders x Rs 20 brokerage at least");
});

test("evaluator: an up-trending path wins for a call, loses for a put; stops respected", () => {
  const c = chain();
  const up: Path = Array.from({ length: 20 }, (_, k) => ({ o: 1 + k * 0.0008, h: 1 + (k + 1) * 0.0008, l: 1 + k * 0.0008, c: 1 + (k + 1) * 0.0008, dt: (k + 1) * 5 / 525600 }));
  const down: Path = up.map((s) => ({ o: 2 - s.o, h: 2 - s.l, l: 2 - s.h, c: 2 - s.c, dt: s.dt }));
  const rules = { kind: "directional" as const, dir: 1 as const, sl: 0.995, t1: 1.005, t2: 1.01, halfAtT1: true };
  const ce = build.longOption(NIFTY, c, 1, 0)!;
  const e = evaluate(ce, NIFTY, [up, up, down], rules, c.spot);
  assert.equal(e.n, 3); assert.ok(Math.abs(e.pWin - 2 / 3) < 1e-9);
  assert.ok(e.avgWin > 0 && e.avgLoss < 0);
  assert.ok(e.maxLoss > 0 && e.score > 0 && e.score < 100);
});

test("tracker: directional card resolves T1 then T2", () => {
  const card: any = { dir: 1, horizon: "intraday", date: "2026-11-19", entryAt: istEpoch("2026-11-19", 600) * 1000,
    underlying: { entry: 100, sl: 99, t1: 101, t2: 102 } };
  const bars = [
    { t: istEpoch("2026-11-19", 600), o: 100, h: 100.5, l: 99.6, c: 100.4, v: 1 },
    { t: istEpoch("2026-11-19", 605), o: 100.4, h: 101.2, l: 100.3, c: 101.1, v: 1 },
    { t: istEpoch("2026-11-19", 610), o: 101.1, h: 102.3, l: 101, c: 102.2, v: 1 },
  ];
  const o = judge(card, bars, "NSE_FNO", 615, "2026-11-19")!;
  assert.equal(o.result, "T2"); assert.equal(o.r, 1.5);
  const o2 = judge({ ...card }, [bars[0], { ...bars[1], l: 98.5 }], "NSE_FNO", 615, "2026-11-19")!;
  assert.equal(o2.result, "stop-loss"); assert.equal(o2.r, -1);
});

test("WAIT ideas are priced at the trigger: option-buy SL below entry, targets above", async () => {
  const { scoreCandidate, cardsFor } = await import("../src/engine/opportunities");
  const c = chain(24000);
  const mk = (k: number, dir: 1 | -1): Path => Array.from({ length: 12 }, (_, j) => {
    const x = 1 + dir * 0.0006 * (j + 1) * k;
    return { o: x, h: x + 0.0004, l: x - 0.0004, c: x, dt: (j + 1) * 5 / 525600 };
  });
  for (const dir of [1, -1] as const) {
    const entry = 24060 - dir * 80;   // trigger away from the current price
    const cand: any = {
      agent: "t", setup: "s", dir, horizon: "intraday", status: "WAIT", trigger: "", entry, sl: entry - dir * 40,
      t1: entry + dir * 40, t2: entry + dir * 80, paths: [mk(1, dir), mk(2, dir), mk(1, -dir as any)],
      rules: { kind: "directional", dir, sl: 1 - dir * 40 / entry, t1: 1 + dir * 40 / entry, t2: 1 + dir * 80 / entry, halfAtT1: true },
      structures: ["long_option", "debit_spread"], minDaysToExpiry: 0, why: [], validUntilMin: 900,
    };
    const scored = scoreCandidate(NIFTY, cand, c, 24060);
    const cards = cardsFor(NIFTY, cand, scored, "2026-11-19", 0);
    assert.ok(cards.length > 0);
    for (const k of cards) {
      assert.ok(k.levels.sl < k.levels.entry && k.levels.t1 > k.levels.entry && k.levels.t2 > k.levels.t1,
        `${dir} ${k.structure}: ${JSON.stringify(k.levels)}`);
    }
  }
});
