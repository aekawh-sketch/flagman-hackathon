@echo off
rem Flagman: the warehouse in the browser instead of the Flagman.exe window - http://localhost:8080.
rem Turns the database on by itself. Not together with Flagman.exe.
rem This window is the warehouse server - keep it open. Stop: close the window or Ctrl+C.
setlocal
chcp 65001 >nul
title Flagman - warehouse server (keep this window open)
set "RES=%~dp0..\app\resources"
set "PGBIN=%RES%\runtime\pgsql\bin"
set "DATA=%ProgramData%\Flagman"
if not defined PORT set "PORT=8080"

rem Already running (Flagman.exe or this file) - just open it
set "FLAGMAN_URL="
if exist "%DATA%\flagman-url.txt" set /p FLAGMAN_URL=<"%DATA%\flagman-url.txt"
if defined FLAGMAN_URL curl.exe -s -f -o nul -m 2 "%FLAGMAN_URL%/actuator/health" && (
  start "" "%FLAGMAN_URL:127.0.0.1=localhost%/"
  exit /b 0
)

if not exist "%DATA%\db-password.txt" (
  echo The database is not created yet. Open Flagman.exe and choose menu "Flagman" - "Rabotat bez servera" once - it creates and fills the database.
  pause
  exit /b 1
)
"%PGBIN%\pg_ctl.exe" status -D "%DATA%\pgdata" >nul 2>&1 || (
  echo Starting the database ...
  "%PGBIN%\pg_ctl.exe" start -w -t 120 -D "%DATA%\pgdata" -l "%DATA%\logs\postgres.log" >nul || (
    echo ERROR. Logs: %DATA%\logs\postgres.log
    pause
    exit /b 1
  )
)
set /p DB_PASSWORD=<"%DATA%\db-password.txt"
rem Keys of the cafe site and the supplier portal (start-cafe.bat, start-supplier.bat)
if exist "%DATA%\keys.env" for /f "usebackq tokens=1,* delims==" %%a in ("%DATA%\keys.env") do set "%%a=%%b"
set "DB_URL=jdbc:postgresql://127.0.0.1:54329/flagman"
set "DB_USER=flagman"
set "UPLOADS_DIR=%DATA%\uploads"
set "WEB_DIR=%RES%\web"
set "SERVER_ADDRESS=127.0.0.1"
>"%DATA%\flagman-url.txt" echo http://127.0.0.1:%PORT%

echo Starting the warehouse on http://localhost:%PORT% ...
rem The browser opens by itself as soon as the server answers
start "" /b powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; for($i=0;$i -lt 180;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%PORT%/actuator/health | Out-Null; Start-Process http://localhost:%PORT%/; break}catch{Start-Sleep 1}}"
cd /d "%DATA%"
"%RES%\runtime\jre\bin\java.exe" -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar "%RES%\server\stock.jar"
del "%DATA%\flagman-url.txt" 2>nul
echo.
echo The warehouse server has stopped. The database is still on - stop-db.bat turns it off.
pause
