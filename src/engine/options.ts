/** Black-Scholes / Black-76 pricing and option-chain parsing. */

const SQ2 = Math.SQRT2;
function erf(x: number) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const ncdf = (x: number) => 0.5 * (1 + erf(x / SQ2));

/** Price of a European option. r = rate; T in years; iv as a fraction (0.14). */
export function bs(type: "CE" | "PE", S: number, K: number, T: number, iv: number, r = 0): number {
  if (T <= 1e-6 || iv <= 1e-4) return Math.max(0, type === "CE" ? S - K : K - S);
  const sq = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / sq, d2 = d1 - sq;
  const df = Math.exp(-r * T);
  return type === "CE" ? S * ncdf(d1) - K * df * ncdf(d2) : K * df * ncdf(-d2) - S * ncdf(-d1);
}
export function delta(type: "CE" | "PE", S: number, K: number, T: number, iv: number, r = 0) {
  if (T <= 1e-6 || iv <= 1e-4) return type === "CE" ? (S > K ? 1 : 0) : S < K ? -1 : 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
  return type === "CE" ? ncdf(d1) : ncdf(d1) - 1;
}
/** Implied vol by bisection (fallback when the chain has no IV). */
export function impliedVol(type: "CE" | "PE", price: number, S: number, K: number, T: number, r = 0) {
  let lo = 0.01, hi = 3;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bs(type, S, K, T, mid, r) > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

export interface Quote { id: string; ltp: number; iv: number; delta: number; oi: number; poi: number; vol: number; bid: number; ask: number }
export interface Chain {
  root: string; expiry: string; spot: number; T: number; r: number;
  strikes: number[]; ce: Map<number, Quote>; pe: Map<number, Quote>;
  atm: number; atmIv: number; step: number;
}

export function parseChain(root: string, expiry: string, data: { last_price: number; oc: Record<string, any> }, T: number, r: number): Chain {
  const ce = new Map<number, Quote>(), pe = new Map<number, Quote>();
  const q = (x: any): Quote | null => x && x.last_price > 0 ? {
    id: String(x.security_id ?? ""), ltp: +x.last_price, iv: (+x.implied_volatility || 0) / 100, delta: +(x.greeks?.delta ?? 0),
    oi: +(x.oi ?? 0), poi: +(x.previous_oi ?? 0), vol: +(x.volume ?? 0), bid: +(x.top_bid_price ?? 0), ask: +(x.top_ask_price ?? 0),
  } : null;
  for (const [k, v] of Object.entries(data.oc ?? {})) {
    const s = +k, c = q(v.ce), p = q(v.pe);
    if (c) ce.set(s, c);
    if (p) pe.set(s, p);
  }
  const strikes = [...new Set([...ce.keys(), ...pe.keys()])].sort((a, b) => a - b);
  const spot = +data.last_price || strikes[Math.floor(strikes.length / 2)];
  const atm = strikes.reduce((b, s) => (Math.abs(s - spot) < Math.abs(b - spot) ? s : b), strikes[0] ?? spot);
  const steps = strikes.slice(1).map((s, i) => s - strikes[i]).filter((x) => x > 0);
  const step = steps.length ? steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 50;
  const fill = (m: Map<number, Quote>, t: "CE" | "PE") => {
    for (const [k, x] of m) if (!x.iv && x.ltp > 0 && T > 0) x.iv = impliedVol(t, x.ltp, spot, k, T, r);
  };
  fill(ce, "CE"); fill(pe, "PE");
  const a = [ce.get(atm)?.iv, pe.get(atm)?.iv].filter((x): x is number => !!x);
  return { root, expiry, spot, T, r, strikes, ce, pe, atm, atmIv: a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0.15, step };
}

/** Strike n steps away from ATM (n>0 = higher). */
export const strikeAt = (c: Chain, n: number) => {
  const i = c.strikes.indexOf(c.atm);
  return c.strikes[Math.max(0, Math.min(c.strikes.length - 1, i + n))];
};
/** Nearest listed strike to a price. */
export const nearestStrike = (c: Chain, x: number) => c.strikes.reduce((b, s) => (Math.abs(s - x) < Math.abs(b - x) ? s : b), c.strikes[0]);

export function chainSummary(c: Chain) {
  let tce = 0, tpe = 0;
  for (const x of c.ce.values()) tce += x.oi;
  for (const x of c.pe.values()) tpe += x.oi;
  let best = Infinity, maxPain = c.atm;
  for (const k of c.strikes) {
    let pain = 0;
    for (const [s, x] of c.ce) pain += Math.max(0, k - s) * x.oi;
    for (const [s, x] of c.pe) pain += Math.max(0, s - k) * x.oi;
    if (pain < best) { best = pain; maxPain = k; }
  }
  const above = [...c.ce].filter(([s]) => s >= c.spot).sort((a, b) => b[1].oi - a[1].oi)[0];
  const below = [...c.pe].filter(([s]) => s <= c.spot).sort((a, b) => b[1].oi - a[1].oi)[0];
  const straddle = (c.ce.get(c.atm)?.ltp ?? 0) + (c.pe.get(c.atm)?.ltp ?? 0);
  return { pcr: tce ? tpe / tce : 0, maxPain, callWall: above?.[0] ?? null, putWall: below?.[0] ?? null, straddle, atmIv: c.atmIv };
}

/** Greeks per unit: delta, gamma, vega (per 1 IV point), theta (per calendar day). */
export function greeks(type: "CE" | "PE", S: number, K: number, T: number, iv: number, r = 0) {
  if (T <= 1e-6 || iv <= 1e-4) return { delta: delta(type, S, K, T, iv, r), gamma: 0, vega: 0, theta: 0 };
  const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * sq), d2 = d1 - iv * sq;
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const gamma = pdf / (S * iv * sq), vega = (S * pdf * sq) / 100;
  const th = -(S * pdf * iv) / (2 * sq) - (type === "CE" ? r * K * Math.exp(-r * T) * ncdf(d2) : -r * K * Math.exp(-r * T) * ncdf(-d2));
  return { delta: delta(type, S, K, T, iv, r), gamma, vega, theta: th / 365 };
}
