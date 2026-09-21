; Stoke's two additions to the generated NSIS script: a welcome page, and a
; "Stoke is running" step that closes Stoke instead of killing it. The second
; is documented at its macro, below the first.
;
; NAMED by electron-builder.yml's `nsis.include`, even though `build/installer.nsh`
; is exactly what that key defaults to. The reason is the same one the three
; image keys are named for (CLAUDE.md gotcha 69): with the key UNSET a missing or
; misspelled file is found by nobody and the installer silently loses its welcome
; page, while with the key SET `getResource` throws InvalidConfigurationError and
; the build stops. Explicit turns a silent downgrade into a loud failure.
;
; WHY A WELCOME PAGE AT ALL. `MUI_WELCOMEFINISHPAGE_BITMAP` -- which is where
; build/installerSidebar.bmp lands -- is read by exactly two page types, welcome
; and finish. electron-builder's assisted page order is install-mode, directory,
; instfiles, MUI_PAGE_FINISH, and its own docs say "Welcome Page is not added by
; default for installer": `assistedInstaller.nsh` inserts `customWelcomePage`
; only `!ifmacrodef`. So without this file the 164x314 campfire appears on one
; installer screen, at the very end, after every decision has been made. Three
; lines move it to the front.
;
; WHY NOT `nsis.script`. That key replaces the whole generated script and takes
; the uninstaller's generation AND its signing with it. `include` is the seam;
; `script` is never to be used here. verify:installer-art asserts it stays unset.
;
; WHY NO ANIMATION. Both routes exist and both were rejected deliberately. An
; animated banner needs a third-party plugin DLL (AnimGif, Animate) -- unsigned,
; 32-bit, from a 2000s-era wiki, committed to build/ and executing inside an
; installer that requests elevation. A pure-nsDialogs custom page needs no DLL
; but means owning a hand-written NSIS page, in a language with no test harness
; in this repo, on the one platform nobody here has ever run, to decorate a
; screen that is up for four seconds. The motion lives in the terminal installer
; and in the app's own first-run campfire instead.
;
; WHAT IS NOT SET, and why each would look like an improvement:
;   - MUI_BGCOLOR / MUI_TEXTCOLOR / MUI_HEADER_TRANSPARENT_TEXT. These are the
;     only way to darken MUI's header strip, and they would have to be defined
;     at TOP LEVEL here (NsisTarget builds the final script as sharedHeader +
;     originalScript, so this file lands before MUI2.nsh and before the page
;     macros read their defines; the same define inside `customHeader` arrives
;     too late). They are left out because build/installerHeader.bmp is drawn
;     LIGHT on purpose, to sit on MUI's default white bar -- and a wrong colour
;     define here is the one change that can make the wizard's own title text
;     unreadable.
;   - ManifestDPIAware. The wizard is DPI-unaware and Windows bitmap-scales the
;     whole window on a scaled display. NSIS's own reference warns that setting
;     it breaks the component page's tree bitmap and can break plugins, so the
;     art is drawn to survive soft scaling instead (big shapes, no text).
;
; UNVERIFIED, and it is the whole of this file. No round of work in this repo
; has ever run on Windows. That `!insertmacro MUI_PAGE_WELCOME` compiles here,
; that the page appears before the directory page, and that the campfire renders
; on it at 100% and 150% scaling are read from app-builder-lib 26.15.3's own
; templates and from the MUI2 documentation. Nobody has watched it.

!macro customWelcomePage
  ; MUI's stock wording, deliberately. The strings come from the language files
  ; `!insertmacro MUI_LANGUAGE` loads further down the generated script, so
  ; every language electron-builder was asked for gets a translated page; a
  ; hand-written MUI_WELCOMEPAGE_TITLE would be English on all of them.
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ---------------------------------------------------------------------------
; customCheckAppRunning: close Stoke, never kill it.
;
; WHAT IT REPLACES. The stock step (app-builder-lib 26.15.3,
; templates/nsis/include/allowOnlyOneInstallerInstance.nsh, _CHECK_APP_RUNNING)
; finds every process whose path starts with $INSTDIR, shows "Stoke is running.
; Click OK to close it." with `/SD IDOK` -- so under /S it confirms ITSELF --
; and then runs Stop-Process on each, and Stop-Process -Force a second later
; (taskkill /F where PowerShell is missing). Every silent install goes through
; it: winget passes /S, the one-line installer passes /S, and electron-updater
; runs the new installer with `--updated /S`. A force-killed Stoke never reaches
; `before-quit`, so `ptys.killAll()` never runs and every `claude` it was
; hosting is orphaned -- CLAUDE.md's first standing trap, "Never force-kill
; Stoke", committed by the installer on the user's behalf.
;
; THE SEAM. That file's CHECK_APP_RUNNING macro does `!ifmacrodef
; customCheckAppRunning` / `!insertmacro customCheckAppRunning` / `!else` the
; kill loop, and this file lands in the shared header before that file is
; included, so defining the macro here replaces the loop in BOTH places it is
; used: the install section (installSection.nsh:33,36) and the uninstaller's
; un.checkAppRunning (uninstaller.nsh:2). With the macro defined, the template
; also skips `Var pid` and getProcessInfo.nsh, which nothing here needs.
;
; WHAT IT DOES INSTEAD. One PowerShell run that:
;   1. lists processes whose ExecutablePath is under the install folder --
;      through Get-CimInstance, because $SYSDIR in this 32-bit installer is the
;      32-bit PowerShell, and Get-Process .Path cannot read a 64-bit process
;      from there while CIM can;
;   2. leaves out its own parent, which is this installer or uninstaller: an
;      upgrade can run the old uninstaller IN PLACE from $INSTDIR
;      (installUtil.nsh's TryInPlace, `_?=$installationDir`), and waiting for
;      yourself to exit is a minute's hang and a false "cannot be closed";
;   3. if nothing is left, exits 0 -- the common case, a fresh install;
;   4. otherwise calls CloseMainWindow() on each that has a main window. That
;      is WM_CLOSE, exactly what clicking the window's X sends: Stoke's
;      `closed` handler runs ptys.killAll() and `window-all-closed` quits, so
;      the sessions end the way a person closing Stoke ends them;
;   5. polls for up to about a minute for every one of them to be gone (the
;      GPU and renderer children, and the terminal hosts, go with the main
;      process), exiting 0 when they are and 1 when they are not.
; A non-zero exit is appCannotBeClosed's Retry/Cancel. `/SD IDCANCEL`, so a
; silent install that cannot close Stoke FAILS -- exit code 2, which winget
; and the one-liner both report -- rather than falling back to a kill. Failing
; loudly is the whole point: the user can close Stoke and run it again; an
; orphaned `claude` cannot be reattached by anybody.
;
; HOW THE FOLDER GETS THERE. Through the environment, never the command text.
; SetEnvironmentVariable on this process is inherited by the PowerShell
; nsExec starts, and the script reads $env:STOKE_INSTDIR. Splicing $INSTDIR
; into the -Command string instead breaks the quoting on the first apostrophe
; in a user name (C:\Users\O'Brien\...), and is an injection point besides.
;
; WRITING THE SCRIPT. It is one line inside a backtick-quoted NSIS string
; inside a double-quoted command-line argument, so: every PowerShell `$` is
; written `$$` (NSIS would otherwise expand it, or refuse the name); no `"`
; anywhere in it (the argument would end); no backslash either -- the one it
; needs is `[char]92`. Readable form, which verify:welcome holds equal to the
; code line with `$$` read back as `$` and these lines joined as they stand:
;
; PS> $ErrorActionPreference='Stop';
; PS> $d=$env:STOKE_INSTDIR;
; PS> if(!$d){exit 1};
; PS> $d=$d.TrimEnd([char]92)+[char]92;
; PS> $me=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)).ParentProcessId;
; PS> $f={@(Get-CimInstance Win32_Process|?{$_.ProcessId -ne $me -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d,[StringComparison]::OrdinalIgnoreCase)})};
; PS> if(!@(&$f).Count){exit 0};
; PS> foreach($x in @(&$f)){$g=Get-Process -Id $x.ProcessId -EA 0;if($g -and $g.MainWindowHandle -ne 0){try{[void]$g.CloseMainWindow()}catch{}}};
; PS> for($i=0;$i -lt 120;$i++){Start-Sleep -Milliseconds 500;if(!@(&$f).Count){exit 0}};
; PS> exit 1
;
; `Stop`, so anything unexpected ends the script non-zero -- the Retry/Cancel
; path, never a silent "nothing is running" that walks into files in use.
; The whole command is about 720 characters at run time; the makensis
; electron-builder downloads (nsis-3.0.4.1) is built with NSIS_MAX_STRLEN=8192
; (`makensis -HDRINFO`), so there is room, but not for an unbounded script.
;
; KNOWN LIMITS, stated rather than hidden. A Stoke with no visible main window
; (still starting, or hung) is not closed, so the minute runs out and the user
; is asked -- by design, since the alternative is the kill. A machine where
; powershell.exe cannot start at all (AppLocker) gets the Retry/Cancel box even
; with Stoke closed, where the stock step fell back to tasklist; under
; Constrained Language Mode CloseMainWindow is refused, so the box asks the
; user to close Stoke by hand, and Retry then succeeds. And the interactive
; installer closes a running Stoke without the stock step's "Click OK to close
; it" first -- the same thing that step did next, minus the kill.
;
; UNVERIFIED, all of it. No round of work in this repo has run on Windows.
; What IS checked: makensis compiles it -- electron-builder passes -WX, so a
; warning here fails the build, and a real `electron-builder --win nsis zip`
; from macOS on 2026-09-21 built both the installer and the uninstaller with
; it. That compile is not vacuous: in a standalone makensis run, one `$` left
; single fails with warning 6000 ("unknown variable/constant") and a bad
; instruction in the body fails with "Error in macro customCheckAppRunning".
; verify:welcome holds its shape. What is
; NOT: that the CIM query sees a running Stoke, that CloseMainWindow reaches
; Electron's window and Stoke quits inside the minute, that the parent-pid
; exclusion matches an in-place uninstaller, and that winget really reports
; exit code 2. Read from app-builder-lib's templates and the NSIS and .NET
; documentation, not watched.
!macro customCheckAppRunning
  Push $R0
  System::Call 'Kernel32::SetEnvironmentVariable(t "STOKE_INSTDIR", t "$INSTDIR")'
  stoke_check_running:
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='Stop';$$d=$$env:STOKE_INSTDIR;if(!$$d){exit 1};$$d=$$d.TrimEnd([char]92)+[char]92;$$me=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$$PID)).ParentProcessId;$$f={@(Get-CimInstance Win32_Process|?{$$_.ProcessId -ne $$me -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d,[StringComparison]::OrdinalIgnoreCase)})};if(!@(&$$f).Count){exit 0};foreach($$x in @(&$$f)){$$g=Get-Process -Id $$x.ProcessId -EA 0;if($$g -and $$g.MainWindowHandle -ne 0){try{[void]$$g.CloseMainWindow()}catch{}}};for($$i=0;$$i -lt 120;$$i++){Start-Sleep -Milliseconds 500;if(!@(&$$f).Count){exit 0}};exit 1"`
    Pop $R0
    StrCmp $R0 "0" stoke_not_running
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY stoke_check_running
    SetErrorLevel 2
    Quit
  stoke_not_running:
  Pop $R0
!macroend
