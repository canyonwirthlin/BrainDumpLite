; After an install/update, tell Explorer the app's icon changed. Without this, shortcuts that were
; pinned to the taskbar / Start keep showing the old icon (and its hover / jump-list icon) until
; the user unpins and re-pins.
!macro NSIS_HOOK_POSTINSTALL
  ; SHCNE_ASSOCCHANGED (0x08000000), SHCNF_IDLIST (0): refresh every cached icon.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; Rebuild the icon cache without killing Explorer.
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend
