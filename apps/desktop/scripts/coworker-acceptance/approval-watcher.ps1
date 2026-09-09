# Stands in for the person at the keyboard during the acceptance run: when the
# Coworker's approval window appears, screenshot it (PrintWindow, no focus change),
# then answer it with the requested key (Enter = Allow, Esc = Don't allow).
param(
  [string] $OutDir,
  [string] $Answer = "{ENTER}",
  [int] $MaxMinutes = 45,
  [int] $MaxAnswers = 10
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
function Find-Approval {
  $found = [IntPtr]::Zero
  $cb = [W+EnumWindowsProc]{ param($h, $l)
    if (-not [W]::IsWindowVisible($h)) { return $true }
    $sb = New-Object System.Text.StringBuilder 256; [void][W]::GetWindowText($h, $sb, 256)
    if ($sb.ToString() -like "Loopcom Coworker*approval*") { $script:found = $h; return $false }
    return $true }
  [void][W]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}
function Shot($h, $path) {
  $r = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $ht = $r.B - $r.T; if ($w -le 0 -or $ht -le 0) { return }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
  [void][W]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
$deadline = (Get-Date).AddMinutes($MaxMinutes); $n = 0
"watcher started $(Get-Date -Format o) answer=$Answer" | Out-File -Append (Join-Path $OutDir "approval-watcher.log")
while ((Get-Date) -lt $deadline -and $n -lt $MaxAnswers) {
  $script:found = [IntPtr]::Zero
  $h = Find-Approval
  if ($h -ne [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 900
    $n++
    $shot = Join-Path $OutDir ("approval-{0:D2}-{1}.png" -f $n, (Get-Date -Format "HHmmss"))
    try { Shot $h $shot } catch { "shot failed: $_" | Out-File -Append (Join-Path $OutDir "approval-watcher.log") }
    [void][W]::SetForegroundWindow($h); Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait($Answer)
    "$(Get-Date -Format o) approval window found → sent $Answer → $shot" | Out-File -Append (Join-Path $OutDir "approval-watcher.log")
    Start-Sleep -Seconds 2
  }
  Start-Sleep -Milliseconds 700
}
"watcher ended $(Get-Date -Format o) answered=$n" | Out-File -Append (Join-Path $OutDir "approval-watcher.log")
