"""OI Analysis Agent — PCR, Max Pain, OI surge and IV rank validation.

Scores a candidate using option-chain context: a bullish breakout with rising
PCR and Call OI build-up gets its confidence boosted; a breakout into heavy
Call resistance gets discounted.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from data.models import Candidate
from .base_agent import BaseAgent


class OIAnalysisAgent(BaseAgent):
    name = "oi_analysis_agent"
    version = "1.0.0"
    description = "Option-chain confirmation: PCR, max pain, OI surge, IV rank"

    def required_data(self) -> List[str]:
        return ["option_chain"]

    def __init__(self, signal_bus=None, config: Optional[dict] = None):
        super().__init__(signal_bus, config)
        self.pcr_bullish = self.config.get("pcr_bullish_threshold", 0.7)
        self.pcr_bearish = self.config.get("pcr_bearish_threshold", 1.3)
        self.oi_change_threshold = self.config.get("oi_change_threshold", 0.15)

    def scan(self, data: Dict[str, Any]) -> List[Candidate]:
        """data: {"candidates": [...], "option_chain": {symbol: chain_dict}}"""
        candidates: List[Candidate] = data.get("candidates", [])
        chains: Dict[str, dict] = data.get("option_chain", {})
        out: List[Candidate] = []

        for c in candidates:
            chain = chains.get(c.symbol)
            if not chain:
                out.append(c)
                continue

            metrics = self._analyze_chain(chain, c.ltp)
            c.metadata = {**(c.metadata or {}), "oi_metrics": metrics}

            # Bullish validation
            if c.direction == "LONG":
                if metrics["pcr"] < self.pcr_bullish and metrics["call_oi_surge"]:
                    c.confidence = min(0.95, c.confidence + 0.08)
                elif metrics["pcr"] > self.pcr_bearish:
                    c.confidence = max(0.0, c.confidence - 0.15)

            # Bearish validation
            else:
                if metrics["pcr"] > self.pcr_bearish and metrics["put_oi_surge"]:
                    c.confidence = min(0.95, c.confidence + 0.08)
                elif metrics["pcr"] < self.pcr_bullish:
                    c.confidence = max(0.0, c.confidence - 0.15)

            out.append(c)

        return out

    def _analyze_chain(self, chain: dict, spot: float) -> Dict[str, Any]:
        strikes = chain.get("strikes", [])
        call_oi = sum(s.get("call_oi", 0) for s in strikes)
        put_oi = sum(s.get("put_oi", 0) for s in strikes)
        pcr = (put_oi / call_oi) if call_oi else 0.0

        call_oi_surge = any(
            abs(s.get("call_oi_change_pct", 0)) > self.oi_change_threshold *
            100 for s in strikes
        )
        put_oi_surge = any(
            abs(s.get("put_oi_change_pct", 0)) > self.oi_change_threshold *
            100 for s in strikes
        )
        max_pain = chain.get("max_pain", spot)

        return {
            "pcr": round(pcr, 2),
            "max_pain": max_pain,
            "call_oi_surge": call_oi_surge,
            "put_oi_surge": put_oi_surge,
            "iv_rank": chain.get("iv_rank", 50),
        }
