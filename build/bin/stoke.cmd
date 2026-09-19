@echo off
rem stoke: open a folder in Stoke from a terminal. Windows.
rem
rem Ships inside the app at <install>\resources\bin\stoke.cmd, beside
rem Stoke.exe two folders up. Settings, Updates, Command line in Stoke adds
rem this folder to the per-user PATH; nothing else here touches PATH.
rem
rem NOT VERIFIED ON WINDOWS. Nobody has run this file. It is written from the
rem cmd.exe and CommandLineToArgvW documentation, and npm run verify:stoke-args
rem checks what can be checked from a Mac: its help text, its line endings,
rem and the argument shape it hands Stoke.exe.
rem
rem Everything except --help and --version becomes
rem     Stoke.exe --stoke-cli --stoke-cwd=CWD -- ARGS
rem which src/shared/stokeArgs.ts reads (the -- keeps Chromium from taking an
rem argument that looks like one of its own switches), and a running Stoke
rem receives through its single-instance lock.
rem
rem KNOWN LIMIT: cmd.exe expands the arguments before this file sees them, so a folder
rem name holding one of  and  pipe  caret  less  greater  percent  has to be
rem quoted where you type it, and even quoted a caret or percent may not arrive
rem intact. The same rule as CLAUDE.md gotcha 13, from the other side.
setlocal EnableExtensions DisableDelayedExpansion
set "STOKE_EXE=%~dp0..\..\Stoke.exe"

if /i "%~1"=="--help" goto help
if /i "%~1"=="-h" goto help
if /i "%~1"=="--version" goto version
if /i "%~1"=="-v" goto version

if not exist "%STOKE_EXE%" goto missing

rem Never hand the GUI a Node runtime flag (gotcha 1): an inherited
rem ELECTRON_RUN_AS_NODE starts Electron as plain node, with no window at all.
set "ELECTRON_RUN_AS_NODE="

rem A drive root is C:\ and the backslash before the closing quote would
rem escape it (CommandLineToArgvW: one backslash then a quote is a literal
rem quote). Doubled, the pair reads back as the single backslash it was.
set "STOKE_CWD=%CD%"
if "%STOKE_CWD:~-1%"=="\" set "STOKE_CWD=%STOKE_CWD%\"

start "" "%STOKE_EXE%" --stoke-cli "--stoke-cwd=%STOKE_CWD%" -- %*
exit /b 0

:missing
echo(stoke: "%STOKE_EXE%" is not there. Reinstall Stoke. 1>&2
exit /b 127

:version
if not exist "%STOKE_EXE%" goto missing
powershell -NoProfile -NonInteractive -Command "Write-Output ('Stoke ' + (Get-Item -LiteralPath $env:STOKE_EXE).VersionInfo.ProductVersion)"
exit /b %ERRORLEVEL%

:help
echo(Usage: stoke [options] [DIR]
echo(
echo(  stoke                   bring Stoke forward, or start it
echo(  stoke DIR               a session in DIR (stoke . for here), or the tab already running there
echo(  stoke --new [DIR]       a new tab even when one is already running there
echo(  stoke --cli ID [DIR]    a session with another coding agent, by id:
echo(                          claude, codex, grok, opencode, pi, gemini, qwen, kimi,
echo(                          copilot, cursor, amp, kilo, aider, crush, droid, cline,
echo(                          auggie, vibe
echo(  stoke --continue [DIR]  pick up the last Claude Code conversation in DIR
echo(  stoke --open [DIR]      add DIR to the sidebar and select it; starts nothing
echo(  stoke update            open Settings, Updates and check for a new Stoke; installs nothing
echo(  stoke --version         the installed version
echo(  stoke --help            this
echo(
echo(DIR defaults to the current folder when an option is given.
echo(A folder named update, or starting with -, is stoke ./update or stoke -- -name.
echo(Settings, Updates, Command line in Stoke puts this command on PATH.
exit /b 0
