# TG 图床数据库初始化与迁移脚本（Windows）

$ErrorActionPreference = 'Stop'

Write-Host "=========================================="
Write-Host "  TG 图床 - 数据库初始化/迁移"
Write-Host "=========================================="
Write-Host ""

$configPath = Join-Path $PSScriptRoot 'data.json'
$sqlPath = Join-Path $PSScriptRoot 'init_db.go.sql'

if (-not (Test-Path $configPath)) {
    Write-Host "[ERROR] 配置文件 data.json 不存在"
    exit 1
}

if (-not (Test-Path $sqlPath)) {
    Write-Host "[ERROR] 找不到 SQL 文件: $sqlPath"
    exit 1
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$db = $config.mysql

if ([string]::IsNullOrWhiteSpace($db.database)) {
    Write-Host "[ERROR] 配置缺失: mysql.database 不能为空"
    exit 1
}

Write-Host "[INFO] 数据库配置:"
Write-Host "  主机: $($db.host)"
Write-Host "  端口: $($db.port)"
Write-Host "  用户: $($db.username)"
Write-Host "  数据库: $($db.database)"
Write-Host ""

$mysqlArgs = @(
    "-h$($db.host)",
    "-P$($db.port)",
    "-u$($db.username)",
    "-p$($db.password)"
)

Write-Host "[INFO] 测试数据库连接..."
& mysql @mysqlArgs -e "SELECT 1;" *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] 数据库连接失败，请检查配置"
    exit 1
}
Write-Host "[SUCCESS] 数据库连接成功"
Write-Host ""

Write-Host "[INFO] 执行表结构初始化与兼容迁移（幂等）..."
Get-Content $sqlPath -Raw | & mysql @mysqlArgs $db.database
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] SQL 执行失败"
    exit 1
}

Write-Host ""
Write-Host "[SUCCESS] 数据库初始化/迁移完成（数据保留）"
Write-Host ""
