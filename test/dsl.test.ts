/** The rule language must reproduce the hand-coded scanners A–D exactly, bar for bar. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scannerAD, scannerB, scannerC } from "../src/agents/breakouts";
import { parseRule, ruleTrue } from "../src/custom/dsl";
import { intradayEnv } from "../src/custom/series";
import { arraysToBars } from "../src/dhan";
import { resample, series } from "../src/indicators";
import { genBars, SPECS } from "./fake";

const A = `Scanner A:  15-minute confirmed bullish breakout Segment: Futures
Stock passes ALL
[0] 15 minute Close > [0] 15 minute EMA(Close,20)
[0] 15 minute Close > [0] 15 minute VWAP
[0] 15 minute Close > [0] 15 minute Open
[0] 15 minute Close > [-1] 15 minute Max(10,High)
[-1] 15 minute Close <= [-2] 15 minute Max(10,High)
[-1] 15 minute Volume > [-1] 15 minute SMA(Volume,20) * 1.5
[0] 15 minute RSI(14) > 55    Segment:   Scanner B: 5-minute bullish entry trigger  Futures`;
const B = `Stock passes ALL
[0] 5 minute Close > [0] 5 minute EMA(Close,20)
[0] 5 minute Close > [0] 5 minute VWAP
[0] 5 minute Close > [-1] 5 minute High
[0] 5 minute Close > [0] 5 minute Open
[0] 5 minute Volume > [-1] 5 minute SMA(Volume,20) * 1.5
[0] 5 minute RSI(14) > 55`;
const C = `[0] 15 minute Close > [0] 15 minute EMA(Close,20)
[0] 15 minute Close > [0] 15 minute VWAP
[0] 15 minute Close < [-1] 15 minute Max(10,High)
[0] 15 minute Close > [-1] 15 minute Max(10,High) * 0.98
[0] 15 minute RSI(14) > 50
[0] 15 minute RSI(14) < 70
[0] 15 minute ATR(14) < [-3] 15 minute ATR(14)`;
const D = `[0] 15 minute Close < [0] 15 minute EMA(Close,20)
[0] 15 minute Close < [0] 15 minute VWAP
[0] 15 minute Close < [0] 15 minute Open
[0] 15 minute Close < [-1] 15 minute Min(10,Low)
[-1] 15 minute Close >= [-2] 15 minute Min(10,Low)
[0] 15 minute Volume > [-1] 15 minute SMA(Volume,20) * 1.5
[0] 15 minute RSI(14) < 45`;

test("parser: your pasted text, headers and trailing notes included", () => {
  const r = parseRule(A);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rule!.conds.length, 7);
  assert.equal(r.rule!.mode, "ALL");
  assert.ok(parseRule("[0] 5 minute Close crossed above [0] 5 minute VWAP").rule);
  assert.ok(parseRule("[0] daily Close > [-1] daily Max(20,High)\n[0] chain PCR > 1.1").rule);
  const bad = parseRule("[0] 15 minute Clsoe > 5");
  assert.match(bad.errors[0].error, /unknown field/);
});

for (const spec of SPECS.slice(0, 3)) test(`A, B, C, D via the rule language = hand-coded scanners on ${spec.root}`, () => {
  const b5 = arraysToBars(genBars(spec, "2026-09-01", "2026-11-19"));
  const b15 = resample(b5, 15, () => 555);
  const s15 = series(b15), s5 = series(b5);
  const far = b5.at(-1)!.t + 86400;
  const e15 = intradayEnv(b5, 15, () => 555, () => NaN, far);
  const e5 = intradayEnv(b5, 5, () => 555, () => NaN, far);
  const rA = parseRule(A).rule!, rB = parseRule(B).rule!, rC = parseRule(C).rule!, rD = parseRule(D).rule!;
  assert.equal(e15.base.length, b15.length);
  const count = { A: 0, B: 0, C: 0, D: 0 };
  for (let i = 25; i < b15.length; i++) {
    const a = scannerAD(s15, b15, i, 1), d = scannerAD(s15, b15, i, -1), c = scannerC(s15, b15, i);
    assert.equal(ruleTrue(rA, e15.env, i, false), a, `A at 15m bar ${i}`);
    assert.equal(ruleTrue(rD, e15.env, i, false), d, `D at 15m bar ${i}`);
    assert.equal(ruleTrue(rC, e15.env, i, false), c, `C at 15m bar ${i}`);
    count.A += +a; count.D += +d; count.C += +c;
  }
  for (let i = 25; i < b5.length; i++) {
    const b = scannerB(s5, b5, i, 1);
    assert.equal(ruleTrue(rB, e5.env, i, false), b, `B at 5m bar ${i}`);
    count.B += +b;
  }
  console.log(spec.root, count);
  assert.ok(count.A + count.B + count.C + count.D > 0, "the comparison exercised some firings");
});
