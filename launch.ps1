$ErrorActionPreference = 'SilentlyContinue'

# ===== 自动配置 Node 环境 =====
$nodeDir = 'D:\新建文件夹 (4)'
$nodeExe = Join-Path $nodeDir 'node.exe'
if (-not (Test-Path $nodeExe)) {
    Write-Host "[错误] 未找到 node.exe: $nodeDir" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit 1
}
$env:PATH = "$nodeDir;$env:PATH"

# ===== 检查服务器是否已在运行 =====
function Test-Server {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

if (-not (Test-Server)) {
    Write-Host '正在启动服务器...'
    Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -WorkingDirectory 'D:\aircraft-lookup' -WindowStyle Minimized

    # 等待服务器就绪（最多 15 秒）
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Server) { $ready = $true; break }
    }
    if (-not $ready) {
        Write-Host '[警告] 服务器启动超时，请检查是否有端口占用或报错。' -ForegroundColor Yellow
    }
}

# ===== 打开浏览器 =====
Write-Host '正在打开浏览器: http://127.0.0.1:3000'
Start-Process 'http://127.0.0.1:3000'

Start-Sleep -Seconds 2