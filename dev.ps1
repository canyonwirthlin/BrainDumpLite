# Run BrainDumpLite from source (dev mode). ASCII only for PowerShell 5.1.
#
#   .\dev.ps1            SANDBOX seeded with a COPY of your real vault (%LOCALAPPDATA%\BrainDumpLite-dev).
#                        The copy happens when the sandbox is new or has no dumps in it. Safe to break;
#                        never touches your real dumps or the installed app.
#   .\dev.ps1 -Clone     re-copy your real vault into the sandbox now, replacing what it holds.
#   .\dev.ps1 -Empty     sandbox that starts blank (no copy).
#   .\dev.ps1 -Reset     wipe the sandbox first (then it is re-seeded as above).
#   .\dev.ps1 -Real      run against your REAL vault. Only for when you truly want that.
param([switch]$Real, [switch]$Clone, [switch]$Empty, [switch]$Reset)
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
    $sdb = Join-Path $sandbox 'braindump.db'
    $needCopy = $Clone
    if (-not $Empty -and -not $Clone) {
        if (-not (Test-Path $sdb)) { $needCopy = $true }
        else {
            # An empty sandbox (e.g. left by an earlier run) has nothing worth keeping: seed it.
            $n = .\.venv\Scripts\python -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select count(*) from dumps').fetchone()[0])" $sdb 2>$null
            if ($LASTEXITCODE -ne 0 -or [int]$n -eq 0) { $needCopy = $true }
        }
    }
    if ($needCopy) {
        $src = $realDir
        $ptr = Join-Path $realDir 'vault-location.txt'
        if (Test-Path $ptr) { $src = (Get-Content $ptr -Raw).Trim() }
        $rdb = Join-Path $src 'braindump.db'
        if (Test-Path $rdb) {
            foreach ($f in 'braindump.db', 'braindump.db-wal', 'braindump.db-shm') { Remove-Item (Join-Path $sandbox $f) -Force -ErrorAction SilentlyContinue }
            # SQLite's own backup API gives a consistent copy even while the installed app has the vault open.
            .\.venv\Scripts\python -c "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close()" $rdb $sdb
            if ($LASTEXITCODE -ne 0) { throw "copying your real vault failed" }
            Write-Host "  copied your real vault ($rdb) into the sandbox" -ForegroundColor DarkGray
        } else { Write-Host "  no real vault found at $src - starting empty" -ForegroundColor Yellow }
    }
    $env:BRAINDUMP_LITE_DATA = $sandbox
    Write-Host "  SANDBOX vault: $sandbox" -ForegroundColor Cyan
}
.\.venv\Scripts\python run.py
