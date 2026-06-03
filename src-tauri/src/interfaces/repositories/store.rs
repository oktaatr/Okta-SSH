use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

use crate::domain::errors::AppError;
use crate::domain::models::ConnectionStore;

pub fn read_store(app: &AppHandle) -> Result<ConnectionStore, AppError> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(ConnectionStore::default());
    }

    let contents = fs::read_to_string(&path).map_err(|err| AppError::ReadStore(err.to_string()))?;
    serde_json::from_str(&contents).map_err(|err| AppError::Json(err.to_string()))
}

pub fn write_store(app: &AppHandle, store: &ConnectionStore) -> Result<(), AppError> {
    let path = store_path(app)?;
    let contents =
        serde_json::to_string_pretty(store).map_err(|err| AppError::Json(err.to_string()))?;
    fs::write(path, contents).map_err(|err| AppError::WriteStore(err.to_string()))
}

fn store_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::AppDataDir)?;
    fs::create_dir_all(&data_dir)?;
    Ok(data_dir.join("connections.json"))
}
