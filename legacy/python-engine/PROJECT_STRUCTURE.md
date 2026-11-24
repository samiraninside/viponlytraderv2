# VIPONLYTRADER Agent Engine — Project Structure

```
trading_agent_engine/
├── config/
│   ├── __init__.py
│   ├── settings.py            # All env vars, Dhan creds, DB path, tier configs
│   └── database.py            # SQLite schema (migrate to Postgres later)
├── data/
│   ├── __init__.py
│   ├── dhan_client.py         # Dhan REST + Websocket client (primary data pipe)
│   ├── indicators.py          # Technical indicators (EMA, VWAP, RSI, ATR, etc.)
│   └── models.py              # Signal, Trade, Order, User, Subscription dataclasses
├── agents/
│   ├── __init__.py
│   ├── base_agent.py          # Abstract Agent base class (plug-and-play)
│   ├── scanner_agent.py       # Scanners A-D (15m breakout, pre-breakout, OI, bearish)
│   ├── strategy_engine.py     # 18 strategy logic executor
│   ├── oi_analysis_agent.py   # PCR, Max Pain, OI surge, IV rank
│   ├── vega_greeks_agent.py   # Portfolio delta/vega/theta exposure
│   ├── averaging_logic_agent.py # Fibonacci add-lot + target re-projection
│   ├── risk_tier_agent.py     # Tier-based risk enforcement (₹2k cap, etc.)
│   └── signal_aggregator.py   # Combines all agent outputs into final signals
├── scheduler/
│   ├── __init__.py
│   └── cron_jobs.py           # Scheduled jobs (market open, 5min, EOD)
├── notification/
│   ├── __init__.py
│   └── dispatcher.py          # WhatsApp, push, admin alerts
├── main.py                    # Entry point: starts all agents
├── requirements.txt
├── .env.example
└── README.md
```

**Design Principles:**
- Each agent is a standalone class with `scan()`, `validate()`, and `emit()` methods.
- Agents communicate via a shared `SignalBus` (in-memory pub/sub) — future: Redis.
- New agents can be dropped into `agents/` without touching existing code.
- Config is env-based; no hardcoded secrets.
- SQLite for local dev; swap to Postgres via `config/database.py`.