use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::domain::errors::AppError;
use crate::domain::models::{SessionOutput, SessionStatus, SshConnection};
use crate::infrastructure::pty_process::{SessionRegistry, TerminalSession};
use crate::usecases::connection_usecase::validate_connection;

pub fn start_embedded_session(
    app: AppHandle,
    sessions: &State<SessionRegistry>,
    connection: SshConnection,
) -> Result<String, AppError> {
    validate_connection(&connection)?;

    let id = connection.id.clone();
    if let Some(session) = sessions.sessions.lock().unwrap().remove(&id) {
        let _ = session.child.lock().unwrap().kill();
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 32,
            cols: 110,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| AppError::LaunchSshSession(err.to_string()))?;

    let mut command = CommandBuilder::new("/usr/bin/ssh");
    command.env("TERM", "xterm-256color");
    command.env("LANG", "en_US.UTF-8");
    command.arg("-tt");
    command.arg("-o");
    command.arg("PreferredAuthentications=password");
    command.arg("-o");
    command.arg("PubkeyAuthentication=no");
    command.arg("-o");
    command.arg("NumberOfPasswordPrompts=1");
    command.arg("-o");
    command.arg("StrictHostKeyChecking=accept-new");
    command.arg("-o");
    command.arg("ConnectTimeout=12");
    command.arg("-o");
    command.arg("ConnectionAttempts=1");
    command.arg("-p");
    command.arg(connection.port.to_string());
    command.arg(format!("{}@{}", connection.username, connection.host));

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| AppError::LaunchSshSession(err.to_string()))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| AppError::LaunchSshSession(err.to_string()))?;
    let master = Arc::new(Mutex::new(pair.master));
    let writer = Arc::new(Mutex::new(
        master
            .lock()
            .unwrap()
            .take_writer()
            .map_err(|err| AppError::LaunchSshSession(err.to_string()))?,
    ));
    let child = Arc::new(Mutex::new(child));

    sessions.sessions.lock().unwrap().insert(
        id.clone(),
        TerminalSession {
            writer: writer.clone(),
            child: child.clone(),
            master: master.clone(),
        },
    );

    let _ = app.emit(
        "ssh-session-status",
        SessionStatus {
            id: id.clone(),
            status: "connecting".to_string(),
        },
    );
    let _ = app.emit(
        "ssh-session-output",
        SessionOutput {
            id: id.clone(),
            data: format!(
                "Connecting to {}@{}:{}...\r\n",
                connection.username, connection.host, connection.port
            ),
        },
    );

    let read_app = app.clone();
    let read_id = id.clone();
    let password = connection.password.clone().unwrap_or_default();
    thread::spawn(move || {
        let mut password_sent = false;
        let mut connected = false;
        let mut buffer = [0_u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    let lowered = data.to_lowercase();
                    if lowered.contains("permission denied")
                        || lowered.contains("authentication failed")
                        || lowered.contains("could not resolve hostname")
                        || lowered.contains("connection timed out")
                        || lowered.contains("operation timed out")
                        || lowered.contains("connection refused")
                        || lowered.contains("no route to host")
                    {
                        let _ = read_app.emit(
                            "ssh-session-status",
                            SessionStatus {
                                id: read_id.clone(),
                                status: "failed".to_string(),
                            },
                        );
                    }
                    if !password_sent
                        && (lowered.contains("password")
                            || lowered.contains("passcode")
                            || lowered.contains("verification code"))
                    {
                        thread::sleep(Duration::from_millis(120));
                        let mut writer = writer.lock().unwrap();
                        let _ = writer.write_all(password.as_bytes());
                        let _ = writer.write_all(b"\r");
                        password_sent = true;
                        let _ = read_app.emit(
                            "ssh-session-status",
                            SessionStatus {
                                id: read_id.clone(),
                                status: "interactive".to_string(),
                            },
                        );
                    }

                    let _ = read_app.emit(
                        "ssh-session-output",
                        SessionOutput {
                            id: read_id.clone(),
                            data,
                        },
                    );

                    if !connected
                        && (lowered.contains("last login")
                            || lowered.contains("welcome to")
                            || lowered.contains(":~$")
                            || lowered.contains("$ "))
                    {
                        connected = true;
                        let _ = read_app.emit(
                            "ssh-session-status",
                            SessionStatus {
                                id: read_id.clone(),
                                status: "connected".to_string(),
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }

        let _ = read_app.emit(
            "ssh-session-status",
            SessionStatus {
                id: read_id,
                status: "closed".to_string(),
            },
        );
    });

    Ok(id)
}
