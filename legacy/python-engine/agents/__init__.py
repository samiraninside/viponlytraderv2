"""Agent framework: BaseAgent + registry + hot-reload.

Every agent inherits from BaseAgent and implements:
  - name, version, description
  - required_data() -> list of data keys it needs
  - scan() -> list[Candidate]
  - validate() -> bool (optional override)
  - emit() -> list[Candidate]

Hot-reload: agents/ folder is watched; new .py files are imported on change.
"""
from .base_agent import BaseAgent
from .registry import AgentRegistry, get_registry
from .signal_bus import SignalBus
from .scanner_agent import ScannerAgent
from .strategy_engine import StrategyEngineAgent
from .oi_analysis_agent import OIAnalysisAgent
from .risk_tier_agent import RiskTierAgent
from .averaging_logic_agent import AveragingLogicAgent
from .signal_aggregator import SignalAggregator
from .vega_greeks_agent import VegaGreeksAgent

__all__ = [
    "BaseAgent",
    "AgentRegistry",
    "get_registry",
    "SignalBus",
    "ScannerAgent",
    "StrategyEngineAgent",
    "OIAnalysisAgent",
    "RiskTierAgent",
    "AveragingLogicAgent",
    "SignalAggregator",
    "VegaGreeksAgent",
]