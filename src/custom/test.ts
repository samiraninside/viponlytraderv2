/** "Test" button: run a scanner over the universe now and over history, without saving it. */
import type { Ctx } from "../agents/types";
import { addDays, type IST, istEpoch, toMins, tradingDaysBetween, type Seg } from "../calendar";
import { Dhan } from "../dhan";
import { runPath } from "../engine/evaluate";
import { parseChain } from "../engine/options";
import { build } from "../engine/structures";
import type { Env } from "../env";
import { dayOf, load5m, loadDaily } from "../history";
import { getKv, loadUniverse, putKv } from "../universe";
import { baseOf, parseRule } from "./dsl";
import { evaluateScanner, type ScannerDef } from "./runner";

export async function testScanner(env: Env, def: ScannerDef, t: IST) {
  const { rule, errors } = parseRule(def.text);
  if (!rule) return { errors };
  const dhan = new Dhan(env);
  await dhan.init();
  const insts = (await loadUniverse(env)).filter((i) => def.kinds.includes(i.kind));
  const benchmark = await loadDaily(env, "NIFTY");
  const rows: any[] = [];
  let chainCalls = 0;
  for (const i of insts) {
    try {
      const hist = await load5m(env, i.key, 60), daily = await loadDaily(env, i.key);
      let today = await dhan.intraday(i.fut.id, i.fut.seg, i.fut.instrument, 5, t.date, addDays(t.date, 1), true).catch(() => []);
      today = today.filter((b) => dayOf(b.t) === t.date && b.t + 300 <= t.epoch / 1000);
      const prevClose = [...hist.values()].at(-1)?.at(-1)?.c ?? daily.at(-1)?.c ?? 0;
      const futPx = today.at(-1)?.c ?? prevClose;
      const ctx: Ctx = {
        now: t, inst: i, today, hist, daily, quote: null, futPx, prevClose, event: false, benchmark,
        ivRank: async () => null,
        chain: async (minDays) => {
          if (chainCalls >= 10) return null;
          let exps = await getKv<string[]>(env, `exp:${i.root}:${t.date}`);
          if (!exps) { chainCalls++; exps = await dhan.expiries(i.chain.scrip, i.chain.seg); await putKv(env, `exp:${i.root}:${t.date}`, exps); }
          const exp = exps.find((e) => e >= t.date && tradingDaysBetween(i.fut.seg as Seg, t.date, e) >= minDays);
          if (!exp) return null;
          chainCalls++;
          const T = Math.max(60, istEpoch(exp, i.kind === "COMMODITY" ? toMins("23:30") : toMins("15:30")) - t.epoch / 1000) / (365 * 86400);
          return parseChain(i.root, exp, await dhan.chain(i.chain.scrip, i.chain.seg, exp), T, i.kind === "COMMODITY" ? 0 : 0.06);
        },
      };
      const r = await evaluateScanner(def, rule, ctx, { anyTimeToday: true });
      if (!r) { rows.push({ symbol: i.root, note: "not enough data" }); continue; }
      // history stats on the future, in R, with the scanner's own stop and targets
      let stats: any = { n: r.paths.length };
      if (r.paths.length) {
        const ts = def.targets.length ? def.targets : [1, 2];
        const rp = r.today ? r.today.risk / r.today.entry : 0.01, e0 = 100;
        const b = build.future(i, def.dir, e0);
        const rules = { kind: "directional" as const, dir: def.dir, sl: 1 - def.dir * rp, t1: 1 + def.dir * ts[0] * rp, t2: 1 + def.dir * (ts[1] ?? ts[0]) * rp, halfAtT1: true };
        const res = r.paths.map((p) => runPath(b, p, rules, e0));
        const R = res.map((x) => x.pnl / (rp * e0));
        const n = R.length, wins = R.filter((x) => x > 0).length;
        stats = { n, pWin: Math.round((wins / n) * 100), pT1: Math.round((res.filter((x) => x.t1).length / n) * 100), avgR: Math.round((R.reduce((a, x) => a + x, 0) / n) * 100) / 100 };
      }
      rows.push({ symbol: i.root, firedToday: r.todayFires, now: !!r.today && r.today.k === r.bars.length - 1, ...stats });
    } catch (e) {
      rows.push({ symbol: i.root, note: (e as Error).message });
    }
  }
  rows.sort((a, b) => Number(!!b.now) - Number(!!a.now) || (b.n ?? 0) - (a.n ?? 0));
  return { mode: baseOf(rule).mode, baseTf: baseOf(rule).tf, conditions: rule.conds.length, logic: rule.mode, rows };
}
