/** Dhan API v2 client for Workers. Data only: this project never places orders. */
import type { Env } from "./env";

const API = "https://api.dhan.co/v2";
const AUTH = "https://auth.dhan.co/app/generateAccessToken";

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; oi?: number }

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits)
function base32(s: string): Uint8Array {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error("TOTP secret is not base32");
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export async function totp(secret: string, epochMs = Date.now(), step = 30, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const ctr = Math.floor(epochMs / 1000 / step);
  const msg = new ArrayBuffer(8);
  const dv = new DataView(msg);
  dv.setUint32(0, Math.floor(ctr / 2 ** 32)); dv.setUint32(4, ctr >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

// ---------------------------------------------------------------- client
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Dhan {
  private token = "";
  private last: Record<string, number> = {};
  calls = 0;
  constructor(private env: Env) {}

  async init(force = false) {
    if (!force) {
      const row = await this.env.DB.prepare("SELECT value, updated FROM kv WHERE key='dhan_token'").first<{ value: string; updated: number }>();
      if (row && Date.now() - row.updated < 20 * 3600 * 1000) { this.token = row.value; return; }
    }
    await this.refreshToken();
  }

  async refreshToken() {
    const { DHAN_CLIENT_ID: id, DHAN_PIN: pin, DHAN_TOTP_SECRET: sec } = this.env;
    if (!id || !pin || !sec) throw new Error("Set DHAN_CLIENT_ID, DHAN_PIN and DHAN_TOTP_SECRET as Worker secrets");
    const code = await totp(sec);
    const url = `${AUTH}?dhanClientId=${encodeURIComponent(id)}&pin=${encodeURIComponent(pin)}&totp=${code}`;
    const r = await fetch(url, { method: "POST" });
    const j: any = await r.json().catch(() => ({}));
    const tok = j.accessToken ?? j.access_token ?? j.data?.accessToken;
    if (!r.ok || !tok) throw new Error(`Dhan token refresh failed (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
    this.token = tok;
    await this.env.DB.prepare("INSERT OR REPLACE INTO kv(key,value,updated) VALUES('dhan_token',?,?)").bind(tok, Date.now()).run();
  }

  /** Simple per-bucket spacing: data 5/s, quote 1/s, chain 1 per 3 s. */
  private async gate(bucket: "data" | "quote" | "chain") {
    const gap = { data: 220, quote: 1050, chain: 3100 }[bucket] * ((globalThis as any).__DHAN_GAP_SCALE ?? 1);
    const wait = (this.last[bucket] ?? 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.last[bucket] = Date.now();
  }

  async post(path: string, body: unknown, bucket: "data" | "quote" | "chain", retry = true): Promise<any> {
    await this.gate(bucket);
    this.calls++;
    const r = await fetch(API + path, {
      method: "POST",
      headers: { "access-token": this.token, "client-id": this.env.DHAN_CLIENT_ID, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 401 && retry) { await this.refreshToken(); return this.post(path, body, bucket, false); }
    if (r.status === 429 && retry) { await sleep(2000); return this.post(path, body, bucket, false); }
    const txt = await r.text();
    let j: any;
    try { j = JSON.parse(txt); } catch { throw new Error(`Dhan ${path} ${r.status}: ${txt.slice(0, 160)}`); }
    if (!r.ok || j?.errorCode || j?.status === "failure") throw new Error(`Dhan ${path} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }

  async intraday(securityId: string, seg: string, instrument: string, interval: number, from: string, to: string, oi = false): Promise<Bar[]> {
    const j = await this.post("/charts/intraday", { securityId, exchangeSegment: seg, instrument, interval: String(interval), oi, fromDate: from, toDate: to }, "data");
    return arraysToBars(j.data ?? j);
  }

  async daily(securityId: string, seg: string, instrument: string, from: string, to: string): Promise<Bar[]> {
    const j = await this.post("/charts/historical", { securityId, exchangeSegment: seg, instrument, expiryCode: 0, oi: false, fromDate: from, toDate: to }, "data");
    return arraysToBars(j.data ?? j);
  }

  /** {SEG: [ids]} → map "SEG:id" → quote object (last_price, ohlc, volume, oi, net_change...) */
  async quote(bySeg: Record<string, string[]>): Promise<Record<string, any>> {
    const out: Record<string, any> = {};
    const segs = Object.entries(bySeg).filter(([, ids]) => ids.length);
    // up to 1000 instruments per call
    let batch: Record<string, number[]> = {}, n = 0;
    const flush = async () => {
      if (!n) return;
      const j = await this.post("/marketfeed/quote", batch, "quote");
      for (const [seg, items] of Object.entries<any>(j.data ?? {})) for (const [id, q] of Object.entries<any>(items ?? {})) out[`${seg}:${id}`] = q;
      batch = {}; n = 0;
    };
    for (const [seg, ids] of segs) for (const id of ids) {
      (batch[seg] ??= []).push(Number(id)); n++;
      if (n >= 990) await flush();
    }
    await flush();
    return out;
  }

  async expiries(scrip: string, seg: string): Promise<string[]> {
    const j = await this.post("/optionchain/expirylist", { UnderlyingScrip: Number(scrip), UnderlyingSeg: seg }, "chain");
    return j.data ?? [];
  }

  async chain(scrip: string, seg: string, expiry: string): Promise<{ last_price: number; oc: Record<string, any> }> {
    const j = await this.post("/optionchain", { UnderlyingScrip: Number(scrip), UnderlyingSeg: seg, Expiry: expiry }, "chain");
    return j.data ?? { last_price: 0, oc: {} };
  }

  /** Open positions (read-only). */
  async positions(retry = true): Promise<any[]> {
    this.calls++;
    const r = await fetch(API + "/positions", { headers: { "access-token": this.token, "client-id": this.env.DHAN_CLIENT_ID, Accept: "application/json" } });
    if (r.status === 401 && retry) { await this.refreshToken(); return this.positions(false); }
    if (!r.ok) throw new Error(`Dhan /positions ${r.status}`);
    const j: any = await r.json();
    return Array.isArray(j) ? j : j.data ?? [];
  }

  /** Instrument list for one segment as CSV text (falls back to the full compact master). */
  async instrumentCsv(seg: string): Promise<ReadableStream<Uint8Array>> {
    const r = await fetch(`${API}/instrument/${seg}`, { headers: { "access-token": this.token } });
    if (r.ok && r.body) return r.body;
    const r2 = await fetch("https://images.dhan.co/api-data/api-scrip-master.csv");
    if (!r2.ok || !r2.body) throw new Error(`instrument list ${seg}: ${r.status}/${r2.status}`);
    return r2.body;
  }
}

export function arraysToBars(d: any): Bar[] {
  const ts: number[] = d?.timestamp ?? [];
  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const b: Bar = { t: Math.round(ts[i]), o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i], v: +(d.volume?.[i] ?? 0) };
    if (d.open_interest?.[i] != null) b.oi = +d.open_interest[i];
    if (Number.isFinite(b.o) && Number.isFinite(b.c)) out.push(b);
  }
  return out;
}
