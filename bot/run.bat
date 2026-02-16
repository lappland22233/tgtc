@echo off
cd /d "%~dp0"

:: 创建虚拟环境
if not exist "venv" (
    echo 创建虚拟环境...
    python -m venv venv
)

:: 激活虚拟环境
call venv\Scripts\activate.bat

:: 安装依赖
pip install -q -r requirements.txt

:: 运行 Bot（直接运行 main.py）
python main.py
pause
