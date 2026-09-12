; Stoke's only addition to the generated NSIS script: a welcome page.
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
