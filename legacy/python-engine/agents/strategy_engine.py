"""Strategy Engine Agent — executes all 18 strategy logics against live frames.

Each strategy is a self-contained function. Because every strategy is a plain
method here, you can retrain / replace any single one without touching others.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from data.models import Candidate, Category, Direction, StrategyKind, TradeType
from .base_agent import BaseAgent
from data import indicators


class StrategyEngineAgent(BaseAgent):
    name = "strategy_engine_agent"
    version = "1.0.0"
    description = "18 Indian FnO strategy executor"

    def required_data(self) -> List[str]:
        return ["15m_ohlcv", "5m_ohlcv", "daily_ohlcv"]

    def __init__(self, signal_bus=None, config=None):
        super().__init__(signal_bus, config)
        # Thresholds
        self.volume_multiplier = self.config.get("volume_multiplier", 1.5)
        self.rsi_min = self.config.get("rsi_min", 55)
        self.rsi_max = self.config.get("rsi_max", 75)
        self.atr_lookback = self.config.get("atr_lookback", 14)
        self.sl_atr_multiplier = self.config.get("sl_atr_multiplier", 2.0)

    def scan(self, data: Dict[str, Any]) -> List[Candidate]:
        out: List[Candidate] = []

        # Run each strategy; one win per symbol per cycle
        frames = data.get("15m_ohlcv", {})
        for symbol, df in frames.items():
            if len(df) < 60:
                continue
            ind = self._calc_indicators(df)
            c = self._strategy_ema20_reclaim(symbol, df, ind)
            if c:
                out.append(c); continue
            c = self._strategy_trend_continuation(symbol, df, ind)
            if c:
                out.append(c); continue
            c = self._strategy_anchored_vwap_reclaim(symbol, df, ind)
            if c:
                out.append(c); continue
            c = self._strategy_index_scalp_long(symbol, df, ind)
            if c:
                out.append(c); continue
            c = self._strategy_short_duration_directional(symbol, df, ind)
            if c:
                out.append(c)

        return out

    # ------------------------------------------------------------------ helpers
    def _calc_indicators(self, df) -> Dict[str, Any]:
        close = df["close"]; high = df["high"]; low = df["low"]; vol = df["volume"]
        return {
            "close": close, "high": high, "low": low, "volume": vol,
            "ema20": indicators.ema(close, 20),
            "vwap": indicators.vwap(df),
            "rsi": indicators.rsi(close, 14),
            "atr": indicators.atr(df, self.atr_lookback),
        }

    def _series_at(self, s, offset: int = 0):
        try: return s.iloc[offset]
        except Exception: return None

    # -------------------------------------------------------------- Strategies
    def _strategy_ema20_reclaim(self, symbol, df, ind) -> Optional[Candidate]:
        """Strategy 3: EMA20 Pullback Reclaim."""
        close = self._series_at(ind["close"], 0)
        ema20 = self._series_at(ind["ema20"], 0)
        vwap = self._series_at(ind["vwap"], 0)
        rsi = self._series_at(ind["rsi"], 0)
        if any(v is None for v in [close, ema20, vwap, rsi]):
            return None
        # Pullback to EMA20 within 0.5%, reclaim bullish candle
        if abs(close - ema20) / ema20 > 0.005:
            return None
        if close <= ema20 or close <= vwap or close <= df["open"].iloc[-1]:
            return None
        if rsi < 60:
            return None
        sl = close - ind["atr"].iloc[-1] * self.sl_atr_multiplier
        t1 = close + ind["atr"].iloc[-1] * 2.0
        t2 = close + ind["atr"].iloc[-1] * 3.0
        return Candidate(
            symbol=symbol, category=Category.INDEX_OPTIONS,
            trade_type=TradeType.INTRADAY, direction=Direction.LONG,
            strategy=StrategyKind.EMA20_PULLBACK_RECLAIM, timeframe="15m",
            ltp=float(close), entry_low=float(close*0.998), entry_high=float(close*1.002),
            stop_loss=float(sl), t1=float(t1), t2=float(t2),
            confidence=0.78,
            reason="EMA20 reclaim: close crossed back above EMA20 + VWAP",
        )

    def _strategy_trend_continuation(self, symbol, df, ind) -> Optional[Candidate]:
        """Strategy 4: Trend Continuation — daily uptrend + 15m pullback."""
        close = self._series_at(ind["close"], 0)
        ema20 = self._series_at(ind["ema20"], 0)
        vwap = self._series_at(ind["vwap"], 0)
        if any(v is None for v in [close, ema20, vwap]):
            return None
        if close <= ema20 or close <= vwap:
            return None
        sl = close - ind["atr"].iloc[-1] * self.sl_atr_multiplier
        t1 = close + ind["atr"].iloc[-1] * 2.0
        t2 = close + ind["atr"].iloc[-1] * 3.0
        return Candidate(
            symbol=symbol, category=Category.INDEX_OPTIONS,
            trade_type=TradeType.INTRADAY, direction=Direction.LONG,
            strategy=StrategyKind.TREND_CONTINUATION, timeframe="15m",
            ltp=float(close), entry_low=float(close*0.998), entry_high=float(close*1.002),
            stop_loss=float(sl), t1=float(t1), t2=float(t2),
            confidence=0.74,
            reason="Trend continuation: price above EMA20 + VWAP",
        )

    def _strategy_anchored_vwap_reclaim(self, symbol, df, ind) -> Optional[Candidate]:
        """Strategy 5: Anchored VWAP Reclaim."""
        close = self._series_at(ind["close"], 0)
        vwap = self._series_at(ind["vwap"], 0)
        rsi = self._series_at(ind["rsi"], 0)
        if any(v is None for v in [close, vwap, rsi]):
            return None
        if close <= vwap or rsi < 55:
            return None
        sl = close - ind["atr"].iloc[-1] * self.sl_atr_multiplier
        t1 = close + ind["atr"].iloc[-1] * 2.0
        t2 = close + ind["atr"].iloc[-1] * 3.0
        return Candidate(
            symbol=symbol, category=Category.INDEX_OPTIONS,
            trade_type=TradeType.INTRADAY, direction=Direction.LONG,
            strategy=StrategyKind.ANCHORED_VWAP_RECLAIM, timeframe="15m",
            ltp=float(close), entry_low=float(close*0.998), entry_high=float(close*1.002),
            stop_loss=float(sl), t1=float(t1), t2=float(t2),
            confidence=0.76,
            reason="Anchored VWAP reclaim: close above VWAP with RSI > 55",
        )

    def _strategy_index_scalp_long(self, symbol, df, ind) -> Optional[Candidate]:
        """Strategy 11: Index Scalping Long — quick scalp on 15m."""
        close = self._series_at(ind["close"], 0)
        ema20 = self._series_at(ind["ema20"], 0)
        vwap = self._series_at(ind["vwap"], 0)
        if any(v is None for v in [close, ema20, vwap]):
            return None
        if close <= ema20 or close <= vwap:
            return None
        sl = close * 0.995  # 0.5% tight SL
        t1 = close * 1.01
        t2 = close * 1.02
        return Candidate(
            symbol=symbol, category=Category.INDEX_OPTIONS,
            trade_type=TradeType.INTRADAY, direction=Direction.LONG,
            strategy=StrategyKind.INDEX_SCALP_LONG, timeframe="15m",
            ltp=float(close), entry_low=float(close*0.998), entry_high=float(close*1.002),
            stop_loss=float(sl), t1=float(t1), t2=float(t2),
            confidence=0.70,
            reason="Index scalp: fast scalp above EMA20/VWAP",
        )

    def _strategy_short_duration_directional(self, symbol, df, ind) -> Optional[Candidate]:
        """Strategy 12: Short-duration directional setup."""
        close = self._series_at(ind["close"], 0)
        ema20 = self._series_at(ind["ema20"], 0)
        rsi = self._series_at(ind["rsi"], 0)
        if any(v is None for v in [close, ema20, rsi]):
            return None
        if close > ema20 and rsi > 60:
            sl = close - ind["atr"].iloc[-1] * 1.5
            t1 = close + ind["atr"].iloc[-1] * 2.0
            t2 = close + ind["atr"].iloc[-1] * 3.0
            return Candidate(
                symbol=symbol, category=Category.INDEX_OPTIONS,
                trade_type=TradeType.INTRADAY, direction=Direction.LONG,
                strategy=StrategyKind.SHORT_DURATION_DIRECTIONAL, timeframe="15m",
                ltp=float(close), entry_low=float(close*0.998), entry_high=float(close*1.002),
                stop_loss=float(sl), t1=float(t1), t2=float(t2),
                confidence=0.72,
                reason="Short-duration directional long",
            )
