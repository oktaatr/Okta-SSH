use ssh2::Session;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct SftpSession {
    pub session: Arc<Mutex<Session>>,
}

#[derive(Default)]
pub struct SftpRegistry {
    pub sessions: Mutex<HashMap<String, SftpSession>>,
}
