use crate::domain::models::SftpEntry;
use std::time::UNIX_EPOCH;

pub fn format_permissions(mode: u32, is_dir: bool) -> String {
    let kind = if is_dir { 'd' } else { '-' };
    let chars: Vec<char> = [
        (mode & 0o400 != 0, 'r'),
        (mode & 0o200 != 0, 'w'),
        (mode & 0o100 != 0, 'x'),
        (mode & 0o040 != 0, 'r'),
        (mode & 0o020 != 0, 'w'),
        (mode & 0o010 != 0, 'x'),
        (mode & 0o004 != 0, 'r'),
        (mode & 0o002 != 0, 'w'),
        (mode & 0o001 != 0, 'x'),
    ]
    .iter()
    .map(|(set, ch)| if *set { *ch } else { '-' })
    .collect();
    format!("{}{}", kind, chars.iter().collect::<String>())
}

pub fn list_local_dir(path: String) -> Result<Vec<SftpEntry>, String> {
    let dir_path = std::path::Path::new(&path);
    let entries = std::fs::read_dir(dir_path)
        .map_err(|e| format!("Cannot read directory: {}", e))?;

    let mut result: Vec<SftpEntry> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let meta = entry.metadata().ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { return None; }
            let full_path = entry.path().to_string_lossy().to_string();
            let is_dir = meta.is_dir();
            let is_symlink = meta.file_type().is_symlink();
            let size = if is_dir { None } else { Some(meta.len()) };
            let modified = meta.modified().ok().and_then(|t| {
                t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
            });
            Some(SftpEntry {
                name,
                path: full_path,
                size,
                modified,
                is_dir,
                is_symlink,
                permissions: String::new(),
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

pub fn get_local_home() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| String::from("/"))
}
