use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::errors::AppError;
use crate::domain::models::{ConnectionDraft, SshConnection};

pub fn create(draft: ConnectionDraft, id: String) -> Result<SshConnection, AppError> {
    validate_draft(&draft)?;

    let now = unix_time();
    let connection = SshConnection {
        id,
        name: clean_text(draft.name),
        host: clean_text(draft.host),
        port: draft.port,
        username: clean_text(draft.username),
        password: clean_optional(draft.password),
        tags: clean_tags(draft.tags),
        favorite: draft.favorite,
        notes: clean_optional(draft.notes),
        created_at: now,
        updated_at: now,
    };

    Ok(connection)
}

pub fn update(
    connection: &mut SshConnection,
    draft: ConnectionDraft,
) -> Result<(), AppError> {
    validate_draft(&draft)?;
    let now = unix_time();

    connection.name = clean_text(draft.name);
    connection.host = clean_text(draft.host);
    connection.port = draft.port;
    connection.username = clean_text(draft.username);
    connection.password = clean_optional(draft.password);
    connection.tags = clean_tags(draft.tags);
    connection.favorite = draft.favorite;
    connection.notes = clean_optional(draft.notes);
    connection.updated_at = now;

    Ok(())
}

pub fn build_ssh_command(connection: &SshConnection) -> Result<String, AppError> {
    validate_connection(connection)?;

    let mut command = vec![
        "ssh".to_string(),
        "-o".to_string(),
        "PreferredAuthentications=password".to_string(),
        "-o".to_string(),
        "PubkeyAuthentication=no".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
        "-p".to_string(),
        connection.port.to_string(),
    ];
    command.push(format!(
        "{}@{}",
        shell_quote(&connection.username),
        shell_quote(&connection.host)
    ));

    Ok(command.join(" "))
}

pub fn validate_draft(draft: &ConnectionDraft) -> Result<(), AppError> {
    if draft.name.trim().is_empty() {
        return Err(AppError::Validation("Nama koneksi wajib diisi".to_string()));
    }
    if draft.host.trim().is_empty() {
        return Err(AppError::Validation("Host wajib diisi".to_string()));
    }
    if draft.username.trim().is_empty() {
        return Err(AppError::Validation("Username wajib diisi".to_string()));
    }
    if draft.port == 0 {
        return Err(AppError::Validation("Port harus lebih dari 0".to_string()));
    }
    if clean_optional(draft.password.clone()).is_none() {
        return Err(AppError::Validation("Password wajib diisi".to_string()));
    }

    Ok(())
}

pub fn validate_connection(connection: &SshConnection) -> Result<(), AppError> {
    validate_draft(&ConnectionDraft {
        name: connection.name.clone(),
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone(),
        password: connection.password.clone(),
        tags: connection.tags.clone(),
        favorite: connection.favorite,
        notes: connection.notes.clone(),
    })
}

pub fn clean_text(value: String) -> String {
    value.trim().to_string()
}

pub fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|inner| inner.trim().to_string())
        .filter(|inner| !inner.is_empty())
}

pub fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut cleaned = tags
        .into_iter()
        .map(clean_text)
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    cleaned.sort();
    cleaned.dedup();
    cleaned
}

pub fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "@%_+=:,./-".contains(character))
    {
        return value.to_string();
    }

    format!("'{}'", value.replace('\'', "'\\''"))
}
