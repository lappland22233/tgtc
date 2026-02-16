@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ==========================================
echo   推送到GitHub私有仓库
echo ==========================================
echo.

REM 配置区域 - 请修改以下信息
set REPO_NAME=tg-imagebed
set GITHUB_USERNAME=YOUR_USERNAME
REM ==========================================

echo [信息] 仓库配置:
echo   仓库名: %REPO_NAME%
echo   用户名: %GITHUB_USERNAME%
echo.

REM 检查git状态
echo [1/5] 检查Git状态...
cd /d "%~dp0"
git status --short >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 当前目录不是Git仓库
    pause
    exit /b 1
)
echo [完成] Git仓库检查通过
echo.

REM 添加文件
echo [2/5] 添加文件到暂存区...
git add .
if %errorlevel% neq 0 (
    echo [警告] 添加文件时出现问题，继续...
)
echo [完成] 文件已添加
echo.

REM 检查是否有变更
echo [3/5] 检查是否有变更...
for /f %%i in ('git diff --cached --short ^| find /c /v ""') do set CHANGES=%%i
if !CHANGES! EQU 0 (
    echo [提示] 没有需要提交的变更
    echo.
    goto :push_only
)
echo [完成] 发现 !CHANGES! 个文件变更
echo.

REM 提交变更
echo [4/5] 提交变更...
set /p COMMIT_MSG=请输入提交描述（或直接回车使用默认）:
if "!COMMIT_MSG!"=="" set COMMIT_MSG=Update: %date% %time%

git commit -m "!COMMIT_MSG!"
if %errorlevel% neq 0 (
    echo [错误] 提交失败
    pause
    exit /b 1
)
echo [完成] 提交成功: !COMMIT_MSG!
echo.

:push_only
REM 推送到GitHub
echo [5/5] 推送到GitHub...
echo.
echo 提示：首次推送可能需要认证
echo.

REM 检查远程仓库
git remote get-url origin >nul 2>&1
if %errorlevel% neq 0 (
    echo [信息] 添加远程仓库...
    git remote add origin https://github.com/%GITHUB_USERNAME%/%REPO_NAME%.git
) else (
    echo [信息] 使用已存在的远程仓库
)
echo.

REM 推送
git push -u origin master
if %errorlevel% equ 0 (
    echo.
    echo ==========================================
    echo   ✅ 推送成功！
    echo ==========================================
    echo.
    echo 仓库地址: https://github.com/%GITHUB_USERNAME%/%REPO_NAME%
    echo.
    echo 后续更新使用:
    echo   1. git add .
    echo   2. git commit -m "描述"
    echo   3. git push
    echo.
) else (
    echo.
    echo ==========================================
    echo   ❌ 推送失败
    echo ==========================================
    echo.
    echo 请检查以下问题:
    echo   1. GitHub仓库是否已创建？
    echo   2. 用户名和仓库名是否正确？
    echo   3. 是否有仓库访问权限？
    echo   4. 网络连接是否正常？
    echo.
    echo 如果遇到认证问题，请执行以下命令之一:
    echo.
    echo 方法1 - 使用Token:
    echo   git remote set-url origin https://YOUR_TOKEN@github.com/%GITHUB_USERNAME%/%REPO_NAME%.git
    echo   然后重新运行此脚本
    echo.
    echo 方法2 - 使用SSH（推荐）:
    echo   1. 生成SSH密钥: ssh-keygen -t ed25519
    echo   2. 添加到GitHub: Settings ^> SSH and GPG keys ^> New SSH key
    echo   3. 切换到SSH: git remote set-url origin git@github.com:%GITHUB_USERNAME%/%REPO_NAME%.git
    echo   4. 重新运行此脚本
    echo.
)

echo ==========================================
pause
