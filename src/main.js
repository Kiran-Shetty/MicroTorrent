import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import SysTray from "systray2";
import { TorrentManager } from "./torrentManager.js";
import { createServer } from "./server.js";
import { showDesktopNotification, sleepSystem, openUrlInBrowser } from "./platformHelpers.js";
import { AppLogger, detectDevMode } from "./logger.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3456;
const args = process.argv.slice(2);

// Check if another instance is already running
async function checkRunningInstance() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}/api/ping`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Forward argument to running instance
async function forwardToRunningInstance(inputArg) {
  const baseUrl = `http://localhost:${PORT}`;
  try {
    if (inputArg.startsWith("magnet:")) {
      const res = await fetch(`${baseUrl}/api/torrents/magnet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ magnetURI: inputArg })
      });
      if (res.ok) {
        console.log("✓ Magnet link forwarded to running MicroTorrent instance.");
      } else {
        console.error("Failed to forward magnet link:", await res.text());
      }
    } else if (inputArg && fs.existsSync(inputArg) && inputArg.toLowerCase().endsWith(".torrent")) {
      const fileBuffer = fs.readFileSync(inputArg);
      const formData = new FormData();
      formData.append("torrentFile", new Blob([fileBuffer]), path.basename(inputArg));
      const res = await fetch(`${baseUrl}/api/torrents/upload`, {
        method: "POST",
        body: formData
      });
      if (res.ok) {
        console.log("✓ Torrent file forwarded to running MicroTorrent instance.");
      } else {
        console.error("Failed to forward torrent file:", await res.text());
      }
    } else {
      await fetch(`${baseUrl}/api/open-window`, { method: "POST" });
      console.log("✓ Restored MicroTorrent window.");
    }
  } catch (err) {
    console.error("Failed to communicate with running MicroTorrent instance:", err.message);
  }
}

const isAlreadyRunning = await checkRunningInstance();
if (isAlreadyRunning) {
  const targetArg = args.find((a) => a.startsWith("magnet:") || a.toLowerCase().endsWith(".torrent")) || "";
  await forwardToRunningInstance(targetArg);
  process.exit(0);
}

function formatSpeed(bytes) {
  if (!bytes || bytes <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const isDevMode = detectDevMode(args);
const appLogger = new AppLogger({
  enabled: isDevMode,
  logDir: path.resolve(APP_ROOT, "logs")
});

// Start Main Daemon Instance
const torrentManager = new TorrentManager({
  logger: appLogger,
  onTorrentComplete(torrent) {
    appLogger.info("Automation", `Download complete notification check for "${torrent.name}"`);
    if (torrentManager.settings.notificationsEnabled !== false) {
      showDesktopNotification("Download Complete", torrent.name || "Torrent finished");
    }
  },
  onAllComplete(action) {
    appLogger.info("Automation", `All downloads finished -> executing action "${action}"`);
    if (action === "pause-seeding") {
      torrentManager.stopAll().catch((err) => appLogger.error("AllComplete Stop Error", err.message, { alwaysConsole: true }));
    } else if (action === "exit") {
      setTimeout(() => cleanup(), 1500).unref?.();
    } else if (action === "sleep") {
      torrentManager.stopAll().catch(() => {}).finally(() => {
        setTimeout(() => sleepSystem(), 1500).unref?.();
      });
    }
  }
});

function launchDesktopWindow() {
  openUrlInBrowser(`http://localhost:${PORT}`);
}

const { server } = createServer(torrentManager, PORT, launchDesktopWindow, appLogger);

// System Tray Setup
let systray = null;
let trayMenuConfig = null;
let trayUpdateTimer = null;
let lastTrayTooltip = "";

function setupSystemTray() {
  try {
    const iconFile = process.platform === "win32" ? "icon.ico" : "logo.png";
    const iconPath = path.resolve(APP_ROOT, "public", iconFile);
    let iconBase64 = "";
    if (fs.existsSync(iconPath)) {
      iconBase64 = fs.readFileSync(iconPath).toString("base64");
    }

    const SysTrayClass = SysTray.default || SysTray;
    trayMenuConfig = {
      icon: iconBase64,
      title: "MicroTorrent",
      tooltip: "MicroTorrent - Background Active",
      items: [
        {
          title: "Show MicroTorrent",
          tooltip: "Open application window",
          checked: false,
          enabled: true
        },
        {
          title: "Open Downloads Folder",
          tooltip: "Open downloads folder",
          checked: false,
          enabled: true
        },
        {
          title: "Pause All Torrents",
          tooltip: "Pause all active downloads",
          checked: false,
          enabled: true
        },
        {
          title: "Resume All Torrents",
          tooltip: "Resume all paused downloads",
          checked: false,
          enabled: true
        },
        {
          title: "Exit MicroTorrent",
          tooltip: "Completely stop and exit application",
          checked: false,
          enabled: true
        }
      ]
    };

    systray = new SysTrayClass({
      menu: trayMenuConfig,
      debug: false,
      copyDir: true
    });

    trayUpdateTimer = setInterval(() => {
      if (!systray || !trayMenuConfig || shuttingDown) return;
      const stats = torrentManager.getGlobalStats();
      const nextTooltip = `MicroTorrent - \u2193 ${formatSpeed(stats.downSpeed)} | \u2191 ${formatSpeed(stats.upSpeed)} (${stats.activeCount} active)`;
      if (nextTooltip !== lastTrayTooltip) {
        lastTrayTooltip = nextTooltip;
        trayMenuConfig.tooltip = nextTooltip;
        try {
          systray.sendAction({ type: "update-menu", menu: trayMenuConfig });
        } catch {}
      }
    }, 5000);
    trayUpdateTimer.unref?.();

    systray.onClick((action) => {
      if (action.seq_id === 0) {
        appLogger.info("Tray", "Opening window");
        launchDesktopWindow();
      } else if (action.seq_id === 1) {
        appLogger.info("Tray", "Opening downloads folder");
        torrentManager.openFolder().catch((err) => appLogger.error("Tray Open Folder Error", err.message, { alwaysConsole: true }));
      } else if (action.seq_id === 2) {
        appLogger.info("Tray", "Pause All clicked");
        torrentManager.pauseAll().catch((err) => appLogger.error("Tray Pause All Error", err.message, { alwaysConsole: true }));
      } else if (action.seq_id === 3) {
        appLogger.info("Tray", "Resume All clicked");
        torrentManager.resumeAll().catch((err) => appLogger.error("Tray Resume All Error", err.message, { alwaysConsole: true }));
      } else if (action.seq_id === 4) {
        appLogger.info("Tray", "Exit clicked");
        cleanup();
      }
    });

    console.log("✓ System Tray initialized (closing the window will keep downloads active in the background).");
  } catch (err) {
    console.warn("System tray could not be initialized:", err.message);
  }
}

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n======================================================`);
  console.log(`  MicroTorrent Background Daemon Active!              `);
  console.log(`  Web Dashboard: ${url}                             `);
  console.log(`  Close window anytime: continues in System Tray      `);
  console.log(`======================================================\n`);
  if (appLogger.enabled) {
    appLogger.info("App", `Dev logging enabled -> console, UI Logs tab, and ${appLogger.logFile}`);
  }

  setupSystemTray();

  // If a magnet or file was passed as initial argument
  const initialTorrent = args.find((a) => a.startsWith("magnet:") || a.toLowerCase().endsWith(".torrent"));
  if (initialTorrent) {
    torrentManager.addTorrent(initialTorrent).catch((err) => {
      console.error("[Initial Torrent Error]", err.message);
    });
  }

  const noLaunch = args.includes("--no-launch");
  if (!noLaunch) {
    launchDesktopWindow();
  }
});

let shuttingDown = false;
function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nStopping MicroTorrent and saving session...");
  if (trayUpdateTimer) {
    clearInterval(trayUpdateTimer);
    trayUpdateTimer = null;
  }
  if (systray) {
    try {
      systray.kill();
    } catch {}
  }
  torrentManager.destroy();
  const forceExit = setTimeout(() => process.exit(0), 2000);
  forceExit.unref?.();
  server.closeAllConnections?.();
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
