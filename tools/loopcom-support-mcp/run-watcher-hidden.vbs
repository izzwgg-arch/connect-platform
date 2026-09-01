' Launches run-watcher.cmd with NO VISIBLE WINDOW.
'
' Why: on 2026-08-31 a Ctrl+C (or a closed console window) killed the watcher
' AND the restart wrapper, and it stayed dead for 18 hours - the wrapper's
' restart loop only survives a crashed CHILD, not a killed console. With no
' window there is nothing to close by accident. The log is the view:
' logs\watcher.log, and the Agent runs tab on /admin/support.
Dim shell, here
Set shell = CreateObject("Wscript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.CurrentDirectory = here
' The final True is load-bearing: wscript WAITS on the wrapper, so the
' scheduled task stays "Running" for the watcher's whole life - which is what
' lets MultipleInstances IgnoreNew block a duplicate watcher, and lets
' Stop-ScheduledTask (the watchdog's restart) really kill the process tree.
shell.Run """" & here & "run-watcher.cmd""", 0, True
