/** What an agent sees and what it returns. Agents never price options or size trades: the engine does that. */
import type { IST } from "../calendar";
import type { Structure } from "../config";
import type { Bar } from "../dhan";
import type { Path, Rules } from "../engine/evaluate";
import type { Chain } from "../engine/options";
import type { DBar } from "../history";
import type { Inst } from "../universe";

export type Horizon = "intraday" | "btst" | "positional";

export interface Ctx {
  now: IST;
  inst: Inst;
  today: Bar[];                 // today's closed 5-min futures bars (with OI)
  hist: Map<string, Bar[]>;     // past sessions' 5-min futures bars
  daily: DBar[];                // ~2 years of daily bars (spot for index/stock, future for crude)
  quote: any | null;            // Dhan quote of the future: last_price, ohlc, volume, oi, net_change
  futPx: number;                // latest future price
  prevClose: number;            // previous session close of the future
  chain: (minDaysToExpiry: number) => Promise<Chain | null>;
  event: boolean;               // an event day from config EVENTS
  benchmark: DBar[];            // NIFTY daily bars, for relative strength
  ivRank: (c: Chain) => Promise<number | null>; // 0-100 from stored ATM IV history, null if < 20 days
}

export interface Candidate {
  agent: string;
  setup: string;                // e.g. "orb_long"
  dir: 1 | -1 | 0;              // 0 = non-directional (option selling / straddle)
  horizon: Horizon;
  status: "WAIT" | "ENTER";
  trigger?: string;             // "5-min close above 24,312"
  entry: number;                // underlying (future) price the levels refer to
  sl: number; t1: number; t2: number; t3?: number;
  paths: Path[];                // history: same setup, same instrument, scaled to today's volatility
  rules: Rules;
  structures: Structure[];      // what the engine may build for this idea
  minDaysToExpiry: number;      // option expiry choice
  ivMult?: number;              // theta: assumed IV drift by exit
  why: string[];                // plain reasons, shown on tap
  validUntilMin: number;        // IST minutes; after this a WAIT/ENTER expires
  riskRefPerUnit?: number;      // undefined-risk structures: loss per unit at the stop
  maxHoldMin?: number;          // time stop in minutes (scalps)
  premiumRange?: [number, number]; // hero-zero: pick OTM strikes whose premium sits in this range
}

export interface Agent {
  name: string;
  /** Which run this agent takes part in. */
  runs: ("preopen" | "cycle" | "btst" | "mcx")[];
  scan(ctx: Ctx): Promise<Candidate[]>;
}
