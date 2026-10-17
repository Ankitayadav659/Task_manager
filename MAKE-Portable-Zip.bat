@echo off
title WorkTrack - Make portable zip
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
echo Building a portable WorkTrack zip (runs on any Windows PC, nothing to install)...
echo It is a FRESH copy: no employees, tasks or passwords from this office are included.
echo.
"%NODE%" --no-warnings make-portable.js
echo.
pause
