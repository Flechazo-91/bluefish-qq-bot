# 一键停止：只停"本程序跑的" SnowLuma / AstrBot / 本地语音服务，不动 QQ 客户端。
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

$patterns = @(
    'snowluma.*index\.mjs',
    'astrbot\.exe"?\s+run',
    'api_v2\.py',
    'stt_server\.py',
    'embed_server\.py'
)

$killed = 0
foreach ($pat in $patterns) {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pat } | ForEach-Object {
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
            $killed++
            W ("已停止 {0} (pid={1})" -f $_.Name, $_.ProcessId)
        } catch { W ("停止失败 {0}: {1}" -f $_.ProcessId, $_.Exception.Message) }
    }
}
Start-Sleep -Seconds 2
$still = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @($port, 5099, 6185, 8000, 8100, 9880) })
W ("共停止 {0} 个进程；仍在线端口: {1}" -f $killed, (($still | Select-Object -ExpandProperty LocalPort -Unique) -join ', '))
exit 0
