#!/usr/bin/env bash
# gate.sh — POSIX sibling of scripts/gate.ps1 (the canonical full verification gate).
#
# PARITY NOTE (deliberate duplication, scope-reviewed): this script runs the IDENTICAL stage
# set in the IDENTICAL fail-fast order as gate.ps1. If you add/remove/reorder a stage, change
# BOTH scripts in the same commit. Read-only: leaves the working tree unchanged.
#
# Usage:  bash scripts/gate.sh   (from any current directory)

set -u

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root" || exit 1

if [ -x ".venv/bin/python" ]; then
    python=".venv/bin/python"
elif [ -x ".venv/Scripts/python.exe" ]; then
    python=".venv/Scripts/python.exe" # Git Bash on Windows
else
    echo "gate: venv python not found (create the venv per CLAUDE.md first)" >&2
    exit 1
fi

activate_node24() {
    if node -v 2>/dev/null | grep -q '^v24\.'; then
        echo "node24: active ($(node -v))"
        return 0
    fi
    if command -v fnm >/dev/null 2>&1; then
        eval "$(fnm env 2>/dev/null)" >/dev/null 2>&1 || true
        fnm use 24 >/dev/null 2>&1 || true
    fi
    if [ -s "${HOME}/.nvm/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "${HOME}/.nvm/nvm.sh" >/dev/null 2>&1 || true
        nvm use 24 >/dev/null 2>&1 || true
    fi
    if node -v 2>/dev/null | grep -q '^v24\.'; then
        echo "node24: active ($(node -v))"
        return 0
    fi
    echo "gate: Node 24 required; found $(node -v 2>/dev/null || echo 'no node')" >&2
    return 1
}

run_stage() {
    stage_name="$1"
    shift
    printf '\n=== gate: %s ===\n' "$stage_name"
    "$@"
    stage_status=$?
    if [ "$stage_status" -ne 0 ]; then
        printf '=== gate FAILED at: %s (exit %s) ===\n' "$stage_name" "$stage_status"
        exit "$stage_status"
    fi
}

run_stage "pytest" "$python" -m pytest
run_stage "ruff check" "$python" -m ruff check .
run_stage "ruff format --check" "$python" -m ruff format --check .
run_stage "mypy" "$python" -m mypy
run_stage "node24 activation" activate_node24
run_stage "codegen check" "$python" -m quantize.codegen check
run_stage "tsc typecheck" npm run typecheck

printf '\n=== gate: ALL STAGES PASSED ===\n'
exit 0
