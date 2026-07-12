// @ts-check
// Minimal, typed IPC bridge. The renderer gets exactly this surface and nothing
// else — no Node, no ipcRenderer, no remote module. Every method maps to a
// single main-process handler.

// Sandboxed Electron preloads must be CommonJS; ESM imports are unavailable here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron')

/** Wrap a broadcast/stream channel as an unsubscribe-returning subscription. */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('hopit', {
  // Aggregate state for the sidebar/header/tray.
  getState: () => ipcRenderer.invoke('getState'),
  onStateUpdate: (callback) => subscribe('state:update', callback),

  // Per-project views (all read from the agent's HTTP endpoints).
  projectStatus: (codebaseId) => ipcRenderer.invoke('projectStatus', codebaseId),
  projectHistory: (codebaseId) => ipcRenderer.invoke('projectHistory', codebaseId),
  projectActivity: (codebaseId) => ipcRenderer.invoke('projectActivity', codebaseId),
  projectFiles: (codebaseId, subpath) => ipcRenderer.invoke('projectFiles', codebaseId, subpath ?? ''),

  // Actions (spawn hop).
  syncNow: (codebaseId) => ipcRenderer.invoke('syncNow', codebaseId),
  refreshNow: (codebaseId) => ipcRenderer.invoke('refreshNow', codebaseId),
  serviceControl: (action, codebaseId) => ipcRenderer.invoke('serviceControl', action, codebaseId),
  hydratePath: (codebaseId, cloudPath, options) => ipcRenderer.invoke('hydratePath', codebaseId, cloudPath, options ?? {}),
  pinPath: (codebaseId, cloudPath, pinned) => ipcRenderer.invoke('pinPath', codebaseId, cloudPath, pinned),

  // Filesystem-friendly helpers.
  revealPath: (targetPath, options) => ipcRenderer.invoke('revealPath', targetPath, options ?? {}),
  openDashboard: (codebaseId) => ipcRenderer.invoke('openDashboard', codebaseId),

  // Add-a-project flow.
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  inspectFolder: (folderPath) => ipcRenderer.invoke('inspectFolder', folderPath),
  addProject: (payload) => ipcRenderer.invoke('addProject', payload),
  onAddLog: (callback) => subscribe('add:log', callback),
  onAddState: (callback) => subscribe('add:state', callback),
  onAddDone: (callback) => subscribe('add:done', callback),
})
