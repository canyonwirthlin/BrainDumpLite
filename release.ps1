# release.ps1 - cut a release. (ASCII only for PowerShell 5.1.)
#
#   .\release.ps1              bump patch  (0.5.0 -> 0.5.1)
#   .\release.ps1 minor        bump minor
#   .\release.ps1 major        bump major
#   .\release.ps1 0.6.2        exact version
#   add -NoPush to stop after the commit + tag (inspect, then git push --follow-tags)
#
# The one human step BEFORE running this: write the "## <new version>" section
# in CHANGELOG.md. That text becomes the GitHub release notes and the in-app
# "What's New". This script refuses to run without it.
#
# Then it: writes the version into app\version.py, src-tauri\tauri.conf.json,
# src-tauri\Cargo.toml (+Cargo.lock) and the ?v= cache-busters in
# static\index.html; commits; tags vX.Y.Z; pushes. GitHub Actions
# (.github\workflows\release.yml) builds the installer and publishes it plus
# latest.json, which every installed app polls on launch.
param([string]$Bump = "patch", [switch]$NoPush)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (git status --porcelain) { throw "Working tree is not clean. Commit or stash first." }

$verFile = "app\version.py"
$cur = (Select-String -Path $verFile -Pattern '"(\d+)\.(\d+)\.(\d+)"').Matches[0]
$maj = [int]$cur.Groups[1].Value; $min = [int]$cur.Groups[2].Value; $pat = [int]$cur.Groups[3].Value
$old = "$maj.$min.$pat"
switch ($Bump.ToLower()) {
    "major" { $maj++; $min = 0; $pat = 0 }
    "minor" { $min++; $pat = 0 }
    "patch" { $pat++ }
    default {
        if ($Bump -match '^\d+\.\d+\.\d+$') { $p = $Bump -split '\.'; $maj = [int]$p[0]; $min = [int]$p[1]; $pat = [int]$p[2] }
        else { throw "Unknown bump '$Bump'. Use patch / minor / major / X.Y.Z" }
    }
}
$new = "$maj.$min.$pat"
Write-Host "  BrainDump Lite  $old  ->  $new" -ForegroundColor Cyan

# Changelog gate: no notes, no release.
& .\.venv\Scripts\python.exe -m app.changelog $new | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "CHANGELOG.md has no '## $new' section. Write what's new first - it becomes the release notes."
}

[IO.File]::WriteAllText($verFile, "__version__ = `"$new`"`n")
$html = [IO.File]::ReadAllText("static\index.html")
[IO.File]::WriteAllText("static\index.html", [regex]::Replace($html, '\?v=[\d.]+', "?v=$new"))
$conf = [IO.File]::ReadAllText("src-tauri\tauri.conf.json")
[IO.File]::WriteAllText("src-tauri\tauri.conf.json", ([regex]'"version":\s*"[\d.]+"').Replace($conf, "`"version`": `"$new`"", 1))
$cargo = [IO.File]::ReadAllText("src-tauri\Cargo.toml")
[IO.File]::WriteAllText("src-tauri\Cargo.toml", ([regex]'(?m)^version = "[\d.]+"').Replace($cargo, "version = `"$new`"", 1))
Push-Location src-tauri
# Refresh Cargo.lock's own-package version. --filter-platform keeps the resolve on this
# machine's target so macOS-only deps (mac-notification-sys) aren't demanded offline.
cargo metadata --format-version 1 --offline --filter-platform x86_64-pc-windows-msvc -q | Out-Null
Pop-Location
Write-Host "  wrote version into version.py, index.html, tauri.conf.json, Cargo.toml/lock" -ForegroundColor DarkGray

git add -A
git commit -q -m "Release v$new"
git tag -a "v$new" -m "Release v$new"   # annotated: --follow-tags only pushes annotated tags
if ($NoPush) { Write-Host "  committed + tagged v$new (not pushed)" -ForegroundColor Yellow; return }
git push --follow-tags
Write-Host ""
Write-Host "  PUSHED v$new - GitHub Actions is building the installer." -ForegroundColor Green
Write-Host "  Watch: https://github.com/canyonwirthlin/BrainDumpLite/actions" -ForegroundColor DarkGray
