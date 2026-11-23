"""Risk Tier Agent — enforces tier-based capital & SL rules.

Every candidate passes through this agent before publication. It:
  1. Maps user capital → tier.
  2. Blocks signals where SL exceeds tier's max SL (in INR).
  3. Blocks option-selling unless tier allows it.
  4. Rejects RR below tier minimum.
"""
from __future__ import annotations

from typing import Any, Dict, List

from data.models import Candidate, TradeType
from .base_agent import BaseAgent
from config.settings import TIER_CONFIG, resolve_tier


class RiskTierAgent(BaseAgent):
    name = "risk_tier_agent"
    version = "1.0.0"
    description = "Tier-based risk enforcement (SL caps, capital gating, RR floors)"

    def required_data(self) -> List[str]:
        return []  # works on candidates directly

    def scan(self, data: Dict[str, Any]) -> List[Candidate]:
        """This agent receives candidates from the aggregator via validate path.
        Here we treat incoming `data` as {"candidates": [...], "user_tier": str}.
        """
        candidates = data.get("candidates", [])
        user_tier = data.get("user_tier") or "tier_1"
        tier_cfg = TIER_CONFIG.get(user_tier, TIER_CONFIG["tier_1"])
        passed: List[Candidate] = []

        for c in candidates:
            # Block option-selling for non-aggressive tiers
            if c.trade_type == TradeType.OPTION_SELLING and not tier_cfg.get("allow_option_selling", False):
                continue

            # Hard SL cap per tier (INR)
            sl_inr = abs((c.entry_low + c.entry_high) / 2 - c.stop_loss) * getattr(c, "lot_size", 1)
            if sl_inr > tier_cfg["max_sl_inr"]:
                continue

            # RR floor
            if c.risk_reward < tier_cfg["rr_range"][0]:
                continue

            c.tier = user_tier
            c.min_capital_required = tier_cfg["capital_min"]
            passed.append(c)

        return passed
