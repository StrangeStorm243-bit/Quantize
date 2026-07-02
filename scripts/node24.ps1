# node24.ps1 — activate the repository's Node 24 toolchain in the CURRENT PowerShell process.
#
# Non-interactive shells do not load the user profile, so `node` resolves to whatever is on the
# system PATH (which may be Node 25+, blocked by engine-strict). This script locates fnm without
# a profile, initializes its environment (process-level env vars persist after the script
# returns), activates Node 24, and asserts `node --version` is v24.*.
#
# Usage (from any shell, any cwd):
#   ./scripts/node24.ps1          # activate + assert; exits 1 with a clear message on failure
# After it succeeds, node/npm/npx in the same process are Node 24.

$ErrorActionPreference = "Stop"

function Find-Fnm {
    $existing = Get-Command fnm -ErrorAction SilentlyContinue
    if ($null -ne $existing) { return (Split-Path $existing.Source) }
    $candidates = @()
    if ($env:LOCALAPPDATA) {
        # winget install location (versioned package dir; wildcard avoids hardcoding the source)
        $candidates += Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages") `
            -Filter "Schniz.fnm_*" -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { $_.FullName }
        $candidates += (Join-Path $env:LOCALAPPDATA "fnm")
    }
    if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE ".fnm") }
    foreach ($dir in $candidates) {
        if ($dir -and (Test-Path (Join-Path $dir "fnm.exe"))) { return $dir }
    }
    return $null
}

$fnmDir = Find-Fnm
if ($null -eq $fnmDir) {
    Write-Error "fnm not found (checked PATH, winget packages, %LOCALAPPDATA%\fnm, %USERPROFILE%\.fnm). Install fnm and Node 24."
    exit 1
}
if ($env:PATH -notlike "*$fnmDir*") { $env:PATH = "$fnmDir;$env:PATH" }

# Initialize fnm in this process (sets FNM_* vars and the multishell PATH entry).
fnm env --use-on-cd --shell power-shell | Out-String | Invoke-Expression

fnm use 24 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "fnm could not activate Node 24 (is it installed? try: fnm install 24)."
    exit 1
}

$nodeVersion = (& node --version) 2>$null
if ($nodeVersion -notlike "v24.*") {
    Write-Error "Node activation failed: 'node --version' reports '$nodeVersion', expected v24.*"
    exit 1
}
Write-Host "node24: active ($nodeVersion)"
