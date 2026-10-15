@echo off
rem Flagman: the ISTOK cafe site and the cashier panel - opens both in the browser.
rem If the warehouse is not running yet, opens Flagman.exe by itself.
rem This window is the site server - keep it open. Stop: close the window or Ctrl+C.
setlocal
chcp 65001 >nul
title Flagman - cafe site and cashier (keep this window open)
set "APP=%~dp0..\app"
set "RES=%APP%\resources"
set "PGBIN=%RES%\runtime\pgsql\bin"
set "DATA=%ProgramData%\Flagman"

rem Already running (double-clicked again) - just open the pages
curl.exe -s -f -o nul -m 2 http://127.0.0.1:3001/ && goto :open_only

call "%APP%\tools\ensure-warehouse.bat" || goto :fail
for /f "usebackq tokens=1,* delims==" %%a in ("%DATA%\keys.env") do set "%%a=%%b"
set /p DB_PASSWORD=<"%DATA%\db-password.txt"
set "PGHOST=127.0.0.1"
set "PGPORT=54329"
set "PGUSER=flagman"
set "PGPASSWORD=%DB_PASSWORD%"

rem Order databases of the site - created once, empty; the schema is safe to apply again
if exist "%DATA%\istok-db.ok" goto :run
echo Creating the site databases istok_kush and istok_kan ...
for %%d in (istok_kush istok_kan) do (
  "%PGBIN%\psql.exe" -q -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '%%d'" | findstr 1 >nul || "%PGBIN%\createdb.exe" %%d || goto :fail
  "%PGBIN%\psql.exe" -q -v ON_ERROR_STOP=1 -d %%d -f "%RES%\sites\istok\server\schema.sql" >nul || goto :fail
)
>"%DATA%\istok-db.ok" echo %date% %time%

:run
set "FLAGMAN_API_KEY=%SITE_API_KEY%"
set "DB_HOST=127.0.0.1"
set "DB_PORT=54329"
set "DB_USER=flagman"
set "DB_NAME_KUSH=istok_kush"
set "DB_NAME_KAN=istok_kan"
set "PORT=3001"
set "HOST=127.0.0.1"
set "NODE_ENV=production"
echo.
echo Cafe site: http://localhost:3001/
echo Cashier:   http://localhost:3001/panel/login.html - login demo-cashier, password demo1234
echo Warehouse: %FLAGMAN_URL%
echo.
rem The browser opens by itself as soon as the site answers
start "" /b powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; for($i=0;$i -lt 60;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3001/ | Out-Null; Start-Process http://localhost:3001/; Start-Process http://localhost:3001/panel/login.html; break}catch{Start-Sleep -Milliseconds 500}}"
"%RES%\runtime\node\node.exe" "%RES%\sites\istok\server\server.js"
echo.
echo The site server has stopped.
pause
exit /b 0

:open_only
start "" http://localhost:3001/
start "" http://localhost:3001/panel/login.html
exit /b 0

:fail
echo.
echo ERROR - see the messages above. Logs: %DATA%\logs
pause
exit /b 1
