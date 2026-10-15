@echo off
rem Called by start-cafe.bat and start-supplier.bat (needs APP and DATA from them).
rem Makes sure the local warehouse answers; if not, opens Flagman.exe and waits for it. Sets FLAGMAN_URL.
rem Exit code 1 - the warehouse did not start, or Flagman.exe works with the server.
call :check && exit /b 0

rem Flagman.exe works with the server by default (settings.json) - then there is no warehouse on this computer:
rem the cafe site and the cashier live on the server too.
findstr /c:"\"mode\": \"local\"" "%APPDATA%\Flagman\settings.json" >nul 2>&1 || (
  echo.
  echo Flagman.exe works with the server - the cafe site and the cashier are on the server too.
  echo Open them with Open-Cafe-Site.bat, Open-Cashier.bat, Open-Supplier-Portal.bat next to Flagman.exe.
  echo To run them on this computer: menu "Flagman" - "Rabotat bez servera", then run this file again.
  exit /b 1
)

echo Starting the warehouse - Flagman.exe opens its window, the first start takes up to a minute ...
start "" "%APP%\Flagman.exe"
set /a WAITED=0
:wait
ping -n 2 127.0.0.1 >nul
call :check && exit /b 0
set /a WAITED+=1
if %WAITED% lss 240 goto :wait
echo The warehouse did not start in 4 minutes. Logs: %DATA%\logs
exit /b 1

:check
set "FLAGMAN_URL="
if exist "%DATA%\flagman-url.txt" set /p FLAGMAN_URL=<"%DATA%\flagman-url.txt"
if not defined FLAGMAN_URL exit /b 1
curl.exe -s -f -o nul -m 3 "%FLAGMAN_URL%/actuator/health"
exit /b %errorlevel%
