"""In-memory pub/sub signal bus. Agents publish candidates; aggregator subscribes."""
from __future__ import annotations

from collections import defaultdict
from typing import Callable, Dict, List

from data.models import Candidate


class SignalBus:
    """Simple pub/sub. Future: Redis Streams for cross-process agents."""

    def __init__(self):
        self._subscribers: Dict[str, List[Callable[[Candidate], None]]] = defaultdict(list)
        self._recent: List[Candidate] = []

    def subscribe(self, agent_name: str, callback: Callable[[Candidate], None]) -> None:
        self._subscribers[agent_name].append(callback)

    def publish(self, source: str, candidate: Candidate) -> None:
        self._recent.append(candidate)
        # Keep only last 500
        if len(self._recent) > 500:
            self._recent.pop(0)

        for cb in self._subscribers.get("*", []):
            cb(candidate)
        for cb in self._subscribers.get(source, []):
            cb(candidate)

    def recent(self, limit: int = 50) -> List[Candidate]:
        return self._recent[-limit:]