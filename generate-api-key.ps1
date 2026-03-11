# 生成随机 API Key 的 PowerShell 脚本

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  TG图床 - API Key 生成工具" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# 生成 32 字节的随机十六进制字符串（64 个字符）
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$API_KEY = [System.BitConverter]::ToString($bytes).Replace("-","").ToLower()

Write-Host "生成的新 API Key:" -ForegroundColor Green
Write-Host ""
Write-Host "  $API_KEY" -ForegroundColor Yellow
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "使用说明：" -ForegroundColor White
Write-Host "1. 复制上面的 API Key" -ForegroundColor White
Write-Host "2. 粘贴到 data.json 文件的 api_keys 数组中" -ForegroundColor White
Write-Host "3. 重启服务使其生效" -ForegroundColor White
Write-Host ""
Write-Host "示例配置：" -ForegroundColor White
Write-Host '{'
Write-Host '  "api_keys": ['
Write-Host "    `"$API_KEY`""
Write-Host '  ]'
Write-Host '}'
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
