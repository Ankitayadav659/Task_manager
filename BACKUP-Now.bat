@echo off
title WorkTrack - Backup
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
echo Creating backup of WorkTrack (app + all data)...
echo.
"%NODE%" --no-warnings backup.js
echo.
echo Tip: copy the newest .zip from "Backup folder" to a pendrive or Google Drive once a week.
pause
