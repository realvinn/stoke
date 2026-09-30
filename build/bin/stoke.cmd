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
rem `account list` and `account env NAME` are answered here too, by reading
rem .stoke\accounts\index.json in the user profile folder, in PowerShell (the
rem name travels in an environment variable, never inside the script: gotcha
rem 101). `env` prints cmd `set` lines, one per variable, for a for /f loop to
rem run in the window that asked.
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
if /i "%~1"=="account" if /i "%~2"=="list" goto account_list
if /i "%~1"=="account" if /i "%~2"=="env" goto account_env

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

:account_list
set "STOKE_ACCOUNT_VERB=list"
set "STOKE_ACCOUNT_NAME="
goto account_ps

:account_env
if "%~3"=="" (
  echo(stoke: stoke account env takes one name: stoke account env work 1>&2
  exit /b 1
)
set "STOKE_ACCOUNT_VERB=env"
set "STOKE_ACCOUNT_NAME=%~3"

:account_ps
powershell -NoProfile -NonInteractive -Command "$i = Join-Path $env:USERPROFILE '.stoke\accounts\index.json'; $x = $null; if (Test-Path -LiteralPath $i) { $x = Get-Content -LiteralPath $i -Raw -Encoding UTF8 | ConvertFrom-Json }; $all = @(); if ($x) { $all = @($x.accounts) }; if ($env:STOKE_ACCOUNT_VERB -eq 'list') { if (-not $all.Count) { Write-Output 'No accounts yet. Add one in Stoke, Settings, Agents, or: stoke account add AGENT NAME'; exit 0 }; foreach ($a in $all) { $where = $a.home; if (-not $a.env) { $where = '(an API key, sealed in Stoke; env exports nothing for it)' }; Write-Output ($a.id + '  ' + $a.cli + '  ' + $a.label); Write-Output ('    ' + $where) }; exit 0 }; $n = [string]$env:STOKE_ACCOUNT_NAME; if ($n -cnotmatch '^[a-z0-9-]+$') { [Console]::Error.WriteLine('stoke: an account name is letters, digits and -, like work.'); exit 1 }; if ($n -eq 'default') { $names = @('CLAUDE_CONFIG_DIR','CODEX_HOME','GROK_HOME','GEMINI_CLI_HOME','QWEN_HOME','KIMI_CODE_HOME','COPILOT_HOME','PI_CODING_AGENT_DIR','CLINE_DIR','VIBE_HOME','FACTORY_HOME_OVERRIDE','GEMINI_FORCE_ENCRYPTED_FILE_STORAGE'); if ($x -and $x.unset) { $names = @($x.unset) }; foreach ($v in $names) { Write-Output ('set ' + $v + '=') }; exit 0 }; $hit = $false; foreach ($a in $all) { if ($a.id -ne $n -and $a.name -ne $n) { continue }; $hit = $true; if (-not $a.env -or -not $a.home) { Write-Output ('rem ' + $a.id + ' is an API-key account: its key stays sealed in Stoke and is not exported.'); continue }; Write-Output ('set ' + [char]34 + $a.env + '=' + $a.home + [char]34); foreach ($p in ([string]$a.extra).Split(' ', [StringSplitOptions]::RemoveEmptyEntries)) { Write-Output ('set ' + [char]34 + $p + [char]34) } }; if (-not $hit) { [Console]::Error.WriteLine('stoke: no account called ' + $n + '. stoke account list shows them.'); exit 1 }; exit 0"
exit /b %ERRORLEVEL%

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
echo(  stoke account list      the agent accounts Stoke holds, and their folders
echo(  stoke account add AGENT NAME
echo(                          make an account of an agent and sign it in, in a Stoke tab
echo(  stoke account env NAME  set lines that point this cmd window at that account
echo(  stoke --version         the installed version
echo(  stoke --help            this
echo(
echo(DIR defaults to the current folder when an option is given.
echo(A folder named update, or starting with -, is stoke ./update or stoke -- -name.
echo(Settings, Updates, Command line in Stoke puts this command on PATH.
exit /b 0
