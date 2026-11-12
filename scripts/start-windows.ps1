<#
.SYNOPSIS
Start AiWork Gateway on Windows without Docker or systemd.

.DESCRIPTION
Runs src/api-bridge.js directly with Node. Configuration lives in .env.windows
(git-ignored, separate from Docker's .env); persistent data lives in .\data.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -Port 18081 -Foreground
#>

param(
    [int]$Port = 8080,
    [switch]$Foreground,
    [switch]$SkipLoginCheck,
    [switch]$Help
)

if ($Help) {
    Get-Help $MyInvocation.MyCommand.Path -Detailed
    exit 0
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Say([string]$msg) { Write-Host "  $msg" }
function Ok([string]$msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Die([string]$msg) { Write-Host "  [x]  $msg" -ForegroundColor Red; exit 1 }

# ---------- 1. Prerequisites ----------
Write-Host "`n1/5 Checking prerequisites" -ForegroundColor White

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die 'Node.js not found. Install Node 20+ from https://nodejs.org/' }
$version = (& $node.Source -v)
$major = [int](($version -replace '^v', '').Split('.')[0])
if ($major -lt 20) { Die "Node 20+ required, found $version" }
Ok "Node $version"

$entry = Join-Path $Root 'src\api-bridge.js'
if (-not (Test-Path -LiteralPath $entry)) { Die 'src\api-bridge.js not found. Run this script from the repository.' }

# ---------- 2. Login state ----------
Write-Host "`n2/5 Checking CLI login state" -ForegroundColor White

$candidates = @()
if ($env:AGENTIX_STATE_DIR) { $candidates += $env:AGENTIX_STATE_DIR }
$candidates += (Join-Path $env:USERPROFILE '.agentix')
if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'Agentix') }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'AiWork') }
$candidates += (Join-Path $env:USERPROFILE '.local\share\agentix')

$stateDir = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Container)) { $stateDir = $c; break }
}
if ($stateDir) {
    Ok "CLI state: $stateDir"
} elseif ($SkipLoginCheck) {
    $stateDir = Join-Path $env:USERPROFILE '.agentix'
    Warn "Login check skipped; using $stateDir (accounts may be 0)"
} else {
    Die "No CLI state directory found. Run 'aiworkcn login' first, or pass -SkipLoginCheck to use the console device authorization flow."
}

# ---------- 3. Configuration ----------
Write-Host "`n3/5 Preparing configuration" -ForegroundColor White

$envFile = Join-Path $Root '.env.windows'
# Keep a separate data dir from Docker's ./data, which may hold keys left by tests.
$dataDir = Join-Path $Root 'data-windows'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $Root '.env.example') -Destination $envFile
    Ok 'Created .env.windows from .env.example'
} else {
    Ok '.env.windows already exists'
}

function Set-EnvValue([string]$path, [string]$key, [string]$value) {
    $lines = @(Get-Content -LiteralPath $path -Encoding UTF8)
    $out = New-Object System.Collections.Generic.List[string]
    $done = $false
    foreach ($line in $lines) {
        if ($line -match ('^\s*' + [regex]::Escape($key) + '=')) {
            if (-not $done) { $out.Add("$key=$value"); $done = $true }
        } else {
            $out.Add($line)
        }
    }
    if (-not $done) { $out.Add("$key=$value") }
    [System.IO.File]::WriteAllText($path, ($out -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

$currentKeys = @(Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^API_KEYS=' })
if (($currentKeys.Count -eq 0) -or ($currentKeys[0] -match 'sk-change-me-please')) {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $newKey = 'sk-' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    Set-EnvValue $envFile 'API_KEYS' "$($newKey):default"
    Ok 'Generated a random API key'
}
$apiKey = ((Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^API_KEYS=' } | Select-Object -First 1) -replace '^API_KEYS=', '').Split(':')[0]

# .env.example targets containers; these paths must point at the local machine.
Set-EnvValue $envFile 'AGENTIX_STATE_DIR' $stateDir
Set-EnvValue $envFile 'GATEWAY_DATA_DIR' $dataDir
Set-EnvValue $envFile 'STATE_PATH' (Join-Path $dataDir 'usage-state.json')
Set-EnvValue $envFile 'DUMP_DIR' (Join-Path $dataDir 'gw-logs')
Set-EnvValue $envFile 'BIND' '127.0.0.1'
Set-EnvValue $envFile 'PORT' "$Port"
Set-EnvValue $envFile 'UPSTREAM' 'direct'
Ok "Config: $envFile (data: $dataDir)"

# Load into this process; child processes inherit them.
foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}

# ---------- 4. Port ----------
Write-Host "`n4/5 Checking port $Port" -ForegroundColor White

$probe = New-Object System.Net.Sockets.TcpClient
try {
    $probe.Connect('127.0.0.1', $Port)
    Die "Port $Port is already in use. Pick another with -Port 18081."
} catch {
    Ok "Port $Port is free"
} finally {
    $probe.Close()
}

# ---------- 5. Start ----------
Write-Host "`n5/5 Starting gateway" -ForegroundColor White

if ($Foreground) {
    Write-Host "`n  Running in foreground. Press Ctrl+C to stop.`n" -ForegroundColor Yellow
    & $node.Source $entry
    exit $LASTEXITCODE
}

# PowerShell 5.1's Start-Process builds a case-sensitive env dictionary and throws
# if both HTTP_PROXY and http_proxy exist (common with Git Bash / proxy tools).
# Keep one spelling per name in this process only; child processes inherit it.
$dupGroups = [Environment]::GetEnvironmentVariables('Process').Keys |
    ForEach-Object { [string]$_ } |
    Group-Object { $_.ToUpperInvariant() } |
    Where-Object { $_.Count -gt 1 }
foreach ($g in $dupGroups) {
    $keep = @($g.Group | Where-Object { $_ -ceq $_.ToUpperInvariant() } | Select-Object -First 1)
    if ($keep.Count -eq 0) { $keep = @($g.Group | Select-Object -First 1) }
    foreach ($k in $g.Group) {
        if ($k -cne $keep[0]) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
    }
}

$outLog = Join-Path $dataDir 'gateway.log'
$errLog = Join-Path $dataDir 'gateway.err.log'
$proc = Start-Process -FilePath $node.Source -ArgumentList @($entry) `
    -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2
        if ($r.Content -match '^ok') { $ready = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}

if (-not $ready) {
    Warn "No healthcheck response within 30s. Logs: $outLog / $errLog"
    Warn "Stop the process with: Stop-Process -Id $($proc.Id)"
    exit 1
}

Ok 'Service is ready'

# Once the gateway has started it writes api-keys.json. Prefer that token, since an
# existing data dir keeps its own keys and ignores the API_KEYS seed in .env.windows.
$keysFile = Join-Path $dataDir 'api-keys.json'
if (Test-Path -LiteralPath $keysFile) {
    try {
        $stored = (Get-Content -LiteralPath $keysFile -Raw -Encoding UTF8 | ConvertFrom-Json).keys |
            Where-Object { -not $_.revoked } | Select-Object -First 1
        if ($stored -and $stored.token) { $apiKey = $stored.token }
    } catch { Warn 'Could not read api-keys.json; showing the key from .env.windows' }
}

Write-Host "`n  Console   http://127.0.0.1:$Port/"
Write-Host "  Base URL  http://127.0.0.1:$Port/v1"
Write-Host "  API Key   $apiKey"
Write-Host "  PID       $($proc.Id)"
Write-Host "  Stop      Stop-Process -Id $($proc.Id)"
Write-Host "  Logs      $outLog"
Write-Host ""
