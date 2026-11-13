<#
.SYNOPSIS
AiWork2API 一键上手（Docker，Windows / PowerShell 版）。

.DESCRIPTION
与 scripts/quickstart.sh 等价：检查环境、准备 .env、构建并启动、探活，最后打印
控制台地址、Base URL 和生成的 API Key。

登录态只检测，不代做；端口被占用时直接报错，不静默顺延。

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\quickstart.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\quickstart.ps1 -SkipLoginCheck
#>

# 维护提示：本文件必须保存为 UTF-8 with BOM。PowerShell 5.1 读取无 BOM 的
# UTF-8 脚本时会按系统代码页解析，中文注释会破坏语法。
param(
    [switch]$SkipLoginCheck,
    [switch]$NoBuild,
    [switch]$Help
)

if ($Help) {
    Get-Help $MyInvocation.MyCommand.Path -Detailed
    exit 0
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Write-Bold([string]$msg) { Write-Host "`n$msg" -ForegroundColor White }
function Write-Info([string]$msg) { Write-Host "  $msg" }
function Write-Ok([string]$msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "  [x]  $msg" -ForegroundColor Red }
function Die([string]$msg) { Write-Fail $msg; exit 1 }

$script:ComposeExe = $null
$script:ComposePrefix = @()

function Read-EnvFile {
    if (-not (Test-Path -LiteralPath $script:EnvFile)) { return @() }
    return @(Get-Content -LiteralPath $script:EnvFile -Encoding UTF8)
}

function Get-EnvValue([string]$key) {
    $pattern = '^\s*' + [regex]::Escape($key) + '='
    $line = Read-EnvFile | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $line) { return $null }
    return ($line -replace $pattern, '').Trim()
}

# 与 bash 版的 write_env 同口径：同名键只留第一处，其余删除；保留原文件换行风格。
function Set-EnvValue([string]$key, [string]$value) {
    $raw = [System.IO.File]::ReadAllText($script:EnvFile)
    $nl = "`n"
    if ($raw -match "`r`n") { $nl = "`r`n" }
    $pattern = '^\s*' + [regex]::Escape($key) + '='
    $out = New-Object System.Collections.Generic.List[string]
    $done = $false
    foreach ($line in ($raw -split "`r?`n")) {
        if ($line -match $pattern) {
            if (-not $done) { $out.Add("$key=$value"); $done = $true }
        } else {
            $out.Add($line)
        }
    }
    if (-not $done) { $out.Add("$key=$value") }
    $text = ($out -join $nl).TrimEnd([char[]]"`r`n") + $nl
    [System.IO.File]::WriteAllText($script:EnvFile, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------- 1. 环境检查 ----------

Write-Bold '1/5 检查环境'

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
    & docker compose version *> $null
    if ($LASTEXITCODE -eq 0) {
        $script:ComposeExe = 'docker'
        $script:ComposePrefix = @('compose')
    }
}
if (-not $script:ComposeExe) {
    $composeV1 = Get-Command docker-compose -ErrorAction SilentlyContinue
    if ($composeV1) {
        $script:ComposeExe = 'docker-compose'
        $script:ComposePrefix = @()
    }
}
if (-not $script:ComposeExe) {
    Die '没找到 Docker Compose。装 Docker Desktop，确认 `docker compose version` 能跑，再回来执行本脚本。'
}
Write-Ok "Docker Compose 可用（$($script:ComposeExe) $($script:ComposePrefix -join ' ')）"

$composeFile = Join-Path $Root 'docker-compose.yml'
if (-not (Test-Path -LiteralPath $composeFile)) {
    Die '当前目录不是项目根目录。在项目根目录执行：powershell -ExecutionPolicy Bypass -File scripts\quickstart.ps1'
}
Write-Ok "项目根目录：$Root"

# 参数必须显式用 -ComposeArgs 数组传：若直接用 `Invoke-Compose up -d`，
# PowerShell 会把 -d 当成函数参数名吞掉，compose 退化成前台模式。
function Invoke-Compose {
    param([string[]]$ComposeArgs)
    if ($script:ComposePrefix.Count -gt 0) {
        & $script:ComposeExe $script:ComposePrefix[0] @ComposeArgs
    } else {
        & $script:ComposeExe @ComposeArgs
    }
}

# ---------- 2. 登录态检测（只检测，不代做） ----------

Write-Bold '2/5 检查登录态'

$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = $env:HOME }

$candidates = @()
if ($env:AGENTIX_STATE_DIR) { $candidates += $env:AGENTIX_STATE_DIR }
$candidates += (Join-Path $homeDir '.local\share\agentix')
$candidates += (Join-Path $homeDir '.agentix')
if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'Agentix') }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'AiWork') }

$stateDir = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Container)) { $stateDir = $c; break }
}

if ($SkipLoginCheck) {
    Write-Warn '已按 -SkipLoginCheck 跳过检测，请自行确认挂载路径正确'
    if (-not $stateDir) { $stateDir = Join-Path $homeDir '.agentix' }
} elseif ($stateDir) {
    Write-Ok "找到登录态目录：$stateDir"
} else {
    Write-Fail '没有找到登录态目录，找过：'
    foreach ($c in $candidates) { Write-Host "      $c" }
    Write-Host ''
    Write-Host '    这一步必须你自己做，官方授权要在浏览器里点确认，脚本代替不了。'
    Write-Host ''
    Write-Host '      irm https://aiwork-dl.dtagi.cn/releases/install-aiwork.ps1 | iex'
    Write-Host '      aiworkcn login'
    Write-Host ''
    Write-Host '    凭据目录不在默认位置的话，在 .env 里写：'
    Write-Host '      AGENTIX_HOST_STATE_DIR=C:/你的/路径'
    Write-Host '    或直接指定：$env:AGENTIX_STATE_DIR="C:\你的\路径" 后再执行本脚本'
    Write-Host ''
    Write-Host '    确认挂载在别处、想继续启动：powershell -ExecutionPolicy Bypass -File scripts\quickstart.ps1 -SkipLoginCheck'
    exit 1
}

if ($stateDir -and -not (Test-Path -LiteralPath $stateDir -PathType Container)) {
    Write-Warn "登录态目录不存在：$stateDir"
    Write-Warn '跳过了登录检测才走到这里；容器会挂进空目录，账号数仍是 0'
}

# ---------- 3. 准备 .env ----------

Write-Bold '3/5 准备 .env'

$script:EnvFile = Join-Path $Root '.env'
if (Test-Path -LiteralPath $script:EnvFile) {
    Write-Ok '.env 已存在，保留不动'
} else {
    Copy-Item -LiteralPath (Join-Path $Root '.env.example') -Destination $script:EnvFile
    Write-Ok '已从 .env.example 生成 .env'
}

# compose 的挂载源要正斜杠，C:\Users\x -> C:/Users/x
function ConvertTo-ComposePath([string]$p) { return ($p -replace '\\', '/') }

$mountHost = Get-EnvValue 'AGENTIX_HOST_STATE_DIR'
if ($mountHost) {
    Write-Ok ".env 已指定 AGENTIX_HOST_STATE_DIR=$mountHost"
} elseif ($stateDir) {
    $mountHost = ConvertTo-ComposePath $stateDir
    Set-EnvValue 'AGENTIX_HOST_STATE_DIR' $mountHost
    Write-Ok "已写入 .env：AGENTIX_HOST_STATE_DIR=$mountHost"
}

$generatedKey = $null
$apiKeys = Get-EnvValue 'API_KEYS'
if ($apiKeys -and $apiKeys -match 'sk-change-me-please') {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $generatedKey = 'sk-' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    Set-EnvValue 'API_KEYS' ($apiKeys -replace 'sk-change-me-please', $generatedKey)
    Write-Ok '已把占位的 sk-change-me-please 换成随机 key'
} else {
    $generatedKey = ($apiKeys -split ':')[0]
    if ($generatedKey) { Write-Ok '沿用 .env 里已有的 key' } else { Write-Warn 'API_KEYS 看起来是空的，稍后调用会 401' }
}

# ---------- 4. 端口检查 ----------

Write-Bold '4/5 检查端口'

$hostPort = Get-EnvValue 'HOST_PORT'
if (-not $hostPort) { $hostPort = '8080' }
$publishAddr = Get-EnvValue 'PUBLISH_ADDR'
if (-not $publishAddr) { $publishAddr = '127.0.0.1' }
$portNumber = [int]$hostPort

$busy = $false
$probe = New-Object System.Net.Sockets.TcpClient
try {
    $probe.Connect('127.0.0.1', $portNumber)
    $busy = $true
} catch {
    $busy = $false
} finally {
    $probe.Close()
}

if ($busy) {
    $running = (Invoke-Compose -ComposeArgs @('ps', '--status', 'running') 2>$null | Out-String)
    if ($running -match 'aiwork') {
        Write-Warn "端口 $portNumber 已被本项目的容器占用，将直接复用并重启"
    } else {
        $nextPort = $portNumber + 1
        Write-Fail "端口 $portNumber 已被其他程序占用。"
        Write-Host '    换一个端口（一条命令，会同时改 .env 并重建）：'
        Write-Host "      ./scripts/set-port.sh --host $nextPort"
        Write-Host '    或者手动改 .env 的 HOST_PORT 后重新执行本脚本。'
        exit 1
    }
} else {
    Write-Ok "端口 $portNumber 空闲"
}

# ---------- 5. 启动并探活 ----------

Write-Bold '5/5 构建并启动（首次约 10~15 秒）'

if ($NoBuild) {
    Invoke-Compose -ComposeArgs @('up', '-d')
} else {
    Invoke-Compose -ComposeArgs @('up', '-d', '--build')
}
if ($LASTEXITCODE -ne 0) {
    Write-Fail '启动失败。'
    Write-Host '    看详细日志：'
    Write-Host "      $($script:ComposeExe) $($script:ComposePrefix -join ' ') logs -f aiwork"
    exit 1
}

$base = "http://127.0.0.1:$portNumber"
Write-Host '  等待服务就绪' -NoNewline
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "$base/healthz" -UseBasicParsing -TimeoutSec 2
        if ($resp.Content -match '^ok') { $ready = $true; break }
    } catch {
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 1
    }
}
Write-Host ''

if (-not $ready) {
    Write-Fail "40 秒内没有探活成功（$base/healthz）"
    Write-Host '    先看日志定位，多半是登录态没挂进去或端口映射不对：'
    Write-Host "      $($script:ComposeExe) $($script:ComposePrefix -join ' ') logs --tail=50 aiwork"
    exit 1
}

Write-Ok '服务已就绪'

# ---------- 收尾 ----------

Write-Host ''
Write-Bold '可以用了'
Write-Host ''
if ($publishAddr -ne '127.0.0.1') {
    Write-Info "注意：PUBLISH_ADDR=$publishAddr，端口已对外发布；公网部署请设 ADMIN_PASSWORD。"
}
Write-Host "  控制台    $base/"
Write-Host "  Base URL  $base/v1"
if ($generatedKey) { Write-Host "  API Key   $generatedKey" } else { Write-Host '  API Key   （见 .env 的 API_KEYS）' }
Write-Host ''
Write-Host '  试一句：'
Write-Host ''
Write-Host "    curl $base/v1/chat/completions ``"
Write-Host "      -H `"Authorization: Bearer $($generatedKey)`" ``"
Write-Host '      -H "Content-Type: application/json" `'
Write-Host '      -d ''{"model":"automodel","messages":[{"role":"user","content":"你好"}]}'''
Write-Host ''
Write-Info '接 Codex CLI：docs/clients/codex.md'
Write-Info '接 Claude Code：docs/clients/claude-code.md'
Write-Info '排障：docs/troubleshooting.md'
