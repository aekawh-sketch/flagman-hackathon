@echo off
rem Flagman: the ISTOK cafe site for guests - opens in the browser (the site works on the server).
call "%~dp0app\tools\addresses.bat"
start "" "%CAFE_URL%"
