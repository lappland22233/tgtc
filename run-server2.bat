@echo off
setlocal

REM 兼容旧入口：run-server2.bat
REM 新结构统一为单服务入口，委托给 manage.sh start

set SCRIPT_DIR=%~dp0
if exist "%SCRIPT_DIR%manage.sh" (
    echo [INFO] run-server2.bat 已弃用，正在切换到统一入口: manage.sh start
    bash "%SCRIPT_DIR%manage.sh" start %*
    exit /b %errorlevel%
)

echo [ERROR] 未找到 manage.sh，请在项目根目录运行。
exit /b 1
