$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) { Write-Error "adb not found at $adb"; exit 1 }
& $adb logcat -c
Write-Host "logcat cleared."
