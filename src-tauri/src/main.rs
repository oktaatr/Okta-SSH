pub mod domain;
pub mod infrastructure;
pub mod interfaces;
pub mod usecases;

use crate::infrastructure::pty_process::{PfProcessRegistry, SessionRegistry};
use crate::infrastructure::ssh2_client::SftpRegistry;
use crate::interfaces::handlers::TransferCancelRegistry;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionRegistry::default())
        .manage(SftpRegistry::default())
        .manage(PfProcessRegistry::default())
        .manage(TransferCancelRegistry::default())
        .invoke_handler(tauri::generate_handler![
            interfaces::handlers::list_connections,
            interfaces::handlers::create_connection,
            interfaces::handlers::update_connection,
            interfaces::handlers::delete_connection,
            interfaces::handlers::ssh_command,
            interfaces::handlers::launch_ssh_session,
            interfaces::handlers::start_ssh_session,
            interfaces::handlers::write_ssh_session,
            interfaces::handlers::stop_ssh_session,
            interfaces::handlers::resize_ssh_session,
            interfaces::handlers::sftp_connect,
            interfaces::handlers::sftp_list_dir,
            interfaces::handlers::sftp_read_file,
            interfaces::handlers::sftp_write_file,
            interfaces::handlers::sftp_upload_local_files,
            interfaces::handlers::sftp_cancel_transfer,
            interfaces::handlers::sftp_download_remote_files,
            interfaces::handlers::copy_local_files,
            interfaces::handlers::sftp_rename,
            interfaces::handlers::sftp_remove,
            interfaces::handlers::sftp_mkdir,
            interfaces::handlers::sftp_rmdir,
            interfaces::handlers::sftp_disconnect,
            interfaces::handlers::sftp_realpath,
            interfaces::handlers::list_local_dir,
            interfaces::handlers::get_local_home,
            interfaces::handlers::rename_local_path,
            interfaces::handlers::delete_local_path,
            interfaces::handlers::list_pf_rules,
            interfaces::handlers::create_pf_rule,
            interfaces::handlers::update_pf_rule,
            interfaces::handlers::delete_pf_rule,
            interfaces::handlers::start_port_forwarding,
            interfaces::handlers::stop_port_forwarding,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Okta SSHManage");
}

fn main() {
    run();
}
