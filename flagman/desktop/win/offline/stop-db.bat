@echo off
rem Flagman: turn off the database (after start-db.bat or start-warehouse.bat, or if it stayed on).
setlocal
set "DATA=%ProgramData%\Flagman"
"%~dp0..\app\resources\runtime\pgsql\bin\pg_ctl.exe" stop -m fast -w -D "%DATA%\pgdata"
pause
