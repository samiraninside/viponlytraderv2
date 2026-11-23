# VIPONLYTRADER — Agentic Trading Engine

Modular, hot-reloadable multi-agent engine for Indian FnO markets (Dhan API).

## What this is

A plugin-based agent framework where every trading "skill" is an independent,
upgradable Python class. Add a new strategy by dropping one file into `agents/`.
Tune thresholds live via `set_params()` — no restart, no code edits.

## Architecture

```
Dhan API (REST + WebSocket)
        │
        ▼
   data layer  (dhan_client, indicators)
        │
        ▼
   SignalBus  (in-memory pub/sub)
        │
   ┌────┴─────────────────────────────────┐
   ▼            ▼            ▼            ▼
Scanner    Strategy        OI Analysis   Vega/Greeks
Agent      Engine Agent    Agent         Agent
   └────────────┬─────────────────────────┘
                ▼
        Risk Tier Agent   (tier SL caps, capital gating)
                ▼
        Signal Aggregator (dedupe, rank, cap 10/day)
                ▼
        Notification       (WhatsApp / push / admin)
```

## Agent roster

| Agent | Responsibility |
|---|---|
| `scanner_agent` | Scanners A–D: 15m breakout, 5m trigger, pre-breakout, bearish breakdown |
| `strategy_engine` | 18 strategy logics (EMA reclaim, VWAP, scalps, directional) |
| `oi_analysis_agent` | PCR, max pain, OI surge, IV rank → confidence adjustment |
| `vega_greeks_agent` | Portfolio delta/vega/theta exposure |
| `risk_tier_agent` | Tier 1/2/3 SL caps, capital gating, R:R floors |
| `averaging_logic_agent` | Fibonacci add-lot averaging + target re-projection (Tier 2/3) |
| `signal_aggregator` | Dedupe by symbol, rank by composite score, cap to 10/day |

## Risk tiers

| Tier | Capital | Max SL/trade | Averaging | Option selling |
|---|---|---|---|---|
| Tier 1 (Conservative) | ₹50k–₹1L | ₹2,000 hard cap | ✗ | ✗ |
| Tier 2 (Moderate) | ₹2L–₹5L | ₹5,000 | ✓ | ✗ |
| Tier 3 (Aggressive) | ₹10L+ | ₹10,000 | ✓ | ✓ |

## Quick start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Configure secrets
copy .env.example .env
# then edit .env with your Dhan client-id + access-token

# 3. Run (paper trading by default)
python main.py
```

## Adding a new agent

Create `agents/my_agent.py`:

```python
from .base_agent import BaseAgent
from data.models import Candidate

class MyAgent(BaseAgent):
    name = "my_agent"
    version = "1.0.0"
    description = "My custom edge"

    def required_data(self):
        return ["15m_ohlcv"]

    def scan(self, data):
        out = []
        # ... your logic ...
        return out
```

Register it in `main.py` → `build_registry()` and instantiate. Done.

## Project layout

```
trading_agent_engine/
├── config/          settings.py (env config), database.py, __init__.py
├── data/            models.py, db_models.py, indicators.py, dhan_client.py
├── agents/          base_agent.py, registry.py, signal_bus.py + all agents
├── scheduler/       cron_jobs.py (market-hours loop)
├── notification/    dispatcher.py
├── main.py          entry point
├── requirements.txt
├── .env.example
└── .gitignore
```

## Status

- [x] Agent framework (hot-reloadable, trainable)
- [x] Scanners A–D
- [x] Strategy engine (6 of 18 strategies implemented; rest are stubs to add)
- [x] OI analysis, Vega/Greeks, Risk tier, Averaging logic, Aggregator
- [x] DB schema (users, signals, trades, averaging, journal, xp)
- [ ] Dhan live data wiring (REST/WS → SignalBus)
- [ ] Notification dispatcher
- [ ] FastAPI gateway (Cloudflare Workers consumes this)
- [ ] Backtesting engine

## License

Proprietary — VIPONLYTRADER.
