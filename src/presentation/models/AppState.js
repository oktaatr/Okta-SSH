import { EMPTY_DRAFT, EMPTY_PF_DRAFT } from "../../domain/entities.js";

// We create a reactive state container using Proxy
let stateUpdatesPaused = 0;

export function runWithoutStateUpdates(fn) {
  stateUpdatesPaused += 1;
  try {
    return fn();
  } finally {
    stateUpdatesPaused -= 1;
  }
}

export function createReactiveState(initialState, onUpdate) {
  const handler = {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'object' && value !== null) {
        return new Proxy(value, handler);
      }
      return value;
    },
    set(target, property, value, receiver) {
      const oldValue = Reflect.get(target, property, receiver);
      if (oldValue !== value) {
        const success = Reflect.set(target, property, value, receiver);
        if (success && stateUpdatesPaused === 0) {
          onUpdate();
        }
        return success;
      }
      return true;
    },
    deleteProperty(target, property) {
      const success = Reflect.deleteProperty(target, property);
      if (success && stateUpdatesPaused === 0) {
        onUpdate();
      }
      return success;
    }
  };
  return new Proxy(initialState, handler);
}

export const initialState = {
  connections: [],
  selectedId: null,
  openedTabs: [],
  activeTabId: null,
  activeView: "home",
  sessionStatusById: {},
  terminalOutputById: {},
  query: "",
  newTabQuery: "",
  modalOpen: false,
  modalMode: "new",
  draft: { ...EMPTY_DRAFT },
  error: "",
  notice: "",
  sftpActivePanel: "left",
  sftpUploadQueue: [],
  sftpContextMenu: null,
  sftpLeft: {
    type: "local",
    sessionId: null,
    connection: null,
    path: "",
    files: [],
    loading: false,
    connecting: false,
    connectingHost: null,
    error: "",
    history: [],
    historyIndex: -1,
    selectedFile: null,
    hostSelectorOpen: false,
    hostSelectorQuery: "",
    renameOpen: false,
    renameValue: "",
    mkdirOpen: false,
    mkdirValue: "",
    deleteOpen: false,
    actionsOpen: false,
  },
  sftpRight: {
    type: "empty",
    sessionId: null,
    connection: null,
    path: "",
    files: [],
    loading: false,
    connecting: false,
    connectingHost: null,
    error: "",
    history: [],
    historyIndex: -1,
    selectedFile: null,
    hostSelectorOpen: false,
    hostSelectorQuery: "",
    renameOpen: false,
    renameValue: "",
    mkdirOpen: false,
    mkdirValue: "",
    deleteOpen: false,
    actionsOpen: false,
  },
  pfRules: [],
  pfStatusById: {},
  pfQuery: "",
  pfSaving: false,
  pfDrawerOpen: false,
  pfEditId: null,
  pfDeleteId: null,
  pfTimeoutRuleId: null,
  pfStartTimeoutById: {},
  pfDrawerStep: "select-remote-host",
  pfWizardDraft: { ...EMPTY_PF_DRAFT },
  pfHostQuery: "",
  pfToasts: [],
  sshToasts: [],
};

let updateCallback = () => {};

export function setUpdateCallback(cb) {
  updateCallback = cb;
}

export const state = createReactiveState(initialState, () => {
  updateCallback();
});
