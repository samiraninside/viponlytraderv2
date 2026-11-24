"""Agent Registry handles discovery and life cycle of modular agents."""
from __future__ import annotations

from typing import Dict, List, Optional, Type

from .base_agent import BaseAgent


class AgentRegistry:
    """Discovers and manages agent instances. Supports hot-reload capability."""

    def __init__(self):
        self._instances: Dict[str, BaseAgent] = {}
        self._classes: Dict[str, Type[BaseAgent]] = {}

    def register(self, agent_cls: Type[BaseAgent]) -> None:
        """Register an agent class for later instantiation."""
        name = getattr(agent_cls, "name", agent_cls.__name__.lower())
        self._classes[name] = agent_cls

    def instantiate(self, name: str, *args, **kwargs) -> Optional[BaseAgent]:
        """Create a new instance of a registered agent class."""
        if name in self._classes:
            instance = self._classes[name](*args, **kwargs)
            self._instances[name] = instance
            return instance
        return None

    def get_instance(self, name: str) -> Optional[BaseAgent]:
        return self._instances.get(name)

    def list_instances(self) -> List[BaseAgent]:
        return list(self._instances.values())

    def list_available(self) -> List[str]:
        return list(self._classes.keys())


_global_registry = AgentRegistry()


def get_registry() -> AgentRegistry:
    return _global_registry
