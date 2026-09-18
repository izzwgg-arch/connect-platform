@echo off
rem LoopCom Works — local dev server on port 3000 (log goes to %TEMP%, never into .next)
cd /d "%~dp0"
npm run dev > "%TEMP%\loopcom-works-dev.log" 2>&1
