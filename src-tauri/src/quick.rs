//! Global quick-capture: Ctrl+Shift+Space (even while the window is hidden in the tray) pops up a small
//! always-on-top box, you type, Ctrl+Enter, and it is saved as a dump. The window is built once at
//! startup (hidden) and then only shown/hidden, so the hotkey is instant. Its page is served by the
//! Python backend (static/quick.html) and talks to the same /api as the main window.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub const LABEL: &str = "quick";

fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}

/// Build the hidden window. Its content is swapped for the real page once the backend is up (lib.rs).
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Quick capture")
        .inner_size(600.0, 250.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .center()
        .visible(false)
        .build()?;
    Ok(())
}

pub fn register(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    if gs.is_registered(shortcut()) {
        return Ok(());
    }
    gs.register(shortcut())
        .map_err(|e| format!("Couldn't claim Ctrl+Shift+Space - another program may be using it ({e})"))
}

pub fn unregister(app: &AppHandle) {
    let _ = app.global_shortcut().unregister(shortcut());
}

/// Hotkey pressed: show the box (focused, ready to type) or hide it if it is already up.
pub fn toggle(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval("window.bdlQuick && window.bdlQuick()");
    }
}
