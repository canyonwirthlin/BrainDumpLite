//! Starts and stops the Python backend (a PyInstaller folder shipped as a
//! Tauri resource). Pure std: no async, no extra crates.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// The running backend process, stored in Tauri's managed state so the
/// exit handler can kill it. `None` after stop().
pub struct Backend(pub Mutex<Option<Child>>);

pub const BACKEND_EXE: &str = "braindump-backend.exe";

/// First free port in [start, start+25), matching the range the standalone
/// backend always used (8756-8780). Falls back to an OS-chosen port.
pub fn pick_port(start: u16) -> u16 {
    for p in start..start + 25 {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(start)
}

/// Where the backend exe lives. Installed app: <install dir>/backend/ (the
/// resource dir IS the exe dir on Windows). `tauri dev`: the folder that
/// build-backend.ps1 writes to, in case tauri-build didn't copy resources.
pub fn exe_path(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("backend").join(BACKEND_EXE);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("backend").join(BACKEND_EXE)
}

pub fn spawn(app: &AppHandle, port: u16) -> Result<Child, String> {
    let exe = exe_path(app);
    if !exe.exists() {
        return Err(format!("backend not found at {} - run build-backend.ps1", exe.display()));
    }
    let mut cmd = Command::new(&exe);
    cmd.env("BRAINDUMP_LITE_SIDECAR", "1")
        .env("BRAINDUMP_LITE_PORT", port.to_string())
        .env("BRAINDUMP_LITE_PARENT_PID", std::process::id().to_string())
        .current_dir(exe.parent().expect("exe has a parent dir"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash
    }
    cmd.spawn().map_err(|e| format!("could not start backend {}: {e}", exe.display()))
}

/// uvicorn binds its socket only after the app is fully constructed, so
/// "port accepts a TCP connection" == "backend is ready".
pub fn wait_ready(port: u16, timeout: Duration) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

pub fn stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<Backend>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_port_returns_a_bindable_port() {
        let p = pick_port(8756);
        assert!(TcpListener::bind(("127.0.0.1", p)).is_ok());
    }

    #[test]
    fn wait_ready_gives_up_on_a_closed_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener); // now nothing listens there
        assert!(!wait_ready(port, Duration::from_millis(700)));
    }

    #[test]
    fn wait_ready_sees_a_listening_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(wait_ready(port, Duration::from_secs(2)));
    }
}
