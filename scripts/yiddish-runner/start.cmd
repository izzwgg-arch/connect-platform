@echo off
rem Loopcom Yiddish audio runner. Create a file named STOP here to stop it.
cd /d "%~dp0"
if exist STOP del STOP
start "Loopcom Yiddish tunnel" /min cmd /c "%~dp0tunnel.cmd"
timeout /t 10 /nobreak >nul
:loop
call "%~dp0node_modules\.bin\tsx.cmd" "%~dp0runner.ts" >> "%~dp0logs\runner.log" 2>&1
if exist STOP exit /b 0
timeout /t 30 /nobreak >nul
goto loop
