@echo off
title Stop WorkTrack
echo Stopping WorkTrack server (port 3000)...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>&1 && echo Stopped.
)
echo.
echo Employees cannot use WorkTrack until you open it again.
pause
