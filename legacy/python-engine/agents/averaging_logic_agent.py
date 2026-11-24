from __future__ import annotations

from typing import Any, Dict, List, Optional

from data.models import Candidate, AveragingState
from .base_agent import BaseAgent

FIB_LEVELS = [0.382, 0.5, 0.618]
MAX_ADDITIONS = 2


class AveragingLogicAgent(BaseAgent):
    """Fibonacci add-lot averaging with target re-projection (Tier 2/3 only)."""

    name = "averaging_logic_agent"
    version = "1.0.0"
    description = "Fibonacci add-lot averaging with target re-projection"

    def required_data(self) -> List[str]:
        return []

    def __init__(self, signal_bus=None, config: Optional[dict] = None):
        super().__init__(signal_bus, config)
        self.states: Dict[str, AveragingState] = {}

    def scan(self, data: Dict[str, Any]) -> List[Candidate]:
        signal = data.get("signal")
        tier = data.get("user_tier", "tier_1")
        price = data.get("current_price")

        if signal is None or tier == "tier_1" or price is None:
            return []

        key = f"{getattr(signal, 'id', 0)}:{tier}"
        state = self.states.get(key)
        if state is None:
            self.states[key] = AveragingState(
                signal_id=signal.id,
                user_id=tier,
                weighted_avg_price=signal.entry_mid,
                original_t1=signal.t1,
                original_t2=signal.t2,
                revised_t1=signal.t1,
                revised_t2=signal.t2,
            )
            return []

        if state.added_lots >= MAX_ADDITIONS:
            return []

        entry = signal.entry_mid
        t1 = state.original_t1
        leg = t1 - entry
        if leg <= 0:
            return []

        fib_zones = [entry + leg * lvl for lvl in FIB_LEVELS]
        triggered = any(abs(price - fib) < leg * 0.02 for fib in fib_zones)
        if not triggered:
            return []

        # Add 1 lot at current price
        state.total_lots += 1
        state.added_lots += 1
        state.weighted_avg_price = (
            (state.weighted_avg_price * (state.total_lots - 1)) + price
        ) / state.total_lots

        # Preserve original per-unit reward distances, anchored at new avg
        reward_t1 = abs(signal.t1 - signal.entry_mid)
        reward_t2 = abs(signal.t2 - signal.entry_mid)
        state.revised_t1 = state.weighted_avg_price + reward_t1
        state.revised_t2 = state.weighted_avg_price + reward_t2

        updated = signal.model_copy(deep=True)
        updated.entry_low = round(state.weighted_avg_price * 1.0, 2)
        updated.entry_high = round(state.weighted_avg_price * 1.002, 2)
        updated.t1 = round(state.revised_t1, 2)
        updated.t2 = round(state.revised_t2, 2)
        updated.metadata = {
            **(updated.metadata or {}),
            "averaged": True,
            "total_lots": state.total_lots,
            "weighted_avg_price": round(state.weighted_avg_price, 2),
        }
        return [updated]

    def get_state(self, signal_id: int, user_id: str) -> Optional[AveragingState]:
        return self.states.get(f"{signal_id}:{user_id}")