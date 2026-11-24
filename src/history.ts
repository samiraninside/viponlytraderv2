/** Bar history in D1 and small indicator helpers. */
import { addDays, IST_OFFSET_MS } from "./calendar";
import type { Bar, Dhan } from "./dhan";
import type { Env } from "./env";
import type { Inst } from "./universe";
import { getKv, putKv } from "./universe";

export const dayOf = (t: number) => new Date(t * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
export const minsOf = (t: number) => { const d = new Date(t * 1000 + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

export function byDay(bars: Bar[]): Map<string, Bar[]> {
  const m = new Map<string, Bar[]>();
  for (const b of bars) { const d = dayOf(b.t); (m.get(d) ?? m.set(d, []).get(d)!).push(b); }
  return m;
}

/** Refresh 5-minute futures history (with OI) and 2 years of daily bars. */
export async function refreshHistory(env: Env, dhan: Dhan, insts: Inst[], today: string) {
  const meta = (await getKv<Record<string, { fut: string; daily: string }>>(env, "history_meta")) ?? {};
  for (const i of insts) {
    const m = meta[i.key];
    try {
      const fresh = !m || m.fut !== i.fut.id;
      const from = fresh ? addDays(today, -88) : addDays(today, -6);
      const bars = await dhan.intraday(i.fut.id, i.fut.seg, i.fut.instrument, 5, from, addDays(today, 1), true);
      const days = byDay(bars.filter((b) => dayOf(b.t) < today));
      if (fresh) await env.DB.prepare("DELETE FROM bars5 WHERE key=?").bind(i.key).run();
      const st = env.DB.prepare("INSERT OR REPLACE INTO bars5(key,day,json) VALUES(?,?,?)");
      const batch = [...days].map(([d, b]) => st.bind(i.key, d, JSON.stringify(b)));
      for (let k = 0; k < batch.length; k += 50) await env.DB.batch(batch.slice(k, k + 50));
      await env.DB.prepare("DELETE FROM bars5 WHERE key=? AND day < ?").bind(i.key, addDays(today, -95)).run();
      if (!m || m.daily !== today) {
        const src = i.spot ?? i.fut;
        const d = await dhan.daily(src.id, src.seg, src.instrument, addDays(today, -730), today);
        const daily = d.map((b) => ({ ...b, d: dayOf(b.t) })).filter((b) => b.d < today);
        await env.DB.prepare("INSERT OR REPLACE INTO daily(key,json) VALUES(?,?)").bind(i.key, JSON.stringify(daily)).run();
      }
      meta[i.key] = { fut: i.fut.id, daily: today };
    } catch (e) {
      console.log(`history ${i.key}: ${(e as Error).message}`);
    }
  }
  await putKv(env, "history_meta", meta);
}

export async function load5m(env: Env, key: string, days = 60): Promise<Map<string, Bar[]>> {
  const { results } = await env.DB.prepare("SELECT day, json FROM bars5 WHERE key=? ORDER BY day DESC LIMIT ?").bind(key, days).all<{ day: string; json: string }>();
  return new Map(results.reverse().map((r) => [r.day, JSON.parse(r.json) as Bar[]]));
}
export type DBar = Bar & { d: string };
export async function loadDaily(env: Env, key: string): Promise<DBar[]> {
  const r = await env.DB.prepare("SELECT json FROM daily WHERE key=?").bind(key).first<{ json: string }>();
  return r ? JSON.parse(r.json) : [];
}

// ---------------------------------------------------------------- indicators
export function vwap(bars: Bar[]): number {
  let pv = 0, v = 0;
  for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; pv += tp * (b.v || 1); v += b.v || 1; }
  return v ? pv / v : bars.at(-1)?.c ?? 0;
}
export function atr(bars: { h: number; l: number; c: number }[], n = 14): number {
  const tr: number[] = [];
  for (let k = 1; k < bars.length; k++) {
    const b = bars[k], p = bars[k - 1];
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  const s = tr.slice(-n);
  return s.length ? s.reduce((a, x) => a + x, 0) / s.length : 0;
}
export function openingRange(day: Bar[], startMin: number, minutes: number) {
  const r = day.filter((b) => minsOf(b.t) >= startMin && minsOf(b.t) < startMin + minutes);
  if (r.length < minutes / 5) return null;
  return { hi: Math.max(...r.map((b) => b.h)), lo: Math.min(...r.map((b) => b.l)), end: startMin + minutes };
}
/** Volume of bars so far today vs the average of the same window in past days. */
export function relVolume(today: Bar[], past: Map<string, Bar[]>, uptoMin: number): number {
  const sum = (bs: Bar[]) => bs.filter((b) => minsOf(b.t) < uptoMin).reduce((a, b) => a + b.v, 0);
  const hist = [...past.values()].slice(-20).map(sum).filter((x) => x > 0);
  const avg = hist.reduce((a, x) => a + x, 0) / (hist.length || 1);
  return avg ? sum(today) / avg : 1;
}
