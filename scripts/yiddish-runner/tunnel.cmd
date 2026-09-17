@echo off
rem Keeps a private tunnel from this PC to the Connect database (127.0.0.1:15432).
:loop
"C:\Windows\System32\OpenSSH\ssh.exe" -N -i "C:\Users\izzyw\.ssh\connect2_ed25519" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -L 15432:127.0.0.1:5432 root@45.14.194.179
timeout /t 15 /nobreak >nul
if exist "%~dp0STOP" exit /b 0
goto loop
