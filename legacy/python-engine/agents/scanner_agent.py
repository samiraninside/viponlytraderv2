"""Scanner Agent — implements Scanners A-D from bra.txt for Indian FnO.

Configurable via JSON config or env. Each scanner returns Candidate objects
that flow through validate() -> emit() -> signal_bus. All thresholds live in
config so strategies can be retrained / tuned without changing code.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from data.models import Candidate, Category, Direction, StrategyKind, TradeType
from .base_agent import BaseAgent
from data import indicators


class ScannerAgent(BaseAgent):
    name = "scanner_agent"
    version = "1.0.0"
    description = "Momentum breakout + pre-breakout scanners (A-D) over FnO universe"

    def required_data(self) -> List[str]:
        return ["15m_ohlcv", "5m_ohlcv", "daily_ohlcv"]

    def __init__(self, signal_bus=None, config: Optional[dict] = None):
        super().__init__(signal_bus, config)
        # Thresholds (trained / tunable)
        self.volume_multiplier = self.config.get("volume_multiplier", 1.5)
        self.rsi_min = self.config.get("rsi_min", 55)
        self.rsi_max = self.config.get("rsi_max", 75)
        self.atr_lookback = self.config.get("atr_lookback", 14)
        self.lookback_high_days = self.config.get("lookback_high_days", 20)

    def scan(self, data: Dict[str, Any]) -> List[Candidate]:
        out: List[Candidate] = []

        # data is expected to contain per-symbol frames:
        # {"15m": {symbol: df}, "5m": {...}, "daily": {...}}
        df_15m = data.get("15m_ohlcv", {})
        df_5m = data.get("5m_ohlcv", {})
        df_daily = data.get("daily_ohlcv", {})

        for symbol, df in df_15m.items():
            if len(df) < self.lookback_high_days + 10:
                continue
            ind = self._calc_indicators(df)
            c = self._evaluate_scanner_a(symbol, df, ind)
            if c:
                out.append(c)
                continue  # one scanner wins per symbol per cycle
            c = self._evaluate_scanner_c(symbol, df, ind)
            if c:
                out.append(c)

        # 5m scanner B
        for symbol, df in df_5m.items():
            if len(df) < 100:
                continue
            ind = self._calc_indicators(df)
            c = self._evaluate_scanner_b(symbol, df, ind)
            if c:
                out.append(c)

        # Daily bearish breakdown scanner D uses daily frames
        for symbol, df in df_daily.items():
            if len(df) < 50:
                continue
            ind = self._calc_indicators(df)
            c = self._evaluate_scanner_d(symbol, df, ind)
            if c:
                out.append(c)

        return out

    # ------------------------------------------------------------------ helpers
    def _calc_indicators(self, df) -> Dict[str, Any]:
        close = df["close"]
        high = df["high"]
        low = df["low"]
        vol = df["volume"]

        ind = {
            "close": close,
            "high": high,
            "low": low,
            "volume": vol,
            "ema20": indicators.ema(close, 20),
            "vwap": indicators.vwap(df),
            "rsi": indicators.rsi(close, 14),
            "atr": indicators.atr(df, self.atr_lookback),
        }
        # 20-day rolling high / 10-day rolling high / low
        ind["high_20"] = high.rolling(self.lookback_high_days).max()
        ind["high_10"] = high.rolling(10).max()
        ind["low_10"] = low.rolling(10).min()
        ind["vol_avg_20"] = vol.rolling(20).mean()
        return ind

    def _series_at(self, s, offset: int = 0):
        """Safe iloc access."""
        try:
            return s.iloc[offset]
        except Exception:
            return None

    def _evaluate_scanner_a(self, symbol: str, df, ind) -> Optional[Candidate]:
        """Scanner A: 15-min confirmed bullish breakout (Futures/Index)."""
        try:
            close = self._series_at(ind["close"], 0)
            prev_close = self._series_at(ind["close"], -1)
            ema20 = self._series_at(ind["ema20"], 0)
            vwap_val = self._series_at(ind["vwap"], 0)
            high_20 = self._series_at(ind["high_20"], -1)  # prior 20-day high
            high_10_prev = self._series_at(ind["high_10"], -2)
            high_10_curr = self._series_at(ind["high_10"], -1)
            vol = self._series_at(ind["volume"], -1)
            vol_avg = self._series_at(ind["vol_avg_20"], -1)
            rsi = self._series_at(ind["rsi"], 0)
        except Exception:
            return None

        if any(v is None for v in [close, prev_close, ema20, vwap_val, high_20,
                                   high_10_prev, high_10_curr, vol, vol_avg, rsi]):
            return None

        cond = (
            close > ema20
            and close > vwap_val
            and close > df["open"].iloc[-1]
            and close > high_10_curr
            and prev_close <= high_10_prev
            and vol > vol_avg * self.volume_multiplier
            and rsi > self.rsi_min
        )

        if not cond:
            return None

        sl = close - ind["atr"].iloc[-1] * 2.0
        t1 = close + ind["atr"].iloc[-1] * 2.0
        t2 = close + ind["atr"].iloc[-1] * 3.0

        return Candidate(
            symbol=symbol,
            category=Category.INDEX_OPTIONS,
            trade_type=TradeType.INTRADAY,
            direction=Direction.LONG,
            strategy=StrategyKind.SCANNER_A_15M_BREAKOUT,
            timeframe="15m",
            ltp=float(close),
            entry_low=float(close * 0.998),
            entry_high=float(close * 1.002),
            stop_loss=float(sl),
            t1=float(t1),
            t2=float(t2),
            confidence=min(0.9, 0.6 + (rsi - 55) / 100),
            reason="Scanner A: 15m close > EMA20 > VWAP > 10d high; vol 1.5x",
            metadata={"indicator_snapshot": "scanner_a"},
        )

    def _evaluate_scanner_b(self, symbol: str, df, ind) -> Optional[Candidate]:
        """Scanner B: 5-min bullish entry trigger."""
        close = self._series_at(ind["close"], 0)
        ema20 = self._series_at(ind["ema20"], 0)
        vwap_val = self._series_at(ind["vwap"], 0)
        high_prev = self._series_at(ind["high"], -1)
        vol = self._series_at(ind["volume"], 0)
        vol_avg = self._series_at(ind["vol_avg_20"], 0)
        rsi = self._series_at(ind["rsi"], 0)

        if any(v is None for v in [close, ema20, vwap_val, high_prev, vol, vol_avg, rsi]):
            return None

        cond = (
            close > ema20
            and close > vwap_val
            and close > high_prev
            and close > df["open"].iloc[-1]
            and vol > vol_avg * self.volume_multiplier
            and rsi > self.rsi_min
        )

        if not cond:
            return None

        sl = close - ind["atr"].iloc[-1] * 1.5
        t1 = close + ind["atr"].iloc[-1] * 2.0
        t2 = close + ind["atr"].iloc[-1] * 3.0

        return Candidate(
            symbol=symbol,
            category=Category.INDEX_OPTIONS,
            trade_type=TradeType.INTRADAY,
            direction=Direction.LONG,
            strategy=StrategyKind.SCANNER_B_5M_TRIGGER,
            timeframe="5m",
            ltp=float(close),
            entry_low=float(close * 0.998),
            entry_high=float(close * 1.002),
            stop_loss=float(sl),
            t1=float(t1),
            t2=float(t2),
            confidence=min(0.88, 0.55 + (rsi - 55) / 100),
            reason="Scanner B: 5m close > EMA20 > VWAP > prev high; vol spike",
            metadata={"indicator_snapshot": "scanner_b"},
        )

    def _evaluate_scanner_c(self, symbol: str, df, ind) -> Optional[Candidate]:
        """Scanner C: pre-breakout accumulation."""
        close = self._series_at(ind["close"], 0)
        ema20 = self._series_at(ind["ema20"], 0)
        vwap_val = self._series_at(ind["vwap"], 0)
        high_10_prev = self._series_at(ind["high_10"], -2)
        high_10_curr = self._series_at(ind["high_10"], -1)
        rsi = self._series_at(ind["rsi"], 0)
        atr_prev = self._series_at(ind["atr"], -3)
        atr_curr = self._series_at(ind["atr"], 0)

        if any(v is None for v in [close, ema20, vwap_val, high_10_prev,
                                   high_10_curr, rsi, atr_prev, atr_curr]):
            return None

        cond = (
            close > ema20
            and close > vwap_val
            and close < high_10_prev
            and close > high_10_curr * 0.98
            and self.rsi_min <= rsi <= self.rsi_max
            and atr_curr < atr_prev  # ATR contraction
        )

        if not cond:
            return None

        sl = close - atr_curr * 2.0
        t1 = close + atr_curr * 2.0
        t2 = close + atr_curr * 3.0

        return Candidate(
            symbol=symbol,
            category=Category.INDEX_OPTIONS,
            trade_type=TradeType.INTRADAY,
            direction=Direction.LONG,
            strategy=StrategyKind.SCANNER_C_PRE_BREAKOUT,
            timeframe="15m",
            ltp=float(close),
            entry_low=float(close * 0.998),
            entry_high=float(close * 1.002),
            stop_loss=float(sl),
            t1=float(t1),
            t2=float(t2),
            confidence=0.72,
            reason="Scanner C: ATR contraction near 10d high, RSI neutral-bullish",
            metadata={"indicator_snapshot": "scanner_c"},
        )

    def _evaluate_scanner_d(self, symbol: str, df, ind) -> Optional[Candidate]:
        """Scanner D: Bearish breakdown."""
        close = self._series_at(ind["close"], 0)
        ema20 = self._series_at(ind["ema20"], 0)
        vwap_val = self._series_at(ind["vwap"], 0)
        low_10_prev = self._series_at(ind["low_10"], -2)
        low_10_curr = self._series_at(ind["low_10"], -1)
        vol = self._series_at(ind["volume"], 0)
        vol_avg = self._series_at(ind["vol_avg_20"], 0)
        rsi = self._series_at(ind["rsi"], 0)

        if any(v is None for v in [close, ema20, vwap_val, low_10_prev,
                                   low_10_curr, vol, vol_avg, rsi]):
            return None

        prev_close = self._series_at(ind["close"], -1)
        cond = (
            close < ema20
            and close < vwap_val
            and close < df["open"].iloc[-1]
            and close < low_10_curr
            and prev_close is not None
            and prev_close >= low_10_prev
            and vol > vol_avg * self.volume_multiplier
            and rsi < 45
        )

        if not cond:
            return None

        sl = close + ind["atr"].iloc[-1] * 2.0
        t1 = close - ind["atr"].iloc[-1] * 2.0
        t2 = close - ind["atr"].iloc[-1] * 3.0

        return Candidate(
            symbol=symbol,
            category=Category.INDEX_OPTIONS,
            trade_type=TradeType.INTRADAY,
            direction=Direction.SHORT,
            strategy=StrategyKind.SCANNER_D_BEARISH_BREAKDOWN,
            timeframe="15m",
            ltp=float(close),
            entry_low=float(close * 0.998),
            entry_high=float(close * 1.002),
            stop_loss=float(sl),
            t1=float(t1),
            t2=float(t2),
            confidence=0.80,
            reason="Scanner D: bearish breakdown below EMA20 & VWAP, vol spike",
            metadata={"indicator_snapshot": "scanner_d"},
        )
