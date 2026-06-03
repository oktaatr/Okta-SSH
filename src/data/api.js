import { invoke } from "@tauri-apps/api/core";

export const isTauri = Boolean(window.__TAURI_INTERNALS__);

export async function api(command, payload = {}) {
  if (isTauri) return invoke(command, payload);
  return browserPreviewApi(command, payload);
}

export function shellQuote(value) {
  return /^[a-zA-Z0-9@%_+=:,./-]+$/.test(value)
    ? value
    : `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function readableError(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

async function browserPreviewApi(command, payload) {
  const key = "okta-sshmanage.preview.connections";
  const read = () => JSON.parse(localStorage.getItem(key) || "[]");
  const write = (connections) => localStorage.setItem(key, JSON.stringify(connections));

  if (command === "list_connections") return read();
  if (command === "create_connection") {
    const now = Date.now();
    const connection = {
      ...payload.draft,
      id: `preview-${now}`,
      notes: payload.draft.notes || null,
      createdAt: now,
      updatedAt: now,
    };
    write([...read(), connection]);
    return connection;
  }
  if (command === "update_connection") {
    const now = Date.now();
    const connections = read();
    const updated = connections.map((connection) =>
      connection.id === payload.id
        ? { ...connection, ...payload.draft, notes: payload.draft.notes || null, updatedAt: now }
        : connection,
    );
    write(updated);
    return updated.find((connection) => connection.id === payload.id);
  }
  if (command === "delete_connection") {
    write(read().filter((connection) => connection.id !== payload.id));
    return null;
  }
  if (command === "ssh_command") return previewSshCommand(payload.connection);
  if (command === "launch_ssh_session") return previewSshCommand(payload.connection);
  if (command === "start_ssh_session") return payload.connection.id;
  if (command === "write_ssh_session") return null;
  if (command === "stop_ssh_session") return null;

  if (command === "sftp_connect") return `sftp-preview-${Date.now()}`;
  if (command === "sftp_list_dir") {
    return [
      { name: "etc", path: "/etc", isDir: true, isSymlink: false, size: null, modified: Date.now() - 3600000, permissions: "drwxr-xr-x" },
      { name: "home", path: "/home", isDir: true, isSymlink: false, size: null, modified: Date.now() - 86400000, permissions: "drwxr-xr-x" },
      { name: "README.md", path: "/README.md", isDir: false, isSymlink: false, size: 4096, modified: Date.now() - 172800000, permissions: "-rw-r--r--" },
    ];
  }
  if (command === "sftp_read_file") return btoa("File content preview");
  if (command === "sftp_write_file") return null;
  if (command === "sftp_rename") return null;
  if (command === "sftp_remove") return null;
  if (command === "sftp_mkdir") return null;
  if (command === "sftp_rmdir") return null;
  if (command === "sftp_disconnect") return null;
  if (command === "sftp_realpath") return payload.path || "/";
  if (command === "sftp_upload_local_files") return null;
  if (command === "sftp_download_remote_files") return null;
  if (command === "sftp_cancel_transfer") return null;
  if (command === "copy_local_files") return null;
  if (command === "rename_local_path") return null;
  if (command === "delete_local_path") return null;

  const pfKey = "okta-sshmanage.preview.pfRules";
  const readPf = () => JSON.parse(localStorage.getItem(pfKey) || "[]");
  const writePf = (rules) => localStorage.setItem(pfKey, JSON.stringify(rules));

  if (command === "list_pf_rules") return readPf();
  if (command === "create_pf_rule") {
    const now = Date.now();
    const rule = { ...payload.draft, id: `pf-${now}`, createdAt: now, updatedAt: now };
    writePf([...readPf(), rule]);
    return rule;
  }
  if (command === "update_pf_rule") {
    const now = Date.now();
    const updated = readPf().map((rule) =>
      rule.id === payload.id ? { ...rule, ...payload.draft, id: payload.id, updatedAt: now } : rule,
    );
    writePf(updated);
    return updated.find((rule) => rule.id === payload.id);
  }
  if (command === "delete_pf_rule") {
    writePf(readPf().filter((r) => r.id !== payload.id));
    return null;
  }
  if (command === "start_port_forwarding") return null;
  if (command === "stop_port_forwarding") return null;

  return null;
}

function previewSshCommand(connection) {
  return [
    "ssh", "-o", "PreferredAuthentications=password",
    "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1",
    "-p", connection.port,
    `${shellQuote(connection.username)}@${shellQuote(connection.host)}`,
  ].join(" ");
}
