; ⛔⛔ CLEAN UP THE RENAME LEFTOVERS THAT MAKE THE TASKBAR ICON A BLANK PAGE.
;
; Found live on Izzy's machine (2026-08-23): a stale "Electron.lnk" in the Start
; Menu still carried this app's AppUserModelID but pointed at the deleted
; Connect.exe. Windows resolves a running window's taskbar button icon from the
; Start Menu shortcut matching its AUMID -- and when it lands on a shortcut whose
; target is gone, it draws the generic "document/paper" icon. Every customer who
; installed a pre-rename ("Connect" / "Electron") build has this same orphan, so
; the fix belongs in the installer, not just on one machine.
;
; The current installer creates "Loopcom.lnk"; these named shortcuts are the
; orphans the Connect->Loopcom rename left behind. Deleting a shortcut that does
; NOT exist is a harmless no-op in NSIS.

!macro customInstall
  Delete "$SMPROGRAMS\Electron.lnk"
  Delete "$SMPROGRAMS\Connect.lnk"
  Delete "$SMPROGRAMS\Connect Communications.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Electron.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Connect.lnk"
!macroend
