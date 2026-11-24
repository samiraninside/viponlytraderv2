"""Vega & Greeks Agent — portfolio-level option risk exposure (Tier 3 only)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from .base_agent import BaseAgent


class VegaGreeksAgent(BaseAgent):
    name = "vega_greeks_agent"
    version = "1.0.0"
    description = "Portfolio delta/vega/theta exposure and skew monitoring"

    def required_data(self) -> List[str]:
        return ["option_chain", "positions"]

    def scan(self, data: Dict[str, Any]) -> List:
        """Not a signal emitter — produces risk dashboard metrics."""
        positions = data.get("positions", [])
        chains = data.get("option_chain", {})

        total_vega = 0.0
        total_delta = 0.0
        total_theta = 0.0

        for pos in positions:
            chain = chains.get(pos.get("symbol"))
            if not chain:
                continue
            atm = self._find_atm(chain, pos.get("underlying_price", 0))
            if not atm:
                continue
            total_vega += atm.get("vega", 0) * pos.get("qty", 0)
            total_delta += atm.get("delta", 0) * pos.get("qty", 0)
            total_theta += atm.get("theta", 0) * pos.get("qty", 0)

        self.last_run = __import__("datetime").datetime.utcnow()
        return [{
            "total_vega": round(total_vega, 2),
            "total_delta": round(total_delta, 2),
            "total_theta": round(total_theta, 2),
            "positions_count": len(positions),
        }]

    def _find_atm(self, chain: dict, spot: float) -> Optional[dict]:
        strikes = chain.get("strikes", [])
        if not strikes:
            return None
        return min(strikes, key=lambda s: abs(s.get("strike", 0) - spot))
