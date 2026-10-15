@echo off
rem Flagman: the supplier portal (FreshPostavka) - sends deliveries to the warehouse by API. Opens it in the browser.
rem If the warehouse is not running yet, opens Flagman.exe by itself.
rem This window is the portal server - keep it open. Stop: close the window or Ctrl+C.
setlocal
chcp 65001 >nul
title Flagman - supplier portal (keep this window open)
set "APP=%~dp0..\app"
set "RES=%APP%\resources"
set "DATA=%ProgramData%\Flagman"

rem Already running (double-clicked again) - just open the page
curl.exe -s -f -o nul -m 2 http://127.0.0.1:3002/ && goto :open_only

call "%APP%\tools\ensure-warehouse.bat" || goto :fail
for /f "usebackq tokens=1,* delims==" %%a in ("%DATA%\keys.env") do set "%%a=%%b"
set "FLAGMAN_API_KEY=%SUPPLIER_API_KEY%"
set "PORT=3002"
echo.
echo Supplier portal: http://localhost:3002/
echo Warehouse:       %FLAGMAN_URL%
echo.
rem The browser opens by itself as soon as the portal answers
start "" /b powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; for($i=0;$i -lt 60;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3002/ | Out-Null; Start-Process http://localhost:3002/; break}catch{Start-Sleep -Milliseconds 500}}"
"%RES%\runtime\node\node.exe" "%RES%\sites\supplier\server.js"
echo.
echo The portal server has stopped.
pause
exit /b 0

:open_only
start "" http://localhost:3002/
exit /b 0

:fail
echo.
echo ERROR - see the messages above. Logs: %DATA%\logs
pause
exit /b 1
