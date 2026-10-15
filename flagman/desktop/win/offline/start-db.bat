@echo off
rem Flagman: turn on only the database - for DBeaver, pgAdmin and so on (Flagman.exe creates it on its first run).
rem Flagman.exe and start-warehouse.bat turn the database on by themselves - this file is not needed for them.
rem Stop: stop-db.bat.
setlocal
title Flagman - database
set "PGBIN=%~dp0..\app\resources\runtime\pgsql\bin"
set "DATA=%ProgramData%\Flagman"
if not exist "%DATA%\pgdata\PG_VERSION" (
  echo The database is not created yet. Open Flagman.exe and choose menu "Flagman" - "Rabotat bez servera" once - it creates and fills the database.
  pause
  exit /b 1
)
"%PGBIN%\pg_ctl.exe" status -D "%DATA%\pgdata" >nul 2>&1 && (
  echo The database is already running.
  goto :done
)
echo Starting PostgreSQL ...
"%PGBIN%\pg_ctl.exe" start -w -t 120 -D "%DATA%\pgdata" -l "%DATA%\logs\postgres.log" || (
  echo ERROR. Logs: %DATA%\logs\postgres.log
  pause
  exit /b 1
)
:done
echo.
echo The database is running: host 127.0.0.1, port 54329, database "flagman", user "flagman".
echo Password: %DATA%\db-password.txt
echo Keep this window open while you work; stop-db.bat turns the database off.
pause
