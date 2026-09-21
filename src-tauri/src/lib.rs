//! The native shell. Owns the window, the tray icon and the Python backend
//! process. Deliberately tiny - all product logic lives in Python and JS.

mod backend;
mod prefs;
mod tray;

use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // Must be first. A second launch (Start Menu, a double-click, the OS
        // login item) never gets as far as starting a second backend: it hands
        // its args to this callback in the running instance and exits. Bring
        // the window forward, unless the OS itself launched it at login.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|a| a == "--minimized") {
                tray::show_main(app);
            }
        }))
        .plugin(tauri_plugin_opener::init()) // web UI opens links in the default browser
        .plugin(tauri_plugin_updater::Builder::new().build()) // JS: __TAURI__.updater.check()
        .plugin(tauri_plugin_process::init()) // JS: __TAURI__.process.relaunch()
        .plugin(tauri_plugin_dialog::init()) // JS: __TAURI__.dialog.open({ directory: true })
        .plugin(tauri_plugin_notification::init()) // JS: __TAURI__.notification.sendNotification()
        // JS: __TAURI__.autostart.{enable,disable,isEnabled}() — the onboarding /
        // Settings "open at startup" toggle. `--minimized` is only present when
        // the OS itself launched us at login, so that boot stays out of the way
        // in the tray instead of popping the window up.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized".into()]),
        ))
        .invoke_handler(tauri::generate_handler![prefs::get_quit_on_close, prefs::set_quit_on_close])
        .setup(|app| {
            app.manage(prefs::Prefs::load(app.handle()));

            // 1. Start the backend on a port we choose, so we know where to navigate.
            let port = backend::pick_port(8756);
            let child = backend::spawn(app.handle(), port)?;
            app.manage(backend::Backend(Mutex::new(Some(child))));
            let launched_minimized = std::env::args().any(|a| a == "--minimized");
            if launched_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

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
        // Close button = hide to tray (tray -> Quit is the real exit), unless
        // Settings -> "Quit when I close the window" is on: then it just quits.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.try_state::<prefs::Prefs>().is_some_and(|p| p.quit_on_close()) {
                    app.exit(0);
                } else {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building BrainDump Lite")
        .run(|app, event| match event {
            // 3. Whatever way the app exits, take the backend down with it.
            tauri::RunEvent::Exit => backend::stop(app),
            // macOS: closing the window only hides it (like Windows' tray behaviour), so a click
            // on the Dock icon has to bring it back.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => tray::show_main(app),
            _ => {}
        });
}
