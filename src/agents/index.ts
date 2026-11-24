/** Agent registry. Add a new agent: create src/agents/<name>.ts exporting an Agent, then list it here. */
import { AGENTS_ENABLED } from "../config";
import { breakout15, preBreakout, trigger5 } from "./breakouts";
import { btst } from "./btst";
import { gap } from "./gap";
import { heroZero } from "./heroZero";
import { avwapReclaim, emaReclaim, indexScalp, vaSweep } from "./intraday";
import { momentum } from "./momentum";
import { oiBuildup } from "./oiBuildup";
import { expiryDecay, premiumDecay } from "./selling";
import { swing } from "./swing";
import type { Agent } from "./types";

export const ALL_AGENTS: Agent[] = [
  momentum, oiBuildup, gap, btst,
  breakout15, trigger5, preBreakout,
  vaSweep, emaReclaim, avwapReclaim, indexScalp, swing,
  premiumDecay, expiryDecay, heroZero,
];

/** Built-in agents switched on, after the on/off switches you set on the website (stored overrides). */
export const isEnabled = (name: string, overrides: Record<string, boolean> = {}) =>
  overrides[name] ?? AGENTS_ENABLED[name] ?? true;

export const activeAgents = (run: Agent["runs"][number], overrides: Record<string, boolean> = {}, extra: Agent[] = []) =>
  [...ALL_AGENTS.filter((a) => isEnabled(a.name, overrides)), ...extra].filter((a) => a.runs.includes(run));
