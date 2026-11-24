/**
 * The publish gate: every call passes through here before it is written to the ledger as
 * published. In personal mode it only attaches the disclosure. It is the single place to plug
 * in commercial checks later (compliance wording, entitlements, registration line) without
 * touching the agents or the engine. See COMMERCIAL.md.
 */
import { COMMERCIAL } from "./config";
import type { Card } from "./engine/opportunities";

export interface Check { name: string; run: (c: Card) => string | null }   // returns a problem, or null

/** Wording that a published call must never contain. Extend as your compliance adviser directs. */
const BANNED = [/guarantee/i, /sure[\s-]?shot/i, /jackpot/i, /risk[\s-]?free/i, /100\s?%/i, /assured/i, /multibagger/i];

export const CHECKS: Check[] = [
  { name: "wording", run: (c) => { const t = [c.trigger, ...c.why].join(" "); const hit = BANNED.find((r) => r.test(t)); return hit ? `banned wording ${hit}` : null; } },
  { name: "stop-loss", run: (c) => (c.levels && Number.isFinite(c.levels.sl) ? null : "no stop-loss") },
  { name: "max loss", run: (c) => (c.maxLoss > 0 || c.structure === "short_strangle" ? null : "max loss missing") },
];

export function publish(c: Card): { ok: boolean; problems: string[]; disclosure: string } {
  const problems = CHECKS.map((k) => k.run(c)).filter((x): x is string => !!x);
  const disclosure = COMMERCIAL.registration ? `${COMMERCIAL.disclosure} Reg. no. ${COMMERCIAL.registration}.` : COMMERCIAL.disclosure;
  return { ok: !COMMERCIAL.requireCompliance || !problems.length, problems, disclosure };
}
