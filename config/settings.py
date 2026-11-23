from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import time
from typing import Dict

from dotenv import load_dotenv

load_dotenv()


def _env(key: str, default: str = "") -> str:
    return os.getenv(key, default)


def _env_bool(key: str, default: bool = False) -> bool:
    return _env(key, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def _env_int(key: str, default: int) -> int:
    try:
        return int(_env(key, str(default)))
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(_env(key, str(default)))
    except ValueError:
        return default


def _parse_time(value: str, fallback: time) -> time:
    try:
        h, m = value.strip().split(":")
        return time(int(h), int(m))
    except (ValueError, AttributeError):
        return fallback


@dataclass(frozen=True)
class DhanConfig:
    client_id: str = _env("DHAN_CLIENT_ID")
    access_token: str = _env("DHAN_ACCESS_TOKEN")
    ws_url: str = _env("DHAN_WS_URL", "wss://api-feed.dhan.co")
    rest_url: str = _env("DHAN_REST_URL", "https://api.dhan.co")


@dataclass(frozen=True)
class MarketConfig:
    open_time: time = _parse_time(_env("MARKET_OPEN_TIME", "09:15"), time(9, 15))
    close_time: time = _parse_time(_env("MARKET_CLOSE_TIME", "15:30"), time(15, 30))
    pre_market_time: time = _parse_time(_env("PRE_MARKET_TIME", "08:30"), time(8, 30))


@dataclass(frozen=True)
class SignalConfig:
    max_signals_per_day: int = _env_int("MAX_SIGNALS_PER_DAY", 10)
    min_confidence: float = _env_float("MIN_CONFIDENCE_SCORE", 0.65)
    min_risk_reward: float = _env_float("MIN_RISK_REWARD_RATIO", 1.5)


TIER_CONFIG: Dict[str, dict] = {
    "tier_1": {
        "name": "Conservative",
        "capital_min": 50000,
        "capital_max": 100000,
        "max_sl_inr": _env_int("TIER_1_MAX_SL", 2000),
        "allow_averaging": False,
        "allow_option_selling": False,
        "rr_range": (1.5, 2.0),
    },
    "tier_2": {
        "name": "Moderate",
        "capital_min": 200000,
        "capital_max": 500000,
        "max_sl_inr": _env_int("TIER_2_MAX_SL", 5000),
        "allow_averaging": True,
        "allow_option_selling": False,
        "rr_range": (1.0, 5.0),
    },
    "tier_3": {
        "name": "Aggressive",
        "capital_min": 1000000,
        "capital_max": None,
        "max_sl_inr": _env_int("TIER_3_MAX_SL", 10000),
        "allow_averaging": True,
        "allow_option_selling": True,
        "rr_range": (5.0, 10.0),
    },
}


@dataclass(frozen=True)
class NotificationConfig:
    whatsapp_url: str = _env("WHATSAPP_API_URL", "https://api.callmebot.com/whatsapp.php")
    whatsapp_phone: str = _env("WHATSAPP_PHONE")
    whatsapp_key: str = _env("WHATSAPP_API_KEY")
    fcm_key: str = _env("FCM_SERVER_KEY")


@dataclass(frozen=True)
class EngineConfig:
    database_url: str = _env("DATABASE_URL", "sqlite:///./data/trading_engine.db")
    paper_trading: bool = _env_bool("PAPER_TRADING", True)
    scan_interval_seconds: int = _env_int("SCAN_INTERVAL_SECONDS", 300)
    dhan: DhanConfig = field(default_factory=DhanConfig)
    market: MarketConfig = field(default_factory=MarketConfig)
    signals: SignalConfig = field(default_factory=SignalConfig)
    notifications: NotificationConfig = field(default_factory=NotificationConfig)


ENGINE = EngineConfig()


def resolve_tier(capital: float) -> str:
    if capital < TIER_CONFIG["tier_1"]["capital_min"]:
        return "tier_1"
    if capital <= TIER_CONFIG["tier_1"]["capital_max"]:
        return "tier_1"
    if capital <= TIER_CONFIG["tier_2"]["capital_max"]:
        return "tier_2"
    return "tier_3"
