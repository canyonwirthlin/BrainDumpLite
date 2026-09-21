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
    path: Option<PathBuf>,
}

impl Prefs {
    pub fn load(app: &AppHandle) -> Prefs {
        let path = app
            .path()
            .local_data_dir()
            .ok()
            .map(|d| d.join("BrainDumpLite").join("shell.json"));
        let quit = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|s| parse_quit_on_close(&s))
            .unwrap_or(false);
        Prefs { quit_on_close: AtomicBool::new(quit), path }
    }

    pub fn quit_on_close(&self) -> bool {
        self.quit_on_close.load(Ordering::Relaxed)
    }

    fn set_quit_on_close(&self, on: bool) -> Result<(), String> {
        self.quit_on_close.store(on, Ordering::Relaxed);
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, serde_json::json!({ "quit_on_close": on }).to_string()).map_err(|e| e.to_string())
    }
}

fn parse_quit_on_close(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("quit_on_close").and_then(|b| b.as_bool()))
        .unwrap_or(false)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_saved_flag() {
        assert!(parse_quit_on_close(r#"{"quit_on_close": true}"#));
        assert!(!parse_quit_on_close(r#"{"quit_on_close": false}"#));
    }

    #[test]
    fn missing_or_broken_file_means_hide_to_tray() {
        assert!(!parse_quit_on_close("{}"));
        assert!(!parse_quit_on_close("not json"));
        assert!(!parse_quit_on_close(r#"{"quit_on_close": "yes"}"#));
    }
}
