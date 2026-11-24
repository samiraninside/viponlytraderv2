"""Scheduler — runs the agent pipeline on the configured cadence.

Pre-market  : 08:30-09:15 (overnight gap analysis)
Intraday    : every SCAN_INTERVAL_SECONDS (default 300s)
Post-market : 15:30-16:00 (EOD summary + journal flush)
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, time as dtime
from typing import Callable, Dict, List

from config.settings import ENGINE

log = logging.getLogger(__name__)


class Scheduler:
    def __init__(self):
        self._jobs: List[Dict] = []

    def add_job(self, name: str, fn: Callable, schedule: str = "intraday"):
        self._jobs.append({"name": name, "fn": fn, "schedule": schedule})

    def run_forever(self):
        log.info("Scheduler started. Market hours %s-%s IST",
                 ENGINE.market.open_time, ENGINE.market.close_time)
        while True:
            now = datetime.now().time()
            if ENGINE.market.open_time <= now <= ENGINE.market.close_time:
                for job in self._jobs:
                    try:
                        job["fn"]()
                    except Exception as exc:
                        log.exception("Job %s failed: %s", job["name"], exc)
            time.sleep(ENGINE.scan_interval_seconds)
