# JWT 认证修复验证脚本 (PowerShell 版本)

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "JWT 认证修复验证" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# 检查 Go 环境
Write-Host "1. 检查 Go 环境..." -ForegroundColor Yellow
try {
    $goVersion = & go version
    Write-Host "✅ Go 版本：$goVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ 错误：未找到 Go 命令" -ForegroundColor Red
    exit 1
}
Write-Host ""

# 检查依赖
Write-Host "2. 检查项目依赖..." -ForegroundColor Yellow
if (Test-Path "go.mod") {
    Write-Host "✅ go.mod 存在" -ForegroundColor Green
} else {
    Write-Host "❌ 错误：未找到 go.mod 文件" -ForegroundColor Red
    exit 1
}
Write-Host ""

# 编译项目
Write-Host "3. 编译项目..." -ForegroundColor Yellow
try {
    & go build -o tg-imagebed-test.exe main.go
    Write-Host "✅ 编译成功" -ForegroundColor Green
} catch {
    Write-Host "❌ 编译失败" -ForegroundColor Red
    exit 1
}
Write-Host ""

# 检查代码关键点
Write-Host "4. 检查代码修改..." -ForegroundColor Yellow
Write-Host ""

Write-Host "  检查点 1: initJWTSecret() 函数是否存在..." -ForegroundColor Cyan
$content = Get-Content "main.go" -Raw
if ($content -match "func initJWTSecret\(\)") {
    Write-Host "  ✅ initJWTSecret() 函数已实现" -ForegroundColor Green
} else {
    Write-Host "  ❌ initJWTSecret() 函数未找到" -ForegroundColor Red
}

Write-Host "  检查点 2: /admin.html 是否移除了 JWT 中间件..." -ForegroundColor Cyan
if ($content -match 'mux\.HandleFunc\("/admin\.html", func\(w http\.ResponseWriter, r \*http\.Request\)') {
    Write-Host "  ✅ /admin.html 已移除 JWT 中间件" -ForegroundColor Green
} else {
    Write-Host "  ❌ /admin.html 仍然使用 JWT 中间件" -ForegroundColor Red
}

Write-Host "  检查点 3: jwt_secret.key 文件引用..." -ForegroundColor Cyan
if ($content -match "jwt_secret\.key") {
    Write-Host "  ✅ jwt_secret.key 文件路径已配置" -ForegroundColor Green
} else {
    Write-Host "  ❌ jwt_secret.key 文件路径未配置" -ForegroundColor Red
}

Write-Host "  检查点 4: .gitignore 是否包含 *.key..." -ForegroundColor Cyan
$gitignoreContent = Get-Content ".gitignore" -Raw
if ($gitignoreContent -match '\*\.key') {
    Write-Host "  ✅ .gitignore 已包含 *.key 规则" -ForegroundColor Green
} else {
    Write-Host "  ⚠️  .gitignore 未包含 *.key 规则（建议添加）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "5. 清理测试文件..." -ForegroundColor Yellow
if (Test-Path "tg-imagebed-test.exe") {
    Remove-Item "tg-imagebed-test.exe" -Force
    Write-Host "✅ 清理完成" -ForegroundColor Green
}
Write-Host ""

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "验证完成！" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "📋 下一步操作：" -ForegroundColor Yellow
Write-Host "1. 运行 '.\tg-imagebed.exe' 启动服务"
Write-Host "2. 访问 http://localhost:8080/admin.html 测试登录页面"
Write-Host "3. 使用 API Key 登录并获取 Token"
Write-Host "4. 重启服务，验证 Token 是否仍然有效"
Write-Host ""
