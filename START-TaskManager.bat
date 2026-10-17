@echo off
title WorkTrack - Office Task Manager (keep this window open)
cd /d "%~dp0"
rem Use the bundled Node.js (portable version) if present, otherwise the installed one
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not exist node_modules (
  echo Installing for the first time, please wait...
  call npm install
)
set OPEN_BROWSER=1
"%NODE%" --no-warnings server.js
pause
