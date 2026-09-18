# Run BrainDumpLite from source (dev mode).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path .venv)) {
    python -m venv .venv
    .\.venv\Scripts\python -m pip install -r requirements.txt
    .\.venv\Scripts\python -m pip install -r requirements-voice.txt
}
.\.venv\Scripts\python run.py
