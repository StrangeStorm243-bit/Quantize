"""Stable runtime-diagnostic codes owned by the evaluator (see ``runtime.diagnostics``)."""

from __future__ import annotations

NO_VISIBLE_SESSION = "no_visible_session"
MISSING_TERMINAL_NODE = "missing_terminal_node"
MULTIPLE_TERMINAL_NODES = "multiple_terminal_nodes"
INVALID_TERMINAL_NODE = "invalid_terminal_node"
IMPLEMENTATION_UNAVAILABLE = "implementation_unavailable"
MISSING_RUNTIME_INPUT = "missing_runtime_input"
NODE_EXECUTION_FAILED = "node_execution_failed"
WRONG_OUTPUT_PORTS = "wrong_output_ports"
WRONG_OUTPUT_TYPE = "wrong_output_type"
