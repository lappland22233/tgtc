@echo off
REM Server2 Windows启动脚本

cd /d "%~dp0"

REM 检查 Go
where go >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 未找到 go
    exit /b 1
)

REM 检查配置文件
if not exist "data.json" (
    echo 错误: 配置文件 data.json 不存在
    echo 请先复制 data.json.example 并填写配置
    exit /b 1
)

REM 检查 go.mod
if not exist "go.mod" (
    echo 错误: 找不到 go.mod 文件
    echo 请确保在项目根目录运行此脚本
    exit /b 1
)

REM 检查依赖
echo 检查依赖...
go mod download github.com/go-sql-driver/mysql >nul 2>&1
go mod download github.com/jmoiron/sqlx >nul 2>&1
go mod tidy >nul 2>&1

REM 创建日志目录
if not exist "logs" mkdir logs

REM 编译 Server
echo 编译 Server...
go build -o server2.exe server2.go

if %errorlevel% neq 0 (
    echo 编译失败
    exit /b 1
)

REM 启动 Server
echo 启动 Server...
start /B server2.exe > logs\server2.log 2>&1

echo.
echo ==========================================
echo Server2 启动成功！
echo ==========================================
echo.
echo 日志文件:
echo   - logs\server2.log
echo.
echo 查看日志:
echo   type logs\server2.log
echo.
echo 停止服务:
echo   taskkill /F /IM server2.exe
echo ==========================================
pause
