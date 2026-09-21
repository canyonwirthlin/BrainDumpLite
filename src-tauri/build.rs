// Runs at compile time: reads tauri.conf.json, embeds icons/resources,
// generates the capability schemas under gen/. The app manifest lists our own
// commands so a capability can grant them: the UI is served from
// http://127.0.0.1, a remote origin, which Tauri denies un-granted commands.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["get_quit_on_close", "set_quit_on_close"]),
        ),
    )
    .expect("failed to run tauri-build")
}
