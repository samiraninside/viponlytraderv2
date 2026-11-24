import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILES } from "../src/config";
import { averagingPlan } from "../src/engine/averaging";

const P = Object.fromEntries(PROFILES.map((p) => [p.id, p]));

// Long call on a breakout: premium 100, stop 70, T1 160, T2 220, lot 75, 1 lot
const opt = {
  agent: "breakout15", structure: "long_option" as const, lots: 1, units: 75, margin: 7500,
  levels: { basis: "premium" as const, entry: 100, sl: 70, t1: 160, t2: 220 },
  underlying: { entry: 25000, sl: 24900, t1: 25200, t2: 25400 },
  maxLoss: 2600,
};

test("risk caps are 2k / 5k / 10k", () => {
  assert.deepEqual(PROFILES.map((p) => p.riskPerTrade), [2000, 5000, 10000]);
});

test("basic profile never gets an averaging plan", () => {
  assert.equal(averagingPlan(opt, P.basic), undefined);
});

test("pyramid adds sit at Fibonacci points of entry→T1, inside the risk cap and reserve", () => {
  const a = averagingPlan(opt, P.big)!;
  assert.equal(a.mode, "pyramid");
  // add 1 at 122.92 (100 + 0.382 × 60) → loss at stop ≈ 7,204; add 2 at 130 would be ≈ 12,419 > 10,000
  assert.equal(a.adds.length, 1);
  assert.equal(a.adds[0].at, 122.92);
  assert.equal(a.adds[0].atUnderlying, 25076.4);
  assert.match(a.skipped!, /past ₹10,000/);
  for (const x of a.adds) { assert.ok(x.riskAfter <= 10000); assert.ok(x.costAfter <= a.reserve); }
  // targets keep their reward distance from the new average
  assert.equal(a.adds[0].t1After, Math.round((a.adds[0].avgAfter + 60) * 100) / 100);
});

test("mid profile: an add that breaks the ₹5,000 cap is skipped and explained", () => {
  const a = averagingPlan(opt, P.mid)!;
  // first add risks (122.92-70)×75×1.15+40 ≈ 4,604 → 2,600+4,604 > 5,000
  assert.equal(a.adds.length, 0);
  assert.match(a.skipped!, /past ₹5,000/);
});

test("average-down adds sit between entry and stop for reclaim setups", () => {
  const a = averagingPlan({ ...opt, agent: "emaReclaim" }, P.mid)!;
  assert.equal(a.mode, "average");
  assert.ok(a.adds.length >= 1);
  assert.ok(a.adds[0].at < 100 && a.adds[0].at > 70);
  assert.ok(a.adds[0].t1After < 160);
});

test("selling, hedged and unlisted agents get no plan", () => {
  assert.equal(averagingPlan({ ...opt, structure: "iron_condor" }, P.big), undefined);
  assert.equal(averagingPlan({ ...opt, agent: "heroZero" }, P.big), undefined);
});
