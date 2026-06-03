use base64::{engine::general_purpose, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use ssh2::{Session, Sftp};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::domain::errors::AppError;
use crate::domain::models::*;
use crate::infrastructure::pty_process::{PfProcessRegistry, SessionRegistry};
use crate::infrastructure::ssh2_client::{SftpRegistry, SftpSession};
use crate::interfaces::repositories::store::{read_store, write_store};
use crate::usecases::connection_usecase;
use crate::usecases::pf_usecase;
use crate::usecases::sftp_usecase;
use crate::usecases::ssh_usecase;

#[derive(Default)]
pub struct TransferCancelRegistry {
    flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

fn emit_sftp_progress(
    app: &AppHandle,
    id: &str,
    loaded: u64,
    total: u64,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit("sftp-upload-progress", UploadProgressEvent {
        id: id.to_string(),
        loaded,
        total,
        done,
        error,
    });
}

fn join_remote_path(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{}", name)
    } else if dir.ends_with('/') {
        format!("{}{}", dir, name)
    } else {
        format!("{}/{}", dir, name)
    }
}

fn is_cancelled(cancel_flag: &Option<Arc<AtomicBool>>) -> bool {
    cancel_flag
        .as_ref()
        .map_or(false, |flag| flag.load(Ordering::SeqCst))
}

fn local_total_bytes(path: &Path) -> Result<u64, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        let mut total = 0;
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            total += local_total_bytes(&entry.path())?;
        }
        Ok(total)
    } else {
        Ok(metadata.len())
    }
}

fn ensure_remote_dir(sftp: &Sftp, path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path == Path::new("/") {
        return Ok(());
    }

    if let Ok(stat) = sftp.stat(path) {
        if stat.is_dir() {
            return Ok(());
        }
        return Err(format!("Remote path already exists and is not a directory: {}", path.display()));
    }

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && parent != path {
            ensure_remote_dir(sftp, parent)?;
        }
    }

    match sftp.mkdir(path, 0o755) {
        Ok(_) => Ok(()),
        Err(e) => match sftp.stat(path) {
            Ok(stat) if stat.is_dir() => Ok(()),
            _ => Err(e.to_string()),
        },
    }
}

fn upload_local_file(
    sftp: &Sftp,
    app: &AppHandle,
    id: &str,
    local_path: &Path,
    remote_path: &Path,
    cancel_flag: &Option<Arc<AtomicBool>>,
    loaded: &mut u64,
    total: u64,
) -> Result<(), String> {
    if is_cancelled(cancel_flag) {
        return Err("Canceled".to_string());
    }

    let mut local_file = std::fs::File::open(local_path).map_err(|e| e.to_string())?;
    let mut remote_file = sftp.create(remote_path).map_err(|e| e.to_string())?;

    let mut buffer = [0u8; 65536];
    let mut last_emit = std::time::Instant::now();

    loop {
        if is_cancelled(cancel_flag) {
            drop(remote_file);
            let _ = sftp.unlink(remote_path);
            return Err("Canceled".to_string());
        }

        match local_file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                remote_file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
                *loaded += n as u64;
                if last_emit.elapsed() > std::time::Duration::from_millis(30) {
                    emit_sftp_progress(app, id, *loaded, total, false, None);
                    last_emit = std::time::Instant::now();
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    Ok(())
}

fn upload_local_path(
    sftp: &Sftp,
    app: &AppHandle,
    id: &str,
    local_path: &Path,
    remote_path: &Path,
    cancel_flag: &Option<Arc<AtomicBool>>,
    loaded: &mut u64,
    total: u64,
) -> Result<(), String> {
    if is_cancelled(cancel_flag) {
        return Err("Canceled".to_string());
    }

    let metadata = std::fs::symlink_metadata(local_path).map_err(|e| e.to_string())?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        ensure_remote_dir(sftp, remote_path)?;
        for entry in std::fs::read_dir(local_path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let child_local = entry.path();
            let child_remote = remote_path.join(entry.file_name());
            upload_local_path(
                sftp,
                app,
                id,
                &child_local,
                &child_remote,
                cancel_flag,
                loaded,
                total,
            )?;
        }
        Ok(())
    } else {
        upload_local_file(sftp, app, id, local_path, remote_path, cancel_flag, loaded, total)
    }
}

fn remote_total_bytes(sftp: &Sftp, path: &Path) -> Result<u64, String> {
    let stat = sftp.stat(path).map_err(|e| e.to_string())?;
    if stat.is_dir() {
        let mut total = 0;
        for (entry_path, _) in sftp.readdir(path).map_err(|e| e.to_string())? {
            let name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            total += remote_total_bytes(sftp, &path.join(name))?;
        }
        Ok(total)
    } else {
        Ok(stat.size.unwrap_or(0))
    }
}

fn download_remote_path(
    sftp: &Sftp,
    app: &AppHandle,
    id: &str,
    remote_path: &Path,
    local_path: &Path,
    loaded: &mut u64,
    total: u64,
) -> Result<(), String> {
    let stat = sftp.stat(remote_path).map_err(|e| e.to_string())?;
    if stat.is_dir() {
        std::fs::create_dir_all(local_path).map_err(|e| e.to_string())?;
        for (entry_path, _) in sftp.readdir(remote_path).map_err(|e| e.to_string())? {
            let name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            let child_remote = remote_path.join(name);
            download_remote_path(
                sftp,
                app,
                id,
                &child_remote,
                &local_path.join(name),
                loaded,
                total,
            )?;
        }
        return Ok(());
    }

    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut remote_file = sftp.open(remote_path).map_err(|e| e.to_string())?;
    let mut local_file = std::fs::File::create(local_path).map_err(|e| e.to_string())?;
    let mut buffer = [0u8; 65536];
    let mut last_emit = std::time::Instant::now();

    loop {
        match remote_file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                local_file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
                *loaded += n as u64;
                if last_emit.elapsed() > std::time::Duration::from_millis(30) {
                    emit_sftp_progress(app, id, *loaded, total, false, None);
                    last_emit = std::time::Instant::now();
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    Ok(())
}

fn copy_local_path(source_path: &Path, target_path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source_path).map_err(|e| e.to_string())?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::create_dir_all(target_path).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(source_path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_local_path(&entry.path(), &target_path.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(source_path, target_path)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn remove_remote_path(sftp: &Sftp, path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path == Path::new("/") {
        return Err("Cannot delete remote root directory".to_string());
    }

    let stat = sftp.lstat(path).or_else(|_| sftp.stat(path)).map_err(|e| e.to_string())?;
    if stat.is_dir() && !stat.file_type().is_symlink() {
        for (entry_path, _) in sftp.readdir(path).map_err(|e| e.to_string())? {
            let name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            remove_remote_path(sftp, &path.join(name))?;
        }
        sftp.rmdir(path).map_err(|e| e.to_string())
    } else {
        sftp.unlink(path).map_err(|e| e.to_string())
    }
}

fn pf_probe_host(bind_address: &str) -> String {
    let address = bind_address.trim();
    if address.is_empty()
        || address == "0.0.0.0"
        || address == "::"
        || address.eq_ignore_ascii_case("localhost")
    {
        "127.0.0.1".to_string()
    } else {
        address.to_string()
    }
}

fn emit_pf_connected_when_ready(
    app: AppHandle,
    id: String,
    bind_address: String,
    bind_port: u16,
    terminal_status_emitted: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let host = pf_probe_host(&bind_address);
        let deadline = std::time::Instant::now() + Duration::from_secs(12);

        while std::time::Instant::now() < deadline {
            if terminal_status_emitted.load(Ordering::SeqCst) {
                return;
            }

            let socket = format!("{host}:{bind_port}");
            if let Ok(mut addrs) = socket.to_socket_addrs() {
                if addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()) {
                    let _ = app.emit("pf-status", SessionStatus {
                        id,
                        status: "connected".to_string(),
                    });
                    return;
                }
            }

            thread::sleep(Duration::from_millis(250));
        }

        if !terminal_status_emitted.load(Ordering::SeqCst) {
            terminal_status_emitted.store(true, Ordering::SeqCst);
            let _ = app.emit("pf-status", SessionStatus {
                id,
                status: "failed".to_string(),
            });
        }
    });
}

// ─── Connection Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub fn list_connections(app: AppHandle) -> Result<Vec<SshConnection>, String> {
    let mut store = read_store(&app)?;
    store
        .connections
        .sort_by(|a, b| b.favorite.cmp(&a.favorite).then(a.name.cmp(&b.name)));
    Ok(store.connections)
}

#[tauri::command]
pub fn create_connection(app: AppHandle, draft: ConnectionDraft) -> Result<SshConnection, String> {
    let mut store = read_store(&app)?;
    let id = format!(
        "conn-{}-{}",
        connection_usecase::unix_time(),
        store.connections.len() + 1
    );
    let connection = connection_usecase::create(draft, id)?;

    store.connections.push(connection.clone());
    write_store(&app, &store)?;
    Ok(connection)
}

#[tauri::command]
pub fn update_connection(
    app: AppHandle,
    id: String,
    draft: ConnectionDraft,
) -> Result<SshConnection, String> {
    let mut store = read_store(&app)?;

    let connection = store
        .connections
        .iter_mut()
        .find(|connection| connection.id == id)
        .ok_or(AppError::NotFound)?;

    connection_usecase::update(connection, draft)?;

    let updated = connection.clone();
    write_store(&app, &store)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_connection(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    let before = store.connections.len();
    store.connections.retain(|connection| connection.id != id);

    if before == store.connections.len() {
        return Err(String::from(AppError::NotFound));
    }

    write_store(&app, &store)?;
    Ok(())
}

#[tauri::command]
pub fn ssh_command(connection: SshConnection) -> Result<String, String> {
    connection_usecase::build_ssh_command(&connection).map_err(String::from)
}

#[tauri::command]
pub fn launch_ssh_session(connection: SshConnection) -> Result<String, String> {
    connection_usecase::build_ssh_command(&connection).map_err(String::from)
}

#[tauri::command]
pub fn start_ssh_session(
    app: AppHandle,
    sessions: State<SessionRegistry>,
    connection: SshConnection,
) -> Result<String, String> {
    ssh_usecase::start_embedded_session(app, &sessions, connection).map_err(String::from)
}

#[tauri::command]
pub fn write_ssh_session(
    sessions: State<SessionRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    let writer = {
        let sessions = sessions.sessions.lock().unwrap();
        sessions
            .get(&id)
            .map(|session| session.writer.clone())
            .ok_or(AppError::SessionNotFound)?
    };

    writer
        .lock()
        .unwrap()
        .write_all(data.as_bytes())
        .map_err(|err| AppError::LaunchSshSession(err.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn stop_ssh_session(sessions: State<SessionRegistry>, id: String) -> Result<(), String> {
    let session = sessions.sessions.lock().unwrap().remove(&id);
    if let Some(session) = session {
        let _ = session.child.lock().unwrap().kill();
    }
    Ok(())
}

#[tauri::command]
pub fn resize_ssh_session(
    sessions: State<SessionRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let master = {
        let sessions = sessions.sessions.lock().unwrap();
        sessions
            .get(&id)
            .map(|session| session.master.clone())
            .ok_or(AppError::SessionNotFound)?
    };

    master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| AppError::LaunchSshSession(err.to_string()))?;
    Ok(())
}

// ─── SFTP Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sftp_connect(
    app_handle: AppHandle,
    connection: SshConnection,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app_handle.state::<SftpRegistry>().inner();
        let password = connection
            .password
            .clone()
            .ok_or_else(|| AppError::Validation("Password wajib diisi".to_string()))?;

        let addr = format!("{}:{}", connection.host, connection.port);
        let mut addrs = std::net::ToSocketAddrs::to_socket_addrs(&addr)
            .map_err(|e| AppError::SftpConnect(e.to_string()))?;
        let socket_addr = addrs.next()
            .ok_or_else(|| AppError::SftpConnect("Invalid host address".to_string()))?;
            
        let tcp = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(5))
            .map_err(|_| AppError::SftpConnect("Koneksi gagal (timeout 5 detik)".to_string()))?;
        tcp.set_read_timeout(Some(Duration::from_secs(20)))
            .map_err(|e| AppError::SftpConnect(e.to_string()))?;
        tcp.set_write_timeout(Some(Duration::from_secs(20)))
            .map_err(|e| AppError::SftpConnect(e.to_string()))?;

        let mut session = Session::new()
            .map_err(|e| AppError::SftpConnect(e.to_string()))?;
        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| AppError::SftpConnect(e.to_string()))?;
        session
            .userauth_password(&connection.username, &password)
            .map_err(|e| AppError::SftpConnect(e.to_string()))?;

        if !session.authenticated() {
            return Err(AppError::SftpConnect(
                "Authentication failed".to_string(),
            ));
        }

        let session_id = format!(
            "sftp-{}-{}",
            connection.id,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );

        registry.sessions.lock().unwrap().insert(
            session_id.clone(),
            SftpSession {
                session: Arc::new(Mutex::new(session)),
            },
        );

        Ok(session_id)
    }).await.map_err(|e| e.to_string())?
    .map_err(String::from)
}

#[tauri::command]
pub fn sftp_list_dir(
    sftp_registry: State<SftpRegistry>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let sessions = sftp_registry.sessions.lock().unwrap();
    let sftp_session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::SftpSessionNotFound)?;

    let session = sftp_session.session.lock().unwrap();
    let sftp = session
        .sftp()
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    let dir_path = std::path::Path::new(&path);
    let entries = sftp
        .readdir(dir_path)
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    let mut result: Vec<SftpEntry> = entries
        .into_iter()
        .filter_map(|(entry_path, stat)| {
            let name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() || name == "." {
                return None;
            }

            let full_path = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };

            let is_dir = stat.is_dir();
            let is_symlink = stat.file_type().is_symlink();
            let size = if is_dir { None } else { Some(stat.size.unwrap_or(0)) };
            let modified = stat.mtime.map(|t| t as u64 * 1000);

            let perms = stat.perm.unwrap_or(0);
            let permissions = sftp_usecase::format_permissions(perms, is_dir);

            Some(SftpEntry {
                name,
                path: full_path,
                size,
                modified,
                is_dir,
                is_symlink,
                permissions,
            })
        })
        .collect();

    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
pub fn sftp_read_file(
    sftp_registry: State<SftpRegistry>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let sessions = sftp_registry.sessions.lock().unwrap();
    let sftp_session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::SftpSessionNotFound)?;

    let session = sftp_session.session.lock().unwrap();
    let sftp = session
        .sftp()
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    let mut file = sftp
        .open(std::path::Path::new(&path))
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    let mut contents = Vec::new();
    file.read_to_end(&mut contents)
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    Ok(general_purpose::STANDARD.encode(&contents))
}

#[tauri::command]
pub fn sftp_write_file(
    sftp_registry: State<SftpRegistry>,
    session_id: String,
    path: String,
    content_b64: String,
) -> Result<(), String> {
    let sessions = sftp_registry.sessions.lock().unwrap();
    let sftp_session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::SftpSessionNotFound)?;

    let session = sftp_session.session.lock().unwrap();
    let sftp = session
        .sftp()
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    let data = general_purpose::STANDARD
        .decode(&content_b64)
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    let mut file = sftp
        .create(std::path::Path::new(&path))
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    file.write_all(&data)
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub async fn sftp_download_remote_files(
    sftp_registry: State<'_, SftpRegistry>,
    app_handle: AppHandle,
    session_id: String,
    remote_files: Vec<LocalFilePayload>,
    local_dir: String,
) -> Result<(), String> {
    let session_arc = {
        let sessions = sftp_registry.sessions.lock().unwrap();
        let sftp_session = sessions
            .get(&session_id)
            .ok_or_else(|| AppError::SftpSessionNotFound)?;
        sftp_session.session.clone()
    };

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let session = match session_arc.lock() {
            Ok(s) => s,
            Err(_) => return Err("Cannot access SFTP session".to_string()),
        };
        let sftp = match session.sftp() {
            Ok(s) => s,
            Err(e) => {
                println!("Gagal membuka sesi SFTP untuk download: {}", e);
                return Err(e.to_string());
            }
        };

        for file_payload in remote_files.into_iter() {
            let remote_path_str = file_payload.path.clone();
            let remote_path = Path::new(&remote_path_str);
            let file_name = remote_path.file_name().unwrap_or_default();
            let file_id = file_payload.id.clone();
            let local_path = Path::new(&local_dir).join(file_name);
            let total = match remote_total_bytes(&sftp, remote_path) {
                Ok(total) => total,
                Err(e) => {
                    emit_sftp_progress(&app_handle, &file_id, 0, 0, true, Some(e));
                    continue;
                }
            };
            let mut loaded = 0;

            match download_remote_path(
                &sftp,
                &app_handle,
                &file_id,
                remote_path,
                &local_path,
                &mut loaded,
                total,
            ) {
                Ok(_) => emit_sftp_progress(&app_handle, &file_id, total, total, true, None),
                Err(e) => {
                    emit_sftp_progress(&app_handle, &file_id, loaded, total, true, Some(e));
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(())
}

#[tauri::command]
pub async fn copy_local_files(
    source_paths: Vec<String>,
    target_dir: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        for source_path_str in source_paths {
            let source_path = Path::new(&source_path_str);
            let file_name = source_path.file_name().unwrap_or_default();
            let target_path = Path::new(&target_dir).join(file_name);
            if source_path.is_dir() && target_path.starts_with(source_path) {
                return Err("Cannot copy a folder into itself".to_string());
            }
            copy_local_path(source_path, &target_path)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub fn sftp_cancel_transfer(
    cancel_registry: State<'_, TransferCancelRegistry>,
    id: String,
) -> Result<(), String> {
    if let Some(flag) = cancel_registry.flags.lock().unwrap().get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload_local_files(
    sftp_registry: State<'_, SftpRegistry>,
    cancel_registry: State<'_, TransferCancelRegistry>,
    app_handle: AppHandle,
    session_id: String,
    remote_dir: String,
    files: Vec<LocalFilePayload>,
) -> Result<(), String> {
    let session_arc = {
        let sessions = sftp_registry.sessions.lock().unwrap();
        let sftp_session = sessions
            .get(&session_id)
            .ok_or_else(|| AppError::SftpSessionNotFound)?;
        sftp_session.session.clone()
    };
    let cancel_flags = cancel_registry.flags.clone();

    {
        let mut flags = cancel_flags.lock().unwrap();
        for file in &files {
            flags.insert(file.id.clone(), Arc::new(AtomicBool::new(false)));
        }
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let session = match session_arc.lock() {
            Ok(s) => s,
            Err(_) => return Err("Cannot access SFTP session".to_string()),
        };
        let sftp = match session.sftp() {
            Ok(s) => s,
            Err(e) => {
                println!("Gagal membuka sesi SFTP untuk upload: {}", e);
                return Err(e.to_string());
            }
        };

        for file_payload in files.into_iter() {
            let path = Path::new(&file_payload.path);
            let file_name = path.file_name().unwrap_or_default().to_string_lossy();
            let total = local_total_bytes(path).unwrap_or(0);
            let file_id = file_payload.id.clone();
            let cancel_flag = cancel_flags.lock().unwrap().get(&file_id).cloned();

            let mut loaded = 0;
            let remote_path = PathBuf::from(join_remote_path(&remote_dir, &file_name));

            match upload_local_path(
                &sftp,
                &app_handle,
                &file_id,
                path,
                &remote_path,
                &cancel_flag,
                &mut loaded,
                total,
            ) {
                Ok(_) => emit_sftp_progress(&app_handle, &file_id, total, total, true, None),
                Err(e) => {
                    emit_sftp_progress(&app_handle, &file_id, loaded, total, true, Some(e));
                }
            }
            cancel_flags.lock().unwrap().remove(&file_id);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(())
}

#[tauri::command]
pub fn sftp_rename(
    sftp_registry: State<SftpRegistry>,
    session_id: String,
    src: String,
    dst: String,
) -> Result<(), String> {
    let sessions = sftp_registry.sessions.lock().unwrap();
    let sftp_session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::SftpSessionNotFound)?;

    let session = sftp_session.session.lock().unwrap();
    let sftp = session
        .sftp()
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    sftp.rename(
        std::path::Path::new(&src),
        std::path::Path::new(&dst),
        None,
    )
    .map_err(|e| AppError::SftpOp(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub fn sftp_remove(
    sftp_registry: State<SftpRegistry>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sessions = sftp_registry.sessions.lock().unwrap();
    let sftp_session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::SftpSessionNotFound)?;

    let session = sftp_session.session.lock().unwrap();
    let sftp = session
        .sftp()
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    sftp.unlink(std::path::Path::new(&path))
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub fn sftp_mkdir(
    sftp_registry: State<SftpRegistry>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sessions = sftp_registry.sessions.lock().unwrap();
    let sftp_session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::SftpSessionNotFound)?;

    let session = sftp_session.session.lock().unwrap();
    let sftp = session
        .sftp()
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    sftp.mkdir(std::path::Path::new(&path), 0o755)
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub fn sftp_rmdir(
    sftp_registry: State<SftpRegistry>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sessions = sftp_registry.sessions.lock().unwrap();
    let sftp_session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::SftpSessionNotFound)?;

    let session = sftp_session.session.lock().unwrap();
    let sftp = session
        .sftp()
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    remove_remote_path(&sftp, Path::new(&path))
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub fn sftp_disconnect(sftp_registry: State<SftpRegistry>, session_id: String) -> Result<(), String> {
    sftp_registry.sessions.lock().unwrap().remove(&session_id);
    Ok(())
}

#[tauri::command]
pub fn sftp_realpath(
    sftp_registry: State<SftpRegistry>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let sessions = sftp_registry.sessions.lock().unwrap();
    let sftp_session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::SftpSessionNotFound)?;

    let session = sftp_session.session.lock().unwrap();
    let sftp = session
        .sftp()
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    let real = sftp
        .realpath(std::path::Path::new(&path))
        .map_err(|e| AppError::SftpOp(e.to_string()))?;

    Ok(real.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_local_dir(path: String) -> Result<Vec<SftpEntry>, String> {
    sftp_usecase::list_local_dir(path)
}

#[tauri::command]
pub fn get_local_home() -> String {
    sftp_usecase::get_local_home()
}

#[tauri::command]
pub fn rename_local_path(src: String, dst: String) -> Result<(), String> {
    std::fs::rename(src, dst).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_local_path(path: String) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

// ─── Port Forwarding Commands ────────────────────────────────────────────────

#[tauri::command]
pub fn list_pf_rules(app: AppHandle) -> Result<Vec<PortForwardingRule>, String> {
    let store = read_store(&app)?;
    Ok(store.port_forwarding_rules)
}

#[tauri::command]
pub fn create_pf_rule(app: AppHandle, draft: PortForwardingDraft) -> Result<PortForwardingRule, String> {
    let mut store = read_store(&app)?;
    let id = format!(
        "pf-{}-{}",
        connection_usecase::unix_time(),
        store.port_forwarding_rules.len() + 1
    );
    let rule = pf_usecase::create(draft, id);
    store.port_forwarding_rules.push(rule.clone());
    write_store(&app, &store)?;
    Ok(rule)
}

#[tauri::command]
pub fn update_pf_rule(app: AppHandle, id: String, draft: PortForwardingDraft) -> Result<PortForwardingRule, String> {
    let mut store = read_store(&app)?;
    let rule = store
        .port_forwarding_rules
        .iter_mut()
        .find(|rule| rule.id == id)
        .ok_or_else(|| String::from("Rule not found"))?;

    pf_usecase::update(rule, draft);

    let updated = rule.clone();
    write_store(&app, &store)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_pf_rule(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.port_forwarding_rules.retain(|r| r.id != id);
    write_store(&app, &store)?;
    Ok(())
}

#[tauri::command]
pub fn start_port_forwarding(
    app: AppHandle,
    pf_registry: State<PfProcessRegistry>,
    rule_id: String,
) -> Result<(), String> {
    let store = read_store(&app)?;
    let rule = store
        .port_forwarding_rules
        .iter()
        .find(|r| r.id == rule_id)
        .ok_or_else(|| String::from("Rule not found"))?
        .clone();

    let connection = store
        .connections
        .iter()
        .find(|c| c.id == rule.host_id)
        .ok_or_else(|| String::from("Host not found"))?
        .clone();

    let bind_port = rule
        .bind_port
        .filter(|port| *port > 0)
        .ok_or_else(|| "Local bind port is required".to_string())?;
    rule.target_port
        .filter(|port| *port > 0)
        .ok_or_else(|| "Destination port is required".to_string())?;
    if rule.target_address.trim().is_empty() {
        return Err("Destination address is required".to_string());
    }

    pf_registry.processes.lock().unwrap().retain(|_, child| {
        child.try_wait().map(|status| status.is_none()).unwrap_or(false)
    });

    let processes = pf_registry.processes.lock().unwrap();
    if let Some(conflict) = store.port_forwarding_rules.iter().find(|candidate| {
        candidate.id != rule_id
            && candidate.bind_port == Some(bind_port)
            && processes.contains_key(&candidate.id)
    }) {
        return Err(format!(
            "Port {bind_port} is already used by {}. Stop it before starting another tunnel on the same port.",
            conflict.name
        ));
    }
    drop(processes);

    if let Some(mut child) = pf_registry.processes.lock().unwrap().remove(&rule_id) {
        let _ = child.kill();
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| err.to_string())?;

    let mut command = CommandBuilder::new("/usr/bin/ssh");
    command.env("TERM", "xterm-256color");
    command.arg("-N");
    command.arg("-o");
    command.arg("StrictHostKeyChecking=accept-new");
    command.arg("-o");
    command.arg("ConnectTimeout=15");
    command.arg("-o");
    command.arg("ExitOnForwardFailure=yes");
    command.arg("-o");
    command.arg("ServerAliveInterval=60");
    command.arg("-o");
    command.arg("ServerAliveCountMax=3");

    let has_password = connection.password.as_deref().map_or(false, |p| !p.is_empty());
    if has_password {
        command.arg("-o");
        command.arg("PreferredAuthentications=password,keyboard-interactive");
        command.arg("-o");
        command.arg("PubkeyAuthentication=no");
        command.arg("-o");
        command.arg("NumberOfPasswordPrompts=1");
    } else {
        command.arg("-o");
        command.arg("PreferredAuthentications=publickey");
        command.arg("-o");
        command.arg("PasswordAuthentication=no");
        command.arg("-o");
        command.arg("BatchMode=yes");
    }

    command.arg("-p");
    command.arg(connection.port.to_string());
    command.arg("-L");
    command.arg(pf_usecase::local_forward_spec(&rule));
    command.arg(format!("{}@{}", connection.username, connection.host));

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| err.to_string())?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));

    pf_registry.processes.lock().unwrap().insert(rule_id.clone(), child);

    let _ = app.emit("pf-status", SessionStatus { id: rule_id.clone(), status: "connecting".to_string() });

    let password = connection.password.clone().unwrap_or_default();
    let read_app = app.clone();
    let read_id = rule_id.clone();
    let terminal_status_emitted = Arc::new(AtomicBool::new(false));
    let bind_address = rule.bind_address.clone();

    if !has_password {
        emit_pf_connected_when_ready(
            app.clone(),
            rule_id.clone(),
            bind_address.clone(),
            bind_port,
            Arc::clone(&terminal_status_emitted),
        );
    }

    thread::spawn(move || {
        let mut password_sent = false;
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
                        || lowered.contains("host key verification failed")
                        || lowered.contains("address already in use")
                        || lowered.contains("could not request")
                        || lowered.contains("forwarding failed")
                        || lowered.contains("remote port forwarding failed")
                    {
                        let _ = read_app.emit("pf-status", SessionStatus {
                            id: read_id.clone(),
                            status: "failed".to_string(),
                        });
                        terminal_status_emitted.store(true, Ordering::SeqCst);
                        break;
                    }

                    if !password_sent
                        && has_password
                        && (lowered.contains("password") || lowered.contains("passcode"))
                    {
                        thread::sleep(Duration::from_millis(80));
                        let mut w = writer.lock().unwrap();
                        let _ = w.write_all(password.as_bytes());
                        let _ = w.write_all(b"\r");
                        drop(w);
                        password_sent = true;
                        
                        emit_pf_connected_when_ready(
                            read_app.clone(),
                            read_id.clone(),
                            bind_address.clone(),
                            bind_port,
                            Arc::clone(&terminal_status_emitted),
                        );
                    }
                }
                Err(_) => break,
            }
        }
        if !terminal_status_emitted.load(Ordering::SeqCst) {
            let _ = read_app.emit("pf-status", SessionStatus { id: read_id, status: "closed".to_string() });
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_port_forwarding(pf_registry: State<PfProcessRegistry>, rule_id: String) -> Result<(), String> {
    if let Some(mut child) = pf_registry.processes.lock().unwrap().remove(&rule_id) {
        let _ = child.kill();
    }
    Ok(())
}
