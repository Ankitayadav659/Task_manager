@echo off
title Install WorkTrack on Desktop
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time, please wait...
  call npm install
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$app = (Get-Location).Path;" ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\WorkTrack.lnk');" ^
  "$lnk.TargetPath = \"$env:WINDIR\System32\wscript.exe\";" ^
  "$lnk.Arguments = '\"' + $app + '\desktop\WorkTrack.vbs\"';" ^
  "$lnk.WorkingDirectory = $app;" ^
  "$lnk.IconLocation = $app + '\desktop\worktrack.ico,0';" ^
  "$lnk.Description = 'WorkTrack - Office Task Manager';" ^
  "$lnk.Save()"
echo.
echo Done! A "WorkTrack" icon is now on your Desktop.
echo Double-click it to open WorkTrack like a normal app.
echo.
pause
