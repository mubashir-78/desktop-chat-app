const {
  app,
  BrowserWindow,
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
let updateReady = false;
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
    showMainWindow();
    if (!url || !mainWindow) return;
    if (rendererReady) {
      mainWindow.webContents.send("desktop:navigate", url);
    } else {
      navigateMainWindow(url);
    }
  });
  notification.on("close", release);
  notification.on("failed", release);

  notification.show();
  return true;
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
      click: () => {
        isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
      },
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
        isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
      });
      notice.show();
    }
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

  mainWindow.webContents.on("page-title-updated", (_event, title) => {
    if (process.platform === "darwin" && mainWindow) {
      const unreadMatch = title.match(/\((\d+)\)/);
      app.setBadgeCount(unreadMatch ? Number(unreadMatch[1]) : 0);
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
    mainWindow?.loadFile(path.join(__dirname, "assets", "offline.html"), {
      query: { retryMs: String(delay), reason: desc },
    });
    setTimeout(() => {
      if (!appLoaded) mainWindow?.loadURL(APP_URL).catch(() => {});
    }, delay);
  });
  wc.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    setTimeout(() => mainWindow?.loadURL(APP_URL).catch(() => {}), 1000);
  });

  for (const ev of ["show", "hide", "focus", "blur", "minimize", "restore"]) {
    mainWindow.on(ev, () => {
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

  ipcMain.on("desktop:renderer-ready", () => {
    rendererReady = true;
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
        mainWindow?.loadURL(APP_URL).catch(() => {});
      }
    });
  }
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now === online) return;
    online = now;
    sendSystem(now ? "online" : "offline");
    if (now && !appLoaded) mainWindow?.loadURL(APP_URL).catch(() => {});
  }, 15_000);
}

if (gotLock) app.whenReady().then(() => {
  configureNotificationPermissions();
  registerSystemEvents();
  initAutoUpdate();
  configureAutoLaunch();
  registerIpcHandlers();

  if (Notification.isSupported()) {
    app.setAppUserModelId("com.pssnexus.chat");
  }

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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Keep running in tray on Windows when window is hidden.
  }
});
