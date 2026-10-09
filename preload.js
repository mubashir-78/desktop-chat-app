const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, cb) {
  const listener = (_event, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("desktopApp", {
  platform: process.platform,
  isDesktop: true,
  version:
    process.argv.find((arg) => arg.startsWith("--app-version="))?.split("=")[1] ??
    null,
  showNotification: (payload) => ipcRenderer.invoke("show-notification", payload),
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
  focusWindow: () => ipcRenderer.invoke("focus-window"),
  onSystemEvent: (cb) => subscribe("desktop:system", cb),
  onNavigate: (cb) => subscribe("desktop:navigate", cb),
  rendererReady: () => ipcRenderer.send("desktop:renderer-ready"),
  retryNow: () => ipcRenderer.invoke("desktop:retry-now"),
});
