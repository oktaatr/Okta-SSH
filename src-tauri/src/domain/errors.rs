use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Gagal membaca direktori data aplikasi")]
    AppDataDir,
    #[error("Gagal membuat direktori data: {0}")]
    CreateDataDir(#[from] std::io::Error),
    #[error("Gagal membaca data koneksi: {0}")]
    ReadStore(String),
    #[error("Gagal menulis data koneksi: {0}")]
    WriteStore(String),
    #[error("Gagal memproses data koneksi: {0}")]
    Json(String),
    #[error("{0}")]
    Validation(String),
    #[error("Koneksi tidak ditemukan")]
    NotFound,
    #[error("Gagal membuka sesi SSH: {0}")]
    LaunchSshSession(String),
    #[error("Sesi SSH tidak ditemukan")]
    SessionNotFound,
    #[error("Gagal membuat koneksi SFTP: {0}")]
    SftpConnect(String),
    #[error("Sesi SFTP tidak ditemukan")]
    SftpSessionNotFound,
    #[error("Operasi SFTP gagal: {0}")]
    SftpOp(String),
}

impl From<AppError> for String {
    fn from(value: AppError) -> Self {
        value.to_string()
    }
}
