# build-backend.ps1 - freeze the Python backend into src-tauri\backend\.
# (ASCII only: PowerShell 5.1 parses BOM-less files as cp1252.)
#
# The Tauri shell bundles that whole folder as a resource and spawns
# backend\braindump-backend.exe as a sidecar. Run this before
#   npm run tauri dev     (try the native app locally)
#   npm run tauri build   (make the installer)
# CI runs it too (.github\workflows\release.yml).
#
#   .\build-backend.ps1            # with voice (faster-whisper)
#   .\build-backend.ps1 -NoVoice   # smaller, no mic button
param([switch]$NoVoice)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .venv)) {
    Write-Host "Creating venv..." -ForegroundColor Cyan
    python -m venv .venv
}
$py = ".\.venv\Scripts\python.exe"

# pip writes notices and warnings to stderr. Under $ErrorActionPreference = 'Stop'
# PowerShell 5.1 turns ANY native stderr line into a terminating error, which kills
# this script on a clean machine (CI) while passing locally where nothing needs
# installing. Run native commands with that off and judge them by exit code alone.
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "$_" } }
    finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
}

Write-Host "Installing dependencies..." -ForegroundColor Cyan
$code = Invoke-Native $py @('-m', 'pip', 'install', '--disable-pip-version-check',
                            '-r', 'requirements.txt', 'pyinstaller')
if ($code -ne 0) { throw "pip install failed (exit $code) - see the log above" }

$voiceOk = $false
if (-not $NoVoice) {
    $code = Invoke-Native $py @('-m', 'pip', 'install', '--disable-pip-version-check',
                                '-r', 'requirements-voice.txt')
    if ($code -ne 0) { Write-Warning "voice dependencies did not install (exit $code)." }
    if ((Invoke-Native $py @('-c', 'import faster_whisper')) -eq 0) { $voiceOk = $true }
    else { Write-Warning "faster-whisper unavailable - building WITHOUT voice." }
}

$args = @(
    '--noconfirm', '--clean', '--onedir',
    '--name', 'braindump-backend',
    '--distpath', 'src-tauri', '--workpath', 'build',
    '--add-data', 'app;app',
    '--add-data', 'static;static',
    '--add-data', 'CHANGELOG.md;.',
    '--add-data', 'catalog;catalog',
    '--add-data', 'examples;examples'
)
if ($voiceOk) {
    $args += @('--collect-all', 'faster_whisper', '--collect-all', 'ctranslate2', '--collect-all', 'av')
}
$args += 'run.py'

$version = (Select-String -Path "app\version.py" -Pattern '"([^"]+)"').Matches[0].Groups[1].Value
Write-Host "Running PyInstaller v$version (a few minutes)..." -ForegroundColor Cyan
Remove-Item -Recurse -Force "src-tauri\backend" -ErrorAction SilentlyContinue
$code = Invoke-Native ".\.venv\Scripts\pyinstaller.exe" $args
if ($code -ne 0) { throw "PyInstaller failed (exit $code)" }
Rename-Item "src-tauri\braindump-backend" "backend"

$size = [math]::Round((Get-ChildItem "src-tauri\backend" -Recurse | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "Done -> src-tauri\backend\braindump-backend.exe ($size MB, voice=$voiceOk)" -ForegroundColor Green
