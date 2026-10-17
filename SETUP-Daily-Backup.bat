@echo off
title WorkTrack - Setup daily automatic backup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$vbs = Join-Path (Get-Location).Path 'desktop\AutoBackup.vbs';" ^
  "$action = New-ScheduledTaskAction -Execute \"$env:WINDIR\System32\wscript.exe\" -Argument ('\"' + $vbs + '\"') -WorkingDirectory (Get-Location).Path;" ^
  "$trigger = New-ScheduledTaskTrigger -Daily -At '7:00 PM';" ^
  "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30);" ^
  "Register-ScheduledTask -TaskName 'WorkTrack Daily Backup' -Action $action -Trigger $trigger -Settings $settings -Description 'Backs up WorkTrack app and data every evening into Backup folder' -Force | Out-Null;" ^
  "Write-Host 'Daily backup is set for 7:00 PM every day.'"
echo.
echo If the PC is off at 7 PM, the backup runs as soon as it is switched on.
pause
