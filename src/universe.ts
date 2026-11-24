/** Builds the day's universe from Dhan's instrument lists: indices, top F&O stocks, MCX crude. */
import { COMMODITIES, INDEX_IDS, INDICES, MCX_POINT_VALUE, STARTER_STOCKS, STOCK_UNIVERSE_SIZE } from "./config";
import type { Dhan } from "./dhan";
import type { Env } from "./env";

export interface Ref { id: string; seg: string; instrument: string }
export interface Inst {
  key: string; root: string; kind: "INDEX" | "STOCK" | "COMMODITY";
  spot: Ref | null;                         // index / equity (null for crude)
  fut: Ref & { expiry: string; lot: number };
  lot: number; tick: number; pointValue: number;
  optSeg: "NSE_FNO" | "BSE_FNO" | "MCX_COMM";
  chain: { scrip: string; seg: string };
}

const COLS: Record<string, string[]> = {
  id: ["SEM_SMST_SECURITY_ID", "SECURITY_ID"], inst: ["SEM_INSTRUMENT_NAME", "INSTRUMENT"],
  sym: ["SEM_TRADING_SYMBOL", "SYMBOL_NAME"], und: ["UNDERLYING_SYMBOL"], exp: ["SEM_EXPIRY_DATE", "SM_EXPIRY_DATE"],
  lot: ["SEM_LOT_UNITS", "LOT_SIZE"], tick: ["SEM_TICK_SIZE", "TICK_SIZE"], exch: ["SEM_EXM_EXCH_ID", "EXCH_ID"],
  series: ["SEM_SERIES", "SERIES"], seg: ["SEM_SEGMENT", "SEGMENT"],
};

export function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export interface Row { id: string; inst: string; sym: string; root: string; exp: string; lot: number; tick: number; exch: string; series: string }

/** Streams a CSV and keeps rows passing `keep`. */
export async function readRows(stream: ReadableStream<Uint8Array>, keep: (r: Row) => boolean): Promise<Row[]> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", idx: Record<string, number> | null = null;
  const rows: Row[] = [];
  const handle = (line: string) => {
    if (!line.trim()) return;
    const f = splitCsv(line.replace(/\r$/, ""));
    if (!idx) {
      idx = {};
      for (const [k, names] of Object.entries(COLS)) idx[k] = f.findIndex((h) => names.includes(h.trim()));
      return;
    }
    const g = (k: string) => (idx![k] >= 0 ? (f[idx![k]] ?? "").trim() : "");
    const inst = g("inst").toUpperCase(), sym = g("sym").toUpperCase();
    const und = g("und").toUpperCase();
    const root = inst === "EQUITY" || inst === "INDEX" ? sym.replace(/\s+/g, "") : und || sym.split("-")[0];
    let tick = parseFloat(g("tick")) || 5;
    if (tick >= 1) tick /= 100;
    const r: Row = { id: g("id"), inst, sym, root, exp: g("exp").slice(0, 10), lot: parseInt(g("lot")) || 1, tick, exch: g("exch").toUpperCase(), series: g("series").toUpperCase() };
    if (keep(r)) rows.push(r);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  handle(buf);
  return rows;
}

const nearest = (rows: Row[], today: string, rollDays = 3) => {
  const cut = new Date(Date.parse(today) + rollDays * 86400e3).toISOString().slice(0, 10);
  return rows.filter((r) => r.exp && r.exp >= cut).sort((a, b) => a.exp.localeCompare(b.exp))[0];
};

export async function buildUniverse(env: Env, dhan: Dhan, today: string) {
  const ranked = await getKv<string[]>(env, "liquidity_rank");
  const stocks = (ranked?.length ? ranked : STARTER_STOCKS).slice(0, STOCK_UNIVERSE_SIZE);
  const want = new Set([...INDICES, ...COMMODITIES, ...stocks]);

  const fno = await readRows(await dhan.instrumentCsv("NSE_FNO"), (r) => r.inst === "FUTIDX" || r.inst === "FUTSTK");
  const bfo = await readRows(await dhan.instrumentCsv("BSE_FNO"), (r) => r.inst === "FUTIDX" && r.root === "SENSEX");
  const mcx = await readRows(await dhan.instrumentCsv("MCX_COMM"), (r) => r.inst === "FUTCOM" && COMMODITIES.includes(r.root));
  const idx = await readRows(await dhan.instrumentCsv("IDX_I"), (r) => r.inst === "INDEX" && INDICES.includes(r.root));
  const eq = await readRows(await dhan.instrumentCsv("NSE_EQ"), (r) => r.inst === "EQUITY" && (r.series === "EQ" || r.series === "") && want.has(r.root) && (r.exch === "NSE" || r.exch === ""));

  // every F&O stock's near future, for tomorrow's liquidity ranking
  const allStockFuts: Record<string, string> = {};
  const byRoot = new Map<string, Row[]>();
  for (const r of [...fno, ...bfo, ...mcx]) (byRoot.get(r.root) ?? byRoot.set(r.root, []).get(r.root)!).push(r);
  for (const [root, rows] of byRoot) if (rows[0].inst === "FUTSTK") { const n = nearest(rows, today); if (n) allStockFuts[root] = n.id; }
  await putKv(env, "fno_stock_futs", allStockFuts);

  const out: Inst[] = [];
  for (const root of want) {
    const futs = byRoot.get(root);
    const f = futs && nearest(futs, today);
    if (!f) continue;
    const kind: Inst["kind"] = COMMODITIES.includes(root) ? "COMMODITY" : INDICES.includes(root) ? "INDEX" : "STOCK";
    let spot: Ref | null = null;
    if (kind === "INDEX") {
      const i = idx.find((r) => r.root === root);
      spot = { id: i?.id || INDEX_IDS[root], seg: "IDX_I", instrument: "INDEX" };
    } else if (kind === "STOCK") {
      const e = eq.find((r) => r.root === root);
      if (!e) continue;
      spot = { id: e.id, seg: "NSE_EQ", instrument: "EQUITY" };
    }
    const futSeg = kind === "COMMODITY" ? "MCX_COMM" : root === "SENSEX" ? "BSE_FNO" : "NSE_FNO";
    out.push({
      key: root, root, kind, spot,
      fut: { id: f.id, seg: futSeg, instrument: f.inst, expiry: f.exp, lot: f.lot },
      lot: f.lot, tick: f.tick || 0.05,
      pointValue: kind === "COMMODITY" ? MCX_POINT_VALUE[root] ?? f.lot : f.lot,
      optSeg: futSeg as Inst["optSeg"],
      chain: spot ? { scrip: spot.id, seg: spot.seg } : { scrip: f.id, seg: "MCX_COMM" },
    });
  }
  const stmt = env.DB.prepare("INSERT OR REPLACE INTO universe(key,json,updated) VALUES(?,?,?)");
  await env.DB.prepare("DELETE FROM universe").run();
  await env.DB.batch(out.map((i) => stmt.bind(i.key, JSON.stringify(i), Date.now())));
  return out;
}

export async function loadUniverse(env: Env): Promise<Inst[]> {
  const { results } = await env.DB.prepare("SELECT json FROM universe").all<{ json: string }>();
  return results.map((r) => JSON.parse(r.json));
}

/** After the close: rank F&O stocks by futures turnover for tomorrow's top-N. */
export async function rankLiquidity(env: Env, dhan: Dhan) {
  const futs = (await getKv<Record<string, string>>(env, "fno_stock_futs")) ?? {};
  const ids = Object.values(futs);
  if (!ids.length) return [];
  const q = await dhan.quote({ NSE_FNO: ids });
  const rows = Object.entries(futs).map(([root, id]) => {
    const x = q[`NSE_FNO:${id}`];
    return { root, turnover: x ? (x.volume ?? 0) * (x.average_price || x.last_price || 0) : 0 };
  }).filter((r) => r.turnover > 0).sort((a, b) => b.turnover - a.turnover);
  const list = rows.map((r) => r.root);
  if (list.length >= 20) await putKv(env, "liquidity_rank", list);
  return list;
}

export async function getKv<T>(env: Env, key: string): Promise<T | null> {
  const r = await env.DB.prepare("SELECT value FROM kv WHERE key=?").bind(key).first<{ value: string }>();
  return r ? (JSON.parse(r.value) as T) : null;
}
export async function putKv(env: Env, key: string, v: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO kv(key,value,updated) VALUES(?,?,?)").bind(key, JSON.stringify(v), Date.now()).run();
}
