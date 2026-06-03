import { api, isTauri, readableError } from '../../data/api.js';
import { EMPTY_DRAFT } from '../../domain/entities.js';
import { runWithoutStateUpdates, state } from '../models/AppState.js';
import { disposeTerminal, focusActiveTerminal, render } from '../views/AppView.js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';

// ─── Data Helpers ─────────────────────────────────────────────────────────────

export async function loadConnections() {
  try {
    const [connections, pfRules] = await Promise.all([
      api("list_connections"),
      api("list_pf_rules").catch(() => []),
    ]);
    state.connections = connections;
    state.pfRules = (pfRules || []).map(normalizePfRule);
    state.openedTabs = state.openedTabs.filter((tab) => findHost(tab.hostId));
    if (state.selectedId && !findHost(state.selectedId)) state.selectedId = null;
    if (
      state.selectedHostGroup &&
      !state.connections.some((host) => hostGroupName(host) === state.selectedHostGroup)
    ) {
      state.selectedHostGroup = "";
    }
    if (state.activeTabId && !findTab(state.activeTabId)) {
      state.activeTabId = state.openedTabs.at(-1)?.id || null;
      state.activeView = state.activeTabId
        ? findTab(state.activeTabId)?.type === "new-tab" ? "new-tab" : "host"
        : "home";
    }
  } catch (error) {
    state.error = readableError(error);
  }
  render();
}

export function findHost(id) {
  return state.connections.find((h) => h.id === id) || null;
}

export function findTab(id) {
  return state.openedTabs.find((t) => t.id === id) || null;
}

export function activeTab() {
  return findTab(state.activeTabId);
}

export function selectedHost() {
  return findHost(state.selectedId);
}

export function filteredHosts() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.connections;
  return state.connections.filter((h) =>
    [h.name, h.host, h.username, h.group, ...(h.tags || [])].join(" ").toLowerCase().includes(q),
  );
}

export function hostGroupName(host) {
  return String(host?.group || "").trim();
}

export function hostGroups(hosts = state.connections) {
  const groupsByName = new Map();
  hosts.forEach((host) => {
    const name = hostGroupName(host);
    if (!name) return;
    const group = groupsByName.get(name);
    if (group) group.hosts.push(host);
    else groupsByName.set(name, { name, hosts: [host] });
  });
  return Array.from(groupsByName.values())
    .map((group) => ({
      ...group,
      hosts: group.hosts.slice().sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function ungroupedHosts(hosts = state.connections) {
  return hosts.filter((host) => !hostGroupName(host));
}

export function openHostGroup(groupName) {
  const normalized = String(groupName || "").trim();
  if (!normalized) return;
  runWithoutStateUpdates(() => {
    state.selectedHostGroup = normalized;
    state.selectedId = null;
    state.error = "";
  });
  render();
}

export function openAllHostGroups() {
  runWithoutStateUpdates(() => {
    state.selectedHostGroup = "";
    state.error = "";
  });
  render();
}

export function filteredNewTabHosts() {
  const q = state.newTabQuery.trim().toLowerCase();
  if (!q) return state.connections;
  return state.connections.filter((h) =>
    [h.name, h.host, h.username, ...(h.tags || [])].join(" ").toLowerCase().includes(q),
  );
}

export function filteredSftpHosts() {
  const q = state.sftpSelectQuery.trim().toLowerCase();
  if (!q) return state.connections;
  return state.connections.filter((h) =>
    [h.name, h.host, h.username, ...(h.tags || [])].join(" ").toLowerCase().includes(q),
  );
}

export function filteredPfRules() {
  const q = state.pfQuery.trim().toLowerCase();
  if (!q) return state.pfRules;
  return state.pfRules.filter((rule) => {
    const host = findHost(rule.host_id);
    return [
      rule.name,
      rule.rule_type,
      rule.tags,
      rule.group,
      rule.bind_address,
      rule.bind_port,
      rule.target_address,
      rule.target_port,
      host?.name,
      host?.host,
      host?.username,
    ].join(" ").toLowerCase().includes(q);
  });
}

export function normalizePfRule(rule) {
  return {
    ...rule,
    rule_type: "Local",
    tags: Array.isArray(rule.tags) ? rule.tags : String(rule.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
    group: rule.group ?? "",
    host_id: rule.host_id ?? rule.hostId ?? "",
    bind_address: rule.bind_address ?? rule.bindAddress ?? "",
    bind_port: rule.bind_port ?? rule.bindPort ?? "",
    target_address: rule.target_address ?? rule.targetAddress ?? "",
    target_port: rule.target_port ?? rule.targetPort ?? "",
    created_at: rule.created_at ?? rule.createdAt,
    updated_at: rule.updated_at ?? rule.updatedAt,
  };
}

export function pfDraftPayload(draft) {
  return {
    name: draft.name,
    tags: String(draft.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
    group: draft.group || "",
    ruleType: draft.rule_type,
    hostId: draft.host_id,
    bindAddress: draft.bind_address,
    bindPort: draft.bind_port || null,
    targetAddress: draft.target_address,
    targetPort: draft.target_port || null,
  };
}

export function pfDraftFromRule(rule) {
  const normalized = normalizePfRule(rule);
  return {
    name: normalized.name || "",
    tags: (normalized.tags || []).join(", "),
    group: normalized.group || "",
    rule_type: normalized.rule_type || "Local",
    host_id: normalized.host_id || "",
    bind_address: normalized.bind_address || "",
    bind_port: normalized.bind_port || "",
    target_address: normalized.target_address || "localhost",
    target_port: normalized.target_port || "",
  };
}

export function activePfPortOwner(rule) {
  if (!rule?.bind_port) return null;
  return state.pfRules.find((candidate) => {
    if (candidate.id === rule.id || candidate.bind_port !== rule.bind_port) return false;
    const status = state.pfStatusById[candidate.id] || "closed";
    return status === "connected" || status === "connecting";
  }) || null;
}

export function createHostTab(host) {
  const maxDuplicateIndex = state.openedTabs
    .filter((tab) => tab.hostId === host.id)
    .reduce((max, tab) => Math.max(max, tab.duplicateIndex ?? 0), -1);
  const duplicateIndex = maxDuplicateIndex + 1;
  return {
    id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hostId: host.id,
    label: duplicateIndex === 0 ? host.name : `${host.name} (${duplicateIndex})`,
    duplicateIndex,
  };
}

// ─── Navigation ───────────────────────────────────────────────────────────────

export function openHome() {
  runWithoutStateUpdates(() => {
    state.activeView = "home";
    state.activeTabId = null;
    state.selectedHostGroup = "";
    state.modalOpen = false;
    state.modalMode = "new";
    state.draft = { ...EMPTY_DRAFT };
    state.notice = "";
    state.error = "";
  });
  render();
}

export function openSftpView() {
  runWithoutStateUpdates(() => {
    state.activeView = "sftp";
    state.activeTabId = null;
    state.modalOpen = false;
    state.modalMode = "new";
    state.draft = { ...EMPTY_DRAFT };
    state.notice = "";
    state.error = "";
  });
  if (state.sftpLeft.type === "local" && !state.sftpLeft.path) {
    sftpInitLocalPanel("left");
  } else {
    render();
  }
}

export function openNewTab() {
  const tab = {
    id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "new-tab",
    label: "New Tab",
  };
  runWithoutStateUpdates(() => {
    state.openedTabs.push(tab);
    state.activeTabId = tab.id;
    state.activeView = "new-tab";
    state.modalOpen = false;
    state.modalMode = "new";
    state.draft = { ...EMPTY_DRAFT };
    state.notice = "";
    state.error = "";
  });
  render();
  focusNewTabSearchInput();
}

export function openNewHostModal() {
  runWithoutStateUpdates(() => {
    state.modalMode = "new";
    state.draft = { ...EMPTY_DRAFT };
    state.error = "";
    state.modalOpen = true;
  });
  render();
}

export function openEditHostModal(id) {
  const host = findHost(id);
  if (!host) return;
  runWithoutStateUpdates(() => {
    state.selectedId = host.id;
    state.modalMode = "edit";
    state.error = "";
    state.draft = {
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      password: host.password || "",
      tags: (host.tags || []).join(", "),
      group: host.group || "",
      favorite: host.favorite || false,
      notes: host.notes || "",
    };
    state.modalOpen = true;
  });
  render();
}

export function closeHostModal() {
  runWithoutStateUpdates(() => {
    state.modalOpen = false;
    state.modalMode = "new";
    state.draft = { ...EMPTY_DRAFT };
    state.error = "";
  });
  render();
}

// ─── SFTP Dual-Panel Logic ────────────────────────────────────────────────────

export function getPanel(side) {
  return side === "left" ? state.sftpLeft : state.sftpRight;
}

// Initialize left panel with local filesystem on first open
export async function sftpInitLocalPanel(side) {
  const panel = getPanel(side);
  panel.type = "local";
  panel.loading = true;
  panel.error = "";
  render();
  try {
    const homePath = await api("get_local_home");
    panel.path = homePath;
    panel.history = [homePath];
    panel.historyIndex = 0;
    const files = await api("list_local_dir", { path: homePath });
    panel.files = files;
    panel.selectedFile = null;
  } catch (e) {
    panel.error = readableError(e);
  }
  panel.loading = false;
  render();
}

export async function sftpLoadPanelDir(side, path) {
  const panel = getPanel(side);
  panel.loading = true;
  panel.error = "";
  render();
  try {
    let files;
    if (panel.type === "local") {
      files = await api("list_local_dir", { path }); console.log("LOCAL FILES:", JSON.stringify(files));
    } else {
      files = await api("sftp_list_dir", { sessionId: panel.sessionId, path });
    }
    panel.files = files;
    panel.path = path;
    panel.selectedFile = null;
    panel.connecting = false;
    panel.connectingHost = null;
  } catch (e) {
    panel.error = readableError(e);
    panel.connecting = false;
    panel.connectingHost = null;
  }
  panel.loading = false;
  render();
}

export async function sftpPanelConnectToHost(side, connection) {
  const panel = getPanel(side);
  panel.connecting = true;
  panel.connectingHost = connection;
  panel.error = "";
  panel.hostSelectorOpen = false;
  render();
  try {
    if (panel.sessionId) {
      await api("sftp_disconnect", { sessionId: panel.sessionId }).catch(() => {});
    }
    const sessionId = await api("sftp_connect", { connection });
    const homePath = await api("sftp_realpath", { sessionId, path: "." });
    panel.type = "sftp";
    panel.sessionId = sessionId;
    panel.connection = connection;
    panel.path = homePath || "/";
    panel.history = [panel.path];
    panel.historyIndex = 0;
    panel.selectedFile = null;
    await sftpLoadPanelDir(side, panel.path);
  } catch (e) {
    // Leave connecting=true and connectingHost so the overlay stays open to display the error
    panel.error = readableError(e);
    panel.loading = false;
    render();
    
    // Automatically revert to host selector after showing error for 2.5 seconds
    setTimeout(() => {
      // Only revert if we are still showing the error for this connection
      if (panel.connecting && panel.error) {
        panel.connecting = false;
        panel.connectingHost = null;
        panel.error = "";
        panel.hostSelectorOpen = true;
        render();
      }
    }, 2500);
  }
}

export async function sftpPanelSwitchToLocal(side) {
  const panel = getPanel(side);
  if (panel.sessionId) {
    await api("sftp_disconnect", { sessionId: panel.sessionId }).catch(() => {});
  }
  panel.type = "local";
  panel.sessionId = null;
  panel.connection = null;
  panel.hostSelectorOpen = false;
  await sftpInitLocalPanel(side);
}

export async function sftpPanelNavigateTo(side, path) {
  const panel = getPanel(side);
  panel.history = panel.history.slice(0, panel.historyIndex + 1);
  panel.history.push(path);
  panel.historyIndex = panel.history.length - 1;
  await sftpLoadPanelDir(side, path);
}

export async function sftpPanelNavigateBack(side) {
  const panel = getPanel(side);
  if (panel.historyIndex <= 0) return;
  panel.historyIndex -= 1;
  await sftpLoadPanelDir(side, panel.history[panel.historyIndex]);
}

export async function sftpPanelNavigateForward(side) {
  const panel = getPanel(side);
  if (panel.historyIndex >= panel.history.length - 1) return;
  panel.historyIndex += 1;
  await sftpLoadPanelDir(side, panel.history[panel.historyIndex]);
}

export async function sftpPanelNavigateUp(side) {
  const panel = getPanel(side);
  const current = panel.path;
  if (current === "/" || !current) return;
  const parent = current.replace(/\/[^/]+\/?$/, "") || "/";
  await sftpPanelNavigateTo(side, parent);
}

export async function sftpPanelReload(side) {
  const panel = getPanel(side);
  if (panel.loading) return;
  await sftpLoadPanelDir(side, panel.path);
}

export async function sftpPanelDeleteSelected(side) {
  const panel = getPanel(side);
  const file = panel.selectedFile;
  if (!file) return;
  panel.deleteOpen = false;
  try {
    if (panel.type === "local") {
      await api("delete_local_path", { path: file.path });
    } else if (file.isDir) {
      await api("sftp_rmdir", { sessionId: panel.sessionId, path: file.path });
    } else {
      await api("sftp_remove", { sessionId: panel.sessionId, path: file.path });
    }
    panel.selectedFile = null;
    await sftpLoadPanelDir(side, panel.path);
  } catch (e) {
    panel.error = readableError(e);
    render();
  }
}

export async function sftpPanelConfirmRename(side) {
  const panel = getPanel(side);
  const file = panel.selectedFile;
  const newName = panel.renameValue.trim();
  if (!file || !newName) return;
  const dir = panel.path.endsWith("/") ? panel.path : panel.path + "/";
  const dst = dir + newName;
  try {
    if (panel.type === "local") {
      await api("rename_local_path", { src: file.path, dst });
    } else {
      await api("sftp_rename", { sessionId: panel.sessionId, src: file.path, dst });
    }
    panel.renameOpen = false;
    panel.renameValue = "";
    await sftpLoadPanelDir(side, panel.path);
  } catch (e) {
    panel.error = readableError(e);
    render();
  }
}

export async function sftpPanelConfirmMkdir(side) {
  const panel = getPanel(side);
  const name = panel.mkdirValue.trim();
  if (!name || panel.type !== "sftp") return;
  const dir = panel.path.endsWith("/") ? panel.path : panel.path + "/";
  const newPath = dir + name;
  try {
    await api("sftp_mkdir", { sessionId: panel.sessionId, path: newPath });
    panel.mkdirOpen = false;
    panel.mkdirValue = "";
    await sftpLoadPanelDir(side, panel.path);
  } catch (e) {
    panel.error = readableError(e);
    render();
  }
}

export async function sftpPanelDownloadSelected(side) {
  const panel = getPanel(side);
  const file = panel.selectedFile;
  if (!file || file.isDir || panel.type !== "sftp") return;
  try {
    const b64 = await api("sftp_read_file", { sessionId: panel.sessionId, path: file.path });
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    panel.error = readableError(e);
    render();
  }
}

// ─── Native Upload ──────────────────────────────────────────────────────────
export function ensureSftpProgressListener() {
  if (!window.__sftpProgressListener) {
    window.__sftpProgressListener = true;
    listen("sftp-upload-progress", (event) => {
      const { id, loaded, total, done, error } = event.payload;
      const entry = state.sftpUploadQueue.find(e => e.id === id);
      if (!entry) return;
      runWithoutStateUpdates(() => {
        entry.loaded = loaded;
        entry.size = total;
        entry.done = done;
        if (error) entry.error = error;
      });
      const pct = total > 0 ? Math.round((loaded / total) * 100) : 100;
      const barEl = document.querySelector(`.sftp-upload-bar[data-upload-id="${id}"]`);
      if (barEl) { barEl.style.width = pct + "%"; if (error) barEl.style.background = "#e74c3c"; }
      const pctEl = document.querySelector(`.sftp-upload-item[data-upload-id="${id}"] .sftp-upload-pct`);
      if (pctEl) pctEl.textContent = error === "Canceled" ? "Canceled" : error ? "Failed" : (done ? "Done" : pct + "%");
      if (done) {
        const itemEl = document.querySelector(`.sftp-upload-item[data-upload-id="${id}"]`);
        const statusClass = error ? "error" : "done";
        if (itemEl) { itemEl.classList.remove("uploading"); itemEl.classList.add(statusClass); }
        itemEl?.querySelector(".sftp-upload-cancel")?.remove();
        if (barEl) { barEl.classList.remove("uploading"); barEl.classList.add(statusClass); }
        const headerEl = document.querySelector(".sftp-upload-panel-header span");
        if (headerEl) {
          const totalQ = state.sftpUploadQueue.length;
          const doneQ = state.sftpUploadQueue.filter(f => f.done).length;
          const isDownloadOnly = state.sftpUploadQueue.every(item => item.type === "download");
          const actionLabel = isDownloadOnly ? "Download" : "Transfer";
          headerEl.textContent = (doneQ === totalQ)
            ? `${actionLabel} complete`
            : `Transferring ${doneQ}/${totalQ} items…`;
        }
        const allDone = state.sftpUploadQueue.every(e => e.done);
        if (allDone) {
          render();
          window.setTimeout(() => {
            state.sftpUploadQueue = [];
            render();
          }, 2000);
        }
      }
    });
  }
}

export async function sftpTriggerUpload(side) {
  const panel = getPanel(side);
  if (panel.type !== "sftp" || !panel.sessionId) {
    panel.error = "Upload requires an active SFTP connection.";
    render();
    return;
  }
  try {
    const selectedFiles = await openDialog({ multiple: true, directory: false });
    if (!selectedFiles || selectedFiles.length === 0) return;

    ensureSftpProgressListener();

    const extractName = (path) => path.split(/[\\/]/).pop();

    const newUploads = selectedFiles.map((path) => ({
      id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
      path: path,
      name: extractName(path),
      size: 0, // Rust will send the correct size
      loaded: 0,
      done: false,
      error: null,
      type: "upload",
    }));
    
    state.sftpUploadQueue.push(...newUploads);
    state.sftpActionsOpen = false;
    render();

    const dir = panel.path.endsWith("/") ? panel.path : panel.path + "/";
    await api("sftp_upload_local_files", {
      sessionId: panel.sessionId,
      remoteDir: dir,
      files: newUploads.map(u => ({ path: u.path, id: u.id })),
    });
    
    await sftpPanelReload(side);
  } catch (err) {
    panel.error = readableError(err);
    render();
  }
}

// ─── SSH Session Logic ────────────────────────────────────────────────────────

export async function saveHost(event) {
  event.preventDefault();
  state.error = "";

  const draft = {
    name: state.draft.name.trim(),
    host: state.draft.host.trim(),
    port: Number(state.draft.port || 22),
    username: state.draft.username.trim(),
    password: state.draft.password,
    tags: state.draft.tags.split(",").map((t) => t.trim()).filter(Boolean),
    group: state.draft.group.trim(),
    favorite: false,
    notes: null,
  };

  try {
    const saved =
      state.modalMode === "edit" && state.selectedId
        ? await api("update_connection", { id: state.selectedId, draft })
        : await api("create_connection", { draft });
    const shouldConnect = state.modalMode === "new";
    state.modalOpen = false;
    state.modalMode = "new";
    state.draft = { ...EMPTY_DRAFT };
    state.query = "";
    state.selectedId = saved.id;
    state.notice = shouldConnect ? `Opening ${saved.name}...` : "Host updated";
    await loadConnections();
    if (shouldConnect) await connectHostById(saved.id);
  } catch (error) {
    state.error = readableError(error);
    render();
  }
}

export async function deleteSelectedHost() {
  const host = selectedHost();
  if (!host) return;

  try {
    await api("delete_connection", { id: host.id });
    const removedTabs = state.openedTabs.filter((tab) => tab.hostId === host.id);
    state.openedTabs = state.openedTabs.filter((tab) => tab.hostId !== host.id);
    removedTabs.forEach((tab) => {
      delete state.sessionStatusById[tab.id];
      delete state.terminalOutputById[tab.id];
      disposeTerminal(tab.id);
      api("stop_ssh_session", { id: tab.id }).catch(() => {});
    });
    if (removedTabs.some((tab) => tab.id === state.activeTabId)) {
      state.activeTabId = state.openedTabs.at(-1)?.id || null;
      state.activeView = state.activeTabId
        ? findTab(state.activeTabId)?.type === "new-tab" ? "new-tab" : "host"
        : "home";
    }
    state.selectedId = null;
    state.modalOpen = false;
    state.notice = "Host deleted";
    await loadConnections();
  } catch (error) {
    state.error = readableError(error);
    render();
  }
}

export async function connectSelectedHost() {
  const host = selectedHost();
  if (!host) return;
  await connectHost(host);
}

export async function connectHostById(id) {
  const host = findHost(id);
  if (!host) return;
  await connectHost(host);
}

export async function connectHost(host, replaceTabId = null) {
  const tab = createHostTab(host);

  runWithoutStateUpdates(() => {
    if (replaceTabId) {
      const index = state.openedTabs.findIndex((t) => t.id === replaceTabId);
      if (index !== -1) state.openedTabs[index] = tab;
      else state.openedTabs.push(tab);
    } else {
      state.openedTabs.push(tab);
    }

    state.activeView = "host";
    state.activeTabId = tab.id;
    state.selectedId = host.id;
    state.sessionStatusById[tab.id] = "connecting";
    state.terminalOutputById[tab.id] = "";
    state.notice = `Opening ${host.name}...`;
  });
  render();

  try {
    await api("start_ssh_session", { connection: { ...host, id: tab.id } });
    state.notice = "";
    window.setTimeout(() => {
      if (state.activeTabId === tab.id && state.sessionStatusById[tab.id] === "connecting") {
        state.sessionStatusById[tab.id] = "interactive";
        state.terminalOutputById[tab.id] =
          state.terminalOutputById[tab.id] || "Starting embedded SSH session...\n";
        render();
        focusActiveTerminal();
      }
    }, 3500);
    if (!isTauri) {
      window.setTimeout(() => {
        state.sessionStatusById[tab.id] = "connected";
        state.terminalOutputById[tab.id] =
          `Welcome to Ubuntu 20.04.1 LTS (GNU/Linux 5.4.0-42-generic x86_64)\r\n\r\n` +
          `System information as of ${new Date().toLocaleString()}\r\n\r\n` +
          `Last login: ${new Date().toLocaleString()} from 122.50.6.195\r\n` +
          `${host.username}@${host.name.toLowerCase().replaceAll(" ", "-")}:~$ `;
        render();
      }, 1400);
    }
  } catch (error) {
    showSshErrorToast(host);
    closeSessionTab(tab.id, {
      returnHome: true,
      error: "",
      stopSession: false,
    });
    return;
  }

  render();
}

export function showSshErrorToast(
  host,
  message = "Connection failed. Check host, credentials, and SSH port.",
) {
  const toastId = "ssh_toast_" + Date.now() + Math.random().toString(36).substr(2, 9);
  const toast = {
    id: toastId,
    hostName: host?.name || "SSH connection",
    message,
    closing: false,
  };
  if (!state.sshToasts) state.sshToasts = [];
  state.sshToasts.push(toast);

  window.setTimeout(() => {
    const t = state.sshToasts.find((item) => item.id === toastId);
    if (t) {
      t.closing = true;
      render();
    }
  }, 2000);

  window.setTimeout(() => {
    const idx = state.sshToasts.findIndex((item) => item.id === toastId);
    if (idx !== -1) {
      state.sshToasts.splice(idx, 1);
      render();
    }
  }, 4000);
}

export function closeActiveSession() {
  const tabId = state.activeTabId;
  if (!tabId) return;
  closeSessionTab(tabId);
}

export function closeSessionTab(tabId, options = {}) {
  const {
    returnHome = false,
    error = "",
    stopSession = true,
  } = options;
  const tab = findTab(tabId);
  const wasActive = state.activeTabId === tabId;
  state.openedTabs = state.openedTabs.filter((t) => t.id !== tabId);
  delete state.sessionStatusById[tabId];
  delete state.terminalOutputById[tabId];
  disposeTerminal(tabId);
  if (stopSession && tab && tab.type !== "new-tab") {
    api("stop_ssh_session", { id: tabId }).catch(() => {});
  }

  if (returnHome) {
    state.activeTabId = null;
    state.activeView = "home";
    state.selectedId = null;
  } else if (wasActive || !state.activeTabId || !findTab(state.activeTabId)) {
    const nextTab = state.openedTabs.at(-1) || null;
    state.activeTabId = nextTab?.id || null;
    state.activeView = nextTab
      ? nextTab.type === "new-tab" ? "new-tab" : "host"
      : "home";
    state.selectedId = nextTab?.hostId || tab?.hostId || null;
  }

  state.notice = "";
  state.error = error;
  render();
}

window.addEventListener("resize", () => {
  if (state.activeTabId && state.fitAddonsById[state.activeTabId]) {
    state.fitAddonsById[state.activeTabId].fit();
  }
});
