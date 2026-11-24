"""Technical indicators used by scanners/strategies. Vectorized with pandas for speed."""
from __future__ import annotations

import pandas as pd
import pandas_ta as ta


def sma(series: pd.Series, length: int = 20) -> pd.Series:
    return ta.sma(series, length=length)


def ema(series: pd.Series, length: int = 20) -> pd.Series:
    return ta.ema(series, length=length)


def vwap(df: pd.DataFrame) -> pd.Series:
    """Standard VWAP using typical price * volume cumulative."""
    tp = (df["high"] + df["low"] + df["close"]) / 3
    return (tp * df["volume"]).cumsum() / df["volume"].cumsum()


def rsi(series: pd.Series, length: int = 14) -> pd.Series:
    return ta.rsi(series, length=length)


def atr(df: pd.DataFrame, length: int = 14) -> pd.Series:
    return ta.atr(df["high"], df["low"], df["close"], length=length)


def macd(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    macd_df = ta.macd(series, fast=fast, slow=slow, signal=signal)
    return macd_df.iloc[:, 0], macd_df.iloc[:, 1], macd_df.iloc[:, 2]


def supertrend(df: pd.DataFrame, length: int = 10, multiplier: float = 3.0):
    st = ta.supertrend(df["high"], df["low"], df["close"], length=length, multiplier=multiplier)
    return st.iloc[:, 0], st.iloc[:, 1]


def adx(df: pd.DataFrame, length: int = 14):
    adx_df = ta.adx(df["high"], df["low"], df["close"], length=length)
    return adx_df.iloc[:, 0], adx_df.iloc[:, 1], adx_df.iloc[:, 2]


def bollinger(series: pd.Series, length: int = 20, std: float = 2.0):
    bb = ta.bbands(series, length=length, std=std)
    return bb.iloc[:, 0], bb.iloc[:, 1], bb.iloc[:, 2]  # lower, middle, upper
