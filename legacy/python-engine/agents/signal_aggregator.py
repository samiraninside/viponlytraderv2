"""Signal Aggregator — deduplicates, ranks, and caps signals to ≤10 per day."""
from __future__ import annotations

from typing import Any, Dict, List

from data.models import Candidate
from .base_agent import BaseAgent


class SignalAggregator(BaseAgent):
    """Deduplicates by symbol, filters by confidence/R:R, ranks to top 10/day."""

    name = "signal_aggregator"
    version = "1.0.0"
    description = "Deduplicate + rank candidates to max 10 signals per day"

    def required_data(self) -> List[str]:
        return []

    def __init__(self, signal_bus=None, config=None):
        super().__init__(signal_bus, config)
        self.emitted_today: Dict[str, Candidate] = {}

    def scan(self, data: Dict[str, Any]) -> List[Candidate]:
        candidates: List[Candidate] = data.get("candidates", [])
        if not candidates:
            return []

        # Deduplicate by symbol (keep highest confidence)
        by_symbol: Dict[str, Candidate] = {}
        for c in candidates:
            if c.symbol not in by_symbol or c.confidence > by_symbol[c.symbol].confidence:
                by_symbol[c.symbol] = c

        # Quality gates
        min_conf = 0.65
        min_rr = 1.5
        try:
            from config.settings import ENGINE
            min_conf = ENGINE.signals.min_confidence
            min_rr = ENGINE.signals.min_risk_reward
        except Exception:
            pass

        filtered = [
            c for c in by_symbol.values()
            if c.confidence >= min_conf and c.risk_reward >= min_rr
        ]

        # Composite score = confidence × risk_reward × tier weight
        tier_weights = {"tier_1": 1.0, "tier_2": 1.2, "tier_3": 0.9}
        for c in filtered:
            weight = tier_weights.get(c.tier or "tier_2", 1.0)
            c.composite_score = round(c.confidence * c.risk_reward * weight, 4)

        filtered.sort(key=lambda x: x.composite_score, reverse=True)

        # Cap to max per day
        max_signals = 10
        try:
            from config.settings import ENGINE
            max_signals = ENGINE.signals.max_signals_per_day
        except Exception:
            pass

        selected = filtered[:max_signals]
        for c in selected:
            self.emitted_today[c.symbol] = c

        return selected

    def reset_daily(self) -> None:
        self.emitted_today.clear()
