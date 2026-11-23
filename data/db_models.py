"""SQLAlchemy ORM models for persistence."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Column, Integer, String, Float, Boolean, DateTime, Text, ForeignKey, Enum
)
from sqlalchemy.orm import relationship

from config.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    phone = Column(String(20), unique=True, nullable=False, index=True)
    name = Column(String(100))
    tier = Column(String(20), default="tier_1")
    capital_declared = Column(Float, default=0.0)
    subscription_plan = Column(String(50), default="basic")
    is_active = Column(Boolean, default=True)
    whatsapp_opt_in = Column(Boolean, default=True)
    push_opt_in = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Subscription(Base):
    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    plan_code = Column(String(50), nullable=False)
    amount_paid = Column(Integer, nullable=False)
    start_date = Column(DateTime, default=datetime.utcnow)
    end_date = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)
    user = relationship("User")


class Signal(Base):
    __tablename__ = "signals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    symbol = Column(String(50), nullable=False, index=True)
    category = Column(String(50), nullable=False)
    trade_type = Column(String(50), nullable=False)
    direction = Column(String(10), nullable=False)
    strategy = Column(String(100), nullable=False)
    timeframe = Column(String(20), nullable=False)
    entry_low = Column(Float, nullable=False)
    entry_high = Column(Float, nullable=False)
    stop_loss = Column(Float, nullable=False)
    t1 = Column(Float, nullable=False)
    t2 = Column(Float, nullable=False)
    confidence = Column(Float, nullable=False)
    status = Column(String(30), default="candidate")
    tier = Column(String(20))
    min_capital_required = Column(Float, default=0.0)
    lot_size = Column(Integer, default=1)
    generated_at = Column(DateTime, default=datetime.utcnow)
    validated_at = Column(DateTime, nullable=True)
    published_at = Column(DateTime, nullable=True)
    reason = Column(Text)
    metadata = Column(Text)  # JSON string

    trades = relationship("Trade", back_populates="signal")


class Trade(Base):
    __tablename__ = "trades"

    id = Column(Integer, primary_key=True, autoincrement=True)
    signal_id = Column(Integer, ForeignKey("signals.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    symbol = Column(String(50), nullable=False)
    side = Column(String(10), nullable=False)
    lots = Column(Integer, default=1)
    entry_price = Column(Float, nullable=False)
    stop_loss = Column(Float, nullable=False)
    target = Column(Float, nullable=False)
    status = Column(String(30), default="open")
    exit_price = Column(Float, nullable=True)
    pnl = Column(Float, nullable=True)
    opened_at = Column(DateTime, default=datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)

    signal = relationship("Signal", back_populates="trades")


class AveragingState(Base):
    __tablename__ = "averaging_states"

    id = Column(Integer, primary_key=True, autoincrement=True)
    signal_id = Column(Integer, ForeignKey("signals.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    original_lots = Column(Integer, default=1)
    total_lots = Column(Integer, default=1)
    weighted_avg_price = Column(Float, nullable=False)
    original_t1 = Column(Float, nullable=False)
    original_t2 = Column(Float, nullable=False)
    revised_t1 = Column(Float, nullable=False)
    revised_t2 = Column(Float, nullable=False)
    added_lots = Column(Integer, default=0)
    last_updated = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class TradeJournal(Base):
    __tablename__ = "trade_journal"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    signal_id = Column(Integer, ForeignKey("signals.id"), nullable=True)
    emotion_tag = Column(String(50), nullable=True)  # calm, greedy, fearful, etc.
    notes = Column(Text, nullable=True)
    r_multiple = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class XpLog(Base):
    __tablename__ = "xp_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    points = Column(Integer, nullable=False)
    reason = Column(String(200), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)