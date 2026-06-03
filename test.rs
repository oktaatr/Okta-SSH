use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpEntry {
    is_dir: bool,
}
fn main() {
    let e = SftpEntry { is_dir: true };
    println!("{}", serde_json::to_string(&e).unwrap());
}
