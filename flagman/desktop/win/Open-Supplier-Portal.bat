@echo off
rem Flagman: the supplier portal - sends deliveries to the warehouse by API. Opens in the browser.
call "%~dp0app\tools\addresses.bat"
start "" "%SUPPLIER_URL%"
