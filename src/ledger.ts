/**
 * The signal ledger: an append-only, hash-chained record of every call the board published,
 * every outcome, every real trade you journal, and every switch flipped (kill switch, agents,
 * scanners). Each row's hash covers the previous row's hash, so editing or deleting any past
 * row breaks the chain from that point on, and /api/ledger/verify shows where.
 *
 * Why it matters: this is your live track record. It is what you test the signals against on
 * your own account now, and the record you would later hand to a verification agency.
 */
import type { Env } from "./env";

export type LedgerKind = "CALL" | "OUTCOME" | "JOURNAL" | "KILL" | "CONFIG";
export interface LedgerRow { seq: number; ts: number; kind: LedgerKind; ref: string; json: string; prev: string; hash: string }

const GENESIS = "0".repeat(64);

export async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const material = (r: Omit<LedgerRow, "hash">) => `${r.seq}|${r.ts}|${r.kind}|${r.ref}|${r.prev}|${r.json}`;

/**
 * Append entries in order. Each insert only succeeds if the chain head is still the one we read
 * (guarded INSERT … SELECT … WHERE), so two writers can never fork the chain; we retry instead.
 */
export async function append(env: Env, items: { kind: LedgerKind; ref: string; data: unknown; ts?: number }[]): Promise<number[]> {
  const seqs: number[] = [];
  for (const it of items) {
    const json = JSON.stringify(it.data);
    for (let attempt = 0; ; attempt++) {
      const head = await env.DB.prepare("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1").first<{ seq: number; hash: string }>();
      const seq = (head?.seq ?? 0) + 1, prev = head?.hash ?? GENESIS, ts = it.ts ?? Date.now();
      const hash = await sha256(material({ seq, ts, kind: it.kind, ref: it.ref, json, prev }));
      await env.DB.prepare(
        `INSERT INTO ledger(seq,ts,kind,ref,json,prev,hash)
         SELECT ?,?,?,?,?,?,? WHERE COALESCE((SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1), ?) = ?
           AND NOT EXISTS (SELECT 1 FROM ledger WHERE seq = ?)`,
      ).bind(seq, ts, it.kind, it.ref, json, prev, hash, GENESIS, prev, seq).run();
      const got = await env.DB.prepare("SELECT hash FROM ledger WHERE seq=?").bind(seq).first<{ hash: string }>();
      if (got?.hash === hash) { seqs.push(seq); break; }
      if (attempt >= 4) throw new Error("ledger: could not append after 5 attempts (concurrent writers)");
    }
  }
  return seqs;
}

/** Recompute every hash. Returns the first broken row, if any. */
export async function verify(env: Env): Promise<{ ok: boolean; rows: number; head: string; brokenAt?: number; reason?: string }> {
  let prev = GENESIS, rows = 0, last = 0;
  for (;;) {
    const { results } = await env.DB.prepare("SELECT * FROM ledger WHERE seq > ? ORDER BY seq LIMIT 500").bind(last).all<LedgerRow>();
    if (!results.length) break;
    for (const r of results) {
      if (r.seq !== last + 1) return { ok: false, rows, head: prev, brokenAt: last + 1, reason: "row missing" };
      if (r.prev !== prev) return { ok: false, rows, head: prev, brokenAt: r.seq, reason: "previous hash does not match" };
      if ((await sha256(material(r))) !== r.hash) return { ok: false, rows, head: prev, brokenAt: r.seq, reason: "row content was changed" };
      prev = r.hash; last = r.seq; rows++;
    }
  }
  return { ok: true, rows, head: prev };
}

export async function rows(env: Env, opts: { kind?: LedgerKind; since?: number; limit?: number } = {}) {
  const where: string[] = [], args: unknown[] = [];
  if (opts.kind) { where.push("kind=?"); args.push(opts.kind); }
  if (opts.since) { where.push("ts>=?"); args.push(opts.since); }
  const sql = `SELECT * FROM ledger ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, opts.limit ?? 500).all<LedgerRow>();
  return results.map((r) => ({ ...r, data: JSON.parse(r.json) }));
}
