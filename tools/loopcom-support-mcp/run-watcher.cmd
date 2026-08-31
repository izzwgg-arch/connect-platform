@echo off
REM ── Keeps the support-ticket watcher alive ───────────────────────────────────
REM
REM  The watcher was written to be left running and then WASN'T: it sat off for
REM  three days and three tickets went unseen. A bare `node watch.mjs` in a
REM  terminal dies with the terminal, the reboot, and the accidental Ctrl-C.
REM  This restarts it, and logs every restart so a crash loop is visible rather
REM  than looking like normal operation.
REM
REM  Installed to run at logon by install-task.ps1. Run it by hand to watch it.

setlocal
cd /d "%~dp0"
set "LOGDIR=%~dp0logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOG=%LOGDIR%\watcher.log"

:loop
echo. >> "%LOG%"
echo ==== started %DATE% %TIME% ==== >> "%LOG%"
node watch.mjs >> "%LOG%" 2>&1
echo ==== exited code %ERRORLEVEL% at %DATE% %TIME% — restarting in 30s ==== >> "%LOG%"
REM 30s, not instant: a restart storm against a bad token would hammer the API
REM and fill the disk with a log nobody reads.
timeout /t 30 /nobreak > nul
goto loop
