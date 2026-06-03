use ouroboros::self_referencing;
use ssh2::Session;

#[self_referencing]
pub struct SftpConnection {
    session: Session,
    #[borrows(session)]
    #[covariant]
    sftp: ssh2::Sftp<'this>,
}
fn main() {}
