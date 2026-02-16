@echo off
REM Server2 和 Bot Windows停止脚本

cd /d "%~dp0"

echo 停止 server2...
taskkill /F /IM server2.exe >nul 2>&1

echo 停止 bot...
taskkill /F /IM python.exe /FI "WINDOWTITLE eq bot.py*" >nul 2>&1
taskkill /F /IM pythonw.exe /FI "WINDOWTITLE eq bot.py*" >nul 2>&1

echo 服务已停止
pause

