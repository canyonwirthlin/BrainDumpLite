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

Write-Host "Installing dependencies..." -ForegroundColor Cyan
& $py -m pip install --quiet --disable-pip-version-check -r requirements.txt pyinstaller

$voiceOk = $false
if (-not $NoVoice) {
    & $py -m pip install --quiet --disable-pip-version-check -r requirements-voice.txt
    & $py -c "import faster_whisper" 2>$null
    if ($LASTEXITCODE -eq 0) { $voiceOk = $true }
    else { Write-Warning "faster-whisper unavailable - building WITHOUT voice." }
}

$args = @(
    '--noconfirm', '--clean', '--onedir',
    '--name', 'braindump-backend',
    '--distpath', 'src-tauri', '--workpath', 'build',
    '--add-data', 'app;app',
    '--add-data', 'static;static',
    '--add-data', 'CHANGELOG.md;.'
)
if ($voiceOk) {
    $args += @('--collect-all', 'faster_whisper', '--collect-all', 'ctranslate2', '--collect-all', 'av')
}
$args += 'run.py'

$version = (Select-String -Path "app\version.py" -Pattern '"([^"]+)"').Matches[0].Groups[1].Value
Write-Host "Running PyInstaller v$version (a few minutes)..." -ForegroundColor Cyan
Remove-Item -Recurse -Force "src-tauri\backend" -ErrorAction SilentlyContinue
& ".\.venv\Scripts\pyinstaller.exe" @args
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
Rename-Item "src-tauri\braindump-backend" "backend"

$size = [math]::Round((Get-ChildItem "src-tauri\backend" -Recurse | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "Done -> src-tauri\backend\braindump-backend.exe ($size MB, voice=$voiceOk)" -ForegroundColor Green
