# Delegates to android-ship.ps1 (JDK, junction build root, Gradle, adb install).
# Prefer: pnpm mobile:android:ship
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $here "android-ship.ps1") @args
exit $LASTEXITCODE
