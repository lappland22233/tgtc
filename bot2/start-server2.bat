@echo off
REM server2 Windows构建和启动脚本（同时启动 bot）

cd /d "%~dp0"

REM 检查虚拟环境
if not exist "venv\" (
    echo 错误: 虚拟环境不存在
    echo 请先运行 init.bat 初始化项目
    exit /b 1
)

REM 构建 server2
echo 构建 server2...
go build -o server2.exe server2.go

if %errorlevel% neq 0 (
    echo 构建失败
    exit /b 1
)

echo 构建成功

REM 创建日志目录
if not exist "logs" mkdir logs

REM 启动 server2（后台）
echo 启动 server2...
start /B server2.exe > logs\server2.log 2>&1

REM 启动 bot（后台）
echo 启动 bot...
call venv\Scripts\activate
start /B python bot.py > logs\bot.log 2>&1
call venv\Scripts\deactivate

echo.
echo ==========================================
echo 服务启动成功！
echo ==========================================
echo.
echo 日志文件:
echo   - logs\server2.log
echo   - logs\bot.log
echo.
echo 查看日志:
echo   type logs\server2.log
echo   type logs\bot.log
echo.
echo 停止服务:
echo   stop.bat
echo ==========================================
pause

