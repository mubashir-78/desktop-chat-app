const {
  app,
  BrowserWindow,
  dialog,
  Tray,
  Menu,
  shell,
  nativeImage,
  Notification,
  session,
  ipcMain,
  powerMonitor,
  net,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

const APP_URL =
  process.env.APP_URL?.trim() || "https://pssnexus-chatapp.vercel.app";
const APP_NAME = "PSS Nexus Chat";
const APP_USER_MODEL_ID = "com.pssnexus.chat";

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const isAutoStart = process.argv.includes("--autostart");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let isQuitting = false;
let rendererReady = false;
let appLoaded = false;
let loadAttempt = 0;
let retryTimer = null;
let updateReady = false;
let unreadCount = 0;
let pendingNavigation = null;
const liveNotifications = new Set();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

function getAppIconPath() {
  return path.join(__dirname, "assets", "icon.png");
}

function getTrayIcon() {
  const tray32 = path.join(__dirname, "assets", "tray.png");
  const tray16 = path.join(__dirname, "assets", "tray-16.png");
  const iconPath = fs.existsSync(tray16) ? tray16 : tray32;
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    return icon;
  }
  const fallback = nativeImage.createFromPath(getAppIconPath());
  return fallback.isEmpty()
    ? nativeImage.createEmpty()
    : fallback.resize({ width: 16, height: 16 });
}

function navigateMainWindow(relativeUrl) {
  if (!mainWindow) return;

  const targetPath = relativeUrl.startsWith("/")
    ? relativeUrl
    : `/${relativeUrl}`;
  const origin = new URL(APP_URL).origin;

  mainWindow.webContents
    .executeJavaScript(
      `(function() {
        if (window.location.origin === ${JSON.stringify(origin)}) {
          window.location.href = ${JSON.stringify(targetPath)};
          return true;
        }
        return false;
      })()`
    )
    .then((navigated) => {
      if (!navigated && mainWindow) {
        mainWindow.loadURL(new URL(targetPath, APP_URL).href);
      }
    })
    .catch(() => {
      if (mainWindow) {
        mainWindow.loadURL(new URL(targetPath, APP_URL).href);
      }
    });
}

function showNativeNotification({ title, body, url }) {
  if (!Notification.isSupported()) return false;

  const notification = new Notification({
    title: title || APP_NAME,
    body: body || "",
    icon: getAppIconPath(),
    silent: true,
  });

  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on("click", () => {
    release();
    openFromNotification(url);
  });
  notification.on("close", release);
  notification.on("failed", release);

  notification.show();
  return true;
}

const BADGE_DIGITS = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

function paintBadgePixels(buffer, size, originX, originY, rows, scale) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx += 1) {
      if (row[dx] !== "1") continue;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const x = originX + dx * scale + sx;
          const y = originY + dy * scale + sy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const index = (y * size + x) * 4;
          buffer[index] = 255;
          buffer[index + 1] = 255;
          buffer[index + 2] = 255;
          buffer[index + 3] = 255;
        }
      }
    }
  });
}

function createBadgeImage(count) {
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  const radius = 15;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - 15.5;
      const dy = y - 15.5;
      if (dx * dx + dy * dy > radius * radius) continue;
      const index = (y * size + x) * 4;
      buffer[index] = 0x3a;
      buffer[index + 1] = 0x1c;
      buffer[index + 2] = 0xe0;
      buffer[index + 3] = 255;
    }
  }

  const label = count > 9 ? "9+" : String(count);
  const scale = 2;
  const glyphWidth = 3 * scale;
  const gap = scale;
  const textWidth = label.length * glyphWidth + (label.length - 1) * gap;
  let cursor = Math.round((size - textWidth) / 2);
  const top = Math.round((size - 5 * scale) / 2);
  for (const character of label) {
    paintBadgePixels(buffer, size, cursor, top, BADGE_DIGITS[character], scale);
    cursor += glyphWidth + gap;
  }

  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function applyUnreadBadge(count) {
  const next = Number.isFinite(count) && count > 0 ? Math.min(99, Math.floor(count)) : 0;
  const increased = next > unreadCount;
  unreadCount = next;

  if (process.platform === "darwin") {
    app.setBadgeCount(next);
  }

  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (process.platform === "win32") {
    if (next === 0) {
      mainWindow.setOverlayIcon(null, "");
    } else {
      mainWindow.setOverlayIcon(createBadgeImage(next), `${next} unread`);
    }
  } else if (process.platform !== "darwin") {
    app.setBadgeCount(next);
  }

  const needsAttention =
    next > 0 && (!mainWindow.isVisible() || !mainWindow.isFocused());
  if (!needsAttention) {
    mainWindow.flashFrame(false);
    return;
  }
  if (increased) mainWindow.flashFrame(true);
}

function deliverNavigation(url) {
  if (!url || !mainWindow || mainWindow.isDestroyed()) return;
  pendingNavigation = url;
  if (!rendererReady) {
    navigateMainWindow(url);
    return;
  }
  mainWindow.webContents.send("desktop:navigate", url);
  pendingNavigation = null;
}

function openFromNotification(url) {
  showMainWindow();
  if (!url) return;
  pendingNavigation = url;
  deliverNavigation(url);
  setTimeout(() => deliverNavigation(pendingNavigation), 400);
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.flashFrame(false);
}

function buildTrayMenu() {
  const template = [
    {
      label: "Open PSS Nexus Chat",
      click: () => showMainWindow(),
    },
  ];
  if (updateReady) {
    template.push({
      label: "Restart to update",
      click: () => installDownloadedUpdate(),
    });
  }
  template.push(
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    }
  );
  return Menu.buildFromTemplate(template);
}

function createTray() {
  if (tray) return;

  tray = new Tray(getTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", () => showMainWindow());
}

async function promptToInstallUpdate() {
  if (!updateReady) return;
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  if (parent) {
    if (parent.isMinimized()) parent.restore();
    parent.show();
  }
  const dialogOptions = {
    type: "info",
    buttons: ["Update", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: APP_NAME,
    message: "A new version is ready",
    detail: "Click Update to install it now. The app will close and open again.",
  };
  const result = parent
    ? await dialog.showMessageBox(parent, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  if (result.response === 0) installDownloadedUpdate();
}

function installDownloadedUpdate() {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeAllListeners("close");
    mainWindow.destroy();
    mainWindow = null;
  }
  // Silent install, then reopen. A visible installer loses the race with the
  // tray process and the app closes before the files are replaced.
  autoUpdater.quitAndInstall(true, true);
}

function initAutoUpdate() {
  if (isDev) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (error) => {
    console.error("[updater]", error?.message || error);
  });
  autoUpdater.on("update-downloaded", () => {
    updateReady = true;
    tray?.setContextMenu(buildTrayMenu());
    if (Notification.isSupported()) {
      const notice = new Notification({
        title: APP_NAME,
        body: "Update ready — restart to apply",
        icon: getAppIconPath(),
        silent: true,
      });
      notice.on("click", () => {
        installDownloadedUpdate();
      });
      notice.show();
    }
    void promptToInstallUpdate();
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(check, 30_000);
  setInterval(check, 6 * 60 * 60 * 1000);
  powerMonitor.on("resume", () => setTimeout(check, 60_000));
}

function createWindow(showOnReady = !isAutoStart) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    autoHideMenuBar: true,
    backgroundColor: "#3f0e40",
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
      additionalArguments: [`--app-version=${app.getVersion()}`],
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (showOnReady) {
      mainWindow?.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentOrigin = new URL(APP_URL).origin;
    let targetOrigin;
    try {
      targetOrigin = new URL(url).origin;
    } catch {
      return;
    }
    if (targetOrigin !== currentOrigin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  const wc = mainWindow.webContents;
  wc.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) rendererReady = false;
  });
  wc.on("did-finish-load", () => {
    if (wc.getURL().startsWith(new URL(APP_URL).origin)) {
      appLoaded = true;
      loadAttempt = 0;
    }
  });
  wc.on("did-fail-load", (_event, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    appLoaded = false;
    const delay = [2000, 5000, 10000, 30000, 60000][
      Math.min(loadAttempt, 4)
    ];
    loadAttempt += 1;
    clearRetryTimer();
    mainWindow?.loadFile(path.join(__dirname, "assets", "offline.html"), {
      query: { retryMs: String(delay), reason: desc },
    });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!appLoaded) void loadChat();
    }, delay);
  });
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const refresh =
      input.key === "F5" ||
      ((input.key === "r" || input.key === "R") &&
        input.control &&
        !input.alt &&
        !input.meta);
    if (!refresh || !isOfflinePage(wc.getURL())) return;
    event.preventDefault();
    void loadChat({ resetAttempts: true });
  });
  wc.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    setTimeout(() => {
      void loadChat({ resetAttempts: true });
    }, 1000);
  });

  for (const ev of ["show", "hide", "focus", "blur", "minimize", "restore"]) {
    mainWindow.on(ev, () => {
      if (ev === "focus" || ev === "show") mainWindow?.flashFrame(false);
      mainWindow?.webContents.send("desktop:system", {
        type: `window-${ev}`,
        at: Date.now(),
      });
    });
  }

  mainWindow.loadURL(APP_URL).catch(() => {});
}

function configureNotificationPermissions() {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(
        permission === "notifications" ||
          permission === "clipboard-sanitized-write" ||
          permission === "fullscreen"
      );
    }
  );

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return (
      permission === "notifications" ||
      permission === "clipboard-sanitized-write" ||
      permission === "fullscreen"
    );
  });
}

function configureAutoLaunch() {
  if (isDev) return;

  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: ["--autostart"],
  });
}

function registerIpcHandlers() {
  ipcMain.handle("show-notification", (_event, payload) => {
    return showNativeNotification(payload ?? {});
  });

  ipcMain.handle("focus-window", () => {
    showMainWindow();
  });

  ipcMain.on("desktop:unread-count", (_event, count) => {
    applyUnreadBadge(Number(count) || 0);
  });

  ipcMain.handle("desktop:retry-now", () => loadChat({ resetAttempts: true }));

  ipcMain.on("desktop:renderer-ready", () => {
    rendererReady = true;
    if (pendingNavigation) deliverNavigation(pendingNavigation);
  });
}

function sendSystem(type) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:system", { type, at: Date.now() });
  }
}

function registerSystemEvents() {
  for (const ev of ["suspend", "resume", "lock-screen", "unlock-screen"]) {
    powerMonitor.on(ev, () => {
      sendSystem(ev);
      if ((ev === "resume" || ev === "unlock-screen") && !appLoaded) {
        void loadChat({ resetAttempts: true });
      }
    });
  }
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now === online) return;
    online = now;
    sendSystem(now ? "online" : "offline");
    if (now && !appLoaded) void loadChat({ resetAttempts: true });
  }, 15_000);
}

function clearRetryTimer() {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

function isOfflinePage(url) {
  return url.startsWith("file:") && url.includes("offline.html");
}

async function loadChat({ resetAttempts = false } = {}) {
  clearRetryTimer();
  if (resetAttempts) loadAttempt = 0;
  try {
    await session.defaultSession.clearHostResolverCache();
  } catch {
    // A stuck lookup should not block the new attempt.
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(APP_URL).catch(() => {});
}

function useGoogleDns() {
  // Windows uses the system resolver unless the built-in one is turned on.
  // Secure mode keeps file and image lookups on Google (8.8.8.8 / 8.8.4.4)
  // instead of falling back to the local DNS that fails for cPanel.
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: "secure",
    secureDnsServers: ["https://dns.google/dns-query"],
  });
}

if (gotLock) app.whenReady().then(() => {
  useGoogleDns();
  configureNotificationPermissions();
  registerSystemEvents();
  initAutoUpdate();
  configureAutoLaunch();
  registerIpcHandlers();

  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(true);
    } else {
      showMainWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Keep running in tray on Windows when window is hidden.
  }
});
