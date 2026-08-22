@echo off
setlocal EnableExtensions
title DeepSeek Harness Launcher
chcp 65001 >nul

set "DSH_URL=http://127.0.0.1:3080"
set "DSH_PORT=3080"
set "TUNNEL_LOG=C:\Users\jhsly\cloudflared-tunnel.log"
set "OBC_LOG=C:\Users\jhsly\cloudflared-obc-tunnel.log"
set "HOST="
set "OBC_HOST="

rem --- [1/6] Main DSH tunnel: delegate to dsh-mobile-link plugin when installed ---
set "PLUGIN_CLI=%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-mobile-link\bin\cli.js"
set "HOST="
set "DSH_DONE="

rem 快速跳过: 如果 DSH 已在运行，直接读取已有隧道地址
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',3080);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 goto already_running

if exist "%PLUGIN_CLI%" goto plugin_main
echo [WARN] dsh-mobile-link 尚未安装：%PLUGIN_CLI%
echo [WARN] 使用 legacy 计划任务启动模式（此模式不保证状态同步）。请先安装插件。
goto legacy_main

:already_running
echo [1/6] DSH 服务已在运行，跳过隧道启动。
for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "$s=Get-Content '%USERPROFILE%\.dsh\mobile-link\tunnel-state.json' -Raw ^| ConvertFrom-Json; if($s.url){($s.url) -replace '^https?://',''}else{''}"`) do set "HOST=%%u"
if defined HOST (
    echo      手机端 DSH 地址: https://%HOST%
) else (
    echo [WARN] 无法从 tunnel-state.json 读取地址。
)
set "DSH_DONE=1"
goto obc

:plugin_main
echo [1/6] dsh-mobile-link 正在启动唯一 3080 端口隧道，校准 DSH trusted-host...
node "%PLUGIN_CLI%" start --port 3080 --no-push > "%TEMP%\dml-main-tunnel.log" 2>&1
if errorlevel 1 (
    echo [ERROR] 插件 start 失败，未显示隧道地址。请运行 doctor 检查。
    type "%TEMP%\dml-main-tunnel.log"
    pause
    exit /b 1
)
for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "$s=Get-Content '%USERPROFILE%\.dsh\mobile-link\tunnel-state.json' -Raw | ConvertFrom-Json; if($s.url){($s.url) -replace '^https?://',''}else{''}"`) do set "HOST=%%u"
if not defined HOST (
    echo [ERROR] 隧道已启动但未获取到隧道验证 URL。
    pause
    exit /b 1
)
set "DSH_DONE=1"
echo      手机端 DSH 地址: https://%HOST%
goto obc

:legacy_main
rem liveness = its metrics port 20241 answers on loopback
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',20241);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
    echo [1/6] 主隧道已在运行（legacy 模式），跳过启动。
    goto extract
)

echo [1/6] Starting cloudflared tunnel...
del "%TUNNEL_LOG%" >nul 2>&1
schtasks /run /tn "dsh-cloudflared" >nul
set /a ttries=0
:tunnelwait
timeout /t 1 /nobreak >nul
set /a ttries+=1
findstr /c:"trycloudflare.com" "%TUNNEL_LOG%" >nul 2>&1
if not errorlevel 1 goto extract
if %ttries% lss 30 goto tunnelwait
echo [ERROR] Tunnel URL not found after 30s. Log follows:
type "%TUNNEL_LOG%" 2>nul
pause
exit /b 1

:extract
for /f "usebackq delims=" %%h in (`powershell -NoProfile -Command "$m=(Select-String -Path '%TUNNEL_LOG%' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1).Matches | Select-Object -Last 1; if($m){ ($m.Value).TrimEnd('/') -replace '^https?://','' }"`) do set "HOST=%%h"
if not defined HOST (
    echo [ERROR] Could not read tunnel address from %TUNNEL_LOG%
    pause
    exit /b 1
)
echo      手机端 DSH 地址: https://%HOST%


:obc
rem --- [2/6] Ensure OpenBiliClaw tunnel (port 8420) is running ---
rem liveness = its metrics port 20243 answers on loopback
set /a obretry=0
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',20243);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
    echo [2/6] OpenBiliClaw 隧道已在运行，跳过启动。
    goto obc_extract
)

echo [2/6] Starting OpenBiliClaw tunnel...
del "%OBC_LOG%" >nul 2>&1
schtasks /run /tn "dsh-cloudflared-obc" >nul
set /a obtries=0
:obcwait
timeout /t 1 /nobreak >nul
set /a obtries+=1
findstr /c:"trycloudflare.com" "%OBC_LOG%" >nul 2>&1
if not errorlevel 1 goto obc_extract
if %obtries% lss 30 goto obcwait
echo [WARN] OpenBiliClaw tunnel URL not found after 30s (dsh still starts).
goto obc_done

:obc_extract
set /a obretry+=1
for /f "usebackq delims=" %%h in (`powershell -NoProfile -Command "$m=(Select-String -Path '%OBC_LOG%' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1).Matches | Select-Object -Last 1; if($m){ ($m.Value).TrimEnd('/') -replace '^https?://','' }"`) do set "OBC_HOST=%%h"
if defined OBC_HOST (
    echo      手机端 OpenBiliClaw 地址: https://%OBC_HOST%
    goto obc_done
)
if %obretry% lss 6 (
    timeout /t 1 /nobreak >nul
    goto obc_extract
)
echo [WARN] OpenBiliClaw 隧道地址未获取到，dsh 将自行处理。
goto obc_done

:obc_done


rem --- HOST fallback: if legacy path detected DSH already running, HOST may be empty ---
if defined HOST goto host_ok
rem Try to recover HOST from tunnel-state.json
for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "$s=Get-Content '%USERPROFILE%\.dsh\mobile-link\tunnel-state.json' -Raw ^| ConvertFrom-Json; if($s.url){($s.url) -replace '^https?://',''}else{''}"`) do set "HOST=%%u"
if defined HOST (
    echo [INFO] 从 tunnel-state.json 恢复 HOST: https://%HOST%
) else (
    echo [WARN] 无法获取手机端隧道地址，微信推送将跳过。
)
:host_ok

if defined DSH_DONE goto open
rem --- [3/6] Check if DSH web service is already listening ---
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',3080);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 goto dsh_already_running

rem --- [4/6] Start DSH web with the tunnel host trusted ---
echo [3/6] Starting DSH service (--trusted-host %HOST%)...
start "DSH Service" /D "%USERPROFILE%\DSH workspace" cmd /k ""%APPDATA%\npm\dsh.cmd" web --trusted-host %HOST%"

echo [4/6] Waiting for DSH service on port 3080...
set /a tries=0
:wait
timeout /t 1 /nobreak >nul
set /a tries+=1
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',3080);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 goto open
if %tries% lss 30 goto wait
echo [WARN] Timeout waiting for DSH, opening console anyway.

:dsh_already_running
echo [3/6] DSH 服务已在端口 3080 上运行，跳过启动。

:open
echo [5/6] Opening DSH web console...
start "" "%DSH_URL%"
echo.
echo ============================================================
echo  本地 DSH 地址:            %DSH_URL%
echo.
echo  [手机端] 你的 DSH（自动适配移动端优化界面）:
echo         https://%HOST%
echo.
if defined OBC_HOST (
    echo  [手机端] 你的 OpenBiliClaw 隧道:
    echo         在手机 DSH 中打开 OpenBiliClaw 时，将
    echo         OpenBiliClaw 后端 API 地址改为:
    echo         https://%OBC_HOST%
) else (
    echo  [WARN] OpenBiliClaw 隧道地址未获取到，手机端可能无法使用。
)
echo.
echo  注意: 请保持本窗口打开，在控制台需要关闭时再关闭。
echo ============================================================
echo.
rem --- [6/6] 通过微信(Server酱)发送手机端链接 ---
echo [6/6] 通过微信发送手机端链接...
if not defined HOST (
    echo [WARN] HOST 为空，跳过微信推送。
    echo [%date% %time%] WX_SEND SKIP (HOST empty) >> "C:\Users\jhsly\wechat-send-last.log"
    goto after_wx
)
findstr /c:"%date%" "C:\Users\jhsly\wechat-send-last.log" 2>nul | findstr /c:"WX_SEND OK" >nul 2>&1
if not errorlevel 1 (
    echo [6/6] 今日已通过微信推送过链接，跳过。
    goto after_wx
)
python "C:\Users\jhsly\sct-send\send_links.py" "%HOST%" "%OBC_HOST%"
if errorlevel 1 (
    echo [WARN] 微信推送失败，可能是网络或配置问题，不影响 DSH 使用。
    echo [%date% %time%] WX_SEND FAIL >> "C:\Users\jhsly\wechat-send-last.log"
) else (
    echo [WX] 已通过微信推送成功。
    echo [%date% %time%] WX_SEND OK >> "C:\Users\jhsly\wechat-send-last.log"
)
:after_wx
echo.

echo  本窗口关闭后，DSH 服务会在另一个 "DSH Service" 窗口继续运行。
pause >nul
endlocal
