@echo off
rem Flagman: the cafe cashier (restaurant panel) - opens in the browser. Login demo-cashier, password demo1234.
call "%~dp0app\tools\addresses.bat"
start "" "%CASHIER_URL%"
