import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import WebTorrent from "webtorrent";
import parseTorrent from "parse-torrent";
import { sanitizeFilePath, validateMagnetURI } from "./security.js";
import { NetworkManager } from "./networkManager.js";
import { AppLogger } from "./logger.js";
import { openPathInExplorer } from "./platformHelpers.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POPCOUNT_LUT = Uint8Array.from({ length: 256 }, (_, n) => {
  let c = 0;
  for (let x = n; x; x &= x - 1) c += 1;
  return c;
});

export class TorrentManager {
  constructor(options = {}) {
    this.defaultDownloadDir = path.resolve(APP_ROOT, "downloads");
    this.downloadDir = options.downloadDir
      ? path.resolve(APP_ROOT, options.downloadDir)
      : this.defaultDownloadDir;
    this.sessionFile = options.sessionFile || path.resolve(APP_ROOT, "session.json");
    this.settingsFile = options.settingsFile || path.resolve(APP_ROOT, "settings.json");

    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }

    this.pausedTorrents = new Set();
    this.stoppedTorrents = new Set();
    this.queuedTorrents = new Set();
    this.sequentialTorrents = new Set();
    this.filePriorities = new Map(); // infoHash -> Map<fileIndex, "high" | "skip">
    this.torrentTags = new Map(); // infoHash -> string
    this.torrentPaths = new Map(); // infoHash -> string
    this.torrentCustomPaths = new Set(); // infoHash set when user chose explicit custom folder
    this.torrentAddedAt = new Map(); // infoHash -> epoch ms
    this.torrentCompletedAt = new Map(); // infoHash -> epoch ms
    this._knownCompleted = new Set();
    this._watchedProcessed = new Set();
    this._movingTorrents = new Set();
    this._schedulerActive = false;

    this.logger = options.logger instanceof AppLogger ? options.logger : new AppLogger({ enabled: false });
    this.onTorrentComplete = typeof options.onTorrentComplete === "function" ? options.onTorrentComplete : null;
    this.onAllComplete = typeof options.onAllComplete === "function" ? options.onAllComplete : null;
    this.openPathHandler = typeof options.openPathHandler === "function" ? options.openPathHandler : openPathInExplorer;

    this.settings = {
      downloadDir: this.downloadDir,
      maxDownloadSpeed: -1, // -1 means uncapped (KB/s)
      maxUploadSpeed: -1,
      maxConns: 120,
      maxActiveDownloads: 0, // 0 = unlimited
      seedRatioLimit: -1, // -1 = unlimited
      autoStopOnComplete: false,
      onCompleteAction: "none", // none | pause-seeding | exit | sleep
      autoTagSubfolder: false,
      showAddDialog: true,
      notificationsEnabled: true,
      incompleteDirEnabled: false,
      incompleteDir: "",
      watchFolderEnabled: false,
      watchFolderPath: "",
      watchFolderAction: "rename", // rename | delete
      watchFolderTag: "",
      scheduler: {
        enabled: false,
        days: [0, 1, 2, 3, 4, 5, 6],
        startTime: "09:00",
        endTime: "18:00",
        altDownloadSpeed: 2048,
        altUploadSpeed: 512
      },
      multiNetworkEnabled: false,
      selectedInterfaces: [],
      ui: {
        theme: "dark",
        density: "comfortable",
        speedUnit: "bytes",
        showSidebar: true,
        showDetailsPanel: true,
        columns: null
      }
    };

    this.networkManager = new NetworkManager({ ...this.settings, logger: this.logger });
    this.loadSettings();

    if (this.settings.downloadDir) {
      this.downloadDir = this.settings.downloadDir;
    }

    const initialLimits = this._computeEffectiveSpeedLimits();
    this._schedulerActive = initialLimits.altActive;
    this._lastAppliedDownKbps = initialLimits.downKbps;
    this._lastAppliedUpKbps = initialLimits.upKbps;
    this.client = new WebTorrent({
      maxConns: this.settings.maxConns,
      dht: true,
      tracker: true,
      utp: !this.networkManager.shouldBindMultiNetwork(),
      downloadLimit: initialLimits.downBytes,
      uploadLimit: initialLimits.upBytes
    });

    this.client.on("error", (err) => {
      this.logger.error("WebTorrent Error", err.message, { alwaysConsole: true });
    });

    this.client.on("add", (torrent) => {
      this._attachTorrentHooks(torrent);
    });

    if (this.client._connPool?.tcpServer) {
      this.client._connPool.tcpServer.on("connection", (socket) => {
        this.networkManager.trackSocket(null, socket);
      });
    }

    this.loadSession();

    this._lifecycleTimer = setInterval(() => {
      this.applyBandwidthSchedule();
      this.scanWatchFolder().catch((err) => {
        console.error("[Watch Folder Error]", err.message);
      });
      this.enforceLifecycleRules().catch((err) => {
        console.error("[Lifecycle Rules Error]", err.message);
      });
    }, 3000);
    this._lifecycleTimer.unref?.();
    if (this.settings.watchFolderEnabled) {
      this.scanWatchFolder().catch(() => {});
    }
  }

  _guardWire(torrent, wire) {
    if (!wire || wire._microtorrentGuarded) return;
    wire._microtorrentGuarded = true;
    const manager = this;
    const isInactive = () =>
      Boolean(
        torrent.paused ||
          manager.pausedTorrents.has(torrent.infoHash) ||
          manager.stoppedTorrents.has(torrent.infoHash)
      );

    const origUnchoke = wire.unchoke;
    if (typeof origUnchoke === "function") {
      wire.unchoke = function (...args) {
        if (isInactive()) {
          try {
            wire.choke();
          } catch {}
          return;
        }
        return origUnchoke.apply(this, args);
      };
    }

    const origOnRequest = wire._onRequest;
    if (typeof origOnRequest === "function") {
      wire._onRequest = function (index, offset, length, ...rest) {
        if (isInactive()) {
          if (this.hasFast && typeof this.reject === "function") {
            try {
              this.reject(index, offset, length);
            } catch {}
          }
          return;
        }
        return origOnRequest.call(this, index, offset, length, ...rest);
      };
    }

    if (isInactive()) {
      try {
        wire.choke();
        wire.uninterested();
      } catch {}
    }
  }

  _attachTorrentHooks(torrent) {
    if (!torrent || torrent._microtorrentHooked) return;
    torrent._microtorrentHooked = true;
    torrent._verifyChecked = 0;
    torrent._isChecking = false;
    torrent._manualChecking = false;

    // WebTorrent defaults to "sequential"; its unoptimized "rarest" RarityMap burns 100% CPU on O(numPieces) scans.
    // Ensure strategy is sequential and destroy RarityMap to prevent wire recalculation overhead and massive speed drops.
    torrent.strategy = "sequential";
    if (torrent._rarityMap) {
      try { torrent._rarityMap.destroy(); } catch (_) {}
      torrent._rarityMap = null;
    }

    const manager = this;
    const isInactive = () =>
      Boolean(
        torrent.paused ||
          manager.pausedTorrents.has(torrent.infoHash) ||
          manager.stoppedTorrents.has(torrent.infoHash)
      );

    if (manager.stoppedTorrents.has(torrent.infoHash)) {
      torrent.discovery = null;
    }

    const origStartDiscovery = torrent._startDiscovery;
    if (typeof origStartDiscovery === "function") {
      torrent._startDiscovery = function (...args) {
        if (manager.stoppedTorrents.has(this.infoHash)) {
          this.discovery = null;
          return;
        }
        return origStartDiscovery.apply(this, args);
      };
    }

    const origCheckDone = torrent._checkDone;
    if (typeof origCheckDone === "function") {
      torrent._checkDone = function (...args) {
        if (!this.discovery) {
          const dummy = { complete() {}, tracker: { start() {} } };
          this.discovery = dummy;
          try {
            return origCheckDone.apply(this, args);
          } finally {
            if (this.discovery === dummy) {
              this.discovery = null;
            }
          }
        }
        try {
          return origCheckDone.apply(this, args);
        } catch (err) {
          if (err instanceof TypeError && err.message.includes("complete")) {
            return true;
          }
          throw err;
        }
      };
    }

    const origRechoke = torrent._rechoke;
    if (typeof origRechoke === "function") {
      torrent._rechoke = function (...args) {
        // WebTorrent's built-in _rechoke timer keeps unchoking wires when paused; choke instead so paused/stopped torrents never seed.
        if (isInactive()) {
          for (const wire of this.wires || []) {
            try {
              wire.choke();
              wire.uninterested();
            } catch {}
          }
          return;
        }
        return origRechoke.apply(this, args);
      };
    }

    torrent.on("wire", (wire) => {
      manager._guardWire(torrent, wire);
    });
    for (const wire of torrent.wires || []) {
      manager._guardWire(torrent, wire);
    }

    const origVerifyPiece = torrent._verifyPiece;
    if (typeof origVerifyPiece === "function") {
      torrent._verifyPiece = function (index, cb) {
        torrent._isChecking = true;
        return origVerifyPiece.call(this, index, (err, isValid) => {
          torrent._verifyChecked = (torrent._verifyChecked || 0) + 1;
          cb(err, isValid);
        });
      };
    }

    torrent.once("metadata", () => {
      torrent.strategy = "sequential";
      if (torrent._rarityMap) {
        try { torrent._rarityMap.destroy(); } catch (_) {}
        torrent._rarityMap = null;
      }
      if (!torrent.ready) {
        torrent._verifyChecked = 0;
        torrent._isChecking = true;
      }
    });

    torrent.once("ready", () => {
      torrent._isChecking = false;
    });

    const origDrain = torrent._drain;
    const networkManager = this.networkManager;

    torrent._drain = function (...args) {
      const bindMulti = networkManager.shouldBindMultiNetwork();
      const origConnect = net.connect;

      net.connect = function (opts, ...rest) {
        const finalOpts = opts && typeof opts === "object" ? { ...opts } : opts;
        let picked = null;

        if (bindMulti && finalOpts && typeof finalOpts === "object" && finalOpts.host) {
          picked = networkManager.pickInterfaceForHost(finalOpts.host);
          if (picked && !finalOpts.localAddress) {
            finalOpts.localAddress = picked.address;
          }
        }

        const socket = origConnect.call(net, finalOpts, ...rest);
        networkManager.trackSocket(picked ? picked.name : null, socket);
        return socket;
      };

      try {
        return origDrain.apply(this, args);
      } finally {
        net.connect = origConnect;
      }
    };
  }

  _drainActiveTorrents() {
    if (!this.client || this.client.destroyed) return;
    for (const t of this.client.torrents) {
      if (t.destroyed || t.paused || !Array.isArray(t._queue)) continue;
      let guard = 0;
      while (t._queue.length > 0 && t._numConns < this.client.maxConns && guard < 100) {
        const before = t._queue.length;
        t._drain();
        if (t._queue.length >= before) break;
        guard += 1;
      }
    }
  }

  async findTorrent(infoHashOrId) {
    if (!infoHashOrId) return null;
    if (typeof infoHashOrId === "string") {
      const normalized = infoHashOrId.trim().toLowerCase();
      const direct = this.client.torrents.find((t) => t.infoHash === normalized);
      if (direct) return direct;
    }
    try {
      return await this.client.get(infoHashOrId);
    } catch {
      return null;
    }
  }

  _resolveConfigPath(dirStr) {
    if (!dirStr || typeof dirStr !== "string") return "";
    const trimmed = dirStr.trim();
    if (!trimmed) return "";
    return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(APP_ROOT, trimmed);
  }

  _normalizeScheduler(input) {
    const base = {
      enabled: false,
      days: [0, 1, 2, 3, 4, 5, 6],
      startTime: "09:00",
      endTime: "18:00",
      altDownloadSpeed: 2048,
      altUploadSpeed: 512
    };
    if (!input || typeof input !== "object") return base;
    const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const days = Array.isArray(input.days)
      ? [...new Set(input.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : base.days;
    return {
      enabled: Boolean(input.enabled),
      days,
      startTime: typeof input.startTime === "string" && timeRe.test(input.startTime) ? input.startTime : base.startTime,
      endTime: typeof input.endTime === "string" && timeRe.test(input.endTime) ? input.endTime : base.endTime,
      altDownloadSpeed: typeof input.altDownloadSpeed === "number" && Number.isFinite(input.altDownloadSpeed)
        ? input.altDownloadSpeed
        : base.altDownloadSpeed,
      altUploadSpeed: typeof input.altUploadSpeed === "number" && Number.isFinite(input.altUploadSpeed)
        ? input.altUploadSpeed
        : base.altUploadSpeed
    };
  }

  _parseTimeMinutes(hhmm) {
    const [h, m] = String(hhmm || "00:00").split(":").map((n) => parseInt(n, 10));
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  }

  _isSchedulerWindowActive(now = new Date()) {
    const s = this.settings.scheduler;
    if (!s?.enabled) return false;
    const days = Array.isArray(s.days) ? s.days : [];
    const day = now.getDay();
    const prevDay = (day + 6) % 7;
    const curMin = now.getHours() * 60 + now.getMinutes();
    const startMin = this._parseTimeMinutes(s.startTime);
    const endMin = this._parseTimeMinutes(s.endTime);

    if (startMin === endMin) {
      return days.includes(day);
    }
    if (startMin < endMin) {
      return days.includes(day) && curMin >= startMin && curMin < endMin;
    }
    // Overnight window (e.g. 22:00 -> 07:00)
    return (curMin >= startMin && days.includes(day)) || (curMin < endMin && days.includes(prevDay));
  }

  _computeEffectiveSpeedLimits(now = new Date()) {
    const altActive = this._isSchedulerWindowActive(now);
    const downKbps = altActive ? this.settings.scheduler.altDownloadSpeed : this.settings.maxDownloadSpeed;
    const upKbps = altActive ? this.settings.scheduler.altUploadSpeed : this.settings.maxUploadSpeed;
    return {
      altActive,
      downKbps,
      upKbps,
      downBytes: downKbps > 0 ? downKbps * 1024 : -1,
      upBytes: upKbps > 0 ? upKbps * 1024 : -1
    };
  }

  applyBandwidthSchedule(now = new Date(), force = false) {
    const limits = this._computeEffectiveSpeedLimits(now);
    const modeChanged = this._schedulerActive !== limits.altActive;
    const changed =
      force ||
      modeChanged ||
      this._lastAppliedDownKbps !== limits.downKbps ||
      this._lastAppliedUpKbps !== limits.upKbps;

    this._schedulerActive = limits.altActive;
    if (!changed || !this.client || this.client.destroyed) return limits.altActive;

    this._lastAppliedDownKbps = limits.downKbps;
    this._lastAppliedUpKbps = limits.upKbps;
    if (typeof this.client.throttleDownload === "function") {
      this.client.throttleDownload(limits.downBytes);
    }
    if (typeof this.client.throttleUpload === "function") {
      this.client.throttleUpload(limits.upBytes);
    }
    if (modeChanged || force) {
      const dlText = limits.downKbps > 0 ? `${limits.downKbps} KB/s` : "unlimited";
      const ulText = limits.upKbps > 0 ? `${limits.upKbps} KB/s` : "unlimited";
      this.logger.info(
        "Scheduler",
        `${limits.altActive ? "Alt limit window active" : "Normal limit mode active"} (down=${dlText}, up=${ulText})`
      );
    }
    return limits.altActive;
  }

  isSchedulerActive() {
    return this._schedulerActive;
  }

  async scanWatchFolder(minAgeMs = 800) {
    if (this._watchScanPromise) return this._watchScanPromise;

    this._watchScanPromise = (async () => {
      if (!this.settings.watchFolderEnabled || !this.settings.watchFolderPath) return 0;
      const watchDir = this.settings.watchFolderPath;
      if (!fs.existsSync(watchDir)) return 0;

      let added = 0;
      let entries;
      try {
        entries = fs.readdirSync(watchDir, { withFileTypes: true });
      } catch {
        return 0;
      }

      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith(".torrent")) continue;
        const fullPath = path.join(watchDir, entry.name);
        if (this._watchedProcessed.has(fullPath)) continue;

        try {
          const st = fs.statSync(fullPath);
          if (minAgeMs > 0 && now - st.mtimeMs < minAgeMs) continue;

          const buf = fs.readFileSync(fullPath);
          this._watchedProcessed.add(fullPath);
          await this.addTorrent(buf, { tag: this.settings.watchFolderTag || "" });
          added += 1;

          if (this.settings.watchFolderAction === "delete") {
            fs.rmSync(fullPath, { force: true });
          } else {
            fs.renameSync(fullPath, `${fullPath}.added`);
          }
          this.logger.info("Watch Folder", `Imported "${entry.name}" (${this.settings.watchFolderAction})`);
        } catch (err) {
          this.logger.error("Watch Folder", `Failed to import ${entry.name}: ${err.message}`, { alwaysConsole: true });
        }
      }
      return added;
    })();

    try {
      return await this._watchScanPromise;
    } finally {
      this._watchScanPromise = null;
    }
  }

  loadSettings() {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
        const mergedUi = { ...this.settings.ui, ...(parsed.ui && typeof parsed.ui === "object" ? parsed.ui : {}) };
        this.settings = { ...this.settings, ...parsed, ui: mergedUi };
        this.settings.scheduler = this._normalizeScheduler(this.settings.scheduler);
        if (this.settings.downloadDir) {
          const resolved = this._resolveConfigPath(this.settings.downloadDir);
          if (resolved) {
            if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
            this.downloadDir = resolved;
            this.settings.downloadDir = resolved;
          }
        }
        if (this.settings.incompleteDir) {
          this.settings.incompleteDir = this._resolveConfigPath(this.settings.incompleteDir);
          if (this.settings.incompleteDirEnabled && this.settings.incompleteDir && !fs.existsSync(this.settings.incompleteDir)) {
            fs.mkdirSync(this.settings.incompleteDir, { recursive: true });
          }
        }
        if (this.settings.watchFolderPath) {
          this.settings.watchFolderPath = this._resolveConfigPath(this.settings.watchFolderPath);
        }
        if (!["rename", "delete"].includes(this.settings.watchFolderAction)) {
          this.settings.watchFolderAction = "rename";
        }
        this.settings.watchFolderTag = this._sanitizeTag(this.settings.watchFolderTag || "");
        if (typeof this.settings.maxConns !== "number" || !Number.isFinite(this.settings.maxConns)) {
          this.settings.maxConns = 120;
        }
        this.settings.maxConns = Math.max(10, Math.min(500, Math.round(this.settings.maxConns)));
        if (typeof this.settings.maxActiveDownloads !== "number" || !Number.isFinite(this.settings.maxActiveDownloads)) {
          this.settings.maxActiveDownloads = 0;
        }
        this.settings.maxActiveDownloads = Math.max(0, Math.min(50, Math.round(this.settings.maxActiveDownloads)));
        if (typeof this.settings.seedRatioLimit !== "number" || !Number.isFinite(this.settings.seedRatioLimit) || this.settings.seedRatioLimit <= 0) {
          this.settings.seedRatioLimit = -1;
        }
        this.settings.autoStopOnComplete = Boolean(this.settings.autoStopOnComplete);
        if (!["none", "pause-seeding", "exit", "sleep"].includes(this.settings.onCompleteAction)) {
          this.settings.onCompleteAction = "none";
        }
        this.networkManager.configure({
          multiNetworkEnabled: Boolean(this.settings.multiNetworkEnabled),
          selectedInterfaces: Array.isArray(this.settings.selectedInterfaces)
            ? this.settings.selectedInterfaces
            : []
        });
      }
    } catch (e) {
      console.error("[Settings Load Error]", e.message);
    }
  }

  saveSettings() {
    try {
      this.settings.downloadDir = this.downloadDir;
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), "utf8");
    } catch (e) {
      console.error("[Settings Save Error]", e.message);
    }
  }

  setSettings({
    downloadDir,
    maxDownloadSpeed,
    maxUploadSpeed,
    maxConns,
    maxActiveDownloads,
    seedRatioLimit,
    autoStopOnComplete,
    onCompleteAction,
    autoTagSubfolder,
    showAddDialog,
    notificationsEnabled,
    incompleteDirEnabled,
    incompleteDir,
    watchFolderEnabled,
    watchFolderPath,
    watchFolderAction,
    watchFolderTag,
    scheduler,
    multiNetworkEnabled,
    selectedInterfaces,
    ui
  }) {
    if (downloadDir && typeof downloadDir === "string") {
      const resolved = this._resolveConfigPath(downloadDir);
      if (resolved) {
        if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
        this.downloadDir = resolved;
        this.settings.downloadDir = resolved;
      }
    }

    if (typeof incompleteDirEnabled === "boolean") {
      this.settings.incompleteDirEnabled = incompleteDirEnabled;
    }
    if (typeof incompleteDir === "string") {
      this.settings.incompleteDir = this._resolveConfigPath(incompleteDir);
    }
    if (this.settings.incompleteDirEnabled && !this.settings.incompleteDir) {
      this.settings.incompleteDir = path.join(this.downloadDir, "incomplete");
    }
    if (this.settings.incompleteDirEnabled && this.settings.incompleteDir && !fs.existsSync(this.settings.incompleteDir)) {
      fs.mkdirSync(this.settings.incompleteDir, { recursive: true });
    }

    if (typeof watchFolderEnabled === "boolean") {
      this.settings.watchFolderEnabled = watchFolderEnabled;
    }
    if (typeof watchFolderPath === "string") {
      const nextPath = this._resolveConfigPath(watchFolderPath);
      if (nextPath !== this.settings.watchFolderPath) {
        this._watchedProcessed.clear();
      }
      this.settings.watchFolderPath = nextPath;
    }
    if (typeof watchFolderAction === "string" && ["rename", "delete"].includes(watchFolderAction)) {
      this.settings.watchFolderAction = watchFolderAction;
    }
    if (typeof watchFolderTag === "string") {
      this.settings.watchFolderTag = this._sanitizeTag(watchFolderTag);
    }
    if (scheduler && typeof scheduler === "object") {
      this.settings.scheduler = this._normalizeScheduler({ ...this.settings.scheduler, ...scheduler });
    }

    if (typeof maxDownloadSpeed === "number" && Number.isFinite(maxDownloadSpeed)) {
      this.settings.maxDownloadSpeed = maxDownloadSpeed;
    }
    if (typeof maxUploadSpeed === "number" && Number.isFinite(maxUploadSpeed)) {
      this.settings.maxUploadSpeed = maxUploadSpeed;
    }
    if (typeof maxConns === "number" && Number.isFinite(maxConns)) {
      this.settings.maxConns = Math.max(10, Math.min(500, Math.round(maxConns)));
    }
    if (typeof maxActiveDownloads === "number" && Number.isFinite(maxActiveDownloads)) {
      this.settings.maxActiveDownloads = Math.max(0, Math.min(50, Math.round(maxActiveDownloads)));
    }
    if (typeof seedRatioLimit === "number" && Number.isFinite(seedRatioLimit)) {
      this.settings.seedRatioLimit = seedRatioLimit <= 0 ? -1 : Math.round(seedRatioLimit * 100) / 100;
    }
    if (typeof autoStopOnComplete === "boolean") {
      this.settings.autoStopOnComplete = autoStopOnComplete;
    }
    if (typeof onCompleteAction === "string" && ["none", "pause-seeding", "exit", "sleep"].includes(onCompleteAction)) {
      this.settings.onCompleteAction = onCompleteAction;
    }
    if (typeof autoTagSubfolder === "boolean") {
      this.settings.autoTagSubfolder = autoTagSubfolder;
    }
    if (typeof showAddDialog === "boolean") {
      this.settings.showAddDialog = showAddDialog;
    }
    if (typeof notificationsEnabled === "boolean") {
      this.settings.notificationsEnabled = notificationsEnabled;
    }
    if (typeof multiNetworkEnabled === "boolean") {
      this.settings.multiNetworkEnabled = multiNetworkEnabled;
    }
    if (Array.isArray(selectedInterfaces)) {
      this.settings.selectedInterfaces = selectedInterfaces
        .filter((item) => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim());
    }
    if (ui && typeof ui === "object") {
      const sanitizedColumns = Array.isArray(ui.columns)
        ? ui.columns
            .filter((c) => c && typeof c.id === "string")
            .map((c) => ({ id: c.id, visible: c.id === "name" ? true : Boolean(c.visible) }))
        : undefined;
      this.settings.ui = {
        ...this.settings.ui,
        ...(typeof ui.theme === "string" ? { theme: ui.theme } : {}),
        ...(typeof ui.density === "string" ? { density: ui.density } : {}),
        ...(typeof ui.speedUnit === "string" ? { speedUnit: ui.speedUnit } : {}),
        ...(typeof ui.showSidebar === "boolean" ? { showSidebar: ui.showSidebar } : {}),
        ...(typeof ui.showDetailsPanel === "boolean" ? { showDetailsPanel: ui.showDetailsPanel } : {}),
        ...(sanitizedColumns ? { columns: sanitizedColumns } : {})
      };
    }

    this.networkManager.configure({
      multiNetworkEnabled: this.settings.multiNetworkEnabled,
      selectedInterfaces: this.settings.selectedInterfaces
    });
    this.saveSettings();

    if (this.client && !this.client.destroyed) {
      this.applyBandwidthSchedule(new Date(), true);
      this.client.maxConns = this.settings.maxConns;
      this.client.utp = this.networkManager.shouldBindMultiNetwork()
        ? false
        : Boolean(WebTorrent.UTP_SUPPORT);
      this._drainActiveTorrents();
      this.enforceLifecycleRules().catch(() => {});
      if (this.settings.watchFolderEnabled) {
        this.scanWatchFolder().catch(() => {});
      }
    }
  }

  getNetworkSnapshot() {
    return this.networkManager.getNetworkSnapshot();
  }

  getSettings() {
    return {
      ...this.settings,
      downloadDir: this.downloadDir,
      defaultDownloadDir: this.defaultDownloadDir,
      schedulerActive: this._schedulerActive
    };
  }

  _sanitizeTag(tag) {
    if (!tag || typeof tag !== "string") return "";
    return tag.trim().replace(/[<>:"/\\|?*\0]/g, "").slice(0, 40);
  }

  _resolveSaveDir(customSavePath = "", tag = "") {
    const cleanTag = this._sanitizeTag(tag);
    let target = this.downloadDir;

    const resolvedCustom = this._resolveConfigPath(customSavePath);
    if (resolvedCustom) {
      target = resolvedCustom;
    } else if (this.settings.autoTagSubfolder && cleanTag) {
      target = sanitizeFilePath(this.downloadDir, cleanTag);
    }

    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    return target;
  }

  async inspectTorrentSource(source) {
    let input = source;
    if (typeof source === "string") {
      const trimmed = source.trim();
      if (trimmed.toLowerCase().endsWith(".torrent") && fs.existsSync(trimmed)) {
        input = fs.readFileSync(trimmed);
      } else if (!validateMagnetURI(trimmed)) {
        throw new Error("Invalid magnet URI or hash");
      } else {
        input = trimmed;
      }
    }

    const parsed = await parseTorrent(input);
    const files = Array.isArray(parsed.files)
      ? parsed.files.map((f, index) => ({
          index,
          name: f.name || path.basename(f.path || `file-${index}`),
          path: f.path || f.name || `file-${index}`,
          length: f.length || 0
        }))
      : [];

    return {
      infoHash: parsed.infoHash,
      name: parsed.name || "Magnet Torrent",
      size: parsed.length || files.reduce((sum, f) => sum + (f.length || 0), 0),
      hasFileList: files.length > 0,
      files
    };
  }

  _setFilePriorityMap(hash, deselectedInput = null, priorityInput = null) {
    const map = new Map();
    if (Array.isArray(deselectedInput)) {
      for (const idx of deselectedInput) {
        if (Number.isInteger(idx) && idx >= 0) map.set(idx, "skip");
      }
    }
    if (priorityInput && typeof priorityInput === "object") {
      for (const [k, v] of Object.entries(priorityInput)) {
        const idx = parseInt(k, 10);
        if (Number.isInteger(idx) && idx >= 0 && (v === "high" || v === "skip")) {
          map.set(idx, v);
        }
      }
    }
    if (map.size > 0) {
      this.filePriorities.set(hash, map);
    } else {
      this.filePriorities.delete(hash);
    }
  }

  loadSession() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const raw = fs.readFileSync(this.sessionFile, "utf8");
        const list = JSON.parse(raw);
        if (!Array.isArray(list)) return;
        for (const item of list) {
          if (item.magnetURI && validateMagnetURI(item.magnetURI)) {
            const hash = item.infoHash ? item.infoHash.toLowerCase() : null;
            if (hash) {
              this._setFilePriorityMap(hash, item.deselectedFiles, item.filePriorities);
              if (item.tag) this.torrentTags.set(hash, this._sanitizeTag(item.tag));
              if (item.savePath) this.torrentPaths.set(hash, item.savePath);
              if (item.isCustomPath) this.torrentCustomPaths.add(hash);
              if (item.completed) this._knownCompleted.add(hash);
              if (item.addedAt) this.torrentAddedAt.set(hash, item.addedAt);
              if (item.completedAt) this.torrentCompletedAt.set(hash, item.completedAt);
              if (item.queued) this.queuedTorrents.add(hash);
              if (item.stopped) this.stoppedTorrents.add(hash);
            }
            this.addTorrent(item.magnetURI, {
              paused: Boolean(item.paused || item.queued || item.stopped),
              stopped: Boolean(item.stopped),
              queued: Boolean(item.queued),
              sequential: Boolean(item.sequential),
              savePath: item.savePath || "",
              isCustomPath: Boolean(item.isCustomPath),
              isSessionRestore: true,
              tag: item.tag || ""
            }).catch((err) => {
              console.error("[Session Restore Error]", err.message);
            });
          }
        }
      }
    } catch (e) {
      console.error("[Session Load Error]", e.message);
    }
  }

  saveSession() {
    try {
      const list = this.client.torrents
        .filter((t) => Boolean(t.infoHash && t.magnetURI))
        .map((t) => {
          const prioMap = this.filePriorities.get(t.infoHash);
          const deselectedFiles = [];
          const filePriorities = {};
          if (prioMap) {
            for (const [idx, prio] of prioMap.entries()) {
              filePriorities[idx] = prio;
              if (prio === "skip") deselectedFiles.push(idx);
            }
          }
          return {
            infoHash: t.infoHash,
            name: t.name,
            magnetURI: t.magnetURI,
            paused: this.pausedTorrents.has(t.infoHash) && !this.queuedTorrents.has(t.infoHash),
            stopped: this.stoppedTorrents.has(t.infoHash),
            queued: this.queuedTorrents.has(t.infoHash),
            sequential: this.sequentialTorrents.has(t.infoHash),
            completed: Boolean(t.done || this._knownCompleted.has(t.infoHash)),
            tag: this.torrentTags.get(t.infoHash) || "",
            savePath: this.torrentPaths.get(t.infoHash) || t.path || this.downloadDir,
            isCustomPath: this.torrentCustomPaths.has(t.infoHash),
            addedAt: this.torrentAddedAt.get(t.infoHash) || null,
            completedAt: this.torrentCompletedAt.get(t.infoHash) || null,
            deselectedFiles,
            filePriorities
          };
        });
      fs.writeFileSync(this.sessionFile, JSON.stringify(list, null, 2), "utf8");
    } catch (e) {
      console.error("[Session Save Error]", e.message);
    }
  }

  async addTorrent(source, options = {}) {
    let torrentInput = source;

    if (typeof source === "string") {
      const trimmed = source.trim();
      if (trimmed.toLowerCase().endsWith(".torrent") && fs.existsSync(trimmed)) {
        torrentInput = fs.readFileSync(trimmed);
      } else if (!validateMagnetURI(trimmed)) {
        throw new Error("Invalid magnet URI or hash");
      } else {
        torrentInput = trimmed;
      }
    }

    const existing = await this.findTorrent(torrentInput);
    if (existing && !existing.destroyed) {
      return this.serializeTorrent(existing);
    }

    const cleanTag = this._sanitizeTag(options.tag || "");
    const resolvedInputPath = this._resolveConfigPath(options.savePath || "");
    const isExplicitCustom =
      typeof options.isCustomPath === "boolean"
        ? options.isCustomPath
        : Boolean(
            resolvedInputPath &&
            !options.isRelocatedCompleted &&
            resolvedInputPath !== this.downloadDir &&
            resolvedInputPath !== this.settings.incompleteDir
          );

    let targetDir;
    if (options.isRelocatedCompleted || (options.isSessionRestore && resolvedInputPath)) {
      targetDir = this._resolveSaveDir(resolvedInputPath, cleanTag);
    } else if (isExplicitCustom) {
      targetDir = this._resolveSaveDir(resolvedInputPath, cleanTag);
    } else if (this.settings.incompleteDirEnabled && this.settings.incompleteDir) {
      targetDir = this._resolveSaveDir(this.settings.incompleteDir, cleanTag);
    } else {
      targetDir = this._resolveSaveDir("", cleanTag);
    }

    const deselectedInput = Array.isArray(options.deselectedFiles)
      ? options.deselectedFiles.filter((idx) => Number.isInteger(idx) && idx >= 0)
      : null;

    // Enforce active download queue at add-time unless explicitly paused or relocated
    const startStopped = Boolean(options.stopped);
    let startPaused = Boolean(options.paused || startStopped);
    let startQueued = Boolean(options.queued);
    if (!startPaused && !startQueued && !options.isRelocatedCompleted && this.settings.maxActiveDownloads > 0) {
      const activeCount = this._countActiveDownloads();
      if (activeCount >= this.settings.maxActiveDownloads) {
        startPaused = true;
        startQueued = true;
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        const opts = {
          path: targetDir,
          destroyStoreOnDestroy: false,
          paused: startPaused,
          deselect: startPaused,
          strategy: "sequential"
        };

        const torrent = this.client.add(torrentInput, opts, (t) => {
          this.logger.info("Torrent Added", `${t.name || t.infoHash} (${targetDir})`, { alwaysConsole: true });
          this.torrentPaths.set(t.infoHash, targetDir);
          if (isExplicitCustom) this.torrentCustomPaths.add(t.infoHash);
          if (!this.torrentAddedAt.has(t.infoHash)) {
            this.torrentAddedAt.set(t.infoHash, options.addedAt || Date.now());
          }
          if (options.completedAt) {
            this.torrentCompletedAt.set(t.infoHash, options.completedAt);
          }
          if (cleanTag) this.torrentTags.set(t.infoHash, cleanTag);
          if (deselectedInput || options.filePriorities) {
            this._setFilePriorityMap(t.infoHash, deselectedInput, options.filePriorities);
          }

          if (startStopped || this.stoppedTorrents.has(t.infoHash)) {
            this.stoppedTorrents.add(t.infoHash);
            this.pausedTorrents.add(t.infoHash);
            this._applyPauseState(t, { disconnectPeers: true });
          } else if (startPaused || this.pausedTorrents.has(t.infoHash)) {
            this.pausedTorrents.add(t.infoHash);
            if (startQueued) this.queuedTorrents.add(t.infoHash);
            this._applyPauseState(t);
          } else {
            if (options.sequential) {
              this.sequentialTorrents.add(t.infoHash);
            }
            this._applyActiveSelections(t);
          }

          if (t.done) {
            this._knownCompleted.add(t.infoHash);
            if (!this.torrentCompletedAt.has(t.infoHash)) {
              this.torrentCompletedAt.set(t.infoHash, Date.now());
            }
          }

          this.saveSession();
          finish(this.serializeTorrent(t));
        });

        torrent.once("_infoHash", () => {
          const hash = torrent.infoHash;
          this.torrentPaths.set(hash, targetDir);
          if (isExplicitCustom) this.torrentCustomPaths.add(hash);
          if (!this.torrentAddedAt.has(hash)) {
            this.torrentAddedAt.set(hash, options.addedAt || Date.now());
          }
          if (cleanTag) this.torrentTags.set(hash, cleanTag);
          if (deselectedInput || options.filePriorities) {
            this._setFilePriorityMap(hash, deselectedInput, options.filePriorities);
          }
          if (startStopped) this.stoppedTorrents.add(hash);
          if (startPaused) this.pausedTorrents.add(hash);
          if (startQueued) this.queuedTorrents.add(hash);
          if (options.sequential) this.sequentialTorrents.add(hash);
          this.saveSession();
        });

        torrent.once("metadata", () => {
          if (startStopped || this.stoppedTorrents.has(torrent.infoHash)) {
            this._applyPauseState(torrent, { disconnectPeers: true });
          } else if (startPaused || this.pausedTorrents.has(torrent.infoHash)) {
            this._applyPauseState(torrent);
          }
        });

        torrent.on("error", (err) => {
          this.logger.error(`Torrent ${torrent.infoHash || "unknown"} Error`, err.message, { alwaysConsole: true });
          if (!settled) {
            settled = true;
            reject(err);
          }
        });

        torrent.on("done", async () => {
          this.logger.info("Torrent Finished", torrent.name || torrent.infoHash, { alwaysConsole: true });
          const hash = torrent.infoHash;
          const wasKnown = this._knownCompleted.has(hash) || options.isRelocatedCompleted;
          const receivedBytes = torrent.received;
          this._knownCompleted.add(hash);
          if (!this.torrentCompletedAt.has(hash)) {
            this.torrentCompletedAt.set(hash, Date.now());
          }
          this.queuedTorrents.delete(hash);

          if (
            !wasKnown &&
            !options.isSessionRestore &&
            !options.paused &&
            !startStopped &&
            this.settings.autoStopOnComplete
          ) {
            this.stoppedTorrents.add(hash);
            this.pausedTorrents.add(hash);
            queueMicrotask(() => {
              if (torrent.destroyed) return;
              this._applyPauseState(torrent, { disconnectPeers: true });
            });
            this.logger.info("Auto-Stop", `Stopped seeding ${torrent.name || hash} on completion`, { alwaysConsole: true });
          }

          const completedSnapshot = !wasKnown && receivedBytes > 0 ? this.serializeTorrent(torrent) : null;
          this.saveSession();

          // Relocate completed download from incompleteDir to final directory if enabled
          if (!wasKnown && receivedBytes > 0 && this.settings.incompleteDirEnabled && !this.torrentCustomPaths.has(hash)) {
            const finalDir = this._resolveSaveDir("", this.torrentTags.get(hash) || "");
            const curDir = this.torrentPaths.get(hash) || torrent.path || this.downloadDir;
            if (path.resolve(curDir) !== path.resolve(finalDir)) {
              const moved = await this._relocateCompletedTorrent(torrent, finalDir);
              if (moved && completedSnapshot) {
                completedSnapshot.path = finalDir;
              }
            }
          }

          // Enforce queue right away so next queued torrent can start
          this.enforceLifecycleRules().catch(() => {});

          if (completedSnapshot) {
            if (this.settings.notificationsEnabled && this.onTorrentComplete) {
              this.onTorrentComplete(completedSnapshot);
            }
            const remaining = this.client.torrents.filter(
              (other) => !other.destroyed && !other.done && (!this.pausedTorrents.has(other.infoHash) || this.queuedTorrents.has(other.infoHash))
            );
            if (remaining.length === 0 && this.settings.onCompleteAction !== "none" && this.onAllComplete) {
              this.onAllComplete(this.settings.onCompleteAction);
            }
          }
        });

        const timer = setTimeout(() => {
          finish(this.serializeTorrent(torrent));
        }, 1500);
        timer.unref?.();
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  _movePathSync(srcPath, dstPath) {
    if (!fs.existsSync(srcPath) || srcPath === dstPath) return false;
    if (fs.existsSync(dstPath)) {
      throw new Error(`Destination already exists: ${dstPath}`);
    }
    const parent = path.dirname(dstPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    try {
      fs.renameSync(srcPath, dstPath);
    } catch (err) {
      if (err.code === "EXDEV") {
        fs.cpSync(srcPath, dstPath, { recursive: true, preserveTimestamps: true });
        fs.rmSync(srcPath, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    return true;
  }

  async _relocateCompletedTorrent(torrent, finalDir) {
    if (!torrent || torrent.destroyed || !torrent.name) return false;
    const hash = torrent.infoHash;
    if (!hash || this._movingTorrents.has(hash)) return false;

    const oldDir = this.torrentPaths.get(hash) || torrent.path || this.downloadDir;
    const srcRoot = sanitizeFilePath(oldDir, torrent.name);
    const dstRoot = sanitizeFilePath(finalDir, torrent.name);
    if (path.resolve(srcRoot) === path.resolve(dstRoot) || !fs.existsSync(srcRoot)) {
      return false;
    }

    this._movingTorrents.add(hash);
    const wasPaused = this.pausedTorrents.has(hash);
    const isSeq = this.sequentialTorrents.has(hash);
    const tag = this.torrentTags.get(hash) || "";
    const prioMap = this.filePriorities.get(hash);
    const filePriorities = prioMap ? Object.fromEntries(prioMap.entries()) : null;
    const addedAt = this.torrentAddedAt.get(hash) || Date.now();
    const completedAt = this.torrentCompletedAt.get(hash) || Date.now();
    const sourceData = torrent.torrentFile || torrent.magnetURI;

    try {
      if (typeof torrent.pause === "function") torrent.pause();
      await new Promise((resolve) => {
        const fallback = setTimeout(resolve, 4000);
        fallback.unref?.();
        torrent.destroy({ destroyStore: false }, () => {
          clearTimeout(fallback);
          resolve();
        });
      });

      this._movePathSync(srcRoot, dstRoot);
      this.torrentPaths.set(hash, finalDir);
      this._knownCompleted.add(hash);

      await this.addTorrent(sourceData, {
        paused: wasPaused,
        sequential: isSeq,
        savePath: finalDir,
        isCustomPath: false,
        isRelocatedCompleted: true,
        tag,
        filePriorities,
        addedAt,
        completedAt
      });
      this.logger.info("Auto-Moved Completed", `${torrent.name} -> ${finalDir}`, { alwaysConsole: true });
      return true;
    } catch (err) {
      this.logger.error("Auto-Move Error", `${torrent.name}: ${err.message}`, { alwaysConsole: true });
      return false;
    } finally {
      this._movingTorrents.delete(hash);
    }
  }

  _applyActiveSelections(torrent) {
    if (!torrent || torrent.destroyed) return;
    const hash = torrent.infoHash;
    const isSeq = this.sequentialTorrents.has(hash);
    const basePriority = isSeq ? 1 : 0;
    torrent.strategy = "sequential";
    if (torrent._rarityMap) {
      try { torrent._rarityMap.destroy(); } catch (_) {}
      torrent._rarityMap = null;
    }

    if (!torrent.pieces || torrent.pieces.length === 0) return;

    const prioMap = this.filePriorities.get(hash);
    if (!prioMap || prioMap.size === 0) {
      torrent.select(0, torrent.pieces.length - 1, basePriority);
      return;
    }

    if (torrent._selections && typeof torrent._selections.clear === "function") {
      torrent._selections.clear();
    }
    if (Array.isArray(torrent.files)) {
      for (let i = 0; i < torrent.files.length; i += 1) {
        const prio = prioMap.get(i) || "normal";
        if (prio !== "skip" && torrent.files[i].length > 0) {
          torrent.files[i].select(prio === "high" ? basePriority + 2 : basePriority);
        }
      }
    }
    if (typeof torrent._updateSelections === "function") {
      torrent._updateSelections();
    }
  }

  _applyPauseState(torrent, { disconnectPeers = false } = {}) {
    if (!torrent || torrent.destroyed) return;
    if (typeof torrent.pause === "function") {
      torrent.pause();
    }
    if (torrent.pieces && torrent.pieces.length > 0) {
      try {
        torrent.deselect(0, torrent.pieces.length - 1);
      } catch (err) {
        console.warn("[Pause Deselect Warning]", err.message);
      }
    }
    if (torrent._selections && typeof torrent._selections.clear === "function") {
      torrent._selections.clear();
      if (typeof torrent._updateSelections === "function") {
        torrent._updateSelections();
      }
    }

    if (disconnectPeers) {
      if (Array.isArray(torrent._queue)) {
        torrent._queue.length = 0;
      }
      if (torrent._peers && typeof torrent._peers.keys === "function") {
        for (const id of [...torrent._peers.keys()]) {
          try {
            torrent.removePeer(id);
          } catch {}
        }
      }
      if (Array.isArray(torrent.wires)) {
        for (const wire of [...torrent.wires]) {
          try {
            wire.destroy();
          } catch {}
        }
      }
      if (torrent._noPeersIntervalId) {
        clearInterval(torrent._noPeersIntervalId);
        torrent._noPeersIntervalId = null;
      }
      if (torrent.discovery) {
        const disc = torrent.discovery;
        torrent.discovery = null;
        try {
          disc.destroy(() => {});
        } catch {}
      } else {
        torrent.discovery = null;
      }
    } else if (Array.isArray(torrent.wires)) {
      // Choke existing wires immediately so paused torrents never seed/upload
      for (const wire of torrent.wires) {
        this._guardWire(torrent, wire);
        try {
          wire.choke();
          wire.uninterested();
        } catch {}
      }
    }
  }

  async recheckTorrent(infoHash) {
    const torrent = await this.findTorrent(infoHash);
    if (!torrent || torrent.destroyed || !torrent.ready) return false;
    if (torrent._manualChecking) return true;

    torrent._manualChecking = true;
    torrent._isChecking = true;
    torrent._verifyChecked = 0;

    this.logger.info("Recheck", `Started verification for ${torrent.name || torrent.infoHash}`);
    try {
      torrent.rescanFiles((err) => {
        torrent._manualChecking = false;
        torrent._isChecking = false;
        if (err) {
          this.logger.error("Recheck Error", `${torrent.infoHash}: ${err.message}`, { alwaysConsole: true });
        } else {
          this.logger.info("Recheck", `Completed verification for ${torrent.name || torrent.infoHash}`);
          if (this.stoppedTorrents.has(torrent.infoHash)) {
            this._applyPauseState(torrent, { disconnectPeers: true });
          } else if (this.pausedTorrents.has(torrent.infoHash)) {
            this._applyPauseState(torrent, { disconnectPeers: false });
          } else {
            this._applyActiveSelections(torrent);
          }
        }
        this.saveSession();
      });
      return true;
    } catch (err) {
      torrent._manualChecking = false;
      torrent._isChecking = false;
      throw err;
    }
  }

  async setFilePriority(infoHash, fileIndex, priority = "normal") {
    if (!["high", "normal", "skip"].includes(priority)) {
      throw new Error("Invalid file priority (expected high, normal, or skip)");
    }
    const torrent = await this.findTorrent(infoHash);
    if (!torrent || torrent.destroyed || !Array.isArray(torrent.files) || !torrent.files[fileIndex]) {
      return false;
    }

    const hash = torrent.infoHash || String(infoHash).toLowerCase();
    let prioMap = this.filePriorities.get(hash);
    if (!prioMap) {
      prioMap = new Map();
      this.filePriorities.set(hash, prioMap);
    }

    if (priority === "normal") {
      prioMap.delete(fileIndex);
      if (prioMap.size === 0) this.filePriorities.delete(hash);
    } else {
      prioMap.set(fileIndex, priority);
    }

    if (!this.pausedTorrents.has(hash)) {
      this._applyActiveSelections(torrent);
    }

    torrent._prioVersion = (torrent._prioVersion || 0) + 1;
    this.saveSession();
    this.logger.info("File Priority", `${torrent.files[fileIndex].name} -> ${priority} (${torrent.name || hash})`);
    return true;
  }

  async setFileSelection(infoHash, fileIndex, selected) {
    return this.setFilePriority(infoHash, fileIndex, selected ? "normal" : "skip");
  }

  async moveQueue(infoHash, direction) {
    const torrent = await this.findTorrent(infoHash);
    const hash = torrent?.infoHash || String(infoHash).toLowerCase();
    if (!this.queuedTorrents.has(hash)) return null;

    const order = [...this.queuedTorrents];
    const idx = order.indexOf(hash);
    if (idx === -1) return null;

    let targetIdx = idx;
    if (direction === "top") targetIdx = 0;
    else if (direction === "bottom") targetIdx = order.length - 1;
    else if (direction === "up") targetIdx = Math.max(0, idx - 1);
    else if (direction === "down") targetIdx = Math.min(order.length - 1, idx + 1);

    if (targetIdx !== idx) {
      order.splice(idx, 1);
      order.splice(targetIdx, 0, hash);
      this.queuedTorrents = new Set(order);
      this.saveSession();
      this.logger.info("Queue", `Moved ${torrent?.name || hash} ${direction} -> #${targetIdx + 1}`);
    }
    return { ok: true, position: order.indexOf(hash) + 1 };
  }

  async setSequential(infoHash, enabled = true) {
    const torrent = await this.findTorrent(infoHash);
    if (!torrent || torrent.destroyed) return false;

    const hash = torrent.infoHash || infoHash;
    if (enabled) {
      this.sequentialTorrents.add(hash);
    } else {
      this.sequentialTorrents.delete(hash);
    }

    if (!this.pausedTorrents.has(hash)) {
      this._applyActiveSelections(torrent);
    } else {
      torrent.strategy = "sequential";
      if (torrent._rarityMap) {
        try { torrent._rarityMap.destroy(); } catch (_) {}
        torrent._rarityMap = null;
      }
    }

    this.saveSession();
    return true;
  }

  isSequential(infoHash) {
    return this.sequentialTorrents.has(String(infoHash).toLowerCase());
  }

  _countActiveDownloads() {
    let count = 0;
    for (const t of this.client.torrents) {
      if (!t.destroyed && !t.done && !this.pausedTorrents.has(t.infoHash) && !this.queuedTorrents.has(t.infoHash)) {
        count += 1;
      }
    }
    return count;
  }

  async enforceLifecycleRules() {
    if (!this.client || this.client.destroyed) return;
    let changed = false;

    // 1. Seed ratio limit check
    if (this.settings.seedRatioLimit > 0) {
      for (const t of [...this.client.torrents]) {
        if (
          !t.destroyed &&
          t.done &&
          !this.pausedTorrents.has(t.infoHash) &&
          !this.stoppedTorrents.has(t.infoHash) &&
          (t.ratio || 0) >= this.settings.seedRatioLimit
        ) {
          this.logger.info("Ratio Limit Reached", `Stopping ${t.name} (ratio ${t.ratio.toFixed(2)})`, { alwaysConsole: true });
          this.stoppedTorrents.add(t.infoHash);
          this.pausedTorrents.add(t.infoHash);
          this._applyPauseState(t, { disconnectPeers: true });
          changed = true;
        }
      }
    }

    // 2. Max active download queue management
    const cap = this.settings.maxActiveDownloads;
    if (cap > 0) {
      let active = this._countActiveDownloads();

      // Queue excess active downloads (newest first)
      if (active > cap) {
        for (let i = this.client.torrents.length - 1; i >= 0 && active > cap; i -= 1) {
          const t = this.client.torrents[i];
          if (!t.destroyed && !t.done && !this.pausedTorrents.has(t.infoHash) && !this.queuedTorrents.has(t.infoHash)) {
            this.pausedTorrents.add(t.infoHash);
            this.queuedTorrents.add(t.infoHash);
            this._applyPauseState(t);
            this.logger.info("Queue", `Queued ${t.name || t.infoHash} (active cap ${cap})`);
            active -= 1;
            changed = true;
          }
        }
      }

      // Start queued downloads while slots are available
      if (active < cap && this.queuedTorrents.size > 0) {
        for (const hash of [...this.queuedTorrents]) {
          if (active >= cap) break;
          const t = await this.findTorrent(hash);
          if (!t || t.destroyed || t.done) {
            this.queuedTorrents.delete(hash);
            continue;
          }
          this.queuedTorrents.delete(hash);
          this.pausedTorrents.delete(hash);
          t._startAsDeselected = false;
          if (typeof t.resume === "function") t.resume();
          this._applyActiveSelections(t);
          this.logger.info("Queue", `Promoted ${t.name || hash} from queue to active`);
          active += 1;
          changed = true;
        }
      }
    } else if (this.queuedTorrents.size > 0) {
      // Queue cap turned off: start all queued torrents
      for (const hash of [...this.queuedTorrents]) {
        this.queuedTorrents.delete(hash);
        const t = await this.findTorrent(hash);
        if (t && !t.destroyed && !t.done) {
          this.pausedTorrents.delete(hash);
          t._startAsDeselected = false;
          if (typeof t.resume === "function") t.resume();
          this._applyActiveSelections(t);
          this.logger.info("Queue", `Started ${t.name || hash} (queue cap removed)`);
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveSession();
    }
  }

  async setTorrentTag(infoHash, tag) {
    const torrent = await this.findTorrent(infoHash);
    if (!torrent || torrent.destroyed) return false;
    const hash = torrent.infoHash || String(infoHash).toLowerCase();
    const clean = this._sanitizeTag(tag);
    if (clean) {
      this.torrentTags.set(hash, clean);
    } else {
      this.torrentTags.delete(hash);
    }
    this.saveSession();
    this.logger.info("Tag", `${torrent.name || hash} -> ${clean || "(cleared)"}`);
    return true;
  }

  async pauseTorrent(infoHash) {
    const torrent = await this.findTorrent(infoHash);
    if (!torrent || torrent.destroyed) return false;

    const hash = torrent.infoHash || infoHash;
    this.queuedTorrents.delete(hash);
    this.pausedTorrents.add(hash);
    this._applyPauseState(torrent, { disconnectPeers: false });
    this.saveSession();
    this.logger.info("Torrent", `Paused ${torrent.name || hash}`);
    this.enforceLifecycleRules().catch(() => {});
    return true;
  }

  async stopTorrent(infoHash) {
    const torrent = await this.findTorrent(infoHash);
    if (!torrent || torrent.destroyed) return false;

    const hash = torrent.infoHash || infoHash;
    this.queuedTorrents.delete(hash);
    this.stoppedTorrents.add(hash);
    this.pausedTorrents.add(hash);
    this._applyPauseState(torrent, { disconnectPeers: true });
    this.saveSession();
    this.logger.info("Torrent", `Stopped ${torrent.name || hash}`);
    this.enforceLifecycleRules().catch(() => {});
    return true;
  }

  async resumeTorrent(infoHash) {
    const torrent = await this.findTorrent(infoHash);
    if (!torrent || torrent.destroyed) return false;

    const hash = torrent.infoHash || infoHash;
    const wasStopped = this.stoppedTorrents.has(hash);
    this.stoppedTorrents.delete(hash);
    this.pausedTorrents.delete(hash);
    this.stoppedTorrents.delete(hash);
    this.queuedTorrents.delete(hash);
    torrent._startAsDeselected = false;

    if (wasStopped && !torrent.discovery && typeof torrent._startDiscovery === "function") {
      try {
        torrent._startDiscovery();
      } catch (err) {
        this.logger.warn("Discovery Restart", `${torrent.name || hash}: ${err.message}`);
      }
    }

    if (typeof torrent.resume === "function") {
      torrent.resume();
    }
    for (const wire of torrent.wires || []) {
      try {
        wire.unchoke();
      } catch {}
    }
    if (typeof torrent._rechoke === "function") {
      try {
        torrent._rechoke();
      } catch {}
    }

    this._applyActiveSelections(torrent);
    this.saveSession();
    this.logger.info("Torrent", `Resumed ${torrent.name || hash}`);
    return true;
  }

  async stopAll() {
    for (const t of [...this.client.torrents]) {
      if (t.infoHash) {
        await this.stopTorrent(t.infoHash);
      }
    }
  }

  async pauseAll() {
    for (const t of [...this.client.torrents]) {
      if (t.infoHash) {
        await this.pauseTorrent(t.infoHash);
      }
    }
  }

  async resumeAll() {
    for (const t of [...this.client.torrents]) {
      if (t.infoHash) {
        await this.resumeTorrent(t.infoHash);
      }
    }
    this.enforceLifecycleRules().catch(() => {});
  }

  _deleteTorrentFiles(torrentPath, torrentName) {
    if (!torrentPath || !torrentName) return;
    try {
      const resolvedBase = path.resolve(torrentPath);
      const safeTarget = sanitizeFilePath(resolvedBase, torrentName);
      if (safeTarget !== resolvedBase && fs.existsSync(safeTarget)) {
        fs.rmSync(safeTarget, { recursive: true, force: true });
      }
    } catch (e) {
      this.logger.error("Delete Files Error", e.message, { alwaysConsole: true });
    }
  }

  async removeTorrent(infoHash, deleteFiles = false) {
    const torrent = await this.findTorrent(infoHash);
    const hash = torrent?.infoHash || String(infoHash).toLowerCase();
    this.logger.info("Torrent", `Removing ${torrent?.name || hash} (deleteFiles=${Boolean(deleteFiles)})`);
    this.pausedTorrents.delete(hash);
    this.stoppedTorrents.delete(hash);
    this.queuedTorrents.delete(hash);
    this.sequentialTorrents.delete(hash);
    this.filePriorities.delete(hash);
    this.torrentTags.delete(hash);
    this.torrentPaths.delete(hash);
    this.torrentCustomPaths.delete(hash);
    this.torrentAddedAt.delete(hash);
    this.torrentCompletedAt.delete(hash);
    this._knownCompleted.delete(hash);

    if (!torrent) {
      this.saveSession();
      return false;
    }

    const torrentPath = torrent.path || this.downloadDir;
    const torrentName = torrent.name;

    if (torrent.destroyed) {
      const idx = this.client.torrents.indexOf(torrent);
      if (idx !== -1) this.client.torrents.splice(idx, 1);
      this.saveSession();
      this.enforceLifecycleRules().catch(() => {});
      if (deleteFiles) {
        this._deleteTorrentFiles(torrentPath, torrentName);
      }
      return true;
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.saveSession();
        this.enforceLifecycleRules().catch(() => {});
        if (deleteFiles) {
          this._deleteTorrentFiles(torrentPath, torrentName);
        }
        resolve(true);
      };

      const fallbackTimer = setTimeout(finish, 5000);
      fallbackTimer.unref?.();

      torrent.destroy({ destroyStore: deleteFiles }, () => {
        clearTimeout(fallbackTimer);
        finish();
      });
    });
  }

  async openFolder(infoHash) {
    let target = this.downloadDir;
    if (infoHash) {
      const torrent = await this.findTorrent(infoHash);
      if (torrent && torrent.name) {
        const basePath = torrent.path || this.downloadDir;
        const full = sanitizeFilePath(basePath, torrent.name);
        if (fs.existsSync(full)) {
          target = full;
        }
      }
    }
    this.openPathHandler(target);
  }

  /**
   * Creates a readable stream for a specific file inside a torrent,
   * supporting HTTP Range headers for real-time video/audio playback.
   */
  async getFileStream(infoHash, fileIndex, rangeHeader = null) {
    const torrent = await this.findTorrent(infoHash);
    if (!torrent || torrent.destroyed || !torrent.files || !torrent.files[fileIndex]) {
      return null;
    }

    const file = torrent.files[fileIndex];
    const total = file.length;
    if (total <= 0) {
      return null;
    }

    const ext = path.extname(file.name).toLowerCase();
    const mimeTypes = {
      ".mp4": "video/mp4",
      ".mkv": "video/webm",
      ".webm": "video/webm",
      ".avi": "video/x-msvideo",
      ".mov": "video/quicktime",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".wav": "audio/wav",
      ".flac": "audio/flac"
    };
    const mimeType = mimeTypes[ext] || "application/octet-stream";

    let start = 0;
    let end = total - 1;
    let isRange = false;

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
      if (match) {
        isRange = true;
        if (match[1] === "" && match[2] !== "") {
          // Suffix-byte-range: bytes=-500
          const suffix = parseInt(match[2], 10);
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          start = match[1] ? parseInt(match[1], 10) : 0;
          end = match[2] ? parseInt(match[2], 10) : total - 1;
        }
        start = Math.max(0, Math.min(start, total - 1));
        end = Math.max(start, Math.min(end, total - 1));
      }
    }

    const stream = file.createReadStream({ start, end });

    return {
      stream,
      start,
      end,
      total,
      mimeType,
      isRange
    };
  }

  _countVerifiedPieces(t, totalPieces) {
    if (t.done) return totalPieces;
    const bf = t.bitfield;
    if (!bf || totalPieces <= 0) return 0;
    if (bf.buffer instanceof Uint8Array) {
      let count = 0;
      const buf = bf.buffer;
      for (let i = 0; i < buf.length; i += 1) {
        count += POPCOUNT_LUT[buf[i]];
      }
      return Math.min(totalPieces, count);
    }
    let count = 0;
    for (let i = 0; i < totalPieces; i += 1) {
      if (bf.get(i)) count += 1;
    }
    return count;
  }

  _buildPieceMap(t) {
    const totalPieces = Array.isArray(t.pieces) ? t.pieces.length : 0;
    if (totalPieces === 0) return { pieceMap: [], totalPieces: 0, verifiedPieces: 0 };

    const maxCells = 240;
    const cellCount = Math.min(totalPieces, maxCells);
    if (t.done) {
      if (!t._donePieceMap || t._donePieceMap.length !== cellCount) {
        t._donePieceMap = new Array(cellCount).fill(2);
      }
      return { pieceMap: t._donePieceMap, totalPieces, verifiedPieces: totalPieces };
    }

    const now = Date.now();
    const cacheKey = `${totalPieces}:${t.downloaded || 0}:${t._verifyChecked || 0}:${this.pausedTorrents.has(t.infoHash)}`;
    if (t._pieceMapCache && t._pieceMapCache.key === cacheKey && now - t._pieceMapCache.at < 2500) {
      return t._pieceMapCache.value;
    }

    const verifiedPieces = this._countVerifiedPieces(t, totalPieces);
    const pieceMap = new Array(cellCount);

    for (let c = 0; c < cellCount; c += 1) {
      const startIdx = Math.floor((c * totalPieces) / cellCount);
      const endIdx = Math.max(startIdx + 1, Math.floor(((c + 1) * totalPieces) / cellCount));
      const span = endIdx - startIdx;
      const step = span <= 4 ? 1 : Math.floor(span / 4);
      let allVerified = true;
      let anyActive = false;

      for (let p = startIdx; p < endIdx; p += step) {
        const verified = Boolean(t.bitfield && t.bitfield.get(p));
        if (!verified) {
          allVerified = false;
          const pieceObj = t.pieces[p];
          const resArr = t._reservations && t._reservations[p];
          if ((resArr && resArr.length > 0 && resArr.some(Boolean)) || (pieceObj && pieceObj.missing < pieceObj.length)) {
            anyActive = true;
          }
        } else {
          anyActive = true;
        }
      }

      pieceMap[c] = allVerified ? 2 : anyActive ? 1 : 0;
    }

    const value = { pieceMap, totalPieces, verifiedPieces };
    t._pieceMapCache = { key: cacheKey, at: now, value };
    return value;
  }

  _calculateAvailability(t) {
    const totalPieces = Array.isArray(t.pieces) ? t.pieces.length : 0;
    if (totalPieces === 0) return t.done ? 1 : 0;

    const wires = t.wires || [];
    if (t.done && wires.length === 0) return 1;

    const now = Date.now();
    const cacheKey = `${totalPieces}:${wires.length}:${t.downloaded || 0}:${t.done}`;
    if (t._availCache && t._availCache.key === cacheKey && now - t._availCache.at < 3500) {
      return t._availCache.val;
    }

    const peerBitfields = [];
    for (let i = 0; i < wires.length && peerBitfields.length < 40; i += 1) {
      const bf = wires[i]?.peerPieces;
      if (bf && typeof bf.get === "function") peerBitfields.push(bf);
    }

    if (t.done && peerBitfields.length === 0) {
      t._availCache = { key: cacheKey, at: now, val: 1 };
      return 1;
    }

    const sampleCount = Math.min(totalPieces, 64);
    let minCopies = Infinity;
    const copyCounts = new Array(sampleCount);

    for (let i = 0; i < sampleCount; i += 1) {
      const p = Math.floor(((i + 0.5) * totalPieces) / sampleCount);
      let copies = t.bitfield && t.bitfield.get(p) ? 1 : 0;
      for (let j = 0; j < peerBitfields.length; j += 1) {
        if (peerBitfields[j].get(p)) copies += 1;
      }
      copyCounts[i] = copies;
      if (copies < minCopies) minCopies = copies;
    }

    let val = 0;
    if (minCopies !== Infinity) {
      let extra = 0;
      for (let i = 0; i < sampleCount; i += 1) {
        if (copyCounts[i] > minCopies) extra += 1;
      }
      val = Math.round((minCopies + extra / sampleCount) * 100) / 100;
    }

    t._availCache = { key: cacheKey, at: now, val };
    return val;
  }

  serializeTorrent(t) {
    const isStopped = this.stoppedTorrents.has(t.infoHash);
    const isQueued = this.queuedTorrents.has(t.infoHash);
    const queuePosition = isQueued ? [...this.queuedTorrents].indexOf(t.infoHash) + 1 : null;
    const isPaused = (this.pausedTorrents.has(t.infoHash) || isStopped) && !isQueued;
    const isSeq = this.sequentialTorrents.has(t.infoHash);
    const prioMap = this.filePriorities.get(t.infoHash);
    const isChecking = Boolean(
      !t.destroyed && (t._manualChecking || (t.metadata && !t.ready) || t._isChecking)
    );

    let status = "downloading";
    if (isStopped) {
      status = "stopped";
    } else if (isChecking && (!isPaused || t._manualChecking)) {
      status = "checking";
    } else if (isQueued) {
      status = "queued";
    } else if (isPaused) {
      status = "paused";
    } else if (t.done) {
      status = "seeding";
    } else if (!t.ready || !t.metadata) {
      status = "connecting";
    } else if (t.numPeers === 0 && t.downloadSpeed === 0) {
      status = "connecting";
    }

    const totalPieces = Array.isArray(t.pieces) ? t.pieces.length : 0;
    const verifyProgress =
      isChecking && totalPieces > 0
        ? Math.min(100, Math.round(((t._verifyChecked || 0) / totalPieces) * 100))
        : 0;

    const eta = t.timeRemaining ? Math.round(t.timeRemaining / 1000) : null;
    const { pieceMap, verifiedPieces } = this._buildPieceMap(t);
    const availability = this._calculateAvailability(t);

    const peers = (t.wires || [])
      .map((w) => {
        const down = typeof w.downloadSpeed === "function" ? w.downloadSpeed() : 0;
        const up = typeof w.uploadSpeed === "function" ? w.uploadSpeed() : 0;
        return {
          addr: w.remoteAddress ? `${w.remoteAddress}:${w.remotePort || 0}` : "Peer",
          type: w.type || "tcp",
          downloadSpeed: down,
          uploadSpeed: up,
          choked: Boolean(w.peerChoking),
          interested: Boolean(w.amInterested)
        };
      })
      .sort((a, b) => (b.downloadSpeed + b.uploadSpeed) - (a.downloadSpeed + a.uploadSpeed))
      .slice(0, 100);

    const trackers = Array.isArray(t.announce) ? t.announce.slice(0, 50) : [];
    let primaryTracker = trackers[0] || (t.numPeers > 0 ? "DHT / PEX" : "-");
    if (trackers[0]) {
      try {
        primaryTracker = new URL(trackers[0]).hostname;
      } catch {}
    }

    const size = t.length || 0;
    const downloaded = t.downloaded || 0;

    return {
      infoHash: t.infoHash,
      name: t.name || "Fetching metadata...",
      status,
      queuePosition,
      verifyProgress,
      size,
      downloaded,
      remaining: Math.max(0, size - downloaded),
      uploaded: t.uploaded || 0,
      progress: Math.min(100, Math.round((t.progress || 0) * 1000) / 10),
      downloadSpeed: t.downloadSpeed || 0,
      uploadSpeed: t.uploadSpeed || 0,
      numPeers: t.numPeers || 0,
      eta,
      ratio: t.ratio ? Math.round(t.ratio * 100) / 100 : 0,
      availability,
      addedAt: this.torrentAddedAt.get(t.infoHash) || null,
      completedAt: this.torrentCompletedAt.get(t.infoHash) || null,
      primaryTracker,
      path: t.path || this.torrentPaths.get(t.infoHash) || this.downloadDir,
      tag: this.torrentTags.get(t.infoHash) || "",
      magnetURI: t.magnetURI,
      sequential: isSeq,
      stopped: isStopped,
      pieceLength: t.pieceLength || 0,
      totalPieces,
      verifiedPieces,
      pieceMap,
      peers,
      trackers,
      files: this._serializeFiles(t, prioMap, isChecking)
    };
  }

  _serializeFiles(t, prioMap, isChecking) {
    const rawFiles = t.files || [];
    if (rawFiles.length === 0) return [];

    const now = Date.now();
    const isPaused = this.pausedTorrents.has(t.infoHash);
    const cacheKey = `${t.done}:${t.downloaded || 0}:${t._prioVersion || 0}:${rawFiles.length}:${isPaused}`;
    if (
      t._filesCache &&
      t._filesCache.key === cacheKey &&
      (t.done || isPaused || (!isChecking && now - t._filesCache.at < 2000))
    ) {
      return t._filesCache.list;
    }

    const list = rawFiles.map((f, index) => {
      const ext = path.extname(f.name).toLowerCase();
      const isMedia = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".mp3", ".wav", ".flac"].includes(ext);
      const filePriority = prioMap?.get(index) || "normal";

      let fileDownloaded = 0;
      if (f.length === 0 || f.done || t.done) {
        fileDownloaded = f.length;
      } else if (
        t.bitfield &&
        typeof f._startPiece === "number" &&
        typeof f._endPiece === "number" &&
        f._startPiece === f._endPiece &&
        t.bitfield.get(f._startPiece)
      ) {
        fileDownloaded = f.length;
      } else {
        // Clamp because WebTorrent's File.downloaded can underflow for single-piece files
        fileDownloaded = Math.max(0, Math.min(f.length, f.downloaded || 0));
      }

      const fileProgress = f.length
        ? Math.min(100, Math.max(0, Math.round((fileDownloaded / f.length) * 100)))
        : 100;

      return {
        index,
        name: f.name,
        path: f.path,
        length: f.length,
        downloaded: fileDownloaded,
        progress: fileProgress,
        priority: filePriority,
        selected: filePriority !== "skip",
        isMedia
      };
    });

    t._filesCache = { key: cacheKey, at: now, list };
    return list;
  }

  getGlobalStats() {
    let downSpeed = 0;
    let upSpeed = 0;
    let activeCount = 0;
    for (const t of this.client.torrents) {
      if (!t.infoHash || t.destroyed) continue;
      downSpeed += t.downloadSpeed || 0;
      upSpeed += t.uploadSpeed || 0;
      const isQueued = this.queuedTorrents.has(t.infoHash);
      const isPaused = this.pausedTorrents.has(t.infoHash) && !isQueued;
      const isChecking = Boolean(t._manualChecking || (t.metadata && !t.ready) || t._isChecking);
      if ((!isPaused && !isQueued && !t.done) || isChecking) {
        activeCount += 1;
      }
    }
    return { downSpeed, upSpeed, activeCount };
  }

  getAllTorrents() {
    return this.client.torrents
      .filter((t) => Boolean(t.infoHash))
      .map((t) => this.serializeTorrent(t));
  }

  async getTorrent(infoHash) {
    const t = await this.findTorrent(infoHash);
    if (!t || t.destroyed) return null;
    return this.serializeTorrent(t);
  }

  destroy() {
    if (this._lifecycleTimer) {
      clearInterval(this._lifecycleTimer);
      this._lifecycleTimer = null;
    }
    this.saveSession();
    if (this.client && !this.client.destroyed) {
      this.client.destroy();
    }
  }
}
