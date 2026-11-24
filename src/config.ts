/**
 * VIPONLYTRADER Scanner: everything you are likely to tune lives here.
 * Indian markets only: NSE / BSE equity derivatives and MCX commodities. Times are IST.
 * Change a value, run `npm run deploy`, done.
 */

export type ProfileId = "basic" | "mid" | "big";
export type Structure =
  | "future" | "long_option" | "debit_spread" | "credit_spread"
  | "iron_fly" | "iron_condor" | "short_strangle" | "fut_hedge" | "long_straddle" | "long_strangle";

export interface Profile {
  id: ProfileId;
  label: string;
  capital: number;          // rupees
  riskPerTrade: number;     // max loss per opportunity, rupees
  maxLots: number;
  maxMarginShare: number;   // a single opportunity may use this share of capital as margin
  structures: Structure[];  // what this profile may be shown
  overnightNeedsHedge: boolean;
  averaging: boolean;       // show a Fibonacci add-lot plan (paid from the reserve, inside riskPerTrade)
}

export const PROFILES: Profile[] = [
  {
    id: "basic", label: "Basic · ₹50K", capital: 50_000, riskPerTrade: 2_000, maxLots: 2, maxMarginShare: 0.6,
    structures: ["long_option", "debit_spread", "long_straddle", "long_strangle"], overnightNeedsHedge: true, averaging: false,
  },
  {
    id: "mid", label: "Mid · ₹1–5L", capital: 300_000, riskPerTrade: 5_000, maxLots: 4, maxMarginShare: 0.5,
    structures: ["future", "long_option", "debit_spread", "credit_spread", "iron_fly", "iron_condor", "fut_hedge", "long_straddle", "long_strangle"],
    overnightNeedsHedge: true, averaging: true,
  },
  {
    id: "big", label: "Big · ₹10L+", capital: 1_000_000, riskPerTrade: 10_000, maxLots: 10, maxMarginShare: 0.4,
    structures: ["future", "long_option", "debit_spread", "credit_spread", "iron_fly", "iron_condor", "short_strangle", "fut_hedge", "long_straddle", "long_strangle"],
    overnightNeedsHedge: true, averaging: true, // naked short strangles are allowed for Big; they always show the gap-loss line
  },
];

/** Index and commodity underlyings. Security ids are looked up from Dhan's instrument list each morning. */
export const INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"];
export const COMMODITIES = ["CRUDEOIL", "CRUDEOILM"];
/** Fallback index ids (Dhan IDX_I) if the instrument list cannot be read. */
export const INDEX_IDS: Record<string, string> = { NIFTY: "13", BANKNIFTY: "25", FINNIFTY: "27", SENSEX: "51" };

/** Stock universe: the top N F&O stocks by yesterday's futures turnover (recomputed after each close). */
export const STOCK_UNIVERSE_SIZE = 50;
/** Used until the first turnover ranking exists. */
export const STARTER_STOCKS = [
  "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "AXISBANK", "KOTAKBANK", "LT", "BHARTIARTL",
  "ITC", "BAJFINANCE", "MARUTI", "M&M", "TMPV", "TATASTEEL", "HINDALCO", "SUNPHARMA", "HCLTECH", "WIPRO",
  "ADANIENT", "ADANIPORTS", "ONGC", "NTPC", "POWERGRID", "COALINDIA", "BAJAJFINSV", "TITAN", "ULTRACEMCO", "ASIANPAINT",
  "JSWSTEEL", "VEDL", "INDUSINDBK", "BANKBARODA", "PNB", "CANBK", "DLF", "BEL", "HAL", "TRENT",
  "ETERNAL", "TECHM", "LTIM", "DRREDDY", "CIPLA", "HEROMOTOCO", "EICHERMOT", "BPCL", "IOC", "GRASIM",
];

/** Rupee value of one point per lot on MCX (lot units differ from contract multipliers). */
export const MCX_POINT_VALUE: Record<string, number> = { CRUDEOIL: 100, CRUDEOILM: 10 };

/** Approximate margins (shown with ≈). Dhan's own margin can differ: check before trading. */
export const MARGIN = {
  futurePctIndex: 0.12, futurePctStock: 0.2, futurePctCommodity: 0.4,
  shortOptionAsFuture: 1.0,   // naked short option ≈ this × future margin
  hedgedBuffer: 1.15,         // spreads / flies / condors ≈ max loss × buffer
};

/** Charges (approximate, from 1 Apr 2026 STT rates). Used in every EV and max-loss figure. */
export const CHARGES = {
  brokeragePerOrder: 20,
  sttOptionSellPct: 0.0015,   // on premium
  sttFutureSellPct: 0.0005,
  ctlMcxFutureSellPct: 0.0001, // MCX CTT, non-agri futures
  ctlMcxOptionSellPct: 0.0005,
  exchOptionPct: 0.0003503, exchFuturePct: 0.0000173, exchMcxPct: 0.000021,
  stampOptionBuyPct: 0.00003, stampFutureBuyPct: 0.00002,
  gstPct: 0.18,
  sebiPerCrore: 10,
};

/** Freeze quantities (units) for index derivatives from 1 Sep 2026. */
export const FREEZE_QTY: Record<string, number> = { NIFTY: 1800, BANKNIFTY: 600, FINNIFTY: 1800 };

/** Scoring. */
export const SCORE = {
  minSamples: 12,       // fewer paths than this: card says "thin evidence"
  shrinkK: 10,          // EV shrink: evR × n/(n+K)
  steepness: 4,         // score = 100 / (1 + e^(-steepness × evR))
  pushAt: 75,           // push when a card reaches this score
  minShow: 55,          // the board only shows ideas scoring at least this (positive expected value)
  topN: 10,
  maxPushPerDay: 10,    // at most this many push alerts a day per profile
  ivCrushFactor: 0.97,  // theta agent assumes IV drifts this much by exit
};

/** Schedule (IST). Intraday cycle runs every 5 minutes inside these windows. */
export const SCHEDULE = {
  tokenRefresh: "08:00",
  universe: "08:05",
  history: "08:15",
  preopen: "09:10",
  nseCycle: ["09:20", "15:30"] as [string, string],
  btst: ["14:50", "15:20"] as [string, string],
  mcxCycle: ["09:05", "23:40"] as [string, string],
  liquidity: "15:50",
  quietHours: ["23:59", "07:30"] as [string, string], // no push in this window
};

/** Entry windows: no new ENTER after these times (IST). */
export const ENTRY_WINDOW = { NSE: ["09:20", "14:45"], MCX: ["09:15", "22:45"] } as const;
/** Intraday square-off. NSE fixed time; MCX minutes before its close. */
export const SQUARE_OFF = { NSE: "15:15", mcxMinutesBeforeClose: 25 };

/** Event days (add RBI policy, budget, big results). Stocks: "SYMBOL:YYYY-MM-DD". Index/all: "ALL:YYYY-MM-DD". */
export const EVENTS: string[] = [
  "ALL:2026-12-04", // RBI policy (check the date)
];

/** Agent switches. Each agent also has its own `settings` block in src/agents/<name>.ts. */
export const AGENTS_ENABLED: Record<string, boolean> = {
  momentum: true, oiBuildup: true, gap: true, btst: true,
  breakout15: true, trigger5: true, preBreakout: true,           // your scanners A/D, B, C
  vaSweep: true, emaReclaim: true, avwapReclaim: true, indexScalp: true, swing: true,
  premiumDecay: true, expiryDecay: true, heroZero: true,
};

/** Option selling is defined-risk only. Set true to also allow naked short strangles (Big profile only). */
export const ALLOW_NAKED_SELLING = false;

/** Applied to every directional idea. */
export const FILTERS = {
  minRewardRisk: 2,            // final target must be at least 2R
  stockMinPrice: 100,          // ₹
  stockMinTradedValueCr: 20,   // 20-day average traded value, ₹ crore
};

/** Better Opportunity Finder: how cards are ranked across strategies. rank = score + bonuses. */
export const RANKING = {
  chainConfirm: 6,             // option chain confirms (+) or conflicts (−)
  perExtraAgent: 3,            // each additional agent agreeing on the same instrument and direction
  maxConfluence: 9,
  maxPerUnderlying: 2,         // at most this many cards per underlying in the top 10
};

/** Hedge optimizer: flag your open F&O book when the delta exposure is larger than this share of the profile capital. */
export const HEDGE = { deltaShareOfCapital: 0.5, stressMovePct: 0.02, everyMinutes: 15 };

/**
 * Averaging (from the old Python engine): add 1 lot at Fibonacci levels, at most `maxAdds` times.
 *  pyramid: adds on the way to T1 (0.382 / 0.5 / 0.618 of entry→T1), for breakouts and momentum.
 *  average: adds on a pullback (0.382 / 0.5 / 0.618 of entry→stop), for reclaim and sweep setups.
 * The stop never moves for the maths, so the plan only lists adds whose combined loss at the stop
 * stays inside the profile's riskPerTrade, and whose cost fits the reserve. Targets are re-projected
 * from the new average with the original reward distances. Agents not listed get no plan.
 */
export const AVERAGING = {
  fib: [0.382, 0.5, 0.618],
  maxAdds: 2,
  reserveShare: 0.3,           // keep this share of capital free; adds are paid from it
  structures: ["future", "long_option", "debit_spread"] as Structure[],
  mode: {
    breakout15: "pyramid", trigger5: "pyramid", momentum: "pyramid", oiBuildup: "pyramid", gap: "pyramid", swing: "pyramid",
    emaReclaim: "average", avwapReclaim: "average", vaSweep: "average", preBreakout: "average",
  } as Record<string, "pyramid" | "average">,
};

/** Auto-pause: switch an agent off when its live results are clearly negative (logged in the ledger; switch it back on in Scanners). */
export const AUTOPAUSE = { enabled: true, minTrades: 20, lookbackDays: 30, pauseBelowAvgR: -0.1 };

/**
 * Data health / kill switch. While data is unhealthy, no new ENTER is shown or pushed.
 *  staleBarMinutes: an instrument's last closed 5-min bar older than this (in market hours) counts as stale
 *  maxStaleShare: more than this share of instruments stale → segment unhealthy
 *  warmupMinutes: checks start this long after the session opens
 *  scanGapMinutes: no successful scan for this long in market hours → the site shows "data stale"
 */
export const HEALTH = { staleBarMinutes: 15, maxStaleShare: 0.3, warmupMinutes: 20, scanGapMinutes: 12 };

/** Don't chase: an ENTER card whose price already ran this many R past entry says "wait for a retracement". */
export const CHASE = { maxR: 0.5, retestR: 0.25 };

/**
 * Exit alerts on trades you journaled. One signal = CAUTION, two or more = EXIT. Stop/target levels always alert.
 * Signals: 5-min close on the wrong side of VWAP, of EMA20, an opposite ENTER on the same instrument,
 * the option chain flipping to "conflicts", and OI unwinding (price against you with OI falling over `oiBars`).
 */
export const EXITS = { exitAt: 2, oiBars: 3 };

/**
 * Commercial switches (all OFF for personal testing). See COMMERCIAL.md before changing any of them.
 *  mode: "personal" | "commercial"
 *  requireCompliance: every published call must pass the compliance hook (src/publish.ts) or it is held back
 *  disclosure: text attached to every published call and shown on the site
 *  registration: your SEBI registration number, shown with the disclosure once you have one
 */
export const COMMERCIAL = {
  mode: "personal" as "personal" | "commercial",
  requireCompliance: false,
  disclosure: "Personal research tool. Not investment advice.",
  registration: null as string | null,
};
