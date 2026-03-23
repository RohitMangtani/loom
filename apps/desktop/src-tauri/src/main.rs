#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

struct LauncherState {
    child: Mutex<Option<Child>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    mode: String,
    primary_url: Option<String>,
    primary_token: Option<String>,
    dashboard_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliStatus {
    claude: bool,
    codex: bool,
    openclaw: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    configured_mode: Option<String>,
    launcher_running: bool,
    local_dashboard_url: Option<String>,
    remote_dashboard_url: Option<String>,
    admin_token: Option<String>,
    primary_url: Option<String>,
    ai_cli: CliStatus,
    note: Option<String>,
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn hive_dir() -> PathBuf {
    home_dir().join(".hive")
}

fn desktop_config_path() -> PathBuf {
    hive_dir().join("desktop-wrapper.json")
}

fn logs_dir() -> PathBuf {
    hive_dir().join("logs")
}

fn token_path() -> PathBuf {
    hive_dir().join("token")
}

fn write_secret(path: &Path, value: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, format!("{value}\n")).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, perms).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|raw| raw.trim().to_string()).filter(|value| !value.is_empty())
}

fn read_config() -> Option<DesktopConfig> {
    let raw = fs::read_to_string(desktop_config_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_config(config: &DesktopConfig) -> Result<(), String> {
    fs::create_dir_all(hive_dir()).map_err(|err| err.to_string())?;
    let raw = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    fs::write(desktop_config_path(), raw + "\n").map_err(|err| err.to_string())
}

fn command_exists(binary: &str) -> bool {
    Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {binary} >/dev/null 2>&1"))
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn port_open(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".generated")
            .join("runtime"))
    } else {
        let resource_dir = app.path().resource_dir().map_err(|err| err.to_string())?;
        Ok(resource_dir.join("runtime"))
    }
}

fn open_log_file() -> Result<File, io::Error> {
    fs::create_dir_all(logs_dir())?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir().join("desktop-wrapper.log"))
}

fn status_note(config: Option<&DesktopConfig>) -> Option<String> {
    match config {
        Some(cfg) if cfg.mode == "connect" && cfg.dashboard_url.as_deref().unwrap_or("").is_empty() => {
            Some("Satellite mode is configured. Add the primary dashboard URL if you want the wrapper to load the full remote control plane in-app.".into())
        }
        Some(cfg) if cfg.mode == "fresh" && !port_open(3310) => {
            Some("Fresh mode is configured. Launch Hive to boot the local daemon sidecar and load the dashboard in this app.".into())
        }
        None => Some("Choose Start New Hive or Join Existing Hive to replace the public shell-script install path with a native wrapper flow.".into()),
        _ => None,
    }
}

fn compute_status(state: &State<LauncherState>) -> DesktopStatus {
    if let Ok(mut child_guard) = state.child.lock() {
        if let Some(child) = child_guard.as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                *child_guard = None;
            }
        }
    }

    let config = read_config();
    let fresh_dashboard = config.as_ref().and_then(|cfg| {
        if cfg.mode == "fresh" {
            Some("http://127.0.0.1:3310".to_string())
        } else {
            None
        }
    });
    let launcher_running = state
        .child
        .lock()
        .ok()
        .and_then(|mut guard| guard.as_mut().map(|child| child.try_wait().ok().flatten().is_none()))
        .unwrap_or(false)
        || port_open(3001)
        || port_open(3310);

    DesktopStatus {
        configured_mode: config.as_ref().map(|cfg| cfg.mode.clone()),
        launcher_running,
        local_dashboard_url: if launcher_running { fresh_dashboard } else { None },
        remote_dashboard_url: config.as_ref().and_then(|cfg| cfg.dashboard_url.clone()),
        admin_token: read_trimmed(&token_path()),
        primary_url: config.as_ref().and_then(|cfg| cfg.primary_url.clone()),
        ai_cli: CliStatus {
            claude: command_exists("claude"),
            codex: command_exists("codex"),
            openclaw: command_exists("openclaw"),
        },
        note: status_note(config.as_ref()),
    }
}

#[tauri::command]
fn desktop_status(state: State<LauncherState>) -> DesktopStatus {
    compute_status(&state)
}

#[tauri::command]
fn save_fresh_setup() -> Result<(), String> {
    write_config(&DesktopConfig {
        mode: "fresh".into(),
        primary_url: None,
        primary_token: None,
        dashboard_url: None,
    })
}

#[tauri::command]
fn save_connect_setup(primary_url: String, primary_token: String, dashboard_url: Option<String>) -> Result<(), String> {
    let normalized_url = if primary_url.starts_with("https://") {
        primary_url.replacen("https://", "wss://", 1)
    } else {
        primary_url
    };

    if normalized_url.trim().is_empty() || primary_token.trim().is_empty() {
        return Err("Primary WebSocket URL and token are required for connect mode.".into());
    }

    write_secret(&hive_dir().join("primary-url"), normalized_url.trim())?;
    write_secret(&hive_dir().join("primary-token"), primary_token.trim())?;

    write_config(&DesktopConfig {
        mode: "connect".into(),
        primary_url: Some(normalized_url.trim().to_string()),
        primary_token: Some(primary_token.trim().to_string()),
        dashboard_url: dashboard_url.filter(|value| !value.trim().is_empty()),
    })
}

#[tauri::command]
fn launch_hive(app: AppHandle, state: State<LauncherState>) -> Result<Option<String>, String> {
    let config = read_config().ok_or_else(|| "Desktop wrapper setup is missing. Save fresh or connect mode first.".to_string())?;
    let runtime = runtime_root(&app)?;
    let node_path = runtime.join("bin").join("node");
    let launcher_path = runtime.join("launcher").join("desktop-launcher.mjs");

    if !node_path.exists() || !launcher_path.exists() {
        return Err("Desktop runtime is not staged. Run `npm run desktop:prepare` before launching the wrapper.".into());
    }

    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() {
          if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(match config.mode.as_str() {
                "fresh" => Some("http://127.0.0.1:3310/bootstrap.html".into()),
                "connect" => config.dashboard_url.clone(),
                _ => None,
            });
          }
        }

        let log = open_log_file().map_err(|err| err.to_string())?;
        let log_err = log.try_clone().map_err(|err| err.to_string())?;

        let mut command = Command::new(node_path);
        command.arg(launcher_path);
        command.env("HIVE_RUNTIME_ROOT", &runtime);
        command.env("HIVE_DESKTOP_MODE", &config.mode);
        command.env("HIVE_DASHBOARD_PORT", "3310");
        if let Some(primary_url) = config.primary_url.as_deref() {
            command.env("HIVE_DESKTOP_PRIMARY_URL", primary_url);
        }
        if let Some(primary_token) = config.primary_token.as_deref() {
            command.env("HIVE_DESKTOP_PRIMARY_TOKEN", primary_token);
        }
        if let Some(dashboard_url) = config.dashboard_url.as_deref() {
            command.env("HIVE_DESKTOP_REMOTE_DASHBOARD_URL", dashboard_url);
        }
        command.stdout(Stdio::from(log));
        command.stderr(Stdio::from(log_err));

        let child = command.spawn().map_err(|err| err.to_string())?;
        *guard = Some(child);
    }

    Ok(match config.mode.as_str() {
        "fresh" => Some("http://127.0.0.1:3310/bootstrap.html".into()),
        "connect" => config.dashboard_url.clone(),
        _ => None,
    })
}

#[tauri::command]
fn stop_hive(state: State<LauncherState>) -> Result<(), String> {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(LauncherState {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            save_fresh_setup,
            save_connect_setup,
            launch_hive,
            stop_hive
        ])
        .run(tauri::generate_context!())
        .expect("error while running hive desktop");
}
