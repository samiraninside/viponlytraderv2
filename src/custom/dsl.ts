/**
 * Scanner rule language, Chartink style. One condition per line:
 *
 *   [0] 15 minute Close > [0] 15 minute EMA(Close,20)
 *   [-1] 15 minute Volume > [-1] 15 minute SMA(Volume,20) * 1.5
 *   [0] 5 minute Close crossed above [0] 5 minute VWAP
 *   [0] daily Close > [-1] daily Max(20,High)
 *   [0] chain PCR > 1.1
 *
 * "Stock passes ALL" (default) or "Stock passes ANY" sets AND / OR. Lines without a comparison
 * (titles, "Segment: Futures") are ignored.
 *
 * Timeframes: 5 minute, 15 minute, 30 minute, 60 minute (1 hour), daily, weekly, chain.
 * Fields: Open High Low Close Volume OI VWAP.
 * Functions: EMA(src,n) SMA(src,n) RSI(n) ATR(n) Max(n,src) Min(n,src) Supertrend(n,mult)
 *            MACD Line(slow,fast,sig) MACD Signal(slow,fast,sig).
 * Chain (live only): PCR, Max Pain, ATM IV, IV Rank, Call Vega, Put Vega, Vega Diff, Spot.
 */

export type TF = 5 | 15 | 30 | 60 | "D" | "W" | "chain";
export type Node =
  | { k: "num"; v: number }
  | { k: "ref"; off: number; tf: TF; fn: string; args: (string | number)[] }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; l: Node; r: Node };
export type Op = ">" | "<" | ">=" | "<=" | "=" | "xa" | "xb";
export interface Cond { l: Node; op: Op; r: Node; text: string }
export interface Rule { mode: "ALL" | "ANY"; conds: Cond[]; tfs: TF[] }

const FIELDS = ["OPEN", "HIGH", "LOW", "CLOSE", "VOLUME", "OI", "VWAP"];
const FNS = ["EMA", "SMA", "RSI", "ATR", "MAX", "MIN", "SUPERTREND", "MACD LINE", "MACD SIGNAL"];
const CHAIN = ["PCR", "MAX PAIN", "ATM IV", "IV RANK", "CALL VEGA", "PUT VEGA", "VEGA DIFF", "SPOT"];

type Tok = { t: "num" | "word" | "sym"; v: string };

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; out.push({ t: "num", v: s.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z_0-9]/.test(s[j])) j++; out.push({ t: "word", v: s.slice(i, j).toUpperCase() }); i = j; continue; }
    const two = s.slice(i, i + 2);
    if ([">=", "<=", "==", "!="].includes(two)) { out.push({ t: "sym", v: two }); i += 2; continue; }
    if ("[]()+-*/,<>=".includes(c)) { out.push({ t: "sym", v: c }); i++; continue; }
    out.push({ t: "sym", v: c }); i++; // unknown characters only matter if the parser reaches them
  }
  return out;
}

class P {
  i = 0;
  constructor(private ts: Tok[]) {}
  peek(o = 0) { return this.ts[this.i + o]; }
  next() { return this.ts[this.i++]; }
  is(v: string, o = 0) { return this.peek(o)?.v === v; }
  expect(v: string) { const t = this.next(); if (t?.v !== v) throw new Error(`expected "${v}" but found "${t?.v ?? "end"}"`); }

  expr(): Node {
    let l = this.term();
    while (this.is("+") || this.is("-")) { const op = this.next().v as "+" | "-"; l = { k: "bin", op, l, r: this.term() }; }
    return l;
  }
  term(): Node {
    let l = this.unary();
    while (this.is("*") || this.is("/")) { const op = this.next().v as "*" | "/"; l = { k: "bin", op, l, r: this.unary() }; }
    return l;
  }
  unary(): Node {
    if (this.is("-") && this.peek(1)?.t === "num") { this.next(); return { k: "num", v: -Number(this.next().v) }; }
    if (this.is("(")) { this.next(); const e = this.expr(); this.expect(")"); return e; }
    if (this.peek()?.t === "num" && !this.isTfAt(0)) return { k: "num", v: Number(this.next().v) };
    return this.ref();
  }
  isTfAt(o: number) {
    const a = this.peek(o), b = this.peek(o + 1);
    return a?.t === "num" && (b?.v === "MINUTE" || b?.v === "MINUTES" || b?.v === "MIN" || b?.v === "HOUR");
  }
  ref(): Node {
    let off = 0;
    if (this.is("[")) {
      this.next();
      let sign = 1;
      if (this.is("-")) { this.next(); sign = -1; } else if (this.is("+")) this.next();
      const n = this.next();
      if (n?.t !== "num") throw new Error("expected a number inside [ ]");
      off = Math.abs(sign * Number(n.v));
      this.expect("]");
    }
    let tf: TF;
    const a = this.peek();
    if (this.isTfAt(0)) {
      const n = Number(this.next().v), unit = this.next().v;
      tf = (unit === "HOUR" ? n * 60 : n) as TF;
      if (![5, 15, 30, 60].includes(tf as number)) throw new Error(`timeframe ${n} ${unit.toLowerCase()} is not supported (5, 15, 30, 60 minute)`);
    } else if (a?.v === "DAILY" || a?.v === "LATEST" || a?.v === "DAY") { this.next(); tf = "D"; }
    else if (a?.v === "WEEKLY" || a?.v === "WEEK") { this.next(); tf = "W"; }
    else if (a?.v === "CHAIN" || a?.v === "OPTION") { this.next(); if (this.is("CHAIN")) this.next(); tf = "chain"; }
    else throw new Error(`expected a timeframe (e.g. "15 minute", "daily") before "${a?.v ?? "end"}"`);
    // name: one or more words
    const words: string[] = [];
    while (this.peek()?.t === "word" && !["CROSSED_ABOVE", "CROSSED_BELOW", "AND", "OR"].includes(this.peek()!.v)) words.push(this.next().v);
    const fn = words.join(" ");
    if (!fn) throw new Error("expected a field or function name");
    const args: (string | number)[] = [];
    if (this.is("(")) {
      this.next();
      while (!this.is(")")) {
        const t = this.next();
        if (!t) throw new Error("missing )");
        if (t.v === ",") continue;
        args.push(t.t === "num" ? Number(t.v) : t.v);
      }
      this.next();
    }
    if (tf === "chain") { if (!CHAIN.includes(fn)) throw new Error(`unknown chain value "${fn}" (use ${CHAIN.join(", ")})`); }
    else if (!FIELDS.includes(fn) && !FNS.includes(fn)) throw new Error(`unknown field or function "${fn}"`);
    return { k: "ref", off, tf, fn, args };
  }
}

export function parseCondition(line: string): Cond {
  const ts = lex(line.replace(/crossed\s+above/i, " CROSSED_ABOVE ").replace(/crossed\s+below/i, " CROSSED_BELOW "));
  const p = new P(ts);
  const l = p.expr();
  const o = p.next();
  if (!o) throw new Error("missing comparison (>, <, >=, <=, =, crossed above/below)");
  const op: Op | undefined = o.v === "CROSSED_ABOVE" ? "xa" : o.v === "CROSSED_BELOW" ? "xb" :
    ({ ">": ">", "<": "<", ">=": ">=", "<=": "<=", "=": "=", "==": "=" } as Record<string, Op>)[o.v];
  if (!op) throw new Error(`"${o.v}" is not a comparison`);
  const r = p.expr();
  // anything after a complete condition (e.g. "Segment: Futures" pasted on the same line) is ignored
  const rest = p.peek() ? ts.slice(p.i).map((x) => x.v).join(" ") : "";
  const consumed = rest ? line.slice(0, line.toUpperCase().lastIndexOf(rest.split(" ")[0])).trim() : line.trim();
  return { l, op, r, text: consumed || line.trim() };
}

export interface ParseResult { rule: Rule | null; errors: { line: number; text: string; error: string }[] }

export function parseRule(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const conds: Cond[] = [];
  const errors: ParseResult["errors"] = [];
  let mode: Rule["mode"] = "ALL";
  lines.forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    if (/passes\s+any/i.test(line)) { mode = "ANY"; return; }
    if (/passes\s+all/i.test(line)) { mode = "ALL"; return; }
    if (!/(>|<|=|crossed\s+(above|below))/i.test(line)) return; // titles, "Segment: Futures", notes
    try { conds.push(parseCondition(line)); } catch (e) { errors.push({ line: n + 1, text: line, error: (e as Error).message }); }
  });
  if (!conds.length && !errors.length) errors.push({ line: 0, text: "", error: "no conditions found (each condition goes on its own line, e.g. [0] 15 minute Close > [0] 15 minute VWAP)" });
  const tfs = new Set<TF>();
  const walk = (x: Node) => { if (x.k === "ref") tfs.add(x.tf); else if (x.k === "bin") { walk(x.l); walk(x.r); } };
  conds.forEach((c) => { walk(c.l); walk(c.r); });
  return { rule: errors.length ? null : { mode, conds, tfs: [...tfs] }, errors };
}

/** How the rule is evaluated: intraday on the smallest intraday timeframe, or once per day. */
export function baseOf(rule: Rule): { mode: "intraday" | "daily"; tf: 5 | 15 | 30 | 60 } {
  const intra = rule.tfs.filter((t): t is 5 | 15 | 30 | 60 => typeof t === "number");
  return intra.length ? { mode: "intraday", tf: Math.min(...intra) as 5 | 15 | 30 | 60 } : { mode: "daily", tf: 15 };
}

// ---------------------------------------------------------------- evaluation
export interface Env {
  /** value of a ref at base position i (NaN if not available) */
  ref: (r: Extract<Node, { k: "ref" }>, i: number) => number;
}
function val(n: Node, e: Env, i: number): number {
  if (n.k === "num") return n.v;
  if (n.k === "ref") return e.ref(n, i);
  const a = val(n.l, e, i), b = val(n.r, e, i);
  return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : b === 0 ? NaN : a / b;
}
const shift = (n: Node): Node => (n.k === "ref" ? { ...n, off: n.off + 1 } : n.k === "bin" ? { ...n, l: shift(n.l), r: shift(n.r) } : n);

export function condTrue(c: Cond, e: Env, i: number, liveOnlyChain: boolean): boolean | null {
  const usesChain = JSON.stringify(c).includes('"tf":"chain"');
  if (usesChain && liveOnlyChain) return null; // not testable on history
  const a = val(c.l, e, i), b = val(c.r, e, i);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  switch (c.op) {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "=": return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    case "xa": case "xb": {
      const pa = val(shift(c.l), e, i), pb = val(shift(c.r), e, i);
      return c.op === "xa" ? pa <= pb && a > b : pa >= pb && a < b;
    }
  }
}

/** history = true: chain conditions are skipped (counted as passed) because there is no chain history. */
export function ruleTrue(rule: Rule, e: Env, i: number, history: boolean): boolean {
  const rs = rule.conds.map((c) => condTrue(c, e, i, history));
  const testable = rs.filter((x) => x !== null) as boolean[];
  if (!testable.length) return false;
  return rule.mode === "ALL" ? testable.every(Boolean) : testable.some(Boolean);
}
