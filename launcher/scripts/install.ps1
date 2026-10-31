# 安装脚本：检查环境 → 装 uv/AstrBot → 生成目录 → 建桌面快捷方式
# 用法（右键"用 PowerShell 运行"，或在终端里）：
#   powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $PSScriptRoot
$log = Join-Path $PSScriptRoot 'install.log'
function W($m) { $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Write-Host $line; Add-Content $log $line -Encoding UTF8 }
"=== 蓝色大肥鱼 安装器 ===" | Out-File $log -Encoding UTF8

# 1) 系统
W ("系统: " + [System.Environment]::OSVersion.VersionString)
if (-not ($PSVersionTable.PSVersion.Major -ge 5)) { W 'PowerShell 版本过低（需要 5.1+）' }

# 2) Python
$py = $null
foreach ($c in @('python', 'py')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
}
if ($py) { W ("Python: " + (& $py --version 2>&1)) } else { W '❌ 没找到 Python，请先装 https://www.python.org/downloads/（勾选 Add to PATH）' }

# 3) Node
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) { W ("Node: " + (& node -v)) } else { W '❌ 没找到 Node.js，请装 https://nodejs.org/ （18 或 20 LTS）' }

# 4) GPU
try { $g = & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>$null; if ($g) { W ("GPU: " + ($g | Select-Object -First 1)) } }
catch { W '⚠️ 没检测到 NVIDIA 显卡：能聊天，但没有语音/唱歌' }

# 5) uv + AstrBot
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) {
    W '安装 uv（Python 包管理器）…'
    try { Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression } catch { W 'uv 安装失败，请手动装：https://docs.astral.sh/uv/' }
    $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
}
if ($uv) {
    W '安装 AstrBot（首次会比较久）…'
    & uv tool install astrbot 2>&1 | ForEach-Object { W $_ }
} else { W '❌ 没有 uv，跳过 AstrBot 安装' }

# 6) 目录
$astrHome = Join-Path $here 'AstrBot'
$snowHome = Join-Path $here 'SnowLuma'
New-Item -ItemType Directory -Force -Path $astrHome, $snowHome, (Join-Path $here 'logs') | Out-Null
W "目录已准备: $astrHome ; $snowHome"
if (-not (Test-Path (Join-Path $snowHome 'app\index.mjs'))) {
    W '⚠️ SnowLuma 需要手动放入：把 SnowLuma 整个 app 目录复制到 SnowLuma\app\（下载地址见安装教程）'
}

# 7) 桌面快捷方式
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '蓝色大肥鱼.lnk'))
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = ('"{0}"' -f (Join-Path $PSScriptRoot '..\启动.vbs'))
$lnk.WorkingDirectory = $here
$lnk.Description = '蓝色大肥鱼控制台'
$lnk.Save()
W '桌面快捷方式已创建：蓝色大肥鱼'

W '安装流程结束。打开桌面「蓝色大肥鱼」→ ①环境自检 → ②填 QQ 和 Key → ③一键启动'
