'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniBrowser', Object.freeze({
  getState: () => ipcRenderer.invoke('browser:state'),
  navigate: (address) => ipcRenderer.invoke('browser:navigate', address),
  back: () => ipcRenderer.invoke('browser:action', 'back'),
  forward: () => ipcRenderer.invoke('browser:action', 'forward'),
  reload: () => ipcRenderer.invoke('browser:action', 'reload'),
  retry: () => ipcRenderer.invoke('browser:action', 'retry'),
  pin: () => ipcRenderer.invoke('browser:action', 'pin'),
  home: () => ipcRenderer.invoke('browser:action', 'home'),
  bookmark: () => ipcRenderer.invoke('browser:action', 'bookmark'),
  toggleUI: () => ipcRenderer.invoke('browser:action', 'toggle-ui'),
  minimize: () => ipcRenderer.invoke('browser:action', 'minimize'),
  maximize: () => ipcRenderer.invoke('browser:action', 'maximize'),
  close: () => ipcRenderer.invoke('browser:action', 'close'),
  installUpdate: () => ipcRenderer.invoke('browser:action', 'install-update'),
  newTab: () => ipcRenderer.invoke('browser:tab', 'new'),
  tab: (command, id) => ipcRenderer.invoke('browser:tab', command, id),
  ui: (command, value) => ipcRenderer.invoke('browser:ui', command, value),
  suggest: (text, anchor) => ipcRenderer.invoke('browser:suggest', text, anchor),
  password: (command, id) => ipcRenderer.invoke('browser:password', command, id),
  clearData: (choices) => ipcRenderer.invoke('browser:clear-data', choices),
  selectTab: (id) => ipcRenderer.invoke('browser:tab', 'select', id),
  closeTab: (id) => ipcRenderer.invoke('browser:tab', 'close', id),
  find: (command, text) => ipcRenderer.invoke('browser:find', command, text),
  zoom: (command) => ipcRenderer.invoke('browser:zoom', command),
  download: (command, id) => ipcRenderer.invoke('browser:download', command, id),
  downloadsPanel: (open) => ipcRenderer.invoke('browser:downloads-panel', open),
  startTabDrag: (id) => ipcRenderer.invoke('browser:tab-drag-start', id),
  endTabDrag: (token, cancel) => ipcRenderer.invoke('browser:tab-drag-end', token, cancel),
  holdChrome: (hold) => ipcRenderer.invoke('browser:chrome-hold', hold),
  addBookmark: (address, title) => ipcRenderer.invoke('browser:bookmark', 'add', address, title),
  removeBookmark: (address) => ipcRenderer.invoke('browser:bookmark', 'remove', address),
  editBookmark: (original, address, title) => ipcRenderer.invoke('browser:bookmark', 'edit', original, address, title),
  reorderBookmarks: (urls) => ipcRenderer.invoke('browser:bookmark', 'reorder', urls),
  reorderProfiles: (ids) => ipcRenderer.invoke('browser:profile', 'reorder', ids),
  createProfile: (name) => ipcRenderer.invoke('browser:profile', 'create', null, name),
  switchProfile: (id) => ipcRenderer.invoke('browser:profile', 'switch', id),
  renameProfile: (id, name) => ipcRenderer.invoke('browser:profile', 'rename', id, name),
  setProfilePicture: (id, picture) => ipcRenderer.invoke('browser:profile', 'picture', id, picture),
  deleteProfile: (id) => ipcRenderer.invoke('browser:profile', 'delete', id),
  profilePanel: (open, height) => ipcRenderer.invoke('browser:profile-panel', open, height),
  sitePanel: (open) => ipcRenderer.invoke('browser:site-panel', open),
  respondPermission: (...args) => ipcRenderer.invoke('browser:permission-response', ...args),
  updatePermission: (...args) => ipcRenderer.invoke('browser:permission-update', ...args),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
  onFocusAddress: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('browser:focus-address', listener);
    return () => ipcRenderer.removeListener('browser:focus-address', listener);
  },
  onFocusFind: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('browser:focus-find', listener);
    return () => ipcRenderer.removeListener('browser:focus-find', listener);
  }
}));
