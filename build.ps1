# Build BrainDumpLite.  (ASCII only: PowerShell 5.1 parses BOM-less files as
# cp1252 and chokes on unicode.)
#
#   .\build.ps1           -> dist\BrainDumpLite\ + BrainDumpLite-win64.zip  (full app, send once)
#   .\build.ps1 -Bundle   -> update\update.zip + update\manifest.json      (push a fix to friends)
#   .\build.ps1 -NoVoice  -> full app without faster-whisper (smaller, no mic)
#
# Live-update flow: friends' exes read update_url.txt (baked into the exe) and
# check that manifest URL at every launch. To ship a fix: bump app\version.py,
# run  .\build.ps1 -Bundle,  upload update.zip, set its public URL in
# manifest.json, upload manifest.json to the update_url.txt location. Done -
# friends get it next restart. See SHARING.md.
param([switch]$NoVoice, [switch]$Bundle)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$version = (Select-String -Path "app\version.py" -Pattern '"([^"]+)"').Matches[0].Groups[1].Value
if (-not (Test-Path "update_url.txt")) {
    Set-Content "update_url.txt" "" -Encoding ascii   # empty = updater disabled
}

if ($Bundle) {
    Write-Host "Building update bundle v$version..." -ForegroundColor Cyan
    Remove-Item update -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory update | Out-Null
    # Named .bin, not .zip: AV web-shields reset .zip downloads from non-browser
    # clients (observed live). It's still a zip inside; the updater doesn't care.
    Compress-Archive -Path app, static, update_url.txt -DestinationPath "update\update.zip" -Force
    Move-Item "update\update.zip" "update\update.bin" -Force
    $sha = (Get-FileHash "update\update.bin" -Algorithm SHA256).Hash.ToLower()
    @"
{
  "version": "$version",
  "url": "REPLACE_WITH_PUBLIC_URL_OF_update.bin",
  "sha256": "$sha"
}
"@ | Set-Content "update\manifest.json" -Encoding ascii
    Write-Host "Done -> update\update.bin + update\manifest.json (sha256 filled in)" -ForegroundColor Green
    Write-Host "Next: upload update.bin, put its public URL into manifest.json, upload manifest.json."
    exit 0
}

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
    '--add-data', 'static;static',
    '--add-data', 'update_url.txt;.'
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
