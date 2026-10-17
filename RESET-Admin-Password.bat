@echo off
title WorkTrack - Reset Admin Password
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
"%NODE%" --no-warnings reset-password.js
pause
