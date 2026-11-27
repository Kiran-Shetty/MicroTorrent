import electron from "electron";
const { app, BrowserWindow, Tray, Menu, dialog, shell, Notification, nativeImage } = electron;
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TorrentManager } from "../src/torrentManager.js";
import { createServer } from "../src/server.js";
import { AppLogger, detectDevMode } from "../src/logger.js";
import { sleepSystem } from "../src/platformHelpers.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFERRED_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3456;

function extractTorrentSource(argv = []) {
  return (
    argv.find((arg) => {
      if (typeof arg !== "string") return false;
      const trimmed = arg.trim();
      return (
        trimmed.startsWith("magnet:") ||
        (trimmed.toLowerCase().endsWith(".torrent") && fs.existsSync(trimmed))
      );
    }) || ""
  );
}

function formatSpeed(bytes) {
  if (!bytes || bytes <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let trayUpdateTimer = null;
let lastTrayTooltip = "";
let server = null;
let torrentManager = null;
let serverUrl = "";
let isQuitting = false;
const pendingInitialSources = [];

const initialArgSource = extractTorrentSource(process.argv.slice(1));
if (initialArgSource) {
  pendingInitialSources.push(initialArgSource);
}

function showAndFocusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (serverUrl) createMainWindow(serverUrl);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function handleIncomingSource(source) {
  if (!source) return;
  if (torrentManager) {
    torrentManager.addTorrent(source).catch((err) => {
      console.error("[Incoming Torrent Error]", err.message);
    });
    showAndFocusWindow();
  } else {
    pendingInitialSources.push(source);
  }
}

app.on("second-instance", (_event, commandLine) => {
  const source = extractTorrentSource(commandLine);
  if (source) {
    handleIncomingSource(source);
  } else {
    showAndFocusWindow();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (url && url.startsWith("magnet:")) {
    handleIncomingSource(url);
  }
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (filePath && filePath.toLowerCase().endsWith(".torrent")) {
    handleIncomingSource(filePath);
  }
});

function createMainWindow(url) {
  const iconPath = path.resolve(
    APP_ROOT,
    "public",
    process.platform === "win32" ? "icon.ico" : "logo.png"
  );

  mainWindow = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    title: "MicroTorrent",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: "#18191c",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.platform !== "darwin") {
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.loadURL(url);

  mainWindow.on("close", (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createSystemTray() {
  try {
    const iconFile = process.platform === "win32" ? "icon.ico" : "logo.png";
    const iconPath = path.resolve(APP_ROOT, "public", iconFile);
    let trayImage = nativeImage.createFromPath(iconPath);
    if (process.platform === "darwin" && !trayImage.isEmpty()) {
      trayImage = trayImage.resize({ width: 18, height: 18 });
    } else if (process.platform === "linux" && !trayImage.isEmpty()) {
      trayImage = trayImage.resize({ width: 22, height: 22 });
    }

    tray = new Tray(trayImage);
    tray.setToolTip("MicroTorrent - Background Active");

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Show MicroTorrent",
        click: () => showAndFocusWindow()
      },
      {
        label: "Open Downloads Folder",
        click: () => {
          torrentManager?.openFolder().catch((err) => {
            console.error("[Tray Open Folder Error]", err.message);
          });
        }
      },
      { type: "separator" },
      {
        label: "Pause All Torrents",
        click: () => {
          torrentManager?.pauseAll().catch((err) => {
            console.error("[Tray Pause All Error]", err.message);
          });
        }
      },
      {
        label: "Resume All Torrents",
        click: () => {
          torrentManager?.resumeAll().catch((err) => {
            console.error("[Tray Resume All Error]", err.message);
          });
        }
      },
      { type: "separator" },
      {
        label: "Exit MicroTorrent",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on("click", () => showAndFocusWindow());
    tray.on("double-click", () => showAndFocusWindow());

    trayUpdateTimer = setInterval(() => {
      if (!tray || tray.isDestroyed() || !torrentManager || isQuitting) return;
      const stats = torrentManager.getGlobalStats();
      const nextTooltip = `MicroTorrent - \u2193 ${formatSpeed(stats.downSpeed)} | \u2191 ${formatSpeed(stats.upSpeed)} (${stats.activeCount} active)`;
      if (nextTooltip !== lastTrayTooltip) {
        lastTrayTooltip = nextTooltip;
        tray.setToolTip(nextTooltip);
      }
    }, 5000);
    trayUpdateTimer.unref?.();
  } catch (err) {
    console.warn("System tray could not be initialized:", err.message);
    tray = null;
  }
}

function listenWithFallback(httpServer, preferredPort) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === "EADDRINUSE" && preferredPort !== 0) {
        httpServer.removeListener("error", onError);
        httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address().port));
      } else {
        reject(err);
      }
    };
    httpServer.once("error", onError);
    httpServer.listen(preferredPort, "127.0.0.1", () => {
      httpServer.removeListener("error", onError);
      resolve(httpServer.address().port);
    });
  });
}

if (gotSingleLock) {
  app.whenReady().then(async () => {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient("magnet");
    }

    const userDataDir = app.getPath("userData");
    const defaultDownloadDir = path.join(app.getPath("downloads"), "MicroTorrent");
    const sessionFile = path.join(userDataDir, "session.json");
    const settingsFile = path.join(userDataDir, "settings.json");
    const logDir = path.join(userDataDir, "logs");

    const isDevMode = detectDevMode(process.argv.slice(1));
    const appLogger = new AppLogger({ enabled: isDevMode, logDir });
    const notifyIcon = path.resolve(APP_ROOT, "public", "logo.png");

    torrentManager = new TorrentManager({
      downloadDir: defaultDownloadDir,
      defaultDownloadDir,
      sessionFile,
      settingsFile,
      logger: appLogger,
      openPathHandler: (target) => {
        shell.openPath(target).then((errMsg) => {
          if (errMsg) console.warn("[Open Folder Warning]", errMsg);
        });
      },
      onTorrentComplete(torrent) {
        if (torrentManager.settings.notificationsEnabled !== false && Notification.isSupported()) {
          new Notification({
            title: "Download Complete",
            body: torrent.name || "Torrent finished",
            icon: fs.existsSync(notifyIcon) ? notifyIcon : undefined
          }).show();
        }
      },
      onAllComplete(action) {
        if (action === "pause-seeding") {
          torrentManager.stopAll().catch(() => {});
        } else if (action === "exit") {
          isQuitting = true;
          setTimeout(() => app.quit(), 1500).unref?.();
        } else if (action === "sleep") {
          torrentManager.stopAll().catch(() => {}).finally(() => {
            setTimeout(() => sleepSystem(), 1500).unref?.();
          });
        }
      }
    });

    const platformHooks = {
      browseForFolder: async (initialDir = "") => {
        const result = await dialog.showOpenDialog(mainWindow || undefined, {
          title: "Select Download Directory",
          defaultPath: initialDir && fs.existsSync(initialDir) ? initialDir : defaultDownloadDir,
          properties: ["openDirectory", "createDirectory"]
        });
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
          return { cancelled: true };
        }
        return { cancelled: false, path: result.filePaths[0] };
      }
    };

    const created = createServer(torrentManager, PREFERRED_PORT, showAndFocusWindow, appLogger, platformHooks);
    server = created.server;

    const boundPort = await listenWithFallback(server, PREFERRED_PORT);
    serverUrl = `http://127.0.0.1:${boundPort}`;

    createSystemTray();
    createMainWindow(serverUrl);

    while (pendingInitialSources.length > 0) {
      const src = pendingInitialSources.shift();
      torrentManager.addTorrent(src).catch((err) => {
        console.error("[Initial Torrent Error]", err.message);
      });
    }

    app.on("activate", () => {
      showAndFocusWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!tray && process.platform !== "darwin") {
      isQuitting = true;
      app.quit();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (trayUpdateTimer) {
      clearInterval(trayUpdateTimer);
      trayUpdateTimer = null;
    }
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
      tray = null;
    }
    if (torrentManager) {
      torrentManager.destroy();
    }
    if (server) {
      server.closeAllConnections?.();
      server.close();
    }
  });
}
