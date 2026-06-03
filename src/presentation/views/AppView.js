import { runWithoutStateUpdates, state } from '../models/AppState.js';
import * as vm from '../viewmodels/AppViewModel.js';
import { api, isTauri, readableError } from '../../data/api.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { listen } from '@tauri-apps/api/event';

const app = document.getElementById("app");

const SFTP_DRAG_MIME = "application/x-okta-sftp-item";
let currentSftpDragItem = null;
let sftpPointerDrag = null;
let suppressNextSftpClick = false;
let lastHostClick = { id: null, at: 0 };
const SFTP_ACTION_MENU_WIDTH = 180;
export const xtermInstancesById = {};
export const fitAddonsById = {};

export function disposeTerminal(id) {
  if (xtermInstancesById[id]) {
    xtermInstancesById[id].dispose();
    delete xtermInstancesById[id];
    delete fitAddonsById[id];
  }
}

const sftpScrollMemory = {
  left: { path: "", top: 0, left: 0 },
  right: { path: "", top: 0, left: 0 },
};

function sftpJoinPath(dir, name) {
  if (!dir || dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function sftpQueueTransfer(item, targetPanel, type) {
  const id = Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  state.sftpUploadQueue.push({
    id,
    name: item.name,
    path: sftpJoinPath(targetPanel.path, item.name),
    size: 0,
    loaded: 0,
    done: false,
    type,
  });
  vm.ensureSftpProgressListener();
  render();
  return id;
}

function readSftpDragItem(dataTransfer) {
  if (!dataTransfer) return currentSftpDragItem;
  const raw =
    dataTransfer.getData(SFTP_DRAG_MIME) ||
    dataTransfer.getData("application/x-sftp-item") ||
    dataTransfer.getData("text/plain");
  if (!raw) return currentSftpDragItem;
  try {
    const item = JSON.parse(raw);
    return item?.path && item?.side ? item : currentSftpDragItem;
  } catch {
    return currentSftpDragItem;
  }
}

function sftpItemFromRow(fileRow) {
  if (!fileRow) return null;
  const { sftpFilePath: path, sftpFileName: name, side } = fileRow.dataset;
  if (!path || !name || !side) return null;
  return {
    path,
    name,
    side,
    isDir: fileRow.dataset.sftpFileIsDir === "true",
  };
}

function sftpPaneAtPoint(x, y) {
  return document.elementFromPoint(x, y)?.closest(".sftp-pane[data-sftp-side]") || null;
}

function clearSftpDropHighlights() {
  document.querySelectorAll(".sftp-pane").forEach(p => p.classList.remove("drag-over"));
}

function captureSftpScrollPositions() {
  return ["left", "right"].reduce((positions, side) => {
    const scroller = document.querySelector(`.sftp-pane[data-sftp-side="${side}"] .sftp-table-wrap`);
    if (scroller) {
      const panelPath = vm.getPanel(side).path;
      positions[side] = {
        path: panelPath,
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
      };
      sftpScrollMemory[side] = { ...positions[side] };
    }
    return positions;
  }, {});
}

function restoreSftpScrollPositions(positions) {
  const apply = () => {
    Object.entries(positions).forEach(([side, pos]) => {
      const scroller = document.querySelector(`.sftp-pane[data-sftp-side="${side}"] .sftp-table-wrap`);
      if (!scroller) return;
      if (pos.path && vm.getPanel(side).path !== pos.path) return;
      scroller.scrollTop = pos.top;
      scroller.scrollLeft = pos.left;
      sftpScrollMemory[side] = { ...pos };
    });
  };

  apply();
  requestAnimationFrame(apply);
  setTimeout(apply, 0);
}

function rememberSftpScrollerPosition(scroller) {
  const side = scroller.closest(".sftp-pane[data-sftp-side]")?.dataset.sftpSide;
  if (!side) return;
  sftpScrollMemory[side] = {
    path: vm.getPanel(side).path,
    top: scroller.scrollTop,
    left: scroller.scrollLeft,
  };
}

function restoreRememberedSftpScrollPositions() {
  restoreSftpScrollPositions(sftpScrollMemory);
}

function renderPreservingSftpScroll(mutator) {
  const scrollPositions = captureSftpScrollPositions();
  runWithoutStateUpdates(mutator);
  render();
  restoreSftpScrollPositions(scrollPositions);
}

function getSftpActionMenuStyle(side) {
  const trigger = document.querySelector(`.sftp-action-trigger[data-side="${side}"]`);
  const pane = document.querySelector(`.sftp-pane[data-sftp-side="${side}"]`);
  if (!trigger || !pane) return "";

  const triggerRect = trigger.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const left = Math.max(
    paneRect.left + margin,
    Math.min(triggerRect.right - SFTP_ACTION_MENU_WIDTH, paneRect.right - SFTP_ACTION_MENU_WIDTH - margin),
  );
  const top = Math.min(triggerRect.bottom + gap, window.innerHeight - 260);
  return `style="left: ${Math.round(left)}px; top: ${Math.round(top)}px;"`;
}

function updateSftpPointerGhost(event) {
  if (!sftpPointerDrag?.ghost) return;
  sftpPointerDrag.ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
}

function startSftpPointerDrag(event) {
  const drag = sftpPointerDrag;
  if (!drag || drag.dragging) return;
  drag.dragging = true;
  suppressNextSftpClick = true;
  currentSftpDragItem = drag.item;
  drag.sourceRow.classList.add("dragging");

  const ghost = document.createElement("div");
  ghost.className = "sftp-drag-ghost";
  ghost.textContent = drag.item.name;
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  updateSftpPointerGhost(event);
}

function finishSftpPointerDrag(event) {
  const drag = sftpPointerDrag;
  if (!drag) return;

  drag.sourceRow.classList.remove("dragging");
  try {
    drag.sourceRow.releasePointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture may already be gone if the WebView cancelled the drag.
  }
  drag.ghost?.remove();
  clearSftpDropHighlights();
  sftpPointerDrag = null;

  if (!drag.dragging) return;
  event.preventDefault();
  event.stopPropagation();

  const pane = sftpPaneAtPoint(event.clientX, event.clientY);
  const targetSide = pane?.dataset.sftpSide;
  if (!targetSide) {
    currentSftpDragItem = null;
    return;
  }

  const targetPanel = vm.getPanel(targetSide);
  if (!targetPanel.path || targetPanel.connecting || targetPanel.loading) {
    currentSftpDragItem = null;
    return;
  }

  transferDroppedSftpItem(drag.item, targetSide, targetPanel).finally(() => {
    currentSftpDragItem = null;
  });
}

async function transferDroppedSftpItem(item, targetSide, targetPanel) {
  if (item.side === targetSide) return;

  const sourcePanel = vm.getPanel(item.side);
  targetPanel.error = "";

  try {
    if (sourcePanel.type === "local" && targetPanel.type === "sftp") {
      const id = sftpQueueTransfer(item, targetPanel, "upload");
      await api("sftp_upload_local_files", {
        sessionId: targetPanel.sessionId,
        remoteDir: targetPanel.path,
        files: [{ id, path: item.path }],
      });
      await vm.sftpPanelReload(targetSide);
      return;
    }

    if (sourcePanel.type === "sftp" && targetPanel.type === "local") {
      const id = sftpQueueTransfer(item, targetPanel, "download");
      await api("sftp_download_remote_files", {
        sessionId: sourcePanel.sessionId,
        remoteFiles: [{ id, path: item.path }],
        localDir: targetPanel.path,
      });
      await vm.sftpPanelReload(targetSide);
      return;
    }

    if (sourcePanel.type === "local" && targetPanel.type === "local") {
      await api("copy_local_files", {
        sourcePaths: [item.path],
        targetDir: targetPanel.path,
      });
      await vm.sftpPanelReload(targetSide);
      return;
    }

    state.notice = "Remote-to-remote transfer is not supported directly.";
    render();
  } catch (err) {
    targetPanel.error = readableError(err);
    render();
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

export function render() {
  const hosts = vm.filteredHosts();
  const openedTabs = state.openedTabs.filter(
    (tab) => tab.type === "new-tab" || vm.findHost(tab.hostId),
  );
  const currentTab = vm.activeTab();
  const activeHost =
    currentTab && currentTab.type !== "new-tab" ? vm.findHost(currentTab.hostId) : null;
  const isNewTabMode = state.activeView === "new-tab";
  const isSftpMode = state.activeView === "sftp";
  const isSessionMode = Boolean(activeHost) || isNewTabMode;
  const activeTerminalStatus = currentTab ? state.sessionStatusById[currentTab.id] : null;
  const isTerminalActive = currentTab && isTerminalStatus(activeTerminalStatus);

  app.innerHTML = `
    <main class="okta-ssh-shell ${isTerminalActive ? "terminal-active" : ""}">
      <header class="tabbar">
        <div class="traffic">
          <button class="traffic-btn traffic-close" type="button" data-action="win-close" aria-label="Close"></button>
          <button class="traffic-btn traffic-minimize" type="button" data-action="win-minimize" aria-label="Minimize"></button>
          <button class="traffic-btn traffic-zoom" type="button" data-action="win-zoom" aria-label="Zoom"></button>
        </div>
        <nav class="tabs" aria-label="Vault tabs">
          <button class="tab vault-tab ${state.activeView === "home" || state.activeView === "port-forwarding" ? "active" : ""}" type="button" data-action="home">
            ${vaultIcon()}
            <span>Home</span>
            ${chevronIcon()}
          </button>
          <button class="tab folder-tab ${isSftpMode ? "active" : ""}" type="button" data-action="sftp">
            ${folderIcon()}
            <span>SFTP</span>
          </button>
          <span class="divider"></span>
          <div class="opened-tabs" aria-label="Opened hosts">
            ${openedTabs.map(topTab).join("")}
          </div>
          <button class="plus-tab" type="button" data-action="new-tab">${plusIcon()}</button>
        </nav>
      </header>

      <div class="app-body ${isSessionMode ? "session-mode" : ""} ${isSftpMode ? "sftp-mode" : ""}">
        ${
          state.activeView === "home" || state.activeView === "port-forwarding"
            ? sidebarPanel(hosts)
            : state.activeView === "sftp"
              ? sftpPanel()
              : state.activeView === "new-tab"
                ? newTabPanel()
                : activeHost
                  ? sessionPanel(activeHost, currentTab.id)
                  : ""
        }
      </div>

      ${state.modalOpen ? hostModal() : ""}
      ${(state.sftpLeft.renameOpen || state.sftpRight.renameOpen) ? sftpRenameModal() : ""}
      ${(state.sftpLeft.mkdirOpen || state.sftpRight.mkdirOpen) ? sftpMkdirModal() : ""}
      ${(state.sftpLeft.deleteOpen || state.sftpRight.deleteOpen) ? sftpDeleteModal() : ""}
      ${state.pfDeleteId ? pfDeleteModal() : ""}
      ${state.pfToasts && state.pfToasts.length ? pfToastContainerHtml() : ""}
      ${state.sshToasts && state.sshToasts.length ? sshToastContainerHtml() : ""}
      ${state.sftpUploadQueue.length ? sftpUploadOverlay() : ""}
    </main>
  `;

  if (isTerminalActive) {
    window.setTimeout(() => attachTerminal(currentTab.id), 0);
  }
  if (isSftpMode) {
    restoreRememberedSftpScrollPositions();
  }
}


export function portForwardingContent() {
  const rules = vm.filteredPfRules();
  const hasRules = state.pfRules.length > 0;
  const listHtml = rules.length === 0
    ? `<div class="pf-empty">
         ${portForwardingIcon()}
         <h2>${hasRules ? "No Matching Forwarding Rules" : "No Port Forwarding Rules"}</h2>
         <p>${hasRules ? "Try a different search keyword." : "Create a rule to securely tunnel traffic through your SSH hosts."}</p>
       </div>`
    : `<div class="pf-rules-list">
         ${rules.map(rule => {
           const status = state.pfStatusById[rule.id] || "closed";
           const isConnected = status === "connected";
           const isConnecting = status === "connecting";
           const host = vm.findHost(rule.host_id);
           const activePortOwner = vm.activePfPortOwner(rule);
           const isPortBlocked = Boolean(activePortOwner) && !isConnected && !isConnecting;
           const initial = (rule.name || "?")[0].toUpperCase();
           const typeColor = rule.rule_type === "Local" ? "pf-badge-local" : rule.rule_type === "Remote" ? "pf-badge-remote" : "pf-badge-dynamic";

           return `
             <div class="pf-rule-card ${isConnected ? "active" : ""}">
               <div class="pf-rule-initial ${typeColor}">${initial}</div>
               <div class="pf-rule-info">
                 <strong>${escapeHtml(rule.name)}</strong>
                 <span>Port ${rule.bind_port || "?"} → ${escapeHtml(host ? host.name : rule.host_id)} → ${escapeHtml(rule.target_address)}:${rule.target_port || "?"}</span>
               </div>
               <div class="pf-rule-actions">
                 <button class="pf-toggle-btn ${isConnected ? "on" : "off"}"
                         data-action="${isConnected ? "pf-stop" : "pf-start"}"
                         data-id="${rule.id}"
                         ${isPortBlocked ? "disabled" : ""}>
                   ${isConnecting ? "..." : isConnected ? "Stop" : isPortBlocked ? "In use" : "Start"}
                 </button>
                 <button class="pf-delete-btn" data-action="pf-delete" data-id="${rule.id}" title="Delete" aria-label="Delete ${escapeHtml(rule.name)}">
                   ${trashIcon()}
                 </button>
               </div>
               <button class="pf-edit-btn" data-action="pf-edit" data-id="${rule.id}" title="Edit" aria-label="Edit ${escapeHtml(rule.name)}">
                 ${pencilIcon()}
               </button>
             </div>
           `;
         }).join("")}
       </div>`;

  return `
    <section class="main-panel pf-main-panel">
      <div class="search-row pf-search-row">
        <label class="search-box">
          <input type="search" name="pfQuery" value="${escapeHtml(state.pfQuery)}" placeholder="Search forwarding" />
        </label>
      </div>

      <div class="toolbar-row">
        <div class="left-tools">
          <button class="new-host pf-new-btn" type="button" data-action="pf-new" data-type="Local">
            ${plusIcon()}
            <span>New forwarding</span>
          </button>
        </div>
      </div>

      <div class="content-area pf-content-area ${rules.length === 0 ? "pf-content-area--empty" : ""}">
        ${state.notice ? `<div class="toast">${escapeHtml(state.notice)}</div>` : ""}
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}
        ${listHtml}

      </div>

      ${state.pfDrawerOpen ? pfDrawer() : ""}
    </section>
  `;
}

export function pfDrawer() {
  const step = state.pfDrawerStep;
  const draft = state.pfWizardDraft;

  if (step === "edit") {
    const selectedHost = vm.findHost(draft.host_id);
    const hostOptions = state.connections.map((host) => `
      <option value="${escapeHtml(host.id)}" ${host.id === draft.host_id ? "selected" : ""}>${escapeHtml(host.name)}</option>
    `).join("");

    return `
      <div class="pf-drawer pf-drawer--open">
        <div class="pf-drawer-header">
          <div class="pf-drawer-titles">
            <span class="pf-drawer-title">Edit Port Forwarding</span>
            <span class="pf-drawer-subtitle">${selectedHost ? escapeHtml(selectedHost.name) : "Personal vault"}</span>
          </div>
          <button class="pf-drawer-close" data-action="pf-drawer-close">${xIcon()}</button>
        </div>

        <div class="pf-drawer-body">
          <div class="pf-drawer-field-group">
            <label class="pf-drawer-field-label">Label <span class="req">*</span></label>
            <input class="pf-drawer-input" type="text" id="pfEditName" required
                   placeholder="Rule name" value="${escapeHtml(draft.name)}" />

            <label class="pf-drawer-field-label">Tag</label>
            <input class="pf-drawer-input" type="text" id="pfEditTags"
                   placeholder="database, production" value="${escapeHtml(draft.tags)}" />

            <label class="pf-drawer-field-label">Group</label>
            <input class="pf-drawer-input" type="text" id="pfEditGroup"
                   placeholder="Infrastructure" value="${escapeHtml(draft.group)}" />

            <label class="pf-drawer-field-label">SSH host <span class="req">*</span></label>
            <select class="pf-drawer-input" id="pfEditHost" required>
              ${hostOptions}
            </select>

            <label class="pf-drawer-field-label">Bind port <span class="req">*</span></label>
            <input class="pf-drawer-input" type="number" id="pfEditBindPort" required min="1" max="65535"
                   placeholder="e.g. 25432" value="${draft.bind_port || ""}" />

            <label class="pf-drawer-field-label">Bind address</label>
            <input class="pf-drawer-input" type="text" id="pfEditBindAddr"
                   placeholder="127.0.0.1 (default)" value="${escapeHtml(draft.bind_address)}" />

            <label class="pf-drawer-field-label">Destination address <span class="req">*</span></label>
            <input class="pf-drawer-input" type="text" id="pfEditDestAddr" required
                   placeholder="localhost" value="${escapeHtml(draft.target_address)}" />

            <label class="pf-drawer-field-label">Destination port <span class="req">*</span></label>
            <input class="pf-drawer-input" type="number" id="pfEditDestPort" required min="1" max="65535"
                   placeholder="e.g. 5432" value="${draft.target_port || ""}" />

            <button class="pf-drawer-primary-btn" data-action="pf-edit-save" ${state.pfSaving ? "disabled" : ""}>${state.pfSaving ? "Saving..." : "Save &amp; Start"}</button>
          </div>
        </div>
      </div>
    `;
  }

  // Host selection step — full host list
  if (step === "select-host") {
    const q = state.pfHostQuery.trim().toLowerCase();
    const hosts = q
      ? state.connections.filter(h => [h.name, h.host, h.username, ...(h.tags||[])].join(" ").toLowerCase().includes(q))
      : state.connections;

    return `
      <div class="pf-drawer pf-drawer--open">
        <div class="pf-drawer-header">
          <div class="pf-drawer-titles">
            <span class="pf-drawer-title">Select Host</span>
            <span class="pf-drawer-subtitle">Personal vault</span>
          </div>
          <button class="pf-drawer-close" data-action="pf-drawer-close">${xIcon()}</button>
        </div>

        <button class="pf-drawer-back" data-action="pf-drawer-back">${arrowLeftIcon()} Back</button>

        <div class="pf-drawer-host-search">
          <label class="pf-drawer-search-box">
            ${searchIcon()}
            <input type="search" placeholder="Search" value="${escapeHtml(state.pfHostQuery)}"
                   data-pf-host-query="true" autocomplete="off" />
          </label>
        </div>

        <div class="pf-drawer-host-list">
          <div class="pf-drawer-host-label">Hosts</div>
          ${hosts.map(h => `
            <button class="pf-drawer-host-item ${draft.host_id === h.id ? "selected" : ""}" data-action="pf-select-host" data-id="${h.id}">
              <span class="pf-host-avatar">${(h.name||"?")[0].toUpperCase()}</span>
              <span class="pf-host-details">
                <strong>${escapeHtml(h.name)}</strong>
                <small>${escapeHtml((h.tags||[]).join(", ") || h.host)}</small>
              </span>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  // Step configs
  const steps = {
    "select-remote-host": {
      title: "Select the remote host:",
      desc: "Select a host where the port will be open. The traffic from this port will be forwarded to the destination host.",
      fields: `
        <button class="pf-drawer-primary-btn" data-action="pf-drawer-to-select-host">Select a host</button>
      `,
    },
    "details": {
      title: "Name this forwarding rule:",
      desc: "Add a label, tag, and group so the forwarding rule is easy to find later.",
      fields: `
        <div class="pf-drawer-field-group">
          <label class="pf-drawer-field-label">Label name <span class="req">*</span></label>
          <input class="pf-drawer-input" type="text" id="pfRuleName" required
                 placeholder="e.g. Redis tunnel" value="${escapeHtml(draft.name)}" />
          <label class="pf-drawer-field-label">Tag</label>
          <input class="pf-drawer-input" type="text" id="pfRuleTags"
                 placeholder="database, production" value="${escapeHtml(draft.tags)}" />
          <label class="pf-drawer-field-label">Group</label>
          <input class="pf-drawer-input" type="text" id="pfRuleGroup"
                 placeholder="Infrastructure" value="${escapeHtml(draft.group)}" />
          <button class="pf-drawer-primary-btn" data-action="pf-drawer-to-destination">Continue</button>
        </div>
      `,
    },
    "destination": {
      title: "Select the destination host:",
      desc: "The destination address and port where the traffic will be forwarded.",
      fields: `
        <div class="pf-drawer-field-group">
          <label class="pf-drawer-field-label">Destination address <span class="req">*</span></label>
          <input class="pf-drawer-input" type="text" id="pfDestAddr" required
                 placeholder="e.g. localhost or remote-host" value="${escapeHtml(draft.target_address)}" />
          <label class="pf-drawer-field-label">Destination port <span class="req">*</span></label>
          <input class="pf-drawer-input" type="number" id="pfDestPort" required min="1" max="65535"
                 placeholder="e.g. 5432" value="${draft.target_port || ""}" />
          <button class="pf-drawer-primary-btn" data-action="pf-drawer-to-bind">Continue</button>
        </div>
      `,
    },
    "bind": {
      title: "Set the port and binding address:",
      desc: "We will forward traffic from specified port and interface address of the selected host.",
      fields: `
        <div class="pf-drawer-field-group">
          <label class="pf-drawer-field-label">${draft.rule_type === "Local" ? "Local" : "Remote"} bind port <span class="req">*</span></label>
          <input class="pf-drawer-input" type="number" id="pfBindPort" required min="1" max="65535"
                 placeholder="e.g. 8080" value="${draft.bind_port || ""}" />
          <label class="pf-drawer-field-label">Bind address</label>
          <input class="pf-drawer-input" type="text" id="pfBindAddr"
                 placeholder="127.0.0.1 (default)" value="${escapeHtml(draft.bind_address)}" />
          <button class="pf-drawer-primary-btn" data-action="pf-drawer-save" ${state.pfSaving ? "disabled" : ""}>${state.pfSaving ? "Saving..." : "Save &amp; Start"}</button>
        </div>
      `,
    },
  };

  const cfg = steps[step] || steps["select-remote-host"];
  const selectedHost = vm.findHost(draft.host_id);

  return `
    <div class="pf-drawer pf-drawer--open">
      <div class="pf-drawer-header">
        <div class="pf-drawer-titles">
          <span class="pf-drawer-title">${draft.rule_type} Port Forwarding</span>
          <span class="pf-drawer-subtitle">${selectedHost ? escapeHtml(selectedHost.name) : "Personal vault"}</span>
        </div>
        <button class="pf-drawer-close" data-action="pf-drawer-close">${xIcon()}</button>
      </div>

      <button class="pf-drawer-back" data-action="pf-drawer-back">${arrowLeftIcon()} Back</button>

      <div class="pf-drawer-body">
        <p class="pf-drawer-step-title">${cfg.title}</p>
        <p class="pf-drawer-desc">${cfg.desc}</p>
        ${cfg.fields}
      </div>
    </div>
  `;
}

export function sftpConnectingOverlay(side) {
  const panel = vm.getPanel(side);
  const h = panel.connectingHost;
  const name = h?.name || "Remote Host";
  const addr = h ? `${h.username || ""}${h.username ? "@" : ""}${h.host}` : "";
  return `
    <div class="sftp-pane-connecting">
      <div class="sftp-connecting-card">
        <div class="sftp-connecting-rings">
          <div class="sftp-ring sftp-ring-1"></div>
          <div class="sftp-ring sftp-ring-2"></div>
          <div class="sftp-ring sftp-ring-3"></div>
          <div class="sftp-connecting-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
          </div>
        </div>
        <div class="sftp-connecting-info">
          <h3>${escapeHtml(name)}</h3>
          ${addr ? `<p>${escapeHtml(addr)}</p>` : ""}
        </div>
        <div class="sftp-connecting-status">
          ${panel.error ? `
            <div style="color: #ff6b6b; text-align: center; margin-bottom: 12px; font-size: 13px; max-width: 250px; line-height: 1.4;">${escapeHtml(panel.error)}</div>
          ` : `
            <div class="sftp-connecting-dots"><span></span><span></span><span></span></div>
            <span class="sftp-connecting-label">Connecting…</span>
          `}
        </div>
      </div>
    </div>
  `;
}

export function sftpPanel() {
  return `
    <div class="sftp-dual-layout">
      ${sftpPaneHtml("left")}
      <div class="sftp-pane-divider"></div>
      ${sftpPaneHtml("right")}
    </div>
    ${state.sftpContextMenu ? sftpContextMenuHtml() : ""}
  `;
}

export function sftpPaneHtml(side) {
  const panel = vm.getPanel(side);
  const isActive = state.sftpActivePanel === side;

  if (panel.type === "empty" && !panel.connecting) {
    return sftpEmptyPaneHtml(side, isActive);
  }
  return sftpBrowserPaneHtml(side, isActive, panel);
}

export function sftpEmptyPaneHtml(side, isActive) {
  const allHosts = state.connections || [];
  const panel = vm.getPanel(side);
  return `
    <div class="sftp-pane ${isActive ? "active" : ""}" data-sftp-side="${side}" tabindex="0">
      <div class="sftp-pane-empty-area">
        <div class="sftp-empty-state">
          <div class="sftp-empty-icon">${folderBigIcon()}</div>
          <h2>${side === "right" ? "Remote Host" : "No Panel"}</h2>
          <p>Select a host to browse its files<br>via SFTP.</p>
          <button class="sftp-select-btn" type="button" data-action="sftp-open-host-selector" data-side="${side}">
            Select host
          </button>
        </div>
      </div>
      ${panel.hostSelectorOpen ? sftpHostSelectorHtml(side) : ""}
    </div>
  `;
}

export function sftpBrowserPaneHtml(side, isActive, panel) {
  const canBack = panel.historyIndex > 0;
  const canForward = panel.historyIndex < panel.history.length - 1;
  const breadcrumbs = buildBreadcrumbs(panel.path);
  const selectedFile = panel.selectedFile;
  const isLocal = panel.type === "local";
  const hostLabel = isLocal
    ? "Local"
    : (panel.connection?.name || panel.connection?.host || "Remote");
  const canUpload = panel.type === "sftp" && Boolean(panel.sessionId);
  const canDownload = panel.type === "sftp" && Boolean(selectedFile) && !selectedFile.isDir;
  const canMakeFolder = panel.type === "sftp";
  const canRename = Boolean(selectedFile);
  const canDelete = Boolean(selectedFile);

  return `
    <div class="sftp-pane ${isActive ? "active" : ""}" data-sftp-side="${side}" tabindex="0">
      ${panel.connecting ? sftpConnectingOverlay(side) : `
      
      <!-- Compact Toolbar -->
      <div class="sftp-pane-toolbar">
        <div class="sftp-pane-host-btn-wrap">
          <button class="sftp-pane-host-btn ${isLocal ? "local" : "remote"}" type="button" 
                  data-action="sftp-open-host-selector" data-side="${side}">
            ${isLocal
              ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z"/></svg>`
              : ubuntuIcon()
            }
            <span>${escapeHtml(hostLabel)}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
        </div>

        <div class="sftp-pane-actions-wrap">
          <div class="sftp-action-group ${panel.actionsOpen ? "open" : ""}" data-panel-side="${side}">
            <button class="sftp-action-trigger" type="button" data-action="sftp-actions-toggle" data-side="${side}">
              <span>Actions</span>${downIcon()}
            </button>
            <div class="sftp-action-menu" ${panel.actionsOpen ? getSftpActionMenuStyle(side) : ""}>
              <button type="button" data-action="sftp-upload" data-side="${side}" ${canUpload ? "" : "disabled"}>${uploadIcon()} Upload</button>
              <button type="button" data-action="sftp-download" data-side="${side}" ${canDownload ? "" : "disabled"}>${downloadIcon()} Download</button>
              <hr/>
              <button type="button" data-action="sftp-mkdir" data-side="${side}" ${canMakeFolder ? "" : "disabled"}>${folderPlusIcon()} New Folder</button>
              <button type="button" data-action="sftp-rename" data-side="${side}" ${canRename ? "" : "disabled"}>${pencilIcon()} Rename</button>
              <button type="button" data-action="sftp-delete" data-side="${side}" ${canDelete ? "" : "disabled"} class="danger">${trashIcon()} Delete</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Navigation bar -->
      <div class="sftp-navbar">
        <button class="sftp-nav-btn" type="button" data-action="sftp-back" data-side="${side}" ${canBack ? "" : "disabled"}>${navBackIcon()}</button>
        <button class="sftp-nav-btn" type="button" data-action="sftp-forward" data-side="${side}" ${canForward ? "" : "disabled"}>${navForwardIcon()}</button>
        <div class="sftp-breadcrumb">
          ${breadcrumbs.map((crumb, i) => `
            <span class="sftp-crumb ${i === breadcrumbs.length - 1 ? "current" : ""}">
              ${i === breadcrumbs.length - 1
                ? `<span>${escapeHtml(crumb.label)}</span>`
                : `<button type="button" data-sftp-path="${escapeHtml(crumb.path)}" data-side="${side}">${escapeHtml(crumb.label)}</button>`
              }
              ${i < breadcrumbs.length - 1 ? '<svg viewBox="0 0 24 24" class="crumb-arrow"><polyline points="9 18 15 12 9 6"></polyline></svg>' : ""}
            </span>
          `).join("")}
        </div>
        <button class="sftp-nav-btn sftp-reload-btn ${panel.loading ? "spinning" : ""}" type="button" data-action="sftp-reload" data-side="${side}" ${panel.loading ? "disabled" : ""}>${refreshIcon()}</button>
      </div>

      <!-- Error bar -->
      ${panel.error ? `<div class="sftp-error-bar">${escapeHtml(panel.error)}<button type="button" data-action="sftp-clear-error" data-side="${side}">${xIcon()}</button></div>` : ""}

      <!-- File Table -->
      <div class="sftp-table-wrap" tabindex="0">
        <table class="sftp-table">
          <thead>
            <tr>
              <th class="col-name">Name</th>
              <th class="col-date">Date Modified</th>
              <th class="col-size">Size</th>
              <th class="col-kind">Kind</th>
            </tr>
          </thead>
          <tbody>
            ${panel.path && panel.path !== "/" ? `
              <tr class="sftp-row sftp-up-row" data-sftp-navigate-up="true" data-side="${side}">
                <td class="col-name"><span class="sftp-file-icon">${folderIcon()}</span><span>..</span></td>
                <td class="col-date">—</td><td class="col-size">—</td><td class="col-kind">folder</td>
              </tr>
            ` : ""}
            ${panel.files.length === 0 && !panel.loading
              ? `<tr><td colspan="4" class="sftp-empty-dir">This folder is empty</td></tr>`
              : panel.files.map(file => sftpFileRow(file, side)).join("")
            }
          </tbody>
        </table>
      </div>

      <!-- Host Selector Overlay -->
      ${panel.hostSelectorOpen ? sftpHostSelectorHtml(side) : ""}
      `}
    </div>
  `;
}

export function sftpHostSelectorHtml(side) {
  const panel = vm.getPanel(side);
  const q = (panel.hostSelectorQuery || "").toLowerCase();
  const hosts = state.connections.filter(h => !q ||
    h.name.toLowerCase().includes(q) || h.host.toLowerCase().includes(q));
  return `
    <div class="sftp-host-selector-overlay" data-side="${side}">
      <div class="sftp-host-selector-header">
        <span>Switch Connection</span>
        <button type="button" data-action="sftp-close-host-selector" data-side="${side}">${xIcon()}</button>
      </div>
      <div class="sftp-host-search-wrap">
        <label class="sftp-host-search">
          ${searchIcon()}
          <input type="search" name="sftpHostSelectorQuery" data-side="${side}"
                 value="${escapeHtml(panel.hostSelectorQuery || "")}" placeholder="Search hosts…" />
        </label>
      </div>
      <div class="sftp-host-list">
        <!-- Local computer option -->
        <div class="sftp-host-row ${panel.type === "local" ? "connected" : ""}"
             role="button" tabindex="0" data-sftp-switch-local="${side}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
          <div class="sftp-host-row-info">
            <strong>Local Computer</strong>
            <small>127.0.0.1</small>
          </div>
          ${panel.type === "local" ? `<span class="sftp-connected-dot"></span>` : ""}
        </div>
        ${hosts.length ? hosts.map(h => sftpHostRowForSelector(h, side, panel)).join("") : `<div class="sftp-no-hosts">No hosts found</div>`}
      </div>
    </div>
  `;
}

export function sftpHostRowForSelector(host, side, panel) {
  const isConnected = panel.type === "sftp" && panel.connection?.id === host.id;
  return `
    <div class="sftp-host-row ${isConnected ? "connected" : ""}"
         role="button" tabindex="0" data-sftp-connect-id="${host.id}" data-side="${side}">
      ${ubuntuIcon()}
      <div class="sftp-host-row-info">
        <strong>${escapeHtml(host.name)}</strong>
        <small>${escapeHtml(host.host)}</small>
      </div>
      ${isConnected ? `<span class="sftp-connected-dot"></span>` : ""}
    </div>
  `;
}

export function sftpContextMenuHtml() {
  const ctx = state.sftpContextMenu;
  return `
    <div class="sftp-context-menu" style="left: ${ctx.x}px; top: ${ctx.y}px;" id="sftp-ctx-menu">
      <div class="sftp-ctx-filename">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ctx.file.isDir ? '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>' : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>'}</svg>
        <span>${escapeHtml(ctx.file.name)}</span>
      </div>
      <div class="sftp-ctx-separator"></div>
      <button class="sftp-ctx-item" type="button" data-action="sftp-open-rename" data-side="${ctx.side}">
        ${pencilIcon()}
        Rename
      </button>
      <button class="sftp-ctx-item danger" type="button" data-action="sftp-open-delete" data-side="${ctx.side}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
        Delete
      </button>
    </div>
  `;
}

export function sftpFileRow(file, side) {
  const panel = vm.getPanel(side);
  const isSelected = panel.selectedFile?.path === file.path;
  const modified = file.modified ? formatDate(file.modified) : "—";
  const size = file.isDir ? "—" : formatSize(file.size);
  const kind = file.isSymlink ? "alias" : file.isDir ? "folder" : fileKind(file.name);
  return `
    <tr class="sftp-row ${isSelected ? "selected" : ""} ${file.isDir ? "is-dir" : ""}"
        data-sftp-file-path="${escapeHtml(file.path)}"
        data-sftp-file-name="${escapeHtml(file.name)}"
        data-sftp-file-is-dir="${file.isDir}"
        data-side="${side}">
      <td class="col-name">
        <span class="sftp-file-icon">${file.isDir ? folderIcon() : fileIcon(file.name)}</span>
        <span class="sftp-file-name">${escapeHtml(file.name)}</span>
        ${file.isSymlink ? `<span class="sftp-symlink-badge">alias</span>` : ""}
      </td>
      <td class="col-date">${modified}</td>
      <td class="col-size">${size}</td>
      <td class="col-kind">${kind}</td>
    </tr>
  `;
}

export function sftpRenameModal() {
  const side = state.sftpLeft.renameOpen ? "left" : state.sftpRight.renameOpen ? "right" : state.sftpActivePanel;
  const panel = vm.getPanel(side);
  const file = panel.selectedFile;
  return `
    <div class="modal-backdrop" role="presentation" data-action="close-sftp-rename" data-side="${side}">
      <form class="host-modal sftp-dialog" data-form="sftp-rename" data-side="${side}">
        <header>
          <h2>Rename "${escapeHtml(file?.name || "")}"</h2>
          <button type="button" data-action="close-sftp-rename" data-side="${side}" aria-label="Close">${xIcon()}</button>
        </header>
        <label>
          <span>New name</span>
          <input name="sftpRenameValue" value="${escapeHtml(panel.renameValue)}" autofocus required />
        </label>
        <footer>
          <div></div>
          <div>
            <button class="modal-secondary" type="button" data-action="close-sftp-rename" data-side="${side}">Cancel</button>
            <button class="modal-primary" type="submit">Rename</button>
          </div>
        </footer>
      </form>
    </div>
  `;
}

export function sftpMkdirModal() {
  const side = state.sftpActivePanel;
  const panel = vm.getPanel(side);
  return `
    <div class="modal-backdrop" role="presentation" data-action="close-sftp-mkdir" data-side="${side}">
      <form class="host-modal sftp-dialog" data-form="sftp-mkdir" data-side="${side}">
        <header>
          <h2>New Folder</h2>
          <button type="button" data-action="close-sftp-mkdir" data-side="${side}" aria-label="Close">${xIcon()}</button>
        </header>
        <label>
          <span>Folder name</span>
          <input name="sftpMkdirValue" value="${escapeHtml(panel.mkdirValue)}" autofocus required />
        </label>
        <footer>
          <div></div>
          <div>
            <button class="modal-secondary" type="button" data-action="close-sftp-mkdir" data-side="${side}">Cancel</button>
            <button class="modal-primary" type="submit">Create</button>
          </div>
        </footer>
      </form>
    </div>
  `;
}

export function sftpDeleteModal() {
  const side = state.sftpLeft.deleteOpen ? "left" : state.sftpRight.deleteOpen ? "right" : state.sftpActivePanel;
  const panel = vm.getPanel(side);
  const file = panel.selectedFile;
  const isDir = file?.isDir;
  return `
    <div class="modal-backdrop" role="presentation" data-action="close-sftp-delete" data-side="${side}">
      <div class="host-modal sftp-dialog sftp-delete-dialog">
        <header>
          <h2>Delete ${isDir ? "Folder" : "File"}</h2>
          <button type="button" data-action="close-sftp-delete" data-side="${side}" aria-label="Close">${xIcon()}</button>
        </header>
        <div class="sftp-delete-body">
          <div class="sftp-delete-icon">${isDir ? folderIcon() : genericFileIcon()}</div>
          <div class="sftp-delete-info">
            <strong>${escapeHtml(file?.name || "")}</strong>
            <span>This action cannot be undone. The ${isDir ? "folder and all its contents" : "file"} will be permanently deleted.</span>
          </div>
        </div>
        <footer>
          <div></div>
          <div>
            <button class="modal-secondary" type="button" data-action="close-sftp-delete" data-side="${side}">Cancel</button>
            <button class="modal-danger" type="button" data-action="sftp-confirm-delete" data-side="${side}">Delete</button>
          </div>
        </footer>
      </div>
    </div>
  `;
}


export function pfDeleteModal() {
  const rule = state.pfRules.find((item) => item.id === state.pfDeleteId);
  const host = rule ? vm.findHost(rule.host_id) : null;
  const status = rule ? state.pfStatusById[rule.id] || "closed" : "closed";
  return `
    <div class="modal-backdrop" role="presentation" data-action="close-pf-delete">
      <div class="host-modal sftp-dialog sftp-delete-dialog">
        <header>
          <h2>Delete Port Forwarding</h2>
          <button type="button" data-action="close-pf-delete" aria-label="Close">${xIcon()}</button>
        </header>
        <div class="sftp-delete-body">
          <div class="sftp-delete-icon pf-delete-icon">${forwardIcon()}</div>
          <div class="sftp-delete-info">
            <strong>${escapeHtml(rule?.name || "Port forwarding rule")}</strong>
            <span>This action cannot be undone. ${status === "connected" || status === "connecting" ? "The active tunnel will be stopped, then the rule will be permanently deleted." : `The rule for ${escapeHtml(host?.name || "this host")} will be permanently deleted.`}</span>
          </div>
        </div>
        <footer>
          <div></div>
          <div>
            <button class="modal-secondary" type="button" data-action="close-pf-delete">Cancel</button>
            <button class="modal-danger" type="button" data-action="pf-confirm-delete">Delete</button>
          </div>
        </footer>
      </div>
    </div>
  `;
}

export function showPfErrorToast(ruleId) {
  const rule = state.pfRules.find((item) => item.id === ruleId);
  const toastId = "toast_" + Date.now() + Math.random().toString(36).substr(2, 9);
  const toast = { id: toastId, rule, closing: false };
  if (!state.pfToasts) state.pfToasts = [];
  state.pfToasts.push(toast);
  
  window.setTimeout(() => {
    const t = state.pfToasts.find(t => t.id === toastId);
    if (t) {
      t.closing = true;
      render();
    }
  }, 2000);
  
  window.setTimeout(() => {
    const idx = state.pfToasts.findIndex(t => t.id === toastId);
    if (idx !== -1) {
      state.pfToasts.splice(idx, 1);
      render();
    }
  }, 4000);
}

export function pfToastContainerHtml() {
  if (!state.pfToasts || state.pfToasts.length === 0) return "";
  return `
    <div class="pf-toast-container">
      ${state.pfToasts.map((t, idx) => `
        <div class="pf-toast ${t.closing ? "pf-toast-closing" : ""}" data-toast-id="${t.id}">
          <div class="pf-toast-icon">${plugIcon()}</div>
          <div class="pf-toast-content">
            <strong>${escapeHtml(t.rule?.name || "Port forwarding rule")}</strong>
            <span>Connection failed. Check host, credentials, local port, and destination.</span>
          </div>
          <button type="button" class="pf-toast-close" data-action="close-pf-toast" data-toast-id="${t.id}">${xIcon()}</button>
        </div>
      `).join("")}
    </div>
  `;
}

export function sshToastContainerHtml() {
  if (!state.sshToasts || state.sshToasts.length === 0) return "";
  return `
    <div class="pf-toast-container">
      ${state.sshToasts.map((t) => `
        <div class="pf-toast ${t.closing ? "pf-toast-closing" : ""}" data-toast-id="${t.id}">
          <div class="pf-toast-icon">${terminalIcon()}</div>
          <div class="pf-toast-content">
            <strong>${escapeHtml(t.hostName || "SSH connection")}</strong>
            <span>${escapeHtml(t.message || "Connection failed. Check host, credentials, and SSH port.")}</span>
          </div>
          <button type="button" class="pf-toast-close" data-action="close-ssh-toast" data-toast-id="${t.id}">${xIcon()}</button>
        </div>
      `).join("")}
    </div>
  `;
}

function clearPfStartTimeout(id) {
  const timer = state.pfStartTimeoutById[id];
  if (!timer) return;
  window.clearTimeout(timer);
  delete state.pfStartTimeoutById[id];
}

function schedulePfStartTimeout(id) {
  clearPfStartTimeout(id);
  state.pfStartTimeoutById[id] = window.setTimeout(() => {
    if (state.pfStatusById[id] !== "connecting") return;
    state.pfStatusById[id] = "closed";
    showPfErrorToast(id);
    delete state.pfStartTimeoutById[id];
    api("stop_port_forwarding", { ruleId: id }).catch(() => {});
    render();
  }, 3000);
}

export function sftpUploadOverlay() {
  const queue = state.sftpUploadQueue;
  const total = queue.length;
  const done = queue.filter((f) => f.done).length;
  const allDone = done === total;
  const isDownloadOnly = queue.every((item) => item.type === "download");
  const actionLabel = isDownloadOnly ? "Download" : "Transfer";

  return `
    <div class="sftp-upload-overlay">
      <div class="sftp-upload-panel">
        <div class="sftp-upload-panel-header">
          <span>${allDone ? `${actionLabel} complete` : `Transferring ${done}/${total} items…`}</span>
          ${allDone ? `<button class="sftp-upload-close" type="button" data-action="sftp-dismiss-upload">${xIcon()}</button>` : ""}
        </div>
        <div class="sftp-upload-list">
          ${queue.map((item) => {
            const pct = item.size > 0 ? Math.round((item.loaded / item.size) * 100) : (item.done ? 100 : 0);
            const statusClass = item.error ? "error" : item.done ? "done" : "uploading";
            return `
              <div class="sftp-upload-item ${statusClass}" data-upload-id="${item.id}">
                <div class="sftp-upload-item-header">
                  <span class="sftp-upload-name">${escapeHtml(item.name)}</span>
                  <span class="sftp-upload-pct">${item.error === "Canceled" ? "Canceled" : item.error ? "Failed" : item.done ? "Done" : pct + "%"}</span>
                  ${item.done || item.type === "download" ? "" : `
                    <button class="sftp-upload-cancel" type="button" data-action="sftp-cancel-upload" data-upload-id="${item.id}" aria-label="Cancel upload">
                      ${xIcon()}
                    </button>
                  `}
                </div>
                <div class="sftp-upload-track">
                  <div class="sftp-upload-bar ${statusClass}" data-upload-id="${item.id}" style="width: ${item.error ? 100 : pct}%"></div>
                </div>
                ${item.error ? `<div class="sftp-upload-error">${escapeHtml(item.error)}</div>` : ""}
              </div>
            `;
          }).join("")}
        </div>
      </div>
    </div>
  `;
}

// ─── Breadcrumb helpers ───────────────────────────────────────────────────────

export function buildBreadcrumbs(path) {
  const parts = path.split("/").filter(Boolean);
  const crumbs = [{ label: "/", path: "/" }];
  parts.forEach((part, i) => {
    crumbs.push({
      label: part,
      path: "/" + parts.slice(0, i + 1).join("/"),
    });
  });
  return crumbs;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

export function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export function formatSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fileKind(name) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const kinds = {
    txt: "Plain Text", md: "Markdown", json: "JSON", js: "JavaScript", ts: "TypeScript",
    html: "HTML", css: "CSS", sh: "Shell Script", py: "Python", rb: "Ruby",
    go: "Go", rs: "Rust", java: "Java", php: "PHP", yml: "YAML", yaml: "YAML",
    toml: "TOML", xml: "XML", sql: "SQL", png: "PNG Image", jpg: "JPEG Image",
    jpeg: "JPEG Image", gif: "GIF Image", svg: "SVG Image", pdf: "PDF", zip: "ZIP Archive",
    gz: "GZip Archive", tar: "TAR Archive", log: "Log File", conf: "Config File",
    env: "ENV File",
  };
  return kinds[ext] || (ext ? `${ext.toUpperCase()} File` : "File");
}

export function fileIcon(name) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const textExts = ["txt", "md", "json", "js", "ts", "html", "css", "sh", "py", "rb", "go", "rs", "yml", "yaml", "toml", "xml", "sql", "conf", "env", "log"];
  const imgExts = ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp"];
  const archiveExts = ["zip", "gz", "tar", "bz2", "7z", "rar"];
  if (textExts.includes(ext)) return codeFileIcon();
  if (imgExts.includes(ext)) return imageFileIcon();
  if (archiveExts.includes(ext)) return archiveFileIcon();
  return genericFileIcon();
}

// ─── Home Panel ───────────────────────────────────────────────────────────────

export function sidebarPanel(hosts) {
  const isPF = state.activeView === "port-forwarding";
  return `
    <aside class="sidebar">
      ${sideItem("Hosts", serversIcon(), !isPF)}
      ${sideItem("Port Forwarding", forwardIcon(), isPF)}
    </aside>

    ${
      isPF ? portForwardingContent() : hostsContent(hosts)
    }
  `;
}

export function hostsContent(hosts) {
  return `
    <section class="main-panel">
      <div class="search-row">
        <label class="search-box">
          <input type="search" name="query" value="${escapeHtml(state.query)}" placeholder="Search hosts" />
        </label>
        <button class="connect-button" type="button" data-action="connect" ${state.selectedId ? "" : "disabled"}>Connect</button>
      </div>

      <div class="toolbar-row">
        <div class="left-tools">
          <button class="new-host" type="button" data-action="new-host">
            ${plusIcon()}
            <span>New host</span>
          </button>
          <button class="small-drop" type="button" aria-label="Open new host menu" data-action="new-host">${downIcon()}</button>
        </div>
      </div>

      <div class="content-area">
        ${state.notice ? `<div class="toast">${escapeHtml(state.notice)}</div>` : ""}
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}

        <section class="hosts-section">
          <h2>Hosts</h2>
          <div class="host-grid">
            ${hosts.length ? hosts.map(hostCard).join("") : emptyHosts()}
          </div>
        </section>
      </div>
    </section>
  `;
}

export function topTab(tab) {
  const active = tab.id === state.activeTabId ? "selected" : "";
  if (tab.type === "new-tab") {
    return `
      <div class="tab host-tab new-tab-tab ${active}">
        <button class="tab-close" type="button" data-close-tab-id="${tab.id}" aria-label="Close New Tab">${xIcon()}</button>
        <button class="tab-label" type="button" data-open-tab-id="${tab.id}">
          <span>New Tab</span>
        </button>
      </div>
    `;
  }

  const host = vm.findHost(tab.hostId);
  if (!host) return "";
  return `
    <div class="tab host-tab ${active}">
      <button class="tab-close" type="button" data-close-tab-id="${tab.id}" aria-label="Close ${escapeHtml(tab.label)}">${xIcon()}</button>
      <button class="tab-label" type="button" data-open-tab-id="${tab.id}">
        <span>${escapeHtml(tab.label)}</span>
      </button>
    </div>
  `;
}

export function newTabPanel() {
  const hosts = vm.filteredNewTabHosts();
  return `
    <section class="new-tab-panel">
      ${state.notice ? `<div class="toast">${escapeHtml(state.notice)}</div>` : ""}
      ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}
      <label class="quick-search">
        <input type="search" name="newTabQuery" value="${escapeHtml(state.newTabQuery)}" placeholder="Search hosts or tabs" autofocus />
      </label>
      <section class="recent-card">
        <header>
          <h2>Recent connections</h2>
        </header>
        <div class="recent-list">
          ${hosts.length ? hosts.map(recentConnectionRow).join("") : emptyRecentConnections()}
        </div>
      </section>
    </section>
  `;
}

export function recentConnectionRow(host) {
  return `
    <div class="recent-row" role="button" tabindex="0" data-new-tab-host-id="${host.id}">
      ${ubuntuIcon()}
      <strong>${escapeHtml(host.name)}</strong>
    </div>
  `;
}

export function sideItem(label, icon, active = false) {
  return `
    <button class="side-item ${active ? "active" : ""}" type="button" data-action="${label === "Port Forwarding" ? "port-forwarding" : "home"}">
      ${icon}
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

export function hostCard(host) {
  const selected = host.id === state.selectedId ? "selected" : "";
  return `
    <div class="host-card ${selected}" role="button" tabindex="0" data-host-id="${host.id}" aria-label="Open ${escapeHtml(host.name)}">
      ${ubuntuIcon("large")}
      <span class="host-copy">
        <strong>${escapeHtml(host.name)}</strong>
        <small>${escapeHtml((host.tags || ["ssh"]).join(", "))}</small>
      </span>
      <button class="host-edit" type="button" data-edit-host-id="${host.id}" aria-label="Edit ${escapeHtml(host.name)}">
        ${pencilIcon()}
      </button>
    </div>
  `;
}

export function emptyHosts() {
  return `
    <div class="empty-hosts">
      <strong>No hosts yet</strong>
      <span>Create a host from Home to start your SSH list.</span>
    </div>
  `;
}

export function emptyRecentConnections() {
  return `
    <div class="empty-recent">
      <strong>No matching hosts</strong>
      <span>Try another host name, tag, address, or username.</span>
    </div>
  `;
}

export function sessionPanel(host, tabId) {
  const status = state.sessionStatusById[tabId] || "connecting";
  if (status === "failed" && state.terminalOutputById[tabId]) return terminalPlayground(host, tabId);
  if (isTerminalStatus(status)) return terminalPlayground(host, tabId);

  const statusText = status === "failed" ? "Connection failed" : "Boosting your shell performance...";

  return `
    <section class="session-panel">
      ${state.notice ? `<div class="toast">${escapeHtml(state.notice)}</div>` : ""}
      ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}
      <article class="connection-card ${status}">
        <header>
          ${ubuntuIcon("large")}
          <div>
            <h2>${escapeHtml(host.name)}</h2>
            <p>SSH ${escapeHtml(host.host)}:${host.port}</p>
          </div>
        </header>
        <div class="connection-flow" aria-label="${escapeHtml(statusText)}">
          <span class="flow-node plug">${plugIcon()}</span>
          <span class="flow-node rocket">${rocketIcon()}</span>
          <span class="flow-line"><i></i></span>
          <span class="flow-node terminal">${terminalIcon()}</span>
        </div>
        <p class="connection-status">${escapeHtml(statusText)}</p>
        <button class="session-close" type="button" data-action="close-session">Close</button>
      </article>
    </section>
  `;
}

export function terminalPlayground(host, tabId) {
  return `
    <section class="terminal-panel">
      <div class="embedded-terminal-container" data-terminal-id="${tabId}"></div>
    </section>
  `;
}

export function hostModal() {
  const isEdit = state.modalMode === "edit";
  return `
    <div class="modal-backdrop" role="presentation">
      <form class="host-modal" data-form="host">
        <header>
          <h2>${isEdit ? "Edit host" : "New host"}</h2>
          <button type="button" data-action="close-modal" aria-label="Close">${xIcon()}</button>
        </header>
        <label>
          <span>Label</span>
          <input name="name" value="${escapeHtml(state.draft.name)}" placeholder="RC Helpdesk Ticket" required />
        </label>
        <label>
          <span>Address</span>
          <input name="host" value="${escapeHtml(state.draft.host)}" placeholder="10.10.10.25" required />
        </label>
        <div class="modal-split">
          <label>
            <span>Username</span>
            <input name="username" value="${escapeHtml(state.draft.username)}" placeholder="okta" required />
          </label>
          <label>
            <span>Port</span>
            <input name="port" type="number" min="1" max="65535" value="${escapeHtml(state.draft.port)}" required />
          </label>
        </div>
        <label>
          <span>Tags</span>
          <input name="tags" value="${escapeHtml(state.draft.tags)}" placeholder="ssh, okta, RC" />
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" value="${escapeHtml(state.draft.password)}" placeholder="SSH password" required />
        </label>
        <footer>
          <div>
            ${isEdit ? `<button class="modal-danger" type="button" data-action="delete-host">Delete</button>` : ""}
          </div>
          <div>
            <button class="modal-secondary" type="button" data-action="close-modal">Cancel</button>
            <button class="modal-primary" type="submit">${isEdit ? "Save changes" : "Save"}</button>
          </div>
        </footer>
      </form>
    </div>
  `;
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

app.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  if (target.name === "query") {
    const s = target.selectionStart ?? target.value.length;
    const e = target.selectionEnd ?? s;
    state.query = target.value;
    render();
    focusSearchInput(s, e);
    return;
  }

  if (target.name === "pfQuery") {
    const s = target.selectionStart ?? target.value.length;
    const e = target.selectionEnd ?? s;
    state.pfQuery = target.value;
    render();
    focusPfSearchInput(s, e);
    return;
  }

  if (target.dataset.pfHostQuery) {
    state.pfHostQuery = target.value;
    render();
    // keep focus on the drawer search input
    const inp = document.querySelector("[data-pf-host-query]");
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    return;
  }


  if (target.name === "newTabQuery") {
    const s = target.selectionStart ?? target.value.length;
    const e = target.selectionEnd ?? s;
    state.newTabQuery = target.value;
    render();
    focusNewTabSearchInput(s, e);
    return;
  }

  if (target.name === "sftpHostSelectorQuery") {
    const side = target.dataset.side || "left";
    vm.getPanel(side).hostSelectorQuery = target.value;
    render();
    window.setTimeout(() => { document.querySelector(`input[name="sftpHostSelectorQuery"][data-side="${side}"]`)?.focus(); }, 0);
    return;
  }

  if (target.name === "sftpRenameValue") {
    const side = target.closest("[data-side]")?.dataset.side || state.sftpActivePanel;
    runWithoutStateUpdates(() => {
      vm.getPanel(side).renameValue = target.value;
    });
    return;
  }

  if (target.name === "sftpMkdirValue") {
    const side = target.closest("[data-side]")?.dataset.side || state.sftpActivePanel;
    runWithoutStateUpdates(() => {
      vm.getPanel(side).mkdirValue = target.value;
    });
    return;
  }

  if (target.name in state.draft) {
    runWithoutStateUpdates(() => {
      state.draft[target.name] = target.value;
    });
  }
});

app.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.dataset.form === "host") vm.saveHost(event);
  if (form.dataset.form === "sftp-rename") {
    const side = form.dataset.side || state.sftpActivePanel;
    vm.sftpPanelConfirmRename(side);
  }
  if (form.dataset.form === "sftp-mkdir") {
    const side = form.dataset.side || state.sftpActivePanel;
    vm.sftpPanelConfirmMkdir(side);
  }

});

// Keyboard events for terminal handled by xterm.js directly
app.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const hostId = target.dataset.hostId;
  if (hostId && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    vm.connectHostById(hostId);
    return;
  }

  const newTabHostId = target.dataset.newTabHostId;
  if (newTabHostId && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    vm.connectHost(vm.findHost(newTabHostId), state.activeTabId);
    return;
  }

  const sftpConnectId = target.dataset.sftpConnectId;
  if (sftpConnectId && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    const host = vm.findHost(sftpConnectId);
    const side = target.dataset.side || "right";
    if (host) vm.sftpPanelConnectToHost(side, host);
    return;
  }

  if (
    state.activeView === "sftp" &&
    !target.closest("input, textarea, select") &&
    ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)
  ) {
    const side = target.closest(".sftp-pane[data-sftp-side]")?.dataset.sftpSide || state.sftpActivePanel;
    const pane = document.querySelector(`.sftp-pane[data-sftp-side="${side}"]`);
    const scroller = pane?.querySelector(".sftp-table-wrap");
    if (scroller) {
      event.preventDefault();
      if (event.key === "ArrowDown") scroller.scrollTop += 40;
      if (event.key === "ArrowUp") scroller.scrollTop -= 40;
      if (event.key === "PageDown") scroller.scrollTop += scroller.clientHeight * 0.85;
      if (event.key === "PageUp") scroller.scrollTop -= scroller.clientHeight * 0.85;
      if (event.key === "Home") scroller.scrollTop = 0;
      if (event.key === "End") scroller.scrollTop = scroller.scrollHeight;
      return;
    }
  }


  const terminalId = target.dataset.terminalId;
  if (!terminalId) return;

  const data = keyToTerminalData(event);
  if (!data) {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) event.preventDefault();
    return;
  }
  event.preventDefault();
  api("write_ssh_session", { id: terminalId, data }).catch((error) => {
    state.error = readableError(error);
    render();
  });
});

app.addEventListener("paste", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const terminalId = target.dataset.terminalId;
  if (!terminalId) return;
  const text = event.clipboardData?.getData("text");
  if (!text) return;
  event.preventDefault();
  api("write_ssh_session", { id: terminalId, data: text }).catch((error) => {
    state.error = readableError(error);
    render();
  });
});

app.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Element) || event.button !== 0 || event.pointerType === "touch") return;
  const fileRow = event.target.closest("[data-sftp-file-path]");
  if (!fileRow) return;
  const item = sftpItemFromRow(fileRow);
  if (!item) return;

  sftpPointerDrag = {
    item,
    sourceRow: fileRow,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    ghost: null,
  };
  fileRow.setPointerCapture?.(event.pointerId);
});

app.addEventListener("pointermove", (event) => {
  const drag = sftpPointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.dragging && distance >= 6) startSftpPointerDrag(event);
  if (!drag.dragging) return;

  event.preventDefault();
  updateSftpPointerGhost(event);

  const pane = sftpPaneAtPoint(event.clientX, event.clientY);
  clearSftpDropHighlights();
  if (pane) {
    pane.classList.add("drag-over");
    const scroller = pane.querySelector(".sftp-table-wrap");
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (event.clientY < rect.top + 36) scroller.scrollTop -= 16;
      if (event.clientY > rect.bottom - 36) scroller.scrollTop += 16;
    }
  }
});

app.addEventListener("pointerup", finishSftpPointerDrag);
app.addEventListener("pointercancel", finishSftpPointerDrag);

app.addEventListener("dragstart", (e) => {
  const fileRow = e.target.closest("[data-sftp-file-path]");
  if (!fileRow || !e.dataTransfer) return;
  const item = sftpItemFromRow(fileRow);
  if (!item) return;

  currentSftpDragItem = item;
  const payload = JSON.stringify(currentSftpDragItem);
  e.dataTransfer.setData(SFTP_DRAG_MIME, payload);
  e.dataTransfer.setData("application/x-sftp-item", payload);
  e.dataTransfer.setData("text/plain", payload);
  e.dataTransfer.effectAllowed = "copy";
  e.target.style.opacity = "0.5";
});

app.addEventListener("dragend", (e) => {
  const fileRow = e.target.closest("[data-sftp-file-path]");
  if (fileRow) fileRow.style.opacity = "";
  currentSftpDragItem = null;
  document.querySelectorAll(".sftp-pane").forEach(p => p.classList.remove("drag-over"));
});

app.addEventListener("dragenter", (e) => {
  const pane = e.target.closest(".sftp-pane");
  if (!pane) return;
  e.preventDefault();
});

app.addEventListener("dragover", (e) => {
  const pane = e.target.closest(".sftp-pane");
  if (!pane) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  pane.classList.add("drag-over");
});

app.addEventListener("dragleave", (e) => {
  const pane = e.target.closest(".sftp-pane");
  if (pane) pane.classList.remove("drag-over");
});

app.addEventListener("drop", (e) => {
  const pane = e.target.closest(".sftp-pane");
  if (pane) pane.classList.remove("drag-over");
  
  const targetSide = pane?.dataset.sftpSide;
  if (!targetSide) return;
  e.preventDefault();
  
  const targetPanel = vm.getPanel(targetSide);
  if (!targetPanel.path || targetPanel.connecting || targetPanel.loading) return;

  const item = readSftpDragItem(e.dataTransfer);
  if (item) {
    transferDroppedSftpItem(item, targetSide, targetPanel).finally(() => {
      currentSftpDragItem = null;
    });
  } else if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
    if (targetPanel.type !== "sftp") {
      state.notice = "You can only drop external files into a remote SFTP panel.";
      render();
      return;
    }
    const newUploads = [];
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      const file = e.dataTransfer.files[i];
      if (file.path) {
        newUploads.push({
          id: Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
          path: file.path,
          name: file.name
        });
      }
    }
    
    if (newUploads.length > 0) {
      const dir = targetPanel.path.endsWith("/") ? targetPanel.path : targetPanel.path + "/";
      newUploads.forEach(u => {
        state.sftpUploadQueue.push({
          id: u.id, name: u.name, path: sftpJoinPath(targetPanel.path, u.name),
          size: 0, loaded: 0, done: false, type: "upload"
        });
      });
      vm.ensureSftpProgressListener();
      render();
      api("sftp_upload_local_files", {
        sessionId: targetPanel.sessionId,
        remoteDir: dir,
        files: newUploads.map(u => ({ path: u.path, id: u.id }))
      }).then(() => vm.sftpPanelReload(targetSide)).catch(err => {
        targetPanel.error = err.toString(); render();
      });
    }
  }
});

app.addEventListener("wheel", (event) => {
  if (!(event.target instanceof Element) || state.activeView !== "sftp") return;
  const pane = event.target.closest(".sftp-pane[data-sftp-side]");
  const scroller = pane?.querySelector(".sftp-table-wrap");
  if (!scroller) return;

  const canScrollY = scroller.scrollHeight > scroller.clientHeight;
  if (!canScrollY) return;

  scroller.scrollTop += event.deltaY;
  rememberSftpScrollerPosition(scroller);
  if (event.deltaY !== 0) event.preventDefault();
}, { passive: false });

app.addEventListener("scroll", (event) => {
  if (!(event.target instanceof Element) || state.activeView !== "sftp") return;
  if (event.target.classList.contains("sftp-table-wrap")) {
    rememberSftpScrollerPosition(event.target);
  }
}, true);

app.addEventListener("contextmenu", (event) => {
  if (!(event.target instanceof Element)) return;
  const fileRow = event.target.closest("[data-sftp-file-path]");
  if (!fileRow) return;

  event.preventDefault();
  const side = fileRow.dataset.side || state.sftpActivePanel;
  const panel = vm.getPanel(side);
  const file = panel.files.find((f) => f.path === fileRow.dataset.sftpFilePath);
  if (!file) return;

  renderPreservingSftpScroll(() => {
    state.sftpActivePanel = side;
    panel.selectedFile = file;
    state.sftpContextMenu = {
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 120),
      side,
      file,
    };
  });
});

app.addEventListener("click", (event) => {
  if (suppressNextSftpClick && event.target instanceof Element && event.target.closest("[data-sftp-file-path]")) {
    suppressNextSftpClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  suppressNextSftpClick = false;

  if (state.sftpContextMenu && event.target instanceof Element && !event.target.closest(".sftp-context-menu")) {
    state.sftpContextMenu = null;
    render();
    return;
  }

  // Edit host button
  const editButton = event.target.closest("[data-edit-host-id]");
  if (editButton) {
    event.stopPropagation();
    lastHostClick = { id: null, at: 0 };
    vm.openEditHostModal(editButton.dataset.editHostId);
    return;
  }

  // SFTP breadcrumb path
  const crumbBtn = event.target.closest("[data-sftp-path]");
  if (crumbBtn) {
    const side = crumbBtn.dataset.side || state.sftpActivePanel;
    state.sftpActivePanel = side;
    vm.sftpPanelNavigateTo(side, crumbBtn.dataset.sftpPath);
    return;
  }

  // SFTP navigate up (..)
  const upRow = event.target.closest("[data-sftp-navigate-up]");
  if (upRow) {
    const side = upRow.dataset.side || state.sftpActivePanel;
    vm.sftpPanelNavigateUp(side);
    return;
  }

  // SFTP file row — single click to select
  const fileRow = event.target.closest("[data-sftp-file-path]");
  if (fileRow && !event.target.closest("[data-sftp-path]")) {
    const path = fileRow.dataset.sftpFilePath;
    const side = fileRow.dataset.side || state.sftpActivePanel;
    const panel = vm.getPanel(side);
    const file = panel.files.find((f) => f.path === path);
    if (file?.isDir && panel.selectedFile?.path === path) {
      vm.sftpPanelNavigateTo(side, path);
      return;
    }
    renderPreservingSftpScroll(() => {
      state.sftpActivePanel = side;
      panel.selectedFile = file || null;
    });
    document.querySelector(`.sftp-pane[data-sftp-side="${side}"]`)?.focus({ preventScroll: true });
    return;
  }

  // SFTP connect to host from host selector
  // SFTP Cancel Connect
  const cancelConnectBtn = event.target.closest("[data-action=\"sftp-cancel-connect\"]");
  if (cancelConnectBtn) {
    const side = cancelConnectBtn.dataset.side;
    const panel = vm.getPanel(side);
    panel.connecting = false;
    panel.connectingHost = null;
    panel.error = "";
    // If it was trying to connect but failed, we should probably open the host selector so they can try again or pick another
    panel.hostSelectorOpen = true;
    render();
    return;
  }
  const sftpConnectEl = event.target.closest("[data-sftp-connect-id]");
  if (sftpConnectEl) {
    const side = sftpConnectEl.dataset.side || "right";
    const host = vm.findHost(sftpConnectEl.dataset.sftpConnectId);
    if (host) vm.sftpPanelConnectToHost(side, host);
    return;
  }

  // SFTP switch to local
  const switchLocalEl = event.target.closest("[data-sftp-switch-local]");
  if (switchLocalEl) {
    const side = switchLocalEl.dataset.sftpSwitchLocal;
    vm.sftpPanelSwitchToLocal(side);
    return;
  }

  // Click on SFTP pane — set active panel
  const paneEl = event.target.closest(".sftp-pane[data-sftp-side]");
  if (paneEl) {
    const side = paneEl.dataset.sftpSide;
    if (state.sftpActivePanel !== side) {
      renderPreservingSftpScroll(() => {
        state.sftpActivePanel = side;
      });
    }
    paneEl.focus({ preventScroll: true });
    // no render needed unless something changed
  }



  const button = event.target.closest("button");
  if (button) {
    // Tab management
    if (button.dataset.openTabId) {
      const tab = vm.findTab(button.dataset.openTabId);
      if (!tab) return;
      state.activeView = tab.type === "new-tab" ? "new-tab" : "host";
      state.activeTabId = tab.id;
      state.selectedId = tab.hostId || null;
      render();
      return;
    }
    if (button.dataset.closeTabId) {
      const id = button.dataset.closeTabId;
      vm.closeSessionTab(id);
      return;
    }

    // Action buttons
    const action = button.dataset.action;

    // Window controls
    if (action === "win-close") { getCurrentWindow().close(); return; }
    if (action === "win-minimize") { getCurrentWindow().minimize(); return; }
    if (action === "win-zoom") {
      getCurrentWindow().isMaximized().then((maximized) => {
        if (maximized) getCurrentWindow().unmaximize();
        else getCurrentWindow().maximize();
      });
      return;
    }

    if (action === "home") vm.openHome();
    if (action === "sftp") vm.openSftpView();
    if (action === "port-forwarding") {
      state.activeView = "port-forwarding";
      render();
    }
    if (action === "pf-new") {
      state.error = "";
      state.notice = "";
      state.pfDrawerOpen = true;
      state.pfDrawerStep = "select-remote-host";
      state.pfEditId = null;
      state.pfSaving = false;
      state.pfWizardDraft.rule_type = button.dataset.type || "Remote";
      state.pfWizardDraft.host_id = "";
      state.pfWizardDraft.bind_port = "";
      state.pfWizardDraft.target_port = "";
      state.pfWizardDraft.target_address = "localhost";
      state.pfWizardDraft.bind_address = "";
      state.pfWizardDraft.name = "";
      state.pfWizardDraft.tags = "";
      state.pfWizardDraft.group = "";
      state.pfHostQuery = "";
      render();
    }
    if (action === "pf-drawer-close") {
      state.pfDrawerOpen = false;
      state.pfEditId = null;
      state.pfSaving = false;
      render();
    }
    if (action === "pf-drawer-back") {
      if (state.pfDrawerStep === "select-remote-host") state.pfDrawerOpen = false;
      else if (state.pfDrawerStep === "edit") {
        state.pfDrawerOpen = false;
        state.pfEditId = null;
      }
      else if (state.pfDrawerStep === "select-host") state.pfDrawerStep = "select-remote-host";
      else if (state.pfDrawerStep === "details") state.pfDrawerStep = "select-host";
      else if (state.pfDrawerStep === "destination") state.pfDrawerStep = "details";
      else if (state.pfDrawerStep === "bind") state.pfDrawerStep = "destination";
      render();
    }
    if (action === "pf-drawer-to-select-host") {
      state.pfDrawerStep = "select-host";
      render();
      // focus search after render
      window.setTimeout(() => {
        const input = document.querySelector("[data-pf-host-query]");
        if (input) input.focus();
      }, 50);
    }
    if (action === "pf-select-host") {
      state.pfWizardDraft.host_id = button.dataset.id;
      const host = vm.findHost(button.dataset.id);
      if (!state.pfWizardDraft.name && host) state.pfWizardDraft.name = host.name;
      if (state.pfDrawerStep === "select-host") {
        state.pfDrawerStep = "details";
      }
      render();
    }
    if (action === "pf-drawer-to-destination") {
      const nameInput = document.getElementById("pfRuleName");
      const tagsInput = document.getElementById("pfRuleTags");
      const groupInput = document.getElementById("pfRuleGroup");
      const name = nameInput?.value.trim();
      if (!name) {
        nameInput?.focus();
        nameInput?.reportValidity();
        return;
      }
      state.pfWizardDraft.name = name;
      state.pfWizardDraft.tags = tagsInput?.value.trim() || "";
      state.pfWizardDraft.group = groupInput?.value.trim() || "";
      state.pfDrawerStep = "destination";
      render();
    }
    if (action === "pf-drawer-to-bind") {
      const destAddr = document.getElementById("pfDestAddr");
      const destPort = document.getElementById("pfDestPort");
      const addr = destAddr?.value.trim();
      const port = parseInt(destPort?.value, 10);
      if (!addr) {
        destAddr?.focus();
        destAddr?.reportValidity();
        return;
      }
      if (!port || port < 1 || port > 65535) {
        destPort?.focus();
        return;
      }
      state.pfWizardDraft.target_address = addr;
      state.pfWizardDraft.target_port = port;
      state.pfDrawerStep = "bind";
      render();
    }
    if (action === "pf-drawer-save") {
      (async () => {
        if (state.pfSaving) return;
        const bindPort = document.getElementById("pfBindPort");
        const bindAddr = document.getElementById("pfBindAddr");
        const port = parseInt(bindPort?.value, 10);
        if (!port || port < 1 || port > 65535) {
          bindPort?.focus();
          bindPort?.reportValidity();
          return;
        }
        state.pfWizardDraft.bind_port = port;
        state.pfWizardDraft.bind_address = bindAddr?.value.trim() || "";
        const host = vm.findHost(state.pfWizardDraft.host_id);
        const hostName = host ? host.name : "Host";
        const ruleType = state.pfWizardDraft.rule_type;
        if (!state.pfWizardDraft.name) {
          state.pfWizardDraft.name = `${ruleType}: ${hostName} :${state.pfWizardDraft.bind_port} → ${state.pfWizardDraft.target_address}:${state.pfWizardDraft.target_port}`;
        }
        const activePortOwner = vm.activePfPortOwner(state.pfWizardDraft);
        if (activePortOwner) {
          state.error = `Port ${state.pfWizardDraft.bind_port} is already used by ${activePortOwner.name}. Stop it before starting another tunnel on the same port.`;
          render();
          return;
        }
        state.error = "";
        state.notice = "";
        state.pfSaving = true;
        render();
        try {
          const rule = vm.normalizePfRule(await api("create_pf_rule", { draft: vm.pfDraftPayload(state.pfWizardDraft) }));
          state.pfDrawerOpen = false;
          state.pfSaving = false;
          state.activeView = "port-forwarding";
          await vm.loadConnections();
          // Auto-start the tunnel
          if (rule && rule.id) {
            state.pfStatusById[rule.id] = "connecting";
            schedulePfStartTimeout(rule.id);
            render();
            try {
              await api("start_port_forwarding", { ruleId: rule.id });
            } catch (error) {
              clearPfStartTimeout(rule.id);
              state.pfStatusById[rule.id] = "failed";
              state.error = readableError(error);
              render();
            }
          }
        } catch (e) {
          state.pfSaving = false;
          state.error = readableError(e);
          render();
        }
      })();
    }

    if (action === "pf-edit") {
      const rule = state.pfRules.find((item) => item.id === button.dataset.id);
      if (!rule) return;
      state.error = "";
      state.notice = "";
      state.pfEditId = rule.id;
      state.pfSaving = false;
      state.pfDrawerOpen = true;
      state.pfDrawerStep = "edit";
      state.pfWizardDraft = vm.pfDraftFromRule(rule);
      render();
    }

    if (action === "pf-edit-save") {
      (async () => {
        if (state.pfSaving) return;
        const id = state.pfEditId;
        if (!id) return;

        const nameInput = document.getElementById("pfEditName");
        const tagsInput = document.getElementById("pfEditTags");
        const groupInput = document.getElementById("pfEditGroup");
        const hostInput = document.getElementById("pfEditHost");
        const bindPortInput = document.getElementById("pfEditBindPort");
        const bindAddrInput = document.getElementById("pfEditBindAddr");
        const destAddrInput = document.getElementById("pfEditDestAddr");
        const destPortInput = document.getElementById("pfEditDestPort");

        const name = nameInput?.value.trim();
        const bindPort = parseInt(bindPortInput?.value, 10);
        const destAddr = destAddrInput?.value.trim();
        const destPort = parseInt(destPortInput?.value, 10);

        if (!name) {
          nameInput?.focus();
          nameInput?.reportValidity();
          return;
        }
        if (!hostInput?.value) {
          hostInput?.focus();
          hostInput?.reportValidity();
          return;
        }
        if (!bindPort || bindPort < 1 || bindPort > 65535) {
          bindPortInput?.focus();
          bindPortInput?.reportValidity();
          return;
        }
        if (!destAddr) {
          destAddrInput?.focus();
          destAddrInput?.reportValidity();
          return;
        }
        if (!destPort || destPort < 1 || destPort > 65535) {
          destPortInput?.focus();
          destPortInput?.reportValidity();
          return;
        }

        state.pfWizardDraft = {
          name,
          tags: tagsInput?.value.trim() || "",
          group: groupInput?.value.trim() || "",
          rule_type: "Local",
          host_id: hostInput.value,
          bind_address: bindAddrInput?.value.trim() || "",
          bind_port: bindPort,
          target_address: destAddr,
          target_port: destPort,
        };
        const activePortOwner = vm.activePfPortOwner({ ...state.pfWizardDraft, id });
        if (activePortOwner) {
          state.error = `Port ${state.pfWizardDraft.bind_port} is already used by ${activePortOwner.name}. Stop it before starting another tunnel on the same port.`;
          render();
          return;
        }
        state.error = "";
        state.notice = "";
        state.pfSaving = true;
        render();

        try {
          const rule = vm.normalizePfRule(await api("update_pf_rule", { id, draft: vm.pfDraftPayload(state.pfWizardDraft) }));
          state.pfDrawerOpen = false;
          state.pfEditId = null;
          state.pfSaving = false;
          state.activeView = "port-forwarding";
          await vm.loadConnections();
          if (rule && rule.id) {
            await api("stop_port_forwarding", { ruleId: rule.id }).catch(() => {});
            state.pfStatusById[rule.id] = "connecting";
            schedulePfStartTimeout(rule.id);
            render();
            try {
              await api("start_port_forwarding", { ruleId: rule.id });
            } catch (error) {
              clearPfStartTimeout(rule.id);
              state.pfStatusById[rule.id] = "failed";
              state.error = readableError(error);
              render();
            }
          }
        } catch (error) {
          state.pfSaving = false;
          state.error = readableError(error);
          render();
        }
      })();
    }

    if (action === "pf-delete") {
      state.pfDeleteId = button.dataset.id;
      render();
    }
    if (action === "close-pf-delete") {
      state.pfDeleteId = null;
      render();
    }
    if (action === "close-pf-timeout") {
      const id = state.pfTimeoutRuleId;
      if (id) {
        clearPfStartTimeout(id);
        state.pfStatusById[id] = "closed";
      }
      state.pfTimeoutRuleId = null;
      render();
    }
    if (action === "pf-confirm-delete") {
      (async () => {
        const id = state.pfDeleteId;
        if (!id) return;
        state.pfDeleteId = null;
        state.error = "";
        try {
          await api("stop_port_forwarding", { ruleId: id }).catch(() => {});
          await api("delete_pf_rule", { id });
          clearPfStartTimeout(id);
          delete state.pfStatusById[id];
          await vm.loadConnections();
        } catch (error) {
          state.error = readableError(error);
          render();
        }
      })();
    }
    if (action === "pf-start") {
      (async () => {
        const id = button.dataset.id;
        const rule = state.pfRules.find((item) => item.id === id);
        if (!rule) return;
        const activePortOwner = vm.activePfPortOwner(rule);
        if (activePortOwner) {
          state.error = `Port ${rule.bind_port} is already used by ${activePortOwner.name}. Stop it before starting another tunnel on the same port.`;
          render();
          return;
        }
        state.pfStatusById[id] = "connecting";
        state.error = "";
        schedulePfStartTimeout(id);
        render();
        try {
          await api("start_port_forwarding", { ruleId: id });
        } catch (error) {
          clearPfStartTimeout(id);
          state.pfStatusById[id] = "failed";
          state.error = readableError(error);
          render();
        }
      })();
    }
    if (action === "pf-stop") {
      (async () => {
        const id = button.dataset.id;
        await api("stop_port_forwarding", { ruleId: id });
        clearPfStartTimeout(id);
        state.pfStatusById[id] = "closed";
        render();
      })();
    }
    if (action === "new-tab" || action === "open-new-tab") vm.openNewTab();
    if (action === "new-host") vm.openNewHostModal();
    if (action === "close-modal") vm.closeHostModal();
    if (action === "delete-host") vm.deleteSelectedHost();
    if (action === "connect") vm.connectSelectedHost();
    if (action === "close-session") vm.closeActiveSession();

    // SFTP actions
    if (action === "sftp-actions-toggle") {
      const side = button.dataset.side || state.sftpActivePanel;
      const panel = vm.getPanel(side);
      renderPreservingSftpScroll(() => {
        state.sftpActivePanel = side;
        panel.actionsOpen = !panel.actionsOpen;
        vm.getPanel(side === "left" ? "right" : "left").actionsOpen = false;
      });
      return;
    }
    // Close actions menu when clicking a menu item
    if (
      action === "sftp-upload" ||
      action === "sftp-download" ||
      action === "sftp-mkdir" ||
      action === "sftp-rename" ||
      action === "sftp-delete"
    ) {
      const side = button.dataset.side || state.sftpActivePanel;
      runWithoutStateUpdates(() => {
        vm.getPanel(side).actionsOpen = false;
      });
      button.closest(".sftp-action-group")?.classList.remove("open");
    }
    
    if (action === "sftp-open-rename") {
      const side = button.dataset.side || state.sftpContextMenu?.side || state.sftpActivePanel;
      state.sftpContextMenu = null;
      state.sftpActivePanel = side;
      const panel = vm.getPanel(side);
      if (panel.selectedFile) {
        panel.renameValue = panel.selectedFile.name;
        panel.renameOpen = true;
        render();
        window.setTimeout(() => document.querySelector(`form[data-form="sftp-rename"][data-side="${side}"] input[name="sftpRenameValue"]`)?.focus(), 0);
      }
      return;
    }

    if (action === "sftp-open-delete") {
      const side = button.dataset.side || state.sftpContextMenu?.side || state.sftpActivePanel;
      state.sftpContextMenu = null; // hide menu
      state.sftpActivePanel = side;
      const panel = vm.getPanel(side);
      if (panel.selectedFile) {
        panel.deleteOpen = true;
        render();
      }
      return;
    }
    if (action === "sftp-open-host-selector") {
      const side = button.dataset.side || state.sftpActivePanel;
      state.sftpActivePanel = side;
      const panel = vm.getPanel(side);
      panel.hostSelectorOpen = true;
      panel.actionsOpen = false;
      render();
      window.setTimeout(() => { document.querySelector(`input[name="sftpHostSelectorQuery"][data-side="${side}"]`)?.focus(); }, 0);
    }
    if (action === "sftp-close-host-selector") {
      const side = button.dataset.side || state.sftpActivePanel;
      vm.getPanel(side).hostSelectorOpen = false;
      render();
    }

    if (action === "sftp-back") vm.sftpPanelNavigateBack(button.dataset.side || state.sftpActivePanel);
    if (action === "sftp-forward") vm.sftpPanelNavigateForward(button.dataset.side || state.sftpActivePanel);
    if (action === "sftp-reload") vm.sftpPanelReload(button.dataset.side || state.sftpActivePanel);
    if (action === "sftp-upload") vm.sftpTriggerUpload(button.dataset.side || state.sftpActivePanel);
    if (action === "sftp-download") vm.sftpPanelDownloadSelected(button.dataset.side || state.sftpActivePanel);
    if (action === "sftp-delete") {
      const side = button.dataset.side || state.sftpActivePanel;
      const panel = vm.getPanel(side);
      if (panel.selectedFile) {
        panel.deleteOpen = true;
        render();
      }
    }
    if (action === "sftp-confirm-delete") vm.sftpPanelDeleteSelected(button.dataset.side || state.sftpActivePanel);
    if (action === "close-sftp-delete") {
      const side = button.dataset.side || state.sftpActivePanel;
      vm.getPanel(side).deleteOpen = false;
      render();
    }
    if (action === "sftp-cancel-upload") {
      const id = button.dataset.uploadId;
      if (id) {
        api("sftp_cancel_transfer", { id }).catch(() => {});
        state.sftpUploadQueue = state.sftpUploadQueue.filter(item => item.id !== id);
        render();
      }
      return;
    }
    if (action === "sftp-dismiss-upload") { state.sftpUploadQueue = []; render(); }
    if (action === "sftp-rename") {
      const side = button.dataset.side || state.sftpActivePanel;
      const panel = vm.getPanel(side);
      if (panel.selectedFile) {
        panel.renameValue = panel.selectedFile.name;
        panel.renameOpen = true;
        render();
        window.setTimeout(() => document.querySelector(`form[data-form="sftp-rename"][data-side="${side}"] input[name="sftpRenameValue"]`)?.focus(), 0);
      }
    }
    if (action === "sftp-mkdir") {
      const side = button.dataset.side || state.sftpActivePanel;
      const panel = vm.getPanel(side);
      if (panel.type === "sftp") {
        panel.mkdirValue = "";
        panel.mkdirOpen = true;
        render();
        window.setTimeout(() => document.querySelector(`form[data-form="sftp-mkdir"][data-side="${side}"] input[name="sftpMkdirValue"]`)?.focus(), 0);
      }
    }
    if (action === "close-sftp-rename") {
      const side = button.dataset.side || state.sftpActivePanel;
      vm.getPanel(side).renameOpen = false;
      render();
    }
    if (action === "close-sftp-mkdir") {
      const side = button.dataset.side || state.sftpActivePanel;
      vm.getPanel(side).mkdirOpen = false;
      render();
    }
    if (action === "sftp-clear-error") {
      const side = button.dataset.side || state.sftpActivePanel;
      vm.getPanel(side).error = "";
      render();
    }
    if (action === "close-pf-toast") {
      const toastId = button.dataset.toastId;
      if (toastId && state.pfToasts) {
        state.pfToasts = state.pfToasts.filter(t => t.id !== toastId);
        render();
      }
    }
    if (action === "close-ssh-toast") {
      const toastId = button.dataset.toastId;
      if (toastId && state.sshToasts) {
        state.sshToasts = state.sshToasts.filter(t => t.id !== toastId);
        render();
      }
    }

    return;
  }

  const hostCardElement = event.target.closest("[data-host-id]");
  if (hostCardElement) {
    const hostId = hostCardElement.dataset.hostId;
    const now = Date.now();
    if (lastHostClick.id === hostId && now - lastHostClick.at < 420) {
      lastHostClick = { id: null, at: 0 };
      vm.connectHostById(hostId);
      return;
    }
    lastHostClick = { id: hostId, at: now };
    state.selectedId = hostId;
    state.error = "";
    if (state.modalOpen) {
      vm.closeHostModal();
      return;
    }
    render();
  }
});

app.addEventListener("dblclick", (event) => {
  if (event.target.closest("[data-edit-host-id]")) return;

  // SFTP double-click directory
  const fileRow = event.target.closest("[data-sftp-file-path]");
  if (fileRow) {
    const path = fileRow.dataset.sftpFilePath;
    const isDir = fileRow.dataset.sftpFileIsDir === "true";
    if (isDir) sftpNavigateTo(path);
    return;
  }

  const recentRow = event.target.closest("[data-new-tab-host-id]");
  if (recentRow) {
    vm.connectHost(vm.findHost(recentRow.dataset.newTabHostId), state.activeTabId);
  }
});

// ─── Terminal Helpers ─────────────────────────────────────────────────────────



export function isTerminalStatus(status) {
  return status === "interactive" || status === "connected";
}

export function keyToTerminalData(event) {
  if (event.ctrlKey && event.key.toLowerCase() === "c") return "\x03";
  if (event.ctrlKey && event.key.toLowerCase() === "d") return "\x04";
  if (event.ctrlKey && event.key.toLowerCase() === "l") return "\x0c";
  if (event.key === "Enter") return "\r";
  if (event.key === "Backspace") return "\x7f";
  if (event.key === "Delete") return "\x1b[3~";
  if (event.key === "Tab") return "\t";
  if (event.key === "ArrowUp") return "\x1b[A";
  if (event.key === "ArrowDown") return "\x1b[B";
  if (event.key === "ArrowRight") return "\x1b[C";
  if (event.key === "ArrowLeft") return "\x1b[D";
  if (event.key === "Home") return "\x1b[H";
  if (event.key === "End") return "\x1b[F";
  if (event.key === "PageUp") return "\x1b[5~";
  if (event.key === "PageDown") return "\x1b[6~";
  if (event.key.length === 1 && !event.metaKey) return event.key;
  return "";
}

export function applyTerminalOutput(previous, data) {
  let output = previous || "";
  const text = String(data ?? "").replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\x1b") {
      const next = text[index + 1];
      if (next === "c") { output = ""; index += 1; continue; }
      if (next === "[") {
        const end = findAnsiSequenceEnd(text, index + 2);
        if (end === -1) continue;
        const sequence = text.slice(index + 2, end + 1);
        const finalByte = sequence.at(-1);
        const params = sequence.slice(0, -1);
        if (finalByte === "J" && (params === "2" || params === "3")) output = "";
        index = end;
        continue;
      }
      continue;
    }
    if (character === "\r") { if (text[index + 1] === "\n") index += 1; output += "\n"; continue; }
    if (character === "\n" || character === "\t") { output += character; continue; }
    if (character === "\b" || character === "\x7f") { output = output.slice(0, -1); continue; }
    if (character >= " ") output += character;
  }
  return output;
}

export function findAnsiSequenceEnd(text, start) {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

export function terminalHtml(output) {
  return escapeHtml(output).replace(
    /(^|\n)(?!root@)([A-Za-z0-9._-]+@[A-Za-z0-9._-]+)(?=:[^\n]*[$#])/g,
    '$1<span class="terminal-user">$2</span>',
  );
}

export async function setupSessionListeners() {
  if (!isTauri) return;

  await listen("ssh-session-output", (event) => {
    const { id, data } = event.payload;
    if (!state.sessionStatusById[id] && !vm.findTab(id)) return;
    if (xtermInstancesById[id]) {
      xtermInstancesById[id].write(data);
    } else {
      state.terminalOutputById[id] = (state.terminalOutputById[id] || "") + data;
    }
  });

  await listen("ssh-session-status", (event) => {
    const { id, status } = event.payload;
    const previousStatus = state.sessionStatusById[id];
    if (!previousStatus && !vm.findTab(id)) return;

    if (status === "failed" || (status === "closed" && !isTerminalStatus(previousStatus))) {
      const failedTab = vm.findTab(id);
      const failedHost = failedTab?.hostId ? vm.findHost(failedTab.hostId) : null;
      vm.showSshErrorToast(failedHost);
      vm.closeSessionTab(id, {
        returnHome: true,
        error: "",
        stopSession: status !== "closed",
      });
      return;
    }

    state.sessionStatusById[id] =
      status === "closed" && isTerminalStatus(previousStatus) ? previousStatus : status;
    render();
    focusActiveTerminal();
  });

  await listen("pf-status", (event) => {
    const { id, status } = event.payload;
    clearPfStartTimeout(id);
    state.pfStatusById[id] = status;
    if (status === "failed") {
      state.pfStatusById[id] = "closed";
      showPfErrorToast(id);
    } else if (status === "connected") {
      // Nothing needed
    }
    render();
  });
}

export function attachTerminal(tabId) {
  const container = document.querySelector(`.embedded-terminal-container[data-terminal-id="${tabId}"]`);
  if (!container) return;

  if (!xtermInstancesById[tabId]) {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 14,
      theme: {
      background: '#102233',
      foreground: '#e5e5ea',
        cursor: '#0a84ff',
        selectionBackground: 'rgba(10, 132, 255, 0.3)',
      }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    
    setTimeout(() => {
      fitAddon.fit();
      api("resize_ssh_session", { id: tabId, cols: term.cols, rows: term.rows }).catch(console.error);
    }, 50);

    term.onData((data) => {
      api("write_ssh_session", { id: tabId, data }).catch(console.error);
    });
    term.onResize(({ cols, rows }) => {
      api("resize_ssh_session", { id: tabId, cols, rows }).catch(console.error);
    });
    xtermInstancesById[tabId] = term;
    fitAddonsById[tabId] = fitAddon;

    if (state.terminalOutputById[tabId]) {
      term.write(state.terminalOutputById[tabId]);
      state.terminalOutputById[tabId] = "";
    }
  } else {
    const term = xtermInstancesById[tabId];
    if (container.firstChild !== term.element) {
      container.innerHTML = "";
      container.appendChild(term.element);
      fitAddonsById[tabId].fit();
    }
  }
}

export function focusActiveTerminal() {
  window.setTimeout(() => {
    if (state.activeTabId && xtermInstancesById[state.activeTabId]) {
      xtermInstancesById[state.activeTabId].focus();
    }
  }, 0);
}

export function focusSearchInput(selectionStart, selectionEnd = selectionStart) {
  window.setTimeout(() => {
    const input = document.querySelector('input[name="query"]');
    if (!(input instanceof HTMLInputElement)) return;
    input.focus();
    input.setSelectionRange(selectionStart, selectionEnd);
  }, 0);
}

export function focusNewTabSearchInput(selectionStart = state.newTabQuery.length, selectionEnd = selectionStart) {
  window.setTimeout(() => {
    const input = document.querySelector('input[name="newTabQuery"]');
    if (!(input instanceof HTMLInputElement)) return;
    input.focus();
    input.setSelectionRange(selectionStart, selectionEnd);
  }, 0);
}

export function focusPfSearchInput(selectionStart = state.pfQuery.length, selectionEnd = selectionStart) {
  window.setTimeout(() => {
    const input = document.querySelector('input[name="pfQuery"]');
    if (!(input instanceof HTMLInputElement)) return;
    input.focus();
    input.setSelectionRange(selectionStart, selectionEnd);
  }, 0);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ─── Icons ────────────────────────────────────────────────────────────────────

export function ubuntuIcon(size = "") {
  return `
    <span class="ubuntu-icon ${size}" aria-hidden="true" style="background: #de8654; display: inline-flex; align-items: center; justify-content: center; ${size === 'large' ? 'width: 36px; height: 36px; border-radius: 8px;' : 'width: 20px; height: 20px; border-radius: 6px;'}">
      <svg style="width: 70%; height: 70%; stroke-width: 2.2; color: #ffffff;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        <rect width="20" height="8" x="2" y="2" rx="2" ry="2"></rect>
        <rect width="20" height="8" x="2" y="14" rx="2" ry="2"></rect>
        <line x1="6" x2="6.01" y1="6" y2="6"></line>
        <line x1="6" x2="6.01" y1="18" y2="18"></line>
      </svg>
    </span>
  `;
}

export function icon(path, viewBox = "0 0 24 24") {
  return `<svg viewBox="${viewBox}" aria-hidden="true">${path}</svg>`;
}

export function vaultIcon() {
  return icon('<rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect>');
}

export function folderIcon() {
  return icon('<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path>');
}

export function portForwardingIcon() {
  return icon('<path d="m16 3 4 4-4 4"></path><path d="M20 7H4"></path><path d="m8 21-4-4 4-4"></path><path d="M4 17h16"></path>');
}

export function folderBigIcon() {
  return `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true" style="width:64px;height:64px;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M8 52h48a4 4 0 0 0 4-4V20a4 4 0 0 0-4-4H30a4 4 0 0 1-3.32-1.78L24.32 11A4 4 0 0 0 21 9H8a4 4 0 0 0-4 4v35c0 2.21 1.79 4 4 4Z"/></svg>`;
}

export function folderPlusIcon() {
  return icon('<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path><line x1="12" y1="10" x2="12" y2="16"></line><line x1="9" y1="13" x2="15" y2="13"></line>');
}

export function xIcon() {
  return icon('<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>');
}

export function plusIcon() {
  return icon('<path d="M5 12h14"></path><path d="M12 5v14"></path>');
}

export function serversIcon() {
  return icon('<rect width="20" height="8" x="2" y="2" rx="2" ry="2"></rect><rect width="20" height="8" x="2" y="14" rx="2" ry="2"></rect><line x1="6" x2="6.01" y1="6" y2="6"></line><line x1="6" x2="6.01" y1="18" y2="18"></line>');
}

export function forwardIcon() {
  return icon('<polyline points="15 17 20 12 15 7"></polyline><path d="M4 18v-2a4 4 0 0 1 4-4h12"></path>');
}

export function arrowRightIcon() {
  return icon('<path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>');
}

export function downIcon() {
  return icon('<polyline points="6 9 12 15 18 9"></polyline>');
}

export function chevronDownIcon() {
  return icon('<polyline points="6 9 12 15 18 9"></polyline>');
}

export function chevronIcon() {
  return icon('<polyline points="9 18 15 12 9 6"></polyline>');
}

export function pencilIcon() {
  return icon('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path>');
}

export function plugIcon() {
  return icon('<path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"></path>');
}

export function terminalIcon() {
  return icon('<polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line>');
}

export function rocketIcon() {
  return icon('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"></path><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path>');
}

export function uploadIcon() {
  return icon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line>');
}

export function downloadIcon() {
  return icon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>');
}

export function trashIcon() {
  return icon('<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>');
}

export function backIcon() {
  return icon('<path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path>');
}

export function searchIcon() {
  return icon('<circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path>');
}

export function arrowLeftIcon() {
  return icon('<line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline>');
}


export function navBackIcon() {
  return icon('<polyline points="15 18 9 12 15 6"></polyline>');
}

export function navForwardIcon() {
  return icon('<polyline points="9 18 15 12 9 6"></polyline>');
}

export function refreshIcon() {
  return icon('<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>');
}

export function spinnerIcon() {
  return `<svg viewBox="0 0 24 24" class="spinner-svg" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="0" fill="none"></circle></svg>`;
}

export function codeFileIcon() {
  return icon('<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>');
}

export function imageFileIcon() {
  return icon('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>');
}

export function archiveFileIcon() {
  return icon('<polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line>');
}

export function genericFileIcon() {
  return icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>');
}
