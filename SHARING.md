# Sharing BrainDump Lite & pushing live updates

## How the update system works (30-second version)

The exe is a **thin launcher**. The real app (`app/` + `static/`) also lives in
the zip, but the launcher prefers any newer copy it finds in the friend's data
folder. On every launch, the app checks a **manifest URL** (baked in from
`update_url.txt`) in the background:

```json
{ "version": "0.3.1", "url": "https://…/update.bin", "sha256": "…" }
```

Newer version → downloaded, hash-verified, staged. A "⬆ restart to update"
pill appears; next launch runs the new code. **If a pushed update crashes at
boot, the launcher marks it bad and rolls back automatically** — you cannot
brick a friend's install with a bad push.

Python-level dependencies are frozen into the exe, so an update can change any
app code but can't add a new pip package — that needs a new exe (rare).

## One-time setup (~10 minutes)

1. Create a **public GitHub repo**, e.g. `braindumplite-updates`
   (public because friends' apps fetch from it without credentials; it only
   ever holds your update zips + manifest, not your personal data).
2. Put the raw manifest URL into `update_url.txt` (one line):
   ```
   https://raw.githubusercontent.com/<you>/braindumplite-updates/main/manifest.json
   ```
3. `.\build.ps1` — bakes the URL into a fresh `BrainDumpLite-win64.zip`.
4. Share that zip with friends via Google Drive / Dropbox / WeTransfer
   (it's ~95 MB — too big for email, fine for any file-share link).

## Pushing a fix to everyone

1. Make your code change in `app/` or `static/`.
2. Bump `app/version.py` (e.g. `0.3.0` → `0.3.1`) and the `?v=` cache-busters
   in `static/index.html` to match.
3. `.\build.ps1 -Bundle` → produces `update\update.bin` + `update\manifest.json`
   (sha256 already filled in).
4. In the GitHub repo: upload `update.bin` (e.g. as `v0.3.1/update.bin` or a
   release asset), copy its **raw/download URL** into `manifest.json`'s `url`
   field, then commit `manifest.json` to `main`.
5. Done. Every friend's app downloads it on next launch and applies it on the
   launch after that (they see the "restart to update" pill).

Test locally before pushing: point `BRAINDUMP_LITE_UPDATE_URL` at a local
manifest and launch the app — same code path end to end.

## Rules of thumb

- **Additive DB changes only** in updates (new columns via `db._migrate()`,
  new tables in SCHEMA) — never rename/drop, older code may still run once.
- New pip dependency, new Python version, PyInstaller change → new exe;
  send friends a fresh zip the old-fashioned way.
- The manifest URL itself ships inside each update bundle, so you can even
  migrate hosting later by pushing an update that changes `update_url.txt`.
