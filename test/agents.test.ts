import assert from "node:assert/strict";
import { test } from "node:test";
import { gap } from "../src/agents/gap";
import { ist, istEpoch, sessions } from "../src/calendar";
import type { Bar } from "../src/dhan";
import type { Inst } from "../src/universe";

const NIFTY: Inst = {
  key: "NIFTY", root: "NIFTY", kind: "INDEX", spot: { id: "13", seg: "IDX_I", instrument: "INDEX" },
  fut: { id: "35001", seg: "NSE_FNO", instrument: "FUTIDX", expiry: "2026-12-29", lot: 65 }, lot: 65, tick: 0.1, pointValue: 65,
  optSeg: "NSE_FNO", chain: { scrip: "13", seg: "IDX_I" },
};

function day(date: string, open: number, upFirst: boolean): Bar[] {
  const out: Bar[] = []; let px = open;
  for (let m = 555, k = 0; m + 5 <= 940; m += 5, k++) {
    const o = px, c = o * (1 + (k === 0 ? (upFirst ? 0.002 : -0.002) : k < 6 ? 0.0012 : 0.0002));
    out.push({ t: istEpoch(date, m), o, h: Math.max(o, c) * 1.0004, l: Math.min(o, c) * 0.9996, c, v: 1000 });
    px = c;
  }
  return out;
}

test("gap agent: WAIT pre-open, ENTER after the first bar confirms, history of similar gaps", async () => {
  const hist = new Map<string, Bar[]>();
  let px = 24000, d = "2026-08-03";
  const daily: any[] = [];
  for (let n = 0; n < 70; n++) {
    while (!sessions("NSE_FNO", d).length) d = new Date(Date.parse(d) + 86400e3).toISOString().slice(0, 10);
    const gapUp = n % 4 === 0;
    const bars = day(d, px * (gapUp ? 1.012 : 1.0), true);
    hist.set(d, bars);
    daily.push({ d, t: bars[0].t, o: bars[0].o, h: Math.max(...bars.map((b) => b.h)), l: Math.min(...bars.map((b) => b.l)), c: bars.at(-1)!.c, v: 1 });
    px = bars.at(-1)!.c;
    d = new Date(Date.parse(d) + 86400e3).toISOString().slice(0, 10);
  }
  const today = "2026-11-19", open = px * 1.012;
  const tdBars = day(today, open, true);
  const base = { inst: NIFTY, hist, daily, quote: null, prevClose: px, chain: async () => null, event: false };
  const pre = await gap.scan({ ...base, now: ist(istEpoch(today, 550) * 1000), today: [], futPx: open } as any);
  assert.ok(pre.length >= 1 && pre.every((c) => c.status === "WAIT"), "pre-open shows WAIT");
  const at925 = await gap.scan({ ...base, now: ist(istEpoch(today, 565) * 1000), today: tdBars.slice(0, 2), futPx: tdBars[1].c } as any);
  const go = at925.find((c) => c.setup === "gap_go_up")!;
  assert.equal(go.status, "ENTER");
  assert.ok(go.paths.length >= 10, `similar gaps in history: ${go.paths.length}`);
  assert.ok(go.sl < go.entry && go.t1 > go.entry);
});
