import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('quickTranslate', {
  captureSelectedText: () => ipcRenderer.invoke('capture-selected-text'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  chooseUpdatePackageDirectory: () => ipcRenderer.invoke('choose-update-package-directory'),
  clearUpdatePackages: () => ipcRenderer.invoke('clear-update-packages'),
  copyText: (text: string) => ipcRenderer.invoke('copy-text', text),
  getDesktopSettings: () => ipcRenderer.invoke('get-desktop-settings'),
  getLatestUpdateTransaction: () => ipcRenderer.invoke('get-latest-update-transaction'),
  openUpdatePackageDirectory: () => ipcRenderer.invoke('open-update-package-directory'),
  openUpdateTransactionLogDirectory: (input?: unknown) => ipcRenderer.invoke('open-update-transaction-log-directory', input),
  onDesktopSettingsChanged: (callback: (settings: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: unknown) => callback(settings);
    ipcRenderer.on('desktop-settings-changed', listener);

    return () => {
      ipcRenderer.removeListener('desktop-settings-changed', listener);
    };
  },
  onUpdateProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress);
    ipcRenderer.on('desktop-update-progress', listener);

    return () => {
      ipcRenderer.removeListener('desktop-update-progress', listener);
    };
  },
  onFloatingSourceCaptured: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('floating-source-captured', listener);

    return () => {
      ipcRenderer.removeListener('floating-source-captured', listener);
    };
  },
  onSelectionCaptured: (callback: (text: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, text: string) => callback(text);
    ipcRenderer.on('selection-captured', listener);

    return () => {
      ipcRenderer.removeListener('selection-captured', listener);
    };
  },
  setDesktopSettings: (settings: unknown) => ipcRenderer.invoke('set-desktop-settings', settings),
  setFloatingSessionPreferences: (preferences: unknown) => ipcRenderer.invoke('set-floating-session-preferences', preferences),
  retryUpdateTransaction: (input?: unknown) => ipcRenderer.invoke('retry-update-transaction', input),
  saveFloatingWindowPosition: () => ipcRenderer.invoke('save-floating-window-position'),
  translateText: (input: unknown) => ipcRenderer.invoke('translate-text', input),
  translateTextStream: (input: unknown, callback: (event: unknown) => void) => {
    const streamId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const record = payload as { streamId?: string; event?: unknown };
      if (record.streamId === streamId) {
        callback(record.event);
      }
    };
    ipcRenderer.on('translate-text-stream-event', listener);

    return ipcRenderer.invoke('translate-text-stream', { streamId, input }).finally(() => {
      ipcRenderer.removeListener('translate-text-stream-event', listener);
    });
  },
  windowControl: (command: unknown) => ipcRenderer.invoke('window-control', command)
});
