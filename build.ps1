# Build BrainDumpLite.  (ASCII only: PowerShell 5.1 parses BOM-less files as
# cp1252 and chokes on unicode.)
#
#   .\build.ps1           -> dist\BrainDumpLite\ + BrainDumpLite-win64.zip  (full app, send once)
#   .\build.ps1 -NoVoice  -> full app without faster-whisper (smaller, no mic)
param([switch]$NoVoice)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$version = (Select-String -Path "app\version.py" -Pattern '"([^"]+)"').Matches[0].Groups[1].Value
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
    '--name', 'BrainDumpLite',
    '--add-data', 'app;app',
    '--add-data', 'static;static'
)
if ($voiceOk) {
    $args += @('--collect-all', 'faster_whisper', '--collect-all', 'ctranslate2', '--collect-all', 'av')
}
$args += 'run.py'

Write-Host "Running PyInstaller v$version (this takes a few minutes)..." -ForegroundColor Cyan
& ".\.venv\Scripts\pyinstaller.exe" @args
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

Copy-Item FRIENDS_README.txt "dist\BrainDumpLite\READ ME FIRST.txt" -Force

Write-Host "Zipping..." -ForegroundColor Cyan
Compress-Archive -Force -Path "dist\BrainDumpLite\*" -DestinationPath "BrainDumpLite-win64.zip"

$size = [math]::Round((Get-Item "BrainDumpLite-win64.zip").Length / 1MB, 1)
Write-Host "`nDone -> BrainDumpLite-win64.zip ($size MB, v$version)" -ForegroundColor Green
Write-Host "Send that zip to a friend. They unzip and double-click BrainDumpLite.exe."
