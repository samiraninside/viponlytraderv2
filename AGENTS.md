# The agents

Each agent is one file in `src/agents/`. It looks at one instrument, using today's 5-min futures
bars with OI, about 60 past sessions, 2 years of daily bars, the live quote and, when it asks, the
option chain. It returns ideas, called candidates, each with:

- the setup and direction, the horizon (intraday, BTST or 2–3 days) and the status (WAIT or ENTER);
- the levels on the future: entry, SL, T1, T2 (and T3);
- **the same rule's past occurrences on this instrument**, as price paths rescaled to today's risk;
- which structures may be built from it.

The engine (`src/engine/`) then builds every allowed structure from the live chain. It replays each
structure along those historical paths, valuing the options with Black-Scholes at each step and
applying SL, half at T1, the rest at T2 and the square-off time. It deducts charges and computes win
rate and expected value. The **score** is `100 / (1 + e^(−4 × EV/risk × n/(n+10)))`: 50 means no
edge, and few samples pull the score toward 50. Each profile gets the best-scoring structure it can
afford within its risk per trade, lots and margin. Only ideas scoring 55 or more with a positive
expected value reach the board.

| agent | file | runs | idea |
| --- | --- | --- | --- |
| **breakout15** | `breakouts.ts` | NSE cycle, MCX | **Scanner A** (15-min confirmed bullish breakout) and **Scanner D** (bearish breakdown), exactly your conditions; SL = max(signal-bar low, close − 1.5 ATR) |
| **trigger5** | `breakouts.ts` | NSE cycle, MCX | **Scanner B** 5-min bullish entry trigger, plus its mirror short (`mirrorShort`) |
| **preBreakout** | `breakouts.ts` | NSE cycle, MCX | **Scanner C** pre-breakout accumulation → **Watchlist** (WAIT) card: "enter on a 15-min close above the 10-bar high" |
| vaSweep | `intraday.ts` | NSE cycle, MCX | **Value Area Liquidity Sweep**: sweep beyond yesterday's value-area edge, close back inside; targets POC then the far edge |
| emaReclaim | `intraday.ts` | NSE cycle, MCX | **EMA20 Pullback Reclaim**: 15-min trend (EMA20 vs EMA50), 5-min pullback to EMA20, reclaim with a close past the previous bar |
| avwapReclaim | `intraday.ts` | NSE cycle, MCX | **Anchored VWAP Reclaim**: VWAP anchored at the 3-session swing low/high, crossed back with volume ≥ 1.5× |
| indexScalp | `intraday.ts` | NSE 09:30–14:30 | **Index Scalping Long**: EMA9 > EMA21, above VWAP, RSI 55–75, volume; 30-minute time stop |
| swing | `swing.ts` | 14:50–15:20, MCX 22:30 | **Swing/BTST** with your filters: price > ₹100, 20-day traded value > ₹20 Cr, close above the 20-day high, volume ≥ 1.5×, above EMA20 and EMA50, RSI 55–75, weekly trend up, outperforming NIFTY 50 over 20 sessions, R:R ≥ 1:2 (mirrored for shorts) |
| premiumDecay | `selling.ts` | NSE 13:00–15:15, MCX 18:00–22:00 | **Premium Decay Selling**, defined risk only: iron condor or fly, or a credit spread on the 15-min trend side, 1–5 sessions to expiry, IV rank ≥ 50 (or rich premium) |
| expiryDecay | `selling.ts` | expiry day 09:45–12:30 | **Expiry Premium Decay**: iron fly or condor on calm expiry days only (skips if price moved > 0.6× daily ATR from the open), stop at the breakevens |
| heroZero | `heroZero.ts` | expiry day 13:30–14:45 | **Hero-Zero**: coiled index on expiry afternoon → cheap OTM call/put (near the high/low) or OTM strangle, premium ₹4–25 (NIFTY); hold to square-off; max loss = premium |
| momentum | `momentum.ts` | NSE cycle, MCX | 15-min opening-range breakout with VWAP and volume |
| oiBuildup | `oiBuildup.ts` | NSE cycle, MCX | after 10:00: futures price + OI build-up |
| gap | `gap.ts` | pre-open, first 30 min | gap ≥ 0.35 × daily ATR, "go" and "fade" scored separately |
| btst | `btst.ts` | 14:50–15:20, MCX 22:30 | strong or weak close into tomorrow's open, or 2–3 days; always hedged |

**Bull Call Spread (defined-risk directional options):** this is a structure, not a separate agent. Every directional idea is also priced as a bull call spread (or a bear put spread) at two widths. The Basic profile only ever gets option buys and spreads.

## The layers on top of the agents

- **Option Chain Confirmation** (`src/engine/confirm.ts`) checks every directional idea against the chain:
  - PCR;
  - near-ATM OI change (put writing vs call writing);
  - distance to the nearest OI wall;
  - the futures build-up type (long build-up, short covering, short build-up, long unwinding);
  - IV rank.

  The result is a badge: **confirms / neutral / conflicts**. There is no history of option chains to score this against, so it adjusts the rank (±6) and does not touch the history-based score.
- **Better Opportunity Finder** (`src/scan.ts`, `RANKING` in config):
  - When several agents flag the same instrument and direction, they merge into one card, credited to all of them ("also flagged by…").
  - `rank = score + 6 × chain verdict + 3 per extra agreeing agent (max +9)`.
  - The top 10 is sorted by rank, with at most 2 cards per underlying.
- **Filters on every directional idea** (`FILTERS`): the final target must be at least 2R; stocks must be above ₹100 with a 20-day average traded value above ₹20 Cr.
- **Hedge Optimizer** (`src/hedge.ts`, `HEDGE` in config):
  - Every 15 minutes it reads your open F&O positions from Dhan (read-only).
  - It shows net delta, gamma, vega and theta per underlying, and the P&L on a ±2% move.
  - When the delta exposure is above half of the profile's capital, it proposes hedges (ATM or OTM protective option, or futures) that remove about half the delta, ranked by stress loss removed per rupee.
- **Averaging plan** (`src/engine/averaging.ts`, `AVERAGING` in config), ported from the old Python engine:
  - Mid and Big only (Basic never averages). Futures, option buys and debit spreads only.
  - Breakouts and momentum **pyramid**: +1 lot at 0.382 / 0.5 / 0.618 of the way from entry to T1.
  - Reclaim, sweep and pre-breakout setups **average**: +1 lot at the same Fibonacci points between entry and the stop.
  - At most 2 adds. The stop does not move in the maths, so an add is listed only if the total loss at the stop stays inside the profile cap (₹2,000 / ₹5,000 / ₹10,000) and its cost fits the 30% reserve. Skipped adds say why.
  - T1 and T2 are re-projected from the new average with the original reward distances.
- **Push cap:** at most 10 push alerts a day per profile, best rank first.
- **Naked selling** is off (`ALLOW_NAKED_SELLING = false`). All option selling is defined-risk.

## Your own scanners (website → Scanners)

Write rules, one per line, in Chartink style. The rule language (`src/custom/dsl.ts`) reproduces scanners A–D bar for bar; `test/dsl.test.ts` checks this. A saved scanner becomes an agent:

- **Same treatment as the built-in agents:** same history replay, scoring, chain check, ranking, push and track record.
- **When it runs:** intraday on the smallest timeframe you use, or once a day near the close if you only use daily or weekly lines.
- **Options:** direction (long or short), segments, stop (`atr:1.5`, `pct:1`, `swing:3`), targets in R, and the hold (1 = BTST, 3 = swing).
- **Chain lines** (`[0] chain PCR > 1.1`, `[0] chain Vega Diff > 0`) are applied live only, because there is no history of option chains to test them on.
- **Not supported:** Chartink's nested form `Max(10, [0] 15 minute High)`. Write `[0] 15 minute Max(10,High)`.

## Changing an agent

Every agent file starts with a `settings` block. Change a number, run `npm test`, then `npm run deploy`.
For example, in `momentum.ts`:

```ts
export const settings = {
  rangeMinutes: 15,       // try 30 for a slower opening range
  minRelVolume: 1.1,
  requireVwap: true,
  ...
};
```

Turn an agent off in `src/config.ts` → `AGENTS_ENABLED`.

You can also ask Claude, e.g.:

- "In the momentum agent, use a 30-minute opening range and require 1.5× volume."
- "Add stock options to the theta agent."
- "Make the BTST agent also require a 20-day closing high."
- "Add an agent for VWAP pullbacks in an uptrend."

## Adding an agent

1. Create `src/agents/myagent.ts` exporting an `Agent` with `name`, `runs`, and `scan(ctx)` that returns `Candidate[]`. Copy `momentum.ts` as a template.
2. Build `paths` with the same rule on past days: use `intradayHistory()` for intraday rules and `dailyPath()` for overnight rules. **No history, no score:** a candidate with no past occurrences is dropped.
3. List it in `src/agents/index.ts` and `AGENTS_ENABLED`.
4. Add a test in `test/` and run `npm test`.

## Rules that keep it honest

- **Same rule:** an agent must use exactly the same rule for today and for its history.
- **Closed bars only:** agents only see closed bars.
- **Freshness:** a trigger older than two bars is not shown as ENTER.
- **Overnight:** no naked futures overnight. The Basic profile only gets defined-risk structures.
