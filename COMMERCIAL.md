# Commercial switches (on hold)

VIPONLYTRADER runs in **personal mode** while you test the signals on your own account. The parts
that only matter once other people pay for the calls are on hold. They need SEBI work first (Research
Analyst registration, the advertising code, PaRRVA-verified performance, algo-provider empanelment for
any order placement, a PMS licence for managed accounts). The code already has a place for each, so
turning them on later is a configuration change plus the listed work, not a rewrite.

## Already in place

| Provision | Where | What it does now | What it becomes |
| --- | --- | --- | --- |
| Publish gate | `src/publish.ts` | Every call passes through it before it is written to the ledger. It attaches the disclosure and runs the checks (banned wording, stop-loss present, max loss present), but in personal mode it never blocks. | Set `COMMERCIAL.requireCompliance = true` and failing calls are held back (status WAIT, reason shown). Add checks to `CHECKS` as your compliance adviser directs. |
| Disclosure | `COMMERCIAL.disclosure`, `COMMERCIAL.registration` in `src/config.ts` | "Personal research tool. Not investment advice." in the footer and on every published call. | Your registered disclosure text and registration number on every call, page and push. |
| Signal ledger | `src/ledger.ts`, table `ledger` | Hash-chained record of every call, outcome, journaled trade, kill-switch and config change. Tamper check at `/api/ledger/verify`, full export at `/api/ledger/export`. | Your record keeping and the raw data for a performance-verification agency. Keep it from day one: a track record can't be rebuilt later. |
| Audit log | `CONFIG` and `KILL` rows in the ledger | Agent on/off (yours and auto-pause), scanner create/edit/delete, kill switch, data-health changes. | Audit trail for an inspection. |
| Users and plans | tables `users`, `subscriptions` (empty) | Not used. One login (password or Cloudflare Access). | Per-user login, plan → profile (Basic / Mid / Big), push subscriptions per user (the `subs` table already stores a profile). |
| Profiles as tiers | `PROFILES` in `src/config.ts` | Three risk profiles with ₹2,000 / ₹5,000 / ₹10,000 caps. | The plan a subscriber pays for decides which profile's board they see. |

## Not built, on purpose

- **Order placement for anyone else** (broker bridge, force-exit): needs algo-provider empanelment
  under SEBI's retail algo framework. Dhan stays read-only.
- **Portfolio management**: needs a PMS licence and has a ₹50 lakh minimum per client.
- **Growth agents** (content, ads, voice): advertising performance needs verified numbers and the
  advertising code. Build these after registration, with the publish gate switched on.
- **Live prices to subscribers**: check Dhan's terms and exchange data licensing before showing
  real-time prices to other users. Signals (entry, stop, targets) are the product; prices are not.

## Turning commercial mode on (later)

1. Registration done and your adviser has reviewed the disclosure text and the banned-wording list.
2. In `src/config.ts`: `COMMERCIAL.mode = "commercial"`, `requireCompliance = true`, set `disclosure` and `registration`.
3. Build per-user login and plans on the `users` / `subscriptions` tables, and map each plan to a profile.
4. Keep the ledger running. Never edit or delete its rows; `/api/ledger/verify` must stay green.
