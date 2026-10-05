@echo off
rem ============================================================
rem  upload-files.bat —— 批量上传指定目录下的所有文件（API Key 认证，失败自动重试）
rem
rem  行为：
rem    * 逐个文件调用 POST /api/files/upload（multipart 字段名 file，见 docs/API.md）
rem    * 单个文件上传失败后等待 60 秒自动重试，单文件最多尝试 3 次（首次 + 2 次重试）
rem    * 单个文件最终失败不会中断整体流程；结束时输出汇总，有失败文件时退出码为 1
rem
rem  用法：
rem    upload-files.bat "D:\要上传的目录" -k tgtc_xxx -u http://127.0.0.1:3000
rem    upload-files.bat "\\pc-1\文件夹1" -k tgtc_xxx -u http://127.0.0.1:3000 -r
rem
rem  目录支持本地路径、网络路径（UNC，如 \\pc-1\文件夹1）以及已映射的网络驱动器（如 Z:\data）：
rem    * 访问网络路径时会临时映射一个盘符，脚本结束自动解除（因此需要系统有空闲盘符）；
rem    * 共享需要凭据时，请先用资源管理器打开一次或 net use 建立连接，脚本不处理凭据输入；
rem    * 网络不可达/无权限时，脚本会给出具体系统提示并以退出码 2 结束。
rem
rem  参数：
rem    目录                  必填，要上传的本地目录或网络路径
rem    -u, --url 地址        服务地址，默认 http://127.0.0.1:3000
rem    -k, --key 密钥        API 密钥（网页端 个人设置 - API 密钥）
rem    -r, --recursive       递归上传子目录中的文件（默认只上传目录第一层）
rem        --retry-delay 秒  失败后重试等待秒数，默认 60
rem        --max-attempts 次 单文件最大尝试次数，默认 3
rem    -h, --help            显示帮助
rem
rem  环境变量（同名命令行参数优先）：
rem    TGTC_BASE_URL、TGTC_API_KEY、TGTC_RETRY_DELAY、TGTC_MAX_ATTEMPTS、TGTC_RECURSIVE
rem
rem  已知限制：cmd 会把文件名里的 & 和 ^ 当成控制字符，无法安全传给 curl。
rem    这类文件会被跳过并在结尾单独列出（退出码 1）；请重命名或改用 upload-files.sh。
rem    其余特殊字符（空格、中文、' ( ) [ ] # $ @ + = ~ , ; % !）均可正常上传。
rem
rem  退出码：0 = 全部上传成功；1 = 存在失败或被跳过的文件；2 = 参数或环境错误
rem ============================================================

setlocal EnableExtensions DisableDelayedExpansion

rem ---- 记录原控制台代码页，临时切到 UTF-8，避免中文文件名与提示乱码 ----
set "ORIG_CP="
for /f "tokens=2 delims=:" %%C in ('chcp 2^>nul') do set "ORIG_CP=%%C"
if defined ORIG_CP set "ORIG_CP=%ORIG_CP: =%"
chcp 65001 >nul 2>&1

set "SCRIPT_NAME=%~nx0"
set "UPLOAD_PATH=/api/files/upload"
set "EXIT_CODE=0"

rem ---- 默认值（环境变量可覆盖，命令行参数优先级最高）----
set "BASE_URL=%TGTC_BASE_URL%"
if not defined BASE_URL set "BASE_URL=http://127.0.0.1:3000"
set "API_KEY=%TGTC_API_KEY%"
set "RETRY_DELAY=%TGTC_RETRY_DELAY%"
if not defined RETRY_DELAY set "RETRY_DELAY=60"
set "MAX_ATTEMPTS=%TGTC_MAX_ATTEMPTS%"
if not defined MAX_ATTEMPTS set "MAX_ATTEMPTS=3"
set "RECURSIVE=%TGTC_RECURSIVE%"
if not defined RECURSIVE set "RECURSIVE=0"
set "TARGET="

rem ---- 临时文件（响应体 / HTTP 状态码 / curl 错误）----
set "TMPROOT=%TEMP%"
if not defined TMPROOT set "TMPROOT=%SystemRoot%\Temp"
set "TMPSET=tgtc-upload-%RANDOM%%RANDOM%"
set "TMPBODY=%TMPROOT%\%TMPSET%.body"
set "TMPCODE=%TMPROOT%\%TMPSET%.code"
set "TMPERR=%TMPROOT%\%TMPSET%.err"
set "TMPFAILED=%TMPROOT%\%TMPSET%.failed"
set "TMPHOSTILE=%TMPROOT%\%TMPSET%.hostile"
type nul >"%TMPFAILED%" 2>nul
type nul >"%TMPHOSTILE%" 2>nul

rem ---- 参数解析 ----
:parse
if "%~1"=="" goto after_parse
set "ARG=%~1"
if /i "%ARG%"=="-h" goto usage
if /i "%ARG%"=="--help" goto usage
if /i "%ARG%"=="-r" ( set "RECURSIVE=1" & shift & goto parse )
if /i "%ARG%"=="--recursive" ( set "RECURSIVE=1" & shift & goto parse )
if /i "%ARG%"=="-u" ( set "BASE_URL=%~2" & shift & shift & goto parse )
if /i "%ARG%"=="--url" ( set "BASE_URL=%~2" & shift & shift & goto parse )
if /i "%ARG%"=="-k" ( set "API_KEY=%~2" & shift & shift & goto parse )
if /i "%ARG%"=="--key" ( set "API_KEY=%~2" & shift & shift & goto parse )
if /i "%ARG%"=="--retry-delay" ( set "RETRY_DELAY=%~2" & shift & shift & goto parse )
if /i "%ARG%"=="--max-attempts" ( set "MAX_ATTEMPTS=%~2" & shift & shift & goto parse )
if not "%TARGET%"=="" goto err_multi_dir
set "TARGET=%~1"
shift
goto parse

:after_parse
if not defined TARGET goto err_no_dir_arg
if not defined API_KEY goto err_no_key
call :is_uint "%RETRY_DELAY%"
if errorlevel 1 goto err_bad_delay
call :is_uint "%MAX_ATTEMPTS%"
if errorlevel 1 goto err_bad_attempts
if "%MAX_ATTEMPTS%"=="0" goto err_bad_attempts
if "%BASE_URL:~-1%"=="/" set "BASE_URL=%BASE_URL:~0,-1%"
set "URL_OK="
if /i "%BASE_URL:~0,7%"=="http://" set "URL_OK=1"
if /i "%BASE_URL:~0,8%"=="https://" set "URL_OK=1"
if not defined URL_OK goto err_bad_url

rem ---- 进入目标目录（顺带校验目录存在；pushd 支持 UNC 网络路径，会临时映射盘符）----
pushd "%TARGET%" 2>nul
if errorlevel 1 goto err_pushd
set "PUSHED=1"
rem 当前目录前缀（不带末尾反斜杠）：用于把绝对路径显示成相对路径
rem （网络路径会被 pushd 映射成盘符，直接显示绝对路径会出现 Z:\ 这类临时盘符）
set "CDP=%CD%"
if "%CDP:~-1%"=="\" set "CDP=%CDP:~0,-1%"

set "REC_FLAG="
if "%RECURSIVE%"=="1" set "REC_FLAG=/s"

rem 含 & 或 ^ 的文件名会被 cmd 解析成控制字符（无法安全传给 curl），单独记录并在最后列出
dir /b /a-d %REC_FLAG% 2>nul | findstr /r /c:"[&^]" >"%TMPHOSTILE%" 2>nul
set "HOSTILE=0"
for /f %%C in ('find /c /v "" ^<"%TMPHOSTILE%"') do set "HOSTILE=%%C"
if not defined HOSTILE set "HOSTILE=0"

set "TOTAL=0"
for /f %%C in ('dir /b /a-d %REC_FLAG% 2^>nul ^| findstr /v /r /c:"[&^]" ^| find /c /v ""') do set "TOTAL=%%C"
if not defined TOTAL set "TOTAL=0"

echo 服务地址: %BASE_URL%%UPLOAD_PATH%
echo 上传目录: %TARGET%
if "%RECURSIVE%"=="1" echo 范围: 含子目录
if not "%RECURSIVE%"=="1" echo 范围: 仅第一层
echo 失败重试: 等待 %RETRY_DELAY% 秒，单文件最多 %MAX_ATTEMPTS% 次尝试
echo 文件数量: %TOTAL%
if %HOSTILE% GTR 0 echo 警告: 有 %HOSTILE% 个文件名含 ^& 或 ^^ 被跳过（见结尾说明）
echo ------------------------------------------------------------

if "%TOTAL%"=="0" (
  echo 目录中没有可上传的文件。
  if %HOSTILE% GTR 0 goto hostile_only
  set "EXIT_CODE=0"
  goto finish
)

set "DIR_ARGS=/b /a-d"
if "%RECURSIVE%"=="1" set "DIR_ARGS=/b /a-d /s"

set "IDX=0"
set "OK_COUNT=0"
set "FAIL_COUNT=0"

for /f "delims=" %%F in ('dir %DIR_ARGS% 2^>nul ^| findstr /v /r /c:"[&^]"') do (
  set "CURFILE=%%F"
  call :upload_one
)

echo ------------------------------------------------------------
set /a FAIL_COUNT+=%HOSTILE%
echo 总数: %TOTAL%    成功: %OK_COUNT%    失败: %FAIL_COUNT%
if %FAIL_COUNT% GTR 0 goto summary_failed
echo 全部上传成功。
set "EXIT_CODE=0"
goto finish

:summary_failed
if %HOSTILE%==%FAIL_COUNT% goto hostile_section
echo 失败文件（重试 %MAX_ATTEMPTS% 次后仍失败）:
type "%TMPFAILED%"
:hostile_section
if %HOSTILE% GTR 0 goto summary_hostile
set "EXIT_CODE=1"
goto finish

:summary_hostile
echo 因文件名含 ^& 或 ^^ 被跳过的文件（cmd 无法安全传参）:
type "%TMPHOSTILE%"
echo 请重命名这些文件，或改用 upload-files.sh（bash 版本无此限制）。
set "EXIT_CODE=1"
goto finish

:hostile_only
echo 为避免误传，以下文件被跳过（文件名含 ^& 或 ^^，请重命名或改用 upload-files.sh）:
type "%TMPHOSTILE%"
set "EXIT_CODE=1"
goto finish

rem ============ 子过程 ============

rem 上传单个文件，失败后等待 RETRY_DELAY 秒重试，最多 MAX_ATTEMPTS 次
:upload_one
set /a IDX+=1
set "FILE=%CURFILE%"
call :to_relative
set /a ATTEMPT=0
echo [%IDX%/%TOTAL%] %RELFILE%

:upload_attempt
set /a ATTEMPT+=1
set "HTTP="
curl -sS -X POST "%BASE_URL%%UPLOAD_PATH%" -H "X-API-Key: %API_KEY%" -H "Accept: application/json" -F "file=@\"%FILE%\"" -o "%TMPBODY%" -w "%%{http_code}" >"%TMPCODE%" 2>"%TMPERR%"
set /p HTTP=<"%TMPCODE%"
if not defined HTTP set "HTTP=000"
if not "%HTTP:~0,1%"=="2" goto upload_failed
findstr /r /c:"\"code\": *0" "%TMPBODY%" >nul 2>&1
if errorlevel 1 goto upload_failed
echo     成功 (HTTP %HTTP%)
set /a OK_COUNT+=1
exit /b 0

:upload_failed
set "ERRSHOW="
set "CURLSHOW="
set /p ERRSHOW=<"%TMPBODY%"
if defined ERRSHOW set "ERRSHOW=%ERRSHOW:~0,300%"
set /p CURLSHOW=<"%TMPERR%"
if defined CURLSHOW set "CURLSHOW=%CURLSHOW:~0,200%"
echo     第 %ATTEMPT%/%MAX_ATTEMPTS% 次尝试失败: HTTP %HTTP%
if defined ERRSHOW echo       响应: %ERRSHOW%
if defined CURLSHOW echo       curl: %CURLSHOW%
if %ATTEMPT% GEQ %MAX_ATTEMPTS% goto upload_give_up
set /a NEXT_ATTEMPT=ATTEMPT+1
echo       等待 %RETRY_DELAY% 秒后重试（第 %NEXT_ATTEMPT%/%MAX_ATTEMPTS% 次尝试）...
call :sleep %RETRY_DELAY%
goto upload_attempt

:upload_give_up
echo       已达最大尝试次数 %MAX_ATTEMPTS% 次，跳过该文件
>>"%TMPFAILED%" echo   - %RELFILE%
set /a FAIL_COUNT+=1
exit /b 1

rem 由绝对路径 FILE 得到相对当前目录的 RELFILE（仅用于显示，避免出现 pushd 的临时盘符）
:to_relative
call set "RELFILE=%%FILE:%CDP%\=%%"
exit /b 0

rem 等待 %1 秒（timeout 在输入被重定向时不可用，退化用 ping 计时）
:sleep
set /a SLEEP_SECS=%~1
if %SLEEP_SECS% LEQ 0 exit /b 0
set /a PING_N=SLEEP_SECS+1
timeout /t %SLEEP_SECS% /nobreak >nul 2>&1
if errorlevel 1 ping -n %PING_N% 127.0.0.1 >nul 2>&1
exit /b 0

rem 校验 %1 是非负整数（返回 0 = 通过，1 = 不通过）
:is_uint
setlocal EnableDelayedExpansion
set "V=%~1"
set "RC=0"
if "!V!"=="" set "RC=1"
for /f "delims=0123456789" %%C in ("!V!") do set "RC=1"
endlocal & exit /b %RC%

rem 清理临时文件
:cleanup_tmp
del /f /q "%TMPBODY%" "%TMPCODE%" "%TMPERR%" "%TMPFAILED%" "%TMPHOSTILE%" >nul 2>&1
exit /b 0

rem ============ 帮助与错误提示 ============

:usage
set "EXIT_CODE=0"
goto show_usage

:err_no_dir_arg
set "EXIT_CODE=2"
echo 错误: 未指定要上传的目录
goto show_usage

:err_multi_dir
set "EXIT_CODE=2"
echo 错误: 只能指定一个目录
goto show_usage

:err_no_key
set "EXIT_CODE=2"
echo 错误: 未提供 API 密钥，请用 -k 或环境变量 TGTC_API_KEY 指定
goto show_usage

:err_pushd
set "IS_UNC="
setlocal EnableDelayedExpansion
set "TG=!TARGET!"
if "!TG:~0,2!"=="\\" set "IS_UNC=1"
endlocal & set "IS_UNC=%IS_UNC%"
set "EXIT_CODE=2"
if defined IS_UNC goto err_unc
echo 错误: 目录不存在或不是目录: %TARGET%
goto err_no_dir_detail

:err_unc
echo 错误: 无法访问网络路径: %TARGET%
echo   请确认主机名与共享名正确、当前账号有访问权限，且系统还有空闲盘符。
echo   需要凭据时请先用资源管理器打开一次，或执行 net use 建立连接后重试。
:err_no_dir_detail
set "SYSERR="
dir "%TARGET%" >nul 2>"%TMPERR%"
set /p SYSERR=<"%TMPERR%"
if defined SYSERR echo   系统提示: %SYSERR%
goto finish

:err_bad_delay
set "EXIT_CODE=2"
echo 错误: --retry-delay 必须是非负整数，当前值: %RETRY_DELAY%
goto finish

:err_bad_attempts
set "EXIT_CODE=2"
echo 错误: --max-attempts 必须是正整数，当前值: %MAX_ATTEMPTS%
goto finish

:err_bad_url
set "EXIT_CODE=2"
echo 错误: 服务地址必须以 http:// 或 https:// 开头: %BASE_URL%
goto finish

:show_usage
echo 用法: %SCRIPT_NAME% "目录" [选项]
echo.
echo 选项:
echo   -u, --url 地址         服务地址，默认 http://127.0.0.1:3000
echo   -k, --key 密钥         API 密钥（或用环境变量 TGTC_API_KEY）
echo   -r, --recursive        递归上传子目录中的文件
echo       --retry-delay 秒   失败后重试等待秒数，默认 60
echo       --max-attempts 次  单文件最大尝试次数，默认 3
echo   -h, --help             显示本帮助
echo.
echo 说明:
echo   目录可以是本地路径、网络路径（UNC，如 \\pc-1\文件夹1）或已映射的网络驱动器。
echo   访问网络路径时会临时映射一个盘符（结束自动解除），共享需要凭据时请先用
echo   资源管理器打开一次或 net use 建立连接。
echo   文件名含 ^& 或 ^^ 的文件无法被 cmd 安全传参，会被跳过并在结尾列出（退出码 1），
echo   请重命名这类文件，或改用 upload-files.sh（bash 版本支持）。
echo.
echo 示例:
echo   %SCRIPT_NAME% "D:\data" -k tgtc_xxx -u https://example.com -r
echo   %SCRIPT_NAME% "\\pc-1\文件夹1" -k tgtc_xxx -u https://example.com -r

rem ============ 统一收尾 ============

:finish
if defined PUSHED popd
call :cleanup_tmp
if defined ORIG_CP chcp %ORIG_CP% >nul 2>&1
endlocal & exit /b %EXIT_CODE%
