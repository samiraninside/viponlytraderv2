"""Dhan API client — REST for candles/option-chain, WebSocket for live ticks.

This is the ONLY module that touches Dhan. Agents never call Dhan directly;
they receive prepared data dicts. That keeps agents testable offline and lets
you swap brokers later without rewriting strategy logic.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional

import pandas as pd

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

from config.settings import ENGINE

log = logging.getLogger(__name__)

# Dhan interval codes for /charts/intraday
_INTERVAL_MAP = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60}


class DhanClient:
    """Thin, defensive wrapper around the Dhan v2 REST API."""

    def __init__(self, client_id: Optional[str] = None, access_token: Optional[str] = None):
        self.client_id = client_id or ENGINE.dhan.client_id
        self.access_token = access_token or ENGINE.dhan.access_token
        self.base_url = ENGINE.dhan.rest_url
        self.session = requests.Session() if requests else None
        if self.session:
            self.session.headers.update(
                {
                    "access-token": self.access_token,
                    "client-id": self.client_id,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                }
            )

    # ------------------------------------------------------------------ utils
    def _post(self, path: str, payload: Dict[str, Any], retries: int = 3) -> Optional[Dict]:
        if not self.session:
            log.error("requests library unavailable")
            return None
        url = f"{self.base_url}{path}"
        for attempt in range(1, retries + 1):
            try:
                r = self.session.post(url, json=payload, timeout=15)
                if r.status_code == 200:
                    return r.json()
                log.warning("Dhan %s -> HTTP %s (%s)", path, r.status_code, r.text[:200])
                if r.status_code in (401, 403):
                    return None  # don't hammer auth failures
            except Exception as exc:  # network, timeout
                log.warning("Dhan %s attempt %s failed: %s", path, attempt, exc)
            time.sleep(min(2 ** attempt, 10))
        return None

    # ------------------------------------------------------------- market data
    def get_intraday(self, security_id: str, interval: str = "15m",
                     days_back: int = 5, exchange_segment: str = "NSE_FNO",
                     instrument: str = "OPTIDX") -> Optional[pd.DataFrame]:
        """Fetch intraday candles as a normalized OHLCV DataFrame."""
        mins = _INTERVAL_MAP.get(interval)
        if mins is None:
            raise ValueError(f"Unsupported interval {interval}")
        to_date = datetime.now().strftime("%Y-%m-%d")
        from_date = (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")
        payload = {
            "securityId": str(security_id),
            "exchangeSegment": exchange_segment,
            "instrument": instrument,
            "interval": str(mins),
            "fromDate": from_date,
            "toDate": to_date,
        }
        raw = self._post("/v2/charts/intraday", payload)
        return self._normalize_candles(raw)

    def get_daily(self, security_id: str, days_back: int = 120,
                  exchange_segment: str = "NSE_EQ",
                  instrument: str = "EQUITY") -> Optional[pd.DataFrame]:
        to_date = datetime.now().strftime("%Y-%m-%d")
        from_date = (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")
        payload = {
            "securityId": str(security_id),
            "exchangeSegment": exchange_segment,
            "instrument": instrument,
            "expiryCode": 0,
            "fromDate": from_date,
            "toDate": to_date,
        }
        raw = self._post("/v2/charts/historical", payload)
        return self._normalize_candles(raw)

    def get_option_chain(self, underlying_scrip: str, underlying_seg: str = "IDX_I",
                         expiry: Optional[str] = None) -> Optional[Dict]:
        payload = {"UnderlyingScrip": underlying_scrip, "UnderlyingSeg": underlying_seg}
        if expiry:
            payload["Expiry"] = expiry
        return self._post("/v2/optionchain", payload)

    # ---------------------------------------------------------------- helpers
    @staticmethod
    def _normalize_candles(raw: Optional[Dict]) -> Optional[pd.DataFrame]:
        """Dhan returns parallel arrays; convert to indexed OHLCV frame."""
        if not raw:
            return None
        # v2 shape: {"open":[..],"high":[..],"low":[..],"close":[..],"volume":[..],"timestamp":[..]}
        if "open" in raw and "timestamp" in raw:
            df = pd.DataFrame(
                {
                    "open": raw["open"],
                    "high": raw["high"],
                    "low": raw["low"],
                    "close": raw["close"],
                    "volume": raw.get("volume", [0] * len(raw["open"])),
                }
            )
            df.index = pd.to_datetime(raw["timestamp"], unit="s", errors="coerce")
            return df.dropna()
        # Some endpoints return {"data": [...]} rows
        if "data" in raw and isinstance(raw["data"], list):
            df = pd.DataFrame(raw["data"])
            if "timestamp" in df.columns:
                df.index = pd.to_datetime(df["timestamp"], unit="s", errors="coerce")
            return df.dropna(how="all")
        log.warning("Unrecognized candle payload keys: %s", list(raw.keys())[:8])
        return None


class DhanWebSocket:
    """Live tick feed. Runs its own thread; calls `on_tick(dict)` per message.

    Kept deliberately simple and defensive: reconnect with backoff.
    Agents never see this class — the scheduler feeds their data dicts.
    """

    def __init__(self, instruments: List[Dict[str, Any]],
                 on_tick: Callable[[Dict[str, Any]], None]):
        self.instruments = instruments  # [{"ExchangeSegment":..,"SecurityId":..}]
        self.on_tick = on_tick
        self._running = False
        self._ws = None

    def start(self) -> None:  # pragma: no cover - network loop
        import threading

        self._running = True
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self) -> None:
        self._running = False
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass

    def _run(self) -> None:  # pragma: no cover
        try:
            import websocket
        except ImportError:
            log.error("websocket-client not installed; live feed disabled")
            return

        backoff = 1
        while self._running:
            try:
                self._ws = websocket.WebSocketApp(
                    ENGINE.dhan.ws_url,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=lambda w, e: log.warning("WS error: %s", e),
                    on_close=lambda w, c, m: log.info("WS closed (%s)", c),
                    header=[
                        f"access-token: {ENGINE.dhan.access_token}",
                        f"client-id: {ENGINE.dhan.client_id}",
                    ],
                )
                self._ws.run_forever(ping_interval=20, ping_timeout=10)
            except Exception as exc:
                log.warning("WS loop error: %s", exc)
            if self._running:
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)

    def _on_open(self, ws) -> None:  # pragma: no cover
        sub = {
            "RequestCode": 15,  # ticker packet
            "InstrumentCount": len(self.instruments),
            "InstrumentList": self.instruments,
        }
        ws.send(json.dumps(sub))
        log.info("WS subscribed to %d instruments", len(self.instruments))

    def _on_message(self, ws, message: bytes) -> None:  # pragma: no cover
        try:
            # Dhan binary feed; here we surface raw bytes length + decode if JSON
            if isinstance(message, (bytes, bytearray)):
                return  # binary parsing lives in a dedicated decoder
            self.on_tick(json.loads(message))
        except Exception as exc:
            log.debug("tick parse error: %s", exc)
