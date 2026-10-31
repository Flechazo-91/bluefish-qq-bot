# 用 GitHub REST API 发布仓库（不需要装 git；适用于 github.com 直连被墙但 api.github.com 可达的情况）
#
# 用法：
#   $env:GITHUB_TOKEN = "ghp_xxx"          # 需要 repo 权限（fine-grained: Contents=Read/Write + Administration=Write）
#   powershell -ExecutionPolicy Bypass -File publish.ps1 -RepoName bluefish-qq-bot
#
# 可选：
#   -RepoName     仓库名，默认 bluefish-qq-bot
#   -Description  仓库描述
#   -Private      建私有仓库（默认公开）
#   -DryRun       只打印将上传的文件，不实际调用写接口

param(
    [string]$RepoName = "bluefish-qq-bot",
    [string]$Description = "Windows 上的 QQ 机器人：唱歌/点歌/画画/课表/抖音自动化（AstrBot 插件 + 工具集）",
    [switch]$Private,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'README.md'))) { $root = $PSScriptRoot }
$api = 'https://api.github.com'

$token = $env:GITHUB_TOKEN
if (-not $token -and -not $DryRun) {
    Write-Host "缺少 GITHUB_TOKEN 环境变量。" -ForegroundColor Yellow
    Write-Host "去 https://github.com/settings/tokens 建一个 classic token（勾 repo），或 fine-grained token（Contents: Read/Write, Administration: Write）"
    exit 2
}

$headers = @{
    Authorization          = "Bearer $token"
    Accept                 = "application/vnd.github+json"
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'bluefish-publish'
}

function Api($method, $path, $body) {
    $uri = "$api$path"
    $args = @{ Method = $method; Uri = $uri; Headers = $headers; TimeoutSec = 60 }
    if ($null -ne $body) { $args['Body'] = ($body | ConvertTo-Json -Depth 5 -Compress); $args['ContentType'] = 'application/json' }
    return Invoke-RestMethod @args
}

# 1) 身份
if ($DryRun) {
    $owner = "<你的GitHub用户名>"
    Write-Host "[DryRun] 跳过令牌校验" -ForegroundColor Yellow
} else {
    try { $me = Api 'GET' '/user' $null } catch {
        Write-Host "令牌校验失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "检查：token 是否过期、是否有 repo / Contents 权限"
        exit 3
    }
    $owner = $me.login
    Write-Host "账号: $owner" -ForegroundColor Cyan
}

# 2) 收集文件
$files = Get-ChildItem $root -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\(\.git|node_modules|__pycache__|logs|Models)\\' -and
    $_.Name -notmatch '\.(pyc|log|db|sqlite|jsonl|wav|mp3|mp4|zip|pth|pt|safetensors|onnx)$'
} | ForEach-Object {
    [pscustomobject]@{
        rel  = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
        size = $_.Length
        path = $_.FullName
    }
}
Write-Host ("待上传 {0} 个文件，共 {1:N0} KB" -f $files.Count, (($files | Measure-Object size -Sum).Sum / 1KB))
if ($DryRun) { $files | ForEach-Object { "  " + $_.rel }; exit 0 }

# 3) 建仓库
try {
    $repo = Api 'POST' '/user/repos' @{
        name        = $RepoName
        description = $Description
        private     = [bool]$Private
        auto_init   = $false
        has_issues  = $true
        has_wiki    = $false
    }
    Write-Host "仓库已创建: $($repo.html_url)" -ForegroundColor Green
} catch {
    Write-Host "创建仓库失败（可能已存在）：$($_.Exception.Message)" -ForegroundColor Yellow
}

# 4) 逐个上传
$i = 0; $fail = 0
foreach ($f in $files) {
    $i++
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.path))
    try {
        Api 'PUT' "/repos/$owner/$RepoName/contents/$([uri]::EscapeDataString($f.rel).Replace('%2F','/'))" @{
            message = "add $($f.rel)"
            content = $b64
        } | Out-Null
        Write-Host ("[{0}/{1}] {2}" -f $i, $files.Count, $f.rel) -ForegroundColor DarkGray
    } catch {
        $fail++
        Write-Host ("[{0}/{1}] 失败 {2}: {3}" -f $i, $files.Count, $f.rel, $_.Exception.Message) -ForegroundColor Red
    }
    Start-Sleep -Milliseconds 150
}

Write-Host ""
Write-Host ("完成：成功 {0}，失败 {1}" -f ($files.Count - $fail), $fail) -ForegroundColor Cyan
Write-Host "仓库地址: https://github.com/$owner/$RepoName"
