"""VIPONLYTRADER Agent Engine — entry point.

Run with:  python main.py
"""
from __future__ import annotations

import logging
import os
import signal
import sys
from typing import Dict, List

from agents import (
    BaseAgent,
    AgentRegistry,
    get_registry,
    SignalBus,
    ScannerAgent,
    StrategyEngineAgent,
    OIAnalysisAgent,
    RiskTierAgent,
    AveragingLogicAgent,
    SignalAggregator,
    VegaGreeksAgent,
)
from config.settings import ENGINE
from scheduler import Scheduler

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("main")


def build_registry() -> AgentRegistry:
    """Instantiate every agent and register it. New agents = one new line here."""
    registry = get_registry()
    registry.register(ScannerAgent)
    registry.register(StrategyEngineAgent)
    registry.register(OIAnalysisAgent)
    registry.register(RiskTierAgent)
    registry.register(AveragingLogicAgent)
    registry.register(SignalAggregator)
    registry.register(VegaGreeksAgent)
    return registry


def run_scan_cycle(bus: SignalBus, registry: AgentRegistry) -> List:
    """One full pipeline cycle: scan -> OI -> risk -> aggregate."""
    # 1. Scanner + Strategy engine emit candidates
    scanner = registry.get_instance("scanner_agent")
    strat = registry.get_instance("strategy_engine_agent")
    oi = registry.get_instance("oi_analysis_agent")
    risk = registry.get_instance("risk_tier_agent")
    agg = registry.get_instance("signal_aggregator")

    # Build data dict (in production this comes from DhanClient + cache)
    data: Dict = {
        "15m_ohlcv": {},
        "5m_ohlcv": {},
        "daily_ohlcv": {},
        "option_chain": {},
        "candidates": [],
    }

    candidates: List = []
    if scanner:
        candidates.extend(scanner.emit(data))
    if strat:
        candidates.extend(strat.emit(data))
    if oi:
        candidates.extend(oi.scan({"candidates": candidates, "option_chain": data.get("option_chain", {})}))
    if risk:
        candidates.extend(risk.scan({"candidates": candidates, "user_tier": "tier_2"}))
    if agg:
        candidates.extend(agg.scan({"candidates": candidates}))

    return candidates


def main() -> int:
    log.info("Starting VIPONLYTRADER Agent Engine (paper_trading=%s)", ENGINE.paper_trading)

    registry = build_registry()
    bus = SignalBus()

    # Instantiate agents with the shared bus
    for name in registry.list_available():
        registry.instantiate(name, signal_bus=bus)

    scheduler = Scheduler()
    scheduler.add_job("scan_cycle", lambda: run_scan_cycle(bus, registry), schedule="intraday")

    # Graceful shutdown
    stop = {"flag": False}

    def _sig_handler(signum, frame):
        log.info("Shutdown signal received (%s)", signum)
        stop["flag"] = True

    signal.signal(signal.SIGINT, _sig_handler)
    signal.signal(signal.SIGTERM, _sig_handler)

    try:
        scheduler.run_forever()
    except KeyboardInterrupt:
        pass

    log.info("Engine stopped. Total agents: %d", len(registry.list_instances()))
    return 0


if __name__ == "__main__":
    sys.exit(main())