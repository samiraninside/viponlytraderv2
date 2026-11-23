from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, List, Optional

from data.models import Candidate


class BaseAgent(ABC):
    """Base class for all agents.

    Subclasses set `name`, `version`, `description`, then implement
    `required_data()` and `scan()`. `emit()` validates and publishes.
    Override `validate()` for per-candidate filters.

    Because every agent is constructed from a config dict and exposes
    `get_params()` / `set_params()`, thresholds can be tuned live and new
    agent files can be dropped into agents/ without touching this class.
    """

    name: str = "base_agent"
    version: str = "1.0.0"
    description: str = ""

    def __init__(self, signal_bus=None, config: Optional[dict] = None):
        self.signal_bus = signal_bus
        self.config: dict = config or {}
        self.created_at: datetime = datetime.utcnow()
        self.last_run: Optional[datetime] = None
        self.run_count: int = 0
        self.total_signals_emitted: int = 0

    def required_data(self) -> List[str]:
        return []

    @abstractmethod
    def scan(self, data: Dict[str, Any]) -> List[Candidate]:
        raise NotImplementedError

    def validate(self, candidate: Candidate) -> bool:
        return True

    def emit(self, data: Dict[str, Any]) -> List[Candidate]:
        candidates = self.scan(data)
        validated = [c for c in candidates if self.validate(c)]

        if self.signal_bus is not None:
            for c in validated:
                self.signal_bus.publish(self.name, c)

        self.last_run = datetime.utcnow()
        self.run_count += 1
        self.total_signals_emitted += len(validated)
        return validated

    def status(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "last_run": self.last_run.isoformat() if self.last_run else None,
            "run_count": self.run_count,
            "signals_emitted": self.total_signals_emitted,
        }

    def get_params(self) -> Dict[str, Any]:
        return dict(self.config)

    def set_params(self, params: Dict[str, Any]) -> None:
        self.config.update(params or {})
