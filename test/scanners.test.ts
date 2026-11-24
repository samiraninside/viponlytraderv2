/**
 * Your scanners A, B, C, D, clause by clause: a passing fixture must fire; breaking any
 * single condition must stop it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scannerAD, scannerB, scannerC } from "../src/agents/breakouts";
import { istEpoch } from "../src/calendar";
import type { Bar } from "../src/dhan";
import { ema, maxHigh, minLow, rsi, series, sma } from "../src/indicators";

const mk = (closes: number[], vols?: number[], tf = 15): Bar[] => closes.map((c, i) => {
  const o = i ? closes[i - 1] : c;
  return { t: istEpoch("2026-11-18", 555) + i * tf * 60, o, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, c, v: vols?.[i] ?? 1000 };
});
const flip = (b: Bar[]) => b.map((x) => ({ ...x, o: 200 - x.o, c: 200 - x.c, h: 200 - x.l, l: 200 - x.h }));

// A: drift up, a pause at [-1] (close below the 10-bar high) with heavy volume, then a breakout bar.
function fixtureA() {
  const closes: number[] = [];
  for (let i = 0; i < 28; i++) closes.push(100 + i * 0.12 + (i % 2 ? 0.15 : 0));
  closes.push(closes[27] - 0.25);          // [-1] pause, stays under the 10-bar high
  closes.push(closes[28] + 1.2);           // [0] breakout
  const vols = closes.map(() => 1000); vols[28] = 2500;   // [-1] volume > 1.5× SMA20
  return mk(closes, vols);
}

test("indicators: EMA seeds with SMA, RSI is Wilder (flat = no data, rising = 100)", () => {
  assert.deepEqual(ema([1, 2, 3, 4], 3).slice(2), [2, 3]);
  assert.equal(sma([1, 2, 3], 3)[2], 2);
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14).at(-1), 100);
});

test("Scanner A fires on the fixture and every clause matters", () => {
  const b = fixtureA(), i = b.length - 1, s = series(b);
  assert.ok(scannerAD(s, b, i, 1), `fixture: c0 ${b[i].c} h10 ${maxHigh(b, i - 1, 10)} rsi ${s.rsi14[i]} ema ${s.ema20[i]} vwap ${s.vwap[i]}`);
  const breaks: [string, (b: Bar[]) => void][] = [
    ["close below EMA20/VWAP", (x) => { x[i].c = s.ema20[i] - 1; x[i].o = x[i].c + 0.1; }],
    ["red candle (close <= open)", (x) => { x[i].o = x[i].c + 0.05; x[i].h = x[i].o + 0.2; }],
    ["no breakout of the 10-bar high", (x) => { x[i].c = maxHigh(x, i - 1, 10) - 0.01; }],
    ["[-1] already above the 10-bar high", (x) => { x[i - 1].c = maxHigh(x, i - 2, 10) + 0.01; x[i - 1].h = x[i - 1].c + 0.2; }],
    ["[-1] volume not 1.5× its SMA20", (x) => { x[i - 1].v = 1000; }],
  ];
  for (const [name, f] of breaks) {
    const x = b.map((y) => ({ ...y })); f(x);
    assert.equal(scannerAD(series(x), x, i, 1), false, name);
  }
  // RSI clause: a choppy series with the same breakout but RSI <= 55 must fail
  const chop = fixtureA().map((y, k) => ({ ...y, c: k < 28 ? 100 + (k % 2 ? 1.5 : -1.5) : y.c }));
  const sc = series(chop);
  if (sc.rsi14[i] <= 55) assert.equal(scannerAD(sc, chop, i, 1), false, "RSI ≤ 55");
});

test("Scanner D mirrors A (with [0] volume, RSI < 45)", () => {
  const b = flip(fixtureA()), i = b.length - 1;
  b[i].v = 2600; b[i - 1].v = 1000;    // D checks [0] volume vs [-1] SMA20
  const s = series(b);
  assert.ok(scannerAD(s, b, i, -1), `D fixture: c0 ${b[i].c} l10 ${minLow(b, i - 1, 10)} rsi ${s.rsi14[i]}`);
  const x = b.map((y) => ({ ...y })); x[i].v = 1000;
  assert.equal(scannerAD(series(x), x, i, -1), false, "[0] volume");
  assert.equal(scannerAD(s, b, i, 1), false, "never fires long");
});

test("Scanner B (5-min trigger) and its mirror", () => {
  const closes: number[] = [];
  for (let i = 0; i < 28; i++) closes.push(100 + i * 0.1 + (i % 2 ? 0.1 : 0));
  closes.push(closes[27] + 0.6);
  const vols = closes.map(() => 1000); vols[28] = 2000;
  const b = mk(closes, vols, 5), i = b.length - 1, s = series(b);
  assert.ok(scannerB(s, b, i, 1));
  const x = b.map((y) => ({ ...y })); x[i].c = x[i - 1].h - 0.01;
  assert.equal(scannerB(series(x), x, i, 1), false, "close must clear the previous high");
  const y = b.map((q) => ({ ...q })); y[i].v = 1400;
  assert.equal(scannerB(series(y), y, i, 1), false, "[0] volume > 1.5× [-1] SMA20");
  const m = flip(b);
  assert.ok(scannerB(series(m), m, i, -1), "mirror short");
});

test("Scanner C (pre-breakout): near the high, RSI 50–70, ATR contracting", () => {
  const closes: number[] = [];
  for (let i = 0; i < 15; i++) closes.push(100 + i * 0.25);                       // trend up to ~103.5
  for (let i = 0; i < 17; i++) closes.push(103.9 + (i % 2 ? 0.35 : -0.3) + i * 0.01); // choppy base
  const n = closes.length;
  const b = mk(closes).map((x, k) => (k >= n - 4 ? { ...x, h: Math.max(x.o, x.c) + 0.03, l: Math.min(x.o, x.c) - 0.03 } : x)); // range tightens
  b[n - 6].h = 104.9; // the 10-bar high, just above the base
  const i = b.length - 1, s = series(b);
  const h10 = maxHigh(b, i - 1, 10);
  const ok = scannerC(s, b, i);
  assert.ok(ok, `C fixture: c ${b[i].c} h10 ${h10} rsi ${s.rsi14[i]} atr ${s.atr14[i]} vs ${s.atr14[i - 3]} ema ${s.ema20[i]} vwap ${s.vwap[i]}`);
  const x = b.map((y) => ({ ...y })); x[i].c = h10 + 0.01;
  assert.equal(scannerC(series(x), x, i), false, "already above the high is a breakout, not pre-breakout");
  const z = b.map((y) => ({ ...y })); z[i].c = h10 * 0.975;
  assert.equal(scannerC(series(z), z, i), false, "more than 2% below the high");
});
