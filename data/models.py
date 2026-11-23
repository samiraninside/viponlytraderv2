"""Core data models shared across agents. Pydantic v2 for validation."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class Direction(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


class TradeType(str, Enum):
    INTRADAY = "INTRADAY"
    BTST = "BTST"
    SWING = "SWING"          # 3-5 days
    OPTION_SELLING = "OPTION_SELLING"


class Category(str, Enum):
    INDEX_OPTIONS = "INDEX_OPTIONS"
    STOCK_OPTIONS = "STOCK_OPTIONS"
    FUTURES = "FUTURES"
    MCX = "MCX"
    EQUITY_CASH = "EQUITY_CASH"


class StrategyKind(str, Enum):
    SCANNER_A_15M_BREAKOUT = "SCANNER_A_15M_BREAKOUT"
    SCANNER_B_5M_TRIGGER = "SCANNER_B_5M_TRIGGER"
    SCANNER_C_PRE_BREAKOUT = "SCANNER_C_PRE_BREAKOUT"
    SCANNER_D_BEARISH_BREAKDOWN = "SCANNER_D_BEARISH_BREAKDOWN"
    EMA20_PULLBACK_RECLAIM = "EMA20_PULLBACK_RECLAIM"
    TREND_CONTINUATION = "TREND_CONTINUATION"
    ANCHORED_VWAP_RECLAIM = "ANCHORED_VWAP_RECLAIM"
    OPTION_CHAIN_CONFIRM = "OPTION_CHAIN_CONFIRM"
    OI_IV_VALIDATION = "OI_IV_VALIDATION"
    PREMIUM_DECAY_SELLING = "PREMIUM_DECAY_SELLING"
    DEFINED_RISK_SELLING = "DEFINED_RISK_SELLING"
    INDEX_SCALP_LONG = "INDEX_SCALP_LONG"
    SHORT_DURATION_DIRECTIONAL = "SHORT_DURATION_DIRECTIONAL"
    BULL_CALL_SPREAD = "BULL_CALL_SPREAD"
    DEFINED_RISK_DIRECTIONAL = "DEFINED_RISK_DIRECTIONAL"
    EXPIRY_PREMIUM_DECAY = "EXPIRY_PREMIUM_DECAY"
    EXPIRY_RISK_CONTROL = "EXPIRY_RISK_CONTROL"
    BETTER_OPPORTUNITY = "BETTER_OPPORTUNITY"
    CROSS_STRATEGY_RANK = "CROSS_STRATEGY_RANK"


class SignalStatus(str, Enum):
    CANDIDATE = "CANDIDATE"       # emitted by scanner/strategy
    VALIDATED = "VALIDATED"       # passed risk + confidence
    PUBLISHED = "PUBLISHED"       # sent to users
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"


class Candidate(BaseModel):
    """Raw output from a scanner/strategy agent before risk gating."""
    symbol: str
    category: Category
    trade_type: TradeType
    direction: Direction
    strategy: StrategyKind
    timeframe: str
    ltp: float
    entry_low: float
    entry_high: float
    stop_loss: float
    t1: float
    t2: float
    confidence: float = Field(ge=0.0, le=1.0)
    generated_at: datetime = Field(default_factory=datetime.utcnow)
    composite_score: float = 0.0
    reason: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @property
    def entry_mid(self) -> float:
        return (self.entry_low + self.entry_high) / 2.0

    @property
    def risk_per_unit(self) -> float:
        return abs(self.entry_mid - self.stop_loss)

    @property
    def reward_t2(self) -> float:
        return abs(self.t2 - self.entry_mid)

    @property
    def risk_reward(self) -> float:
        r = self.risk_per_unit
        return round(self.reward_t2 / r, 2) if r > 0 else 0.0

    def in_entry_range(self, price: float) -> bool:
        return self.entry_low <= price <= self.entry_high


class Signal(Candidate):
    """A validated, publishable signal."""
    id: Optional[int] = None
    status: SignalStatus = SignalStatus.CANDIDATE
    validated_at: Optional[datetime] = None
    published_at: Optional[datetime] = None
    tier: Optional[str] = None
    min_capital_required: float = 0.0
    lot_size: int = 1


class AveragingState(BaseModel):
    """Tracks a user's position as it averages down (Tier 2/3 only)."""
    signal_id: int
    user_id: str
    original_lots: int = 1
    total_lots: int = 1
    weighted_avg_price: float
    original_t1: float
    original_t2: float
    revised_t1: float
    revised_t2: float
    added_lots: int = 0
    last_updated: datetime = Field(default_factory=datetime.utcnow)


class Trade(BaseModel):
    """Execution record, whether paper or live."""
    id: Optional[int] = None
    signal_id: int
    user_id: str
    symbol: str
    side: str          # BUY / SELL
    lots: int = 1
    entry_price: float
    stop_loss: float
    target: float
    status: str = "OPEN"   # OPEN / CLOSED / SL_HIT / TARGET_HIT
    exit_price: Optional[float] = None
    pnl: Optional[float] = None
    opened_at: datetime = Field(default_factory=datetime.utcnow)
    closed_at: Optional[datetime] = None


class SubscriptionPlan(BaseModel):
    code: str
    name: str
    price_inr: int
    tier: str
    features: List[str] = Field(default_factory=list)
    is_custom: bool = False


DEFAULT_PLANS: List[SubscriptionPlan] = [
    SubscriptionPlan(
        code="basic",
        name="Basic",
        price_inr=2999,
        tier="tier_1",
        features=["Pre-market signals", "Index options", "₹2,000 SL cap"],
    ),
    SubscriptionPlan(
        code="mid",
        name="Mid",
        price_inr=4999,
        tier="tier_2",
        features=["Live intraday signals", "Stock + index options", "Averaging enabled"],
    ),
    SubscriptionPlan(
        code="advanced",
        name="Advanced",
        price_inr=9999,
        tier="tier_3",
        features=["Option selling + hedging", "MCX", "Vega analytics"],
    ),
    SubscriptionPlan(
        code="portfolio",
        name="Portfolio Management",
        price_inr=0,
        tier="tier_3b",
        features=["Personalized mgmt", "Discord meetings", "By invitation"],
        is_custom=True,
    ),
]
