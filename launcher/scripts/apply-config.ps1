# 把 profile.json 写进 AstrBot / SnowLuma 的配置里（可重复执行）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $here 'profile.json'
if (-not (Test-Path $profilePath)) { throw "找不到 profile.json（先在界面里保存一次）" }
$p = Get-Content $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json

function Write-Utf8NoBom([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Resolve-Home([string]$child, [string]$fallback) {
    $cands = @((Join-Path $here $child), $fallback)
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path } }
    return $null
}

$astr = Resolve-Home 'AstrBot' 'D:/AstrBot'
$snow = Resolve-Home 'SnowLuma' 'D:/SnowLuma'
if (-not $astr) { throw "找不到 AstrBot 目录（放在本程序同级或 D:/AstrBot）" }
if (-not $snow) { throw "找不到 SnowLuma 目录（放在本程序同级或 D:/SnowLuma）" }

$lines = @()

# ---------- AstrBot: 模型 Key ----------
$cfgPath = Join-Path $astr 'data\cmd_config.json'
if (Test-Path $cfgPath) {
    Copy-Item $cfgPath "$cfgPath.bak" -Force
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $src = $cfg.provider_sources | Where-Object { $_.id -eq 'deepseek_source' }
    if ($src) {
        if ($p.deepseek_key) { $src.key = @($p.deepseek_key.Trim()) }
        if ($p.deepseek_base) { $src.api_base = $p.deepseek_base.Trim() }
    }
    Write-Utf8NoBom $cfgPath ($cfg | ConvertTo-Json -Depth 40)
    $lines += "AstrBot: API Key 已写入"
} else {
    $lines += "AstrBot: 没找到 cmd_config.json（首次启动后会生成，届时再点一次保存）"
}

# ---------- AstrBot: 功能开关 ----------
$plugMap = @{ 'astrbot_plugin_sing' = [bool]$p.enable_sing; 'astrbot_plugin_music' = [bool]$p.enable_music }
$enabled = @()
foreach ($k in $plugMap.Keys) { if ($plugMap[$k]) { $enabled += $k } }
if ($enabled.Count -gt 0 -and (Test-Path $cfgPath)) {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $all = @(Get-ChildItem (Join-Path $astr 'data\plugins') -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $off = $all | Where-Object { $enabled -notcontains $_ -and $_ -match 'sing|music|douyin' }
    if ($off) { $lines += ("AstrBot: 建议在管理页关闭插件 " + ($off -join ', ')) }
}

# ---------- 网易云 cookie ----------
if ($p.netease_cookie) {
    $ck = $p.netease_cookie.Trim()
    $out = Join-Path $astr 'netease.cookie'
    if ($ck -match 'MUSIC_U\s*=') {
        # 用户贴的是 k=v 形式 → 转成插件要的「k 空格 v」每行一条
        $pairs = @()
        foreach ($kv in ($ck -split '[;\r\n]+')) {
            if ($kv -match '^\s*([^=]+?)\s*=\s*(.+?)\s*$') { $pairs += ("{0} {1}" -f $Matches[1], $Matches[2]) }
        }
        Write-Utf8NoBom $out (($pairs -join "`r`n") + "`r`n")
    } else {
        Write-Utf8NoBom $out ($ck + "`n")
    }
    $lines += "AstrBot: 网易云 cookie 已写入"
}

# ---------- SnowLuma: 账号 + OneBot ----------
$uin = ($p.qq | Out-String).Trim()
if ($uin) {
    $cfgDir = Join-Path $snow 'app\config'
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    $file = Join-Path $cfgDir "onebot_$uin.json"
    $token = ($p.onebot_token | Out-String).Trim()
    if (-not $token) { $token = [guid]::NewGuid().ToString('N').Substring(0, 28) }
    $port = if ($p.onebot_port) { [int]$p.onebot_port } else { 3000 }
    $tmpl = @{
        mode     = 'snapshot'
        networks = @{
            httpServers = @(@{ name = 'http-default'; accessToken = $token; messageFormat = 'array'; reportSelfMessage = $false
                    host = '127.0.0.1'; port = $port; path = '/'; enableWebSocket = $false })
            httpClients = @()
            wsServers   = @(@{ name = 'ws-default'; accessToken = $token; messageFormat = 'array'; reportSelfMessage = $false
                    host = '127.0.0.1'; port = 3001; path = '/'; role = 'Universal' })
            wsClients   = @(@{ name = 'astrbot'; enabled = $true; url = 'ws://127.0.0.1:6199/ws'; role = 'Universal'
                    accessToken = 'snowluma-change-me'; messageFormat = 'array'; reportSelfMessage = $false; reconnectIntervalMs = 3000 })
        }
        statusCommand = @{ enabled = $true; swallow = $false; cooldownSeconds = 5; trigger = '#sl' }
        historySync   = @{ enabled = $false }
        notifications = @{ channelIds = @() }
    }
    Write-Utf8NoBom $file ($tmpl | ConvertTo-Json -Depth 20)
    $lines += "SnowLuma: 账号 $uin 的 OneBot 配置已写入（端口 $port）"
}

# 把 token 回写到 profile，方便界面显示
$lines -join "`n"
