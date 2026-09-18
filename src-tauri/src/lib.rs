//! The native shell. Owns the window, the tray icon and the Python backend
//! process. Deliberately tiny - all product logic lives in Python and JS.

mod backend;
mod tray;

use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init()) // web UI opens links in the default browser
        .plugin(tauri_plugin_updater::Builder::new().build()) // JS: __TAURI__.updater.check()
        .plugin(tauri_plugin_process::init()) // JS: __TAURI__.process.relaunch()
        .plugin(tauri_plugin_dialog::init()) // JS: __TAURI__.dialog.open({ directory: true })
        .setup(|app| {
            // 1. Start the backend on a port we choose, so we know where to navigate.
            let port = backend::pick_port(8756);
            let child = backend::spawn(app.handle(), port)?;
            app.manage(backend::Backend(Mutex::new(Some(child))));

            // 2. Off the UI thread: wait for the port, then swap the splash for the app.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let ready = backend::wait_ready(port, Duration::from_secs(90));
                let Some(window) = handle.get_webview_window("main") else { return };
                if ready {
                    let url = format!("http://127.0.0.1:{port}/").parse().expect("valid url");
                    let _ = window.navigate(url);
                } else {
                    let log = handle
                        .path()
                        .local_data_dir()
                        .map(|d| d.join("BrainDumpLite").join("logs").join("backend.log"))
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|_| "%LOCALAPPDATA%\\BrainDumpLite\\logs\\backend.log".into());
                    let _ = window.eval(&format!("window.bdlFailed({})", serde_json::to_string(&log).unwrap()));
                }
            });

            tray::setup(app.handle())?;
            Ok(())
        })
        // Close button = hide to tray. Tray -> Quit is the real exit.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building BrainDump Lite")
        .run(|app, event| {
            // 3. Whatever way the app exits, take the backend down with it.
            if let tauri::RunEvent::Exit = event {
                backend::stop(app);
            }
        });
}
