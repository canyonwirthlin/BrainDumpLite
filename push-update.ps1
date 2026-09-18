# push-update.ps1 - one-command update publisher for BrainDump Lite.
# Double-click push-update.bat instead of running this directly.
#
#   push-update.bat            -> bump patch  (0.3.0 -> 0.3.1)
#   push-update.bat minor      -> bump minor  (0.3.1 -> 0.4.0)
#   push-update.bat major      -> bump major  (0.4.0 -> 1.0.0)
#   push-update.bat 0.5.2      -> set an exact version
#
# What it does, start to finish:
#   1. Bumps app\version.py and the ?v= cache-busters in static\index.html
#   2. Runs build.ps1 -Bundle  (makes update\update.bin + manifest.json)
#   3. Fills the real download URL + sha256 into the manifest
#   4. Copies both files into a local clone of the update repo, commits, pushes
# Friends' apps pick it up on their next launch. You send them nothing.
param([string]$Bump = "patch")
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# --- repo config (change here if you ever move the update repo) ---------------
$RepoOwner = "canyonwirthlin"
$RepoName  = "BrainDumpLiteUpdateService"
$Branch    = "main"
$RepoGit   = "https://github.com/$RepoOwner/$RepoName.git"
$RawBase   = "https://raw.githubusercontent.com/$RepoOwner/$RepoName/$Branch"
$BinUrl    = "$RawBase/update.bin"
# Local clone of the update repo, kept as a sibling of this folder.
$RepoDir   = Join-Path (Split-Path $PSScriptRoot -Parent) $RepoName

function Run($exe, [string[]]$a) {
    & $exe @a
    if ($LASTEXITCODE -ne 0) { throw "$exe $($a -join ' ')  (exit $LASTEXITCODE)" }
}

# --- 1. work out the new version ---------------------------------------------
$verFile = Join-Path $PSScriptRoot "app\version.py"
$cur = (Select-String -Path $verFile -Pattern '"(\d+)\.(\d+)\.(\d+)"').Matches[0]
$maj = [int]$cur.Groups[1].Value; $min = [int]$cur.Groups[2].Value; $pat = [int]$cur.Groups[3].Value
$old = "$maj.$min.$pat"

switch ($Bump.ToLower()) {
    "major" { $maj++; $min = 0; $pat = 0 }
    "minor" { $min++; $pat = 0 }
    "patch" { $pat++ }
    default {
        if ($Bump -match '^\d+\.\d+\.\d+$') {
            $p = $Bump -split '\.'; $maj = [int]$p[0]; $min = [int]$p[1]; $pat = [int]$p[2]
        } else { throw "Unknown bump '$Bump'. Use patch / minor / major / X.Y.Z" }
    }
}
$new = "$maj.$min.$pat"
Write-Host "  BrainDump Lite  $old  ->  $new" -ForegroundColor Cyan
Write-Host ""

# --- 2. write version.py + cache-busters -------------------------------------
[System.IO.File]::WriteAllText($verFile, "__version__ = `"$new`"`n")

$htmlFile = Join-Path $PSScriptRoot "static\index.html"
$html = [System.IO.File]::ReadAllText($htmlFile)
$html = [regex]::Replace($html, '\?v=[\d.]+', "?v=$new")
[System.IO.File]::WriteAllText($htmlFile, $html)
Write-Host "  bumped version.py + index.html cache-busters" -ForegroundColor DarkGray

# --- 3. build the bundle ------------------------------------------------------
Write-Host "  building update bundle..." -ForegroundColor DarkGray
Run "powershell" @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                   (Join-Path $PSScriptRoot 'build.ps1'), '-Bundle')

# --- 4. fill the real URL into the manifest ----------------------------------
$manFile = Join-Path $PSScriptRoot "update\manifest.json"
$man = [System.IO.File]::ReadAllText($manFile)
$man = $man.Replace("REPLACE_WITH_PUBLIC_URL_OF_update.bin", $BinUrl)
[System.IO.File]::WriteAllText($manFile, $man)

# --- 5. make sure the update repo is cloned & current ------------------------
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
    Write-Host "  cloning update repo (first run)..." -ForegroundColor DarkGray
    Run "git" @('clone', $RepoGit, $RepoDir)
} else {
    # Only pull if the repo already has commits (fresh/empty repos have no HEAD).
    & git -C $RepoDir rev-parse HEAD *> $null
    if ($LASTEXITCODE -eq 0) { Run "git" @('-C', $RepoDir, 'pull', '--ff-only') }
}

# --- 6. copy artifacts, commit, push -----------------------------------------
Copy-Item (Join-Path $PSScriptRoot "update\update.bin")     $RepoDir -Force
Copy-Item (Join-Path $PSScriptRoot "update\manifest.json")  $RepoDir -Force
Run "git" @('-C', $RepoDir, 'add', 'update.bin', 'manifest.json')

$dirty = & git -C $RepoDir status --porcelain
if (-not $dirty) {
    Write-Host "  nothing changed - already published v$new?" -ForegroundColor Yellow
    return
}
Run "git" @('-C', $RepoDir, 'commit', '-m', "Publish v$new")
Run "git" @('-C', $RepoDir, 'push', '-u', 'origin', "HEAD:$Branch")

Write-Host ""
Write-Host "  PUBLISHED v$new" -ForegroundColor Green
Write-Host "  Friends get it on their next app restart. You send them nothing." -ForegroundColor Green
Write-Host "  (raw.githubusercontent caches ~5 min, so allow a few minutes.)" -ForegroundColor DarkGray
