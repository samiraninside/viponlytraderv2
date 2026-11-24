# VIPONLYTRADER Scanner

A personal scanner for Indian markets only: NSE / BSE index and stock F&O, and MCX crude oil.
It runs on Cloudflare every 5 minutes, scores every idea by replaying it on the instrument's own
history, and shows the best 10 for your profile (Basic ₹50K, Mid ₹1–5L, Big ₹10L+) on your
tablet, with push alerts. **It never places orders.** You trade in the Dhan app yourself.

## What you get on the tablet

- **Top 10 cards per profile**. Each card shows:
  - **Status:** ENTER (act now) or WAIT (with the exact trigger).
  - **What to trade:** future, option buy, debit spread, future plus protective option, straddle, iron fly or condor, or short strangle (Big profile only).
  - **Levels:** entry, SL, T1, T2 (and T3 for 2–3 day ideas) as premium or future price, plus the matching levels on the future.
  - **Size and risk:** lots for your profile, approximate margin, max loss at the stop, and the worst case if the stop isn't honoured.
  - **Odds:** expected value after charges, and the win % with its sample size ("thin evidence" when there were few past cases).
  - **Exit time:** intraday square-off time, "next open" for BTST, or the exit date.
  - **Why:** the reasons, revealed with one tap.
- **Filters:** Intraday · BTST · 2–3 days · Option selling · Watchlist (pre-breakouts and other WAIT ideas) · Hedges.
- **Agents and option-chain check:** each card names every agent that flagged it, and carries an option-chain badge (confirms / neutral / conflicts) with the reasons under "Why".
- **Hedges tab:** your open F&O book from Dhan (delta, gamma, vega, theta, ±2% P&L) and hedge ideas when the exposure is large for the profile.
- **Track record:** every ENTER card is followed to its outcome (T1, T2, SL or time exit, in R), grouped by score band and by agent, so you can see whether high scores really do better.
- **Scanners tab:** write your own scanner in Chartink-style rules (your Scanner A text works as pasted), **Check rules**, **Test on the market** (today's passes and each instrument's history, in R), then **Save**. It runs every 5 minutes like the built-in agents. Built-in agents can be switched on and off on the same page.
- **Greeks tab:** every 15 minutes for each index and crude, the call vega vs put vega of the nearest expiry, weighted by open interest. It shows the difference and how it has changed today, plus the ATM call and put IV, theta, and a chart of put − call vega through the day. Custom scanners can use `[0] chain Vega Diff`, `Call Vega`, `Put Vega`, `IV Rank` and `PCR`.
- **Hero-Zero (expiry day):** after 13:30 on an index's expiry day, if the index is coiled (narrow range), it suggests cheap OTM options (₹4–25 on NIFTY) or an OTM strangle. Max loss is the premium. It is scored on history like everything else, so expect few cards.
- **⚙ Settings:** Dhan status and connection test, login mode, push keys.
- **Push alerts:** when a card turns ENTER with a score of 75 or more for your profile. Quiet from 23:59 to 07:30.

## The schedule (IST, automatic)

| time | job |
| --- | --- |
| 08:00 | new Dhan access token from your PIN + TOTP (no manual login) |
| 08:05 | universe: NIFTY, BANKNIFTY, FINNIFTY, SENSEX, top 50 F&O stocks by yesterday's futures turnover, CRUDEOIL, CRUDEOILM; near-month futures, rolled 3 days before expiry |
| 08:15 | history: 5-min futures bars with OI (~3 months) and 2 years of daily bars |
| 09:10 | pre-open gap list |
| 09:20–15:30 | every 5 min: all agents, scoring, tracking, push |
| 14:50–15:20 | BTST and 2–3 day ideas added |
| 09:05–23:40 | MCX crude every 5 min (to 23:30 or 23:55 with US daylight saving) |
| 15:50 | turnover ranking for tomorrow's top 50 |

The 2026 NSE and MCX holiday calendars are built in, including MCX days where only one session is closed. F&O closed at 15:30 until 31 Jul 2026, closes at 15:40 from 3 Aug 2026, and at 15:45 from 7 Dec 2026, when index contracts close at 15:30 on their expiry day. **Add the 2027 holidays** to `EXTRA_HOLIDAYS` in `src/calendar.ts` when the exchanges publish them; the app shows a note until you do.

## Where Dhan plugs in (the only 3 places)

1. **In Dhan:**
   - Keep the **Data API** subscription active. It provides intraday charts, quotes and the option chain.
   - Enable **TOTP** on your account and save the **TOTP secret key** shown during setup (the text under the QR code).
2. **In Cloudflare:** add three Secrets to the Worker: `DHAN_CLIENT_ID`, `DHAN_PIN` (your 6-digit Dhan PIN) and `DHAN_TOTP_SECRET`. The Worker logs in to Dhan by itself every morning with these. The code that uses them is `src/dhan.ts`.
3. **In the app:** go to ⚙ Settings → **Test Dhan connection**. It checks login, a live NIFTY quote (Data API) and your positions (read-only).

No order API is used, so no static IP is needed.

## Deploy, mostly in the Cloudflare dashboard (about 30 minutes, once)

**A. Put the code on GitHub**

Create a **private** repository (e.g. `viponly-scanner`) and upload this folder: the GitHub website → Add file → Upload files works. Alternatively, connect the repository to Claude and it can push the code for you.

**B. Cloudflare account**

1. Sign up at dash.cloudflare.com.
2. Go to Workers & Pages → **Plans** and choose **Workers Paid** ($5/month).

**C. Database**

1. Go to Storage & Databases → **D1** → **Create**, and name it `viponly-scanner`.
2. Copy its **Database ID** into `wrangler.toml` on GitHub, where it says `REPLACE_WITH_ID_FROM_wrangler_d1_create`, and commit.
3. Open the database → **Console**, paste the whole of `schema.sql` and run it.

**D. Create the Worker from GitHub**

1. Go to Workers & Pages → **Create** → **Import a repository**, and pick your repository.
2. Keep the deploy command `npx wrangler deploy` and deploy.

From then on, every push to GitHub redeploys automatically.

**E. Secrets**

1. Open the Worker → Settings → **Variables and Secrets** → Add, with the type set to **Secret**.
2. Add `DHAN_CLIENT_ID`, `DHAN_PIN`, `DHAN_TOTP_SECRET` and `APP_PASSWORD` (your login password for the app).
3. After your first login, use ⚙ Settings → **Generate push keys** to create `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_JWK`, then add `VAPID_SUBJECT` (`mailto:you@example.com`).

**F. Open it**

1. Open `https://viponly-scanner.<your-subdomain>.workers.dev` and log in.
2. In ⚙ Settings, run **Test Dhan connection**.
3. On the next trading day at 08:00 IST the token, universe and history jobs run by themselves. Tap 🔔 on the tablet to turn on alerts.

**Command-line alternative** (Node.js 20+): `npm install`, `npx wrangler login`, `npx wrangler d1 create viponly-scanner`, `npm run db:init`, `npx wrangler secret put …` for each secret, then `npm run deploy`.

## DNS: only if you want your own address

- **No DNS change** is needed to use the `workers.dev` address.
- **For `scanner.viponlytrader.com`:** Cloudflare can only attach a Worker to a domain whose DNS it runs. Add `viponlytrader.com` to Cloudflare (Add a domain). It imports your existing records: check that every record you use today is there, including A records for current sites and MX records for email. Then change the two **nameservers** at your registrar to the ones Cloudflare gives you.
- Once the domain shows **Active**, open the Worker → Settings → **Domains & Routes** → **Add custom domain** → `scanner.viponlytrader.com`. Cloudflare creates the DNS record and the HTTPS certificate itself. Don't create a CNAME for that name first.
- **Optional, stronger login:** Zero Trust → Access → protect `scanner.viponlytrader.com` with your email. Then set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as secrets and set `workers_dev = false`.

## On the Android tablet

1. Open the URL in **Chrome**, log in, then use Chrome's menu → **Add to Home screen / Install app**.
2. Open it from the home screen, pick your profile, tap **🔔** and allow notifications. A test notification confirms push works. Alerts follow the profile that was selected when you tapped the bell.

## First week checklist

- `/api/status`: the `token`, `universe` and `history` jobs show today's date and `error: null`, and the universe lists your instruments.
- The status line under the filters shows the last scan time and how many instruments it covered.
- Compare one card's premium, lot size and margin with the Dhan app. Margins are estimates (`MARGIN` in `src/config.ts`), so tune them if Dhan differs.
- This was tested end to end on a simulated trading day with a fake Dhan API, not against your live account. If a Dhan call fails, the error appears in `/api/status` or under `lastRun` in `/api/cards`.

## Changing things

- Profiles, risk per trade, lots, universe size, schedule, charges, margins, push threshold and event days are all in `src/config.ts`.
- The agents are in `src/agents/`. See [AGENTS.md](AGENTS.md).
- After any change: `npm test`, then `npm run deploy`.

## Commands

```bash
npm test            # offline tests, including a simulated full trading day
npm run typecheck
npm run dev         # local run; put secrets in .dev.vars (see .dev.vars.example)
npm run deploy
```

## Honest limits

- **Scores:** a score is history replayed, not a forecast. A new contract has only a few months of 5-min history, and news, results, RBI days and expiry moves can do what history never did.
- **Option pricing:** option outcomes are modelled with Black-Scholes, using today's IV from the chain (option selling assumes a small IV drop). Premium levels on cards are approximate.
- **Charges:** brokerage, STT at the April 2026 rates, exchange fees, GST and stamp duty are included approximately.
- **Defined risk only:** option selling is defined-risk only. If you turn `ALLOW_NAKED_SELLING` on, Big-profile strangle cards show the loss on the largest gap of the last year.
- **The chain check is a heuristic.** It moves the ranking a little and is never mixed into the history-based score.
- **Personal use only.** Sharing these calls with a group would need SEBI Research Analyst registration.

## History

`legacy/python-engine/` is the first Python skeleton of this project, kept for reference. Its useful
ideas now live in the Cloudflare build: the ₹2,000 / ₹5,000 / ₹10,000 risk caps, Fibonacci averaging
(`src/engine/averaging.ts`), no averaging on the Basic profile, and the 10-a-day alert cap.
It is not deployed and is not maintained.
