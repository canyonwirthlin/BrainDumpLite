//! Shell-level preferences the Rust side has to know before any page has
//! loaded (the close button is handled here, not in JS). One tiny JSON file
//! next to the logs; the web UI reads/writes it through two commands.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};

/// `quit_on_close` false (default) = the close button hides the window to the
/// tray; true = it quits the app like any other program.
pub struct Prefs {
    quit_on_close: AtomicBool,
    /// Global Ctrl+Shift+Space opens the quick-capture box from anywhere. On by default.
    quick_capture: AtomicBool,
    path: Option<PathBuf>,
}

impl Prefs {
    pub fn load(app: &AppHandle) -> Prefs {
        let path = app
            .path()
            .local_data_dir()
            .ok()
            .map(|d| d.join("BrainDumpLite").join("shell.json"));
        let text = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok());
        let quit = text.as_deref().map(parse_quit_on_close).unwrap_or(false);
        let quick = text.as_deref().map(parse_quick_capture).unwrap_or(true);
        Prefs { quit_on_close: AtomicBool::new(quit), quick_capture: AtomicBool::new(quick), path }
    }

    pub fn quick_capture(&self) -> bool {
        self.quick_capture.load(Ordering::Relaxed)
    }

    fn set_quick_capture(&self, on: bool) -> Result<(), String> {
        self.quick_capture.store(on, Ordering::Relaxed);
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::json!({ "quit_on_close": self.quit_on_close(), "quick_capture": self.quick_capture() });
        std::fs::write(path, json.to_string()).map_err(|e| e.to_string())
    }

    pub fn quit_on_close(&self) -> bool {
        self.quit_on_close.load(Ordering::Relaxed)
    }

    fn set_quit_on_close(&self, on: bool) -> Result<(), String> {
        self.quit_on_close.store(on, Ordering::Relaxed);
        self.save()
    }
}

fn parse_quit_on_close(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("quit_on_close").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

fn parse_quick_capture(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("quick_capture").and_then(|b| b.as_bool()))
        .unwrap_or(true)
}

// JS: __TAURI__.core.invoke("get_quit_on_close") / invoke("set_quit_on_close", { enabled })
#[tauri::command]
pub fn get_quit_on_close(prefs: State<'_, Prefs>) -> bool {
    prefs.quit_on_close()
}

#[tauri::command]
pub fn set_quit_on_close(prefs: State<'_, Prefs>, enabled: bool) -> Result<(), String> {
    prefs.set_quit_on_close(enabled)
}

/// Turn the global quick-capture hotkey on or off (registers/unregisters it right away).
/// Errors when another program already owns the key combination.
#[tauri::command]
pub fn set_quick_capture(app: AppHandle, prefs: State<'_, Prefs>, enabled: bool) -> Result<(), String> {
    if enabled {
        crate::quick::register(&app)?;
    } else {
        crate::quick::unregister(&app);
    }
    prefs.set_quick_capture(enabled)
}

#[tauri::command]
pub fn get_quick_capture(prefs: State<'_, Prefs>) -> bool {
    prefs.quick_capture()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_saved_flag() {
        assert!(parse_quit_on_close(r#"{"quit_on_close": true}"#));
        assert!(!parse_quit_on_close(r#"{"quit_on_close": false}"#));
    }

    #[test]
    fn quick_capture_defaults_on() {
        assert!(parse_quick_capture("{}"));
        assert!(parse_quick_capture("not json"));
        assert!(!parse_quick_capture(r#"{"quick_capture": false}"#));
    }

    #[test]
    fn missing_or_broken_file_means_hide_to_tray() {
        assert!(!parse_quit_on_close("{}"));
        assert!(!parse_quit_on_close("not json"));
        assert!(!parse_quit_on_close(r#"{"quit_on_close": "yes"}"#));
    }
}
