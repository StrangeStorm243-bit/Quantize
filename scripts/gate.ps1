# gate.ps1 — the canonical full verification gate (CLAUDE.md "Repository commands").
#
# Runs every authoritative check, fail-fast, from any current directory. Read-only: leaves the
# working tree unchanged. Exits non-zero on the first failing stage.
#
# PARITY NOTE: scripts/gate.sh is the POSIX sibling and must run the IDENTICAL stage set in the
# IDENTICAL fail-fast order. If you add/remove/reorder a stage, change BOTH scripts together.
#
# Usage:  ./scripts/gate.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Error "gate: venv python not found at $python (create the venv per CLAUDE.md first)"
    exit 1
}

Push-Location $repoRoot
try {
    $stages = @(
        @{ Name = "pytest";              Cmd = { & $python -m pytest } },
        @{ Name = "ruff check";          Cmd = { & $python -m ruff check . } },
        @{ Name = "ruff format --check"; Cmd = { & $python -m ruff format --check . } },
        @{ Name = "mypy";                Cmd = { & $python -m mypy } },
        @{ Name = "node24 activation";   Cmd = { & (Join-Path $repoRoot "scripts\node24.ps1") } },
        @{ Name = "codegen check";       Cmd = { & $python -m quantize.codegen check } },
        @{ Name = "tsc typecheck";       Cmd = { npm run typecheck } }
    )
    foreach ($stage in $stages) {
        Write-Host ""
        Write-Host "=== gate: $($stage.Name) ===" -ForegroundColor Cyan
        & $stage.Cmd
        if ($LASTEXITCODE -ne 0) {
            Write-Host "=== gate FAILED at: $($stage.Name) (exit $LASTEXITCODE) ===" -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }
    Write-Host ""
    Write-Host "=== gate: ALL STAGES PASSED ===" -ForegroundColor Green
    exit 0
}
finally {
    Pop-Location
}
