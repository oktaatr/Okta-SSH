use portable_pty::Child;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};

pub struct TerminalSession {
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
}

#[derive(Default)]
pub struct SessionRegistry {
    pub sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Default)]
pub struct PfProcessRegistry {
    pub processes: Mutex<HashMap<String, Box<dyn Child + Send + Sync>>>,
}
