# Working on your own version before releasing

Your installed BrainDump Lite only changes when you publish a release (it updates itself from
GitHub Releases). Everything below lets you run **unreleased** code without the public getting it.

## Day to day

```powershell
git switch -c dev          # once: do your work here, not on master (master = what's released)
.\dev.ps1                  # run from source against a SANDBOX vault (never touches your real dumps)
.\dev.ps1 -Clone           # same, but starts from a copy of your real vault - try changes on real data, risk-free
.\dev.ps1 -Reset           # wipe the sandbox and start empty
.\dev.ps1 -Real            # run from source against your REAL vault (changes are permanent)
```

The sandbox lives in `%LOCALAPPDATA%\BrainDumpLite-dev`, so it can sit next to the installed app.
Stop the installed app first if the browser tab you opened doesn't respond: both use local ports.

Native window instead of the browser tab: `.\build-backend.ps1` then `npm run tauri dev`
(set `$env:BRAINDUMP_LITE_DATA` first if you want it to use the sandbox too).

## Nothing goes public until you say so

- Only a **tag** (`vX.Y.Z`) makes GitHub Actions build and publish anything. Pushing `dev` publishes nothing.
- `release.ps1` refuses to run unless you're on `master`, so an accidental release from `dev` is impossible.

## Releasing

```powershell
.\.venv\Scripts\python -m pytest -q     # green?
git switch master
git merge dev
# write "## X.Y.Z - date" in CHANGELOG.md, commit it, then:
.\release.ps1 minor                     # or patch / major / X.Y.Z
```
