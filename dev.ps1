# Run BrainDumpLite from source (dev mode). ASCII only for PowerShell 5.1.
#
#   .\dev.ps1            SANDBOX: your own scratch vault (%LOCALAPPDATA%\BrainDumpLite-dev).
#                        Safe to break; never touches your real dumps or the installed app.
#   .\dev.ps1 -Clone     sandbox, but first COPIES your real vault into it (once) so you can
#                        try unreleased changes on your real data without any risk to it.
#   .\dev.ps1 -Reset     wipe the sandbox and start empty again.
#   .\dev.ps1 -Real      run against your REAL vault. Only for when you truly want that.
param([switch]$Real, [switch]$Clone, [switch]$Reset)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path .venv)) {
    python -m venv .venv
    .\.venv\Scripts\python -m pip install -r requirements.txt
    .\.venv\Scripts\python -m pip install -r requirements-voice.txt
}
$realDir = Join-Path $env:LOCALAPPDATA 'BrainDumpLite'
$sandbox = Join-Path $env:LOCALAPPDATA 'BrainDumpLite-dev'
if ($Real) {
    Write-Host "  REAL vault: $realDir - changes here are permanent." -ForegroundColor Yellow
} else {
    if ($Reset -and (Test-Path $sandbox)) { Remove-Item -Recurse -Force $sandbox; Write-Host "  sandbox wiped" -ForegroundColor DarkGray }
    New-Item -ItemType Directory -Force $sandbox | Out-Null
    if ($Clone -and -not (Test-Path (Join-Path $sandbox 'braindump.db'))) {
        $src = $realDir
        $ptr = Join-Path $realDir 'vault-location.txt'
        if (Test-Path $ptr) { $src = (Get-Content $ptr -Raw).Trim() }
        if (Test-Path (Join-Path $src 'braindump.db')) {
            # A copy of the file alone can miss recent writes still in the -wal file, so copy all three.
            foreach ($f in 'braindump.db', 'braindump.db-wal', 'braindump.db-shm') {
                if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) $sandbox -Force }
            }
            Write-Host "  copied your real vault into the sandbox" -ForegroundColor DarkGray
        } else { Write-Host "  no real vault found at $src - starting empty" -ForegroundColor Yellow }
    }
    $env:BRAINDUMP_LITE_DATA = $sandbox
    Write-Host "  SANDBOX vault: $sandbox" -ForegroundColor Cyan
}
.\.venv\Scripts\python run.py
