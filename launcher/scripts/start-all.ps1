# 一键启动：QQ（若未开）→ SnowLuma → AstrBot → 语音/向量服务，全部隐藏窗口。
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'startup.log'

function W($msg) { $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg; Write-Host $line; Add-Content $log $line -Encoding UTF8 }

$profilePath = Join-Path $here 'profile.json'
$p = @{}
if (Test-Path $profilePath) { $p = Get-Content $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json }
$port = if ($p.onebot_port) { [int]$p.onebot_port } else { 3000 }

function Resolve-Home([string]$child, [string]$fallback) {
    foreach ($c in @((Join-Path $here $child), $fallback)) { if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path } }
    return $null
}
$astr = Resolve-Home 'AstrBot' 'D:/AstrBot'
$snow = Resolve-Home 'SnowLuma' 'D:/SnowLuma'
if (-not $astr) { W '找不到 AstrBot 目录'; exit 2 }
if (-not $snow) { W '找不到 SnowLuma 目录'; exit 2 }

function PortOpen([int]$p) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); return $true } catch { return $false }
}
function WaitPort([int]$p, [int]$sec = 60) {
    for ($i = 0; $i -lt $sec; $i++) { if (PortOpen $p) { return $true }; Start-Sleep -Seconds 1 }
    return $false
}
function StartHidden([string]$file, [string]$args, [string]$workdir, [string]$name) {
    try {
        Start-Process -FilePath $file -ArgumentList $args -WorkingDirectory $workdir -WindowStyle Hidden
        W "已启动 $name"
    } catch { W "启动 $name 失败: $($_.Exception.Message)" }
}

# 0) 应用最新配置
$apply = Join-Path $PSScriptRoot 'apply-config.ps1'
if ((Test-Path $apply) -and (Test-Path $profilePath)) {
    try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $apply 2>&1; W ('配置: ' + (($out | Out-String).Trim() -replace "`r?`n", ' | ')) }
    catch { W "配置应用失败: $($_.Exception.Message)" }
}

# 1) QQ 客户端（SnowLuma 需要挂在 QQ 上）
$qq = Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue
if (-not $qq) {
    $qqExe = @(
        'C:\Program Files\Tencent\QQNT\QQ.exe',
        'C:\Program Files (x86)\Tencent\QQNT\QQ.exe'
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($qqExe) { StartHidden $qqExe '' (Split-Path $qqExe) 'QQ 客户端'; Start-Sleep -Seconds 8 }
    else { W '没找到 QQ 客户端，请先手动打开并登录小号' }
}

# 2) SnowLuma
if (-not (PortOpen 5099)) {
    $nodeExe = Join-Path $snow 'app\node.exe'
    if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
    if ($nodeExe) {
        StartHidden $nodeExe 'index.mjs' (Join-Path $snow 'app') 'SnowLuma'
        if (-not (WaitPort 5099 60)) { W 'SnowLuma 60 秒内没起来，看 logs\snowluma*.log' }
    } else { W '没找到 node.exe，装 Node 18+ 再试' }
}

# 3) AstrBot
if (-not (PortOpen 6185)) {
    $astrExe = @(
        (Join-Path $astr 'astrbot.exe'),
        "$env:USERPROFILE\AppData\Roaming\uv\tools\astrbot\Scripts\astrbot.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($astrExe) {
        StartHidden $astrExe 'run' $astr 'AstrBot'
        if (-not (WaitPort 6185 120)) { W 'AstrBot 120 秒内没起来，看 AstrBot\data\logs\astrbot.log' }
    } else { W '没找到 astrbot.exe，先跑 install.ps1' }
}

# 4) 可选：本地语音/向量服务（有就起，没有不影响聊天）
$svc = @(
    @{ port = 9880; name = 'TTS 语音合成'; dir = 'Models\GPT-SoVITS'; args = 'api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml' },
    @{ port = 8000; name = 'STT 语音识别'; dir = $astr; args = 'stt_server.py' },
    @{ port = 8100; name = 'Embedding 向量'; dir = $astr; args = 'embed_server.py' }
)
foreach ($s in $svc) {
    if (PortOpen $s.port) { continue }
    $d = if ($s.dir -like 'Models*') { Join-Path $here $s.dir } else { $s.dir }
    if (-not (Test-Path $d)) { continue }
    $py = @(
        (Join-Path $here 'python\python.exe'),
        "$env:USERPROFILE\AppData\Roaming\uv\tools\astrbot\Scripts\python.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($py) { StartHidden $py $s.args $d $s.name }
}

Start-Sleep -Seconds 3
$ok = 0; $total = 4
foreach ($pp in @($port, 5099, 6185, 9880)) { if (PortOpen $pp) { $ok++ } }
W "完成：端口在线 $ok/4（OneBot=$port, SnowLuma=5099, AstrBot=6185, TTS=9880）"
if (-not (PortOpen $port)) { W 'OneBot 没起来：确认 QQ 已登录、SnowLuma 配置里的端口一致' }
exit 0
