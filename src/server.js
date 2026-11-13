import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { WebSocketServer } from "ws";
import { browseForFolder } from "./windowsHelpers.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upload = multer({ storage: multer.memoryStorage() });

export function createServer(torrentManager, port = 3456, onOpenWindowRequest = null, logger = null) {
  const appLogger = logger || torrentManager?.logger || null;
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json());
  app.use(express.static(path.resolve(APP_ROOT, "public")));

  if (appLogger?.enabled) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on("finish", () => {
        const isSkip = req.path === "/api/logs" || (req.method === "GET" && (req.path === "/api/torrents" || req.path === "/api/ping"));
        if ((!isSkip && req.path.startsWith("/api/")) || res.statusCode >= 400) {
          const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
          appLogger.log(level, "HTTP", `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
        }
      });
      next();
    });
  }

  app.get("/api/ping", (req, res) => {
    res.json({ ok: true, version: "1.0.0", devMode: Boolean(appLogger?.enabled) });
  });

  app.get("/api/logs", (req, res) => {
    const devMode = Boolean(appLogger?.enabled);
    res.json({
      devMode,
      logs: devMode ? appLogger.getEntries() : []
    });
  });

  app.delete("/api/logs", (req, res) => {
    if (appLogger?.enabled) {
      appLogger.clear();
    }
    res.json({ ok: true });
  });

  app.post("/api/open-window", (req, res) => {
    if (typeof onOpenWindowRequest === "function") {
      onOpenWindowRequest();
    }
    res.json({ ok: true });
  });

  // API Endpoints
  app.get("/api/torrents", (req, res) => {
    res.json(torrentManager.getAllTorrents());
  });

  app.get("/api/torrents/:infoHash", async (req, res) => {
    try {
      const t = await torrentManager.getTorrent(req.params.infoHash);
      if (!t) return res.status(404).json({ error: "Torrent not found" });
      res.json(t);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/torrents/inspect", upload.single("torrentFile"), async (req, res) => {
    try {
      const source = req.file?.buffer || req.body?.magnetURI;
      if (!source) return res.status(400).json({ error: "Missing torrent source" });
      const info = await torrentManager.inspectTorrentSource(source);
      res.json(info);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/torrents/magnet", async (req, res) => {
    const { magnetURI, savePath, tag, paused, sequential, deselectedFiles } = req.body || {};
    if (!magnetURI) return res.status(400).json({ error: "Missing magnetURI" });
    try {
      const torrent = await torrentManager.addTorrent(magnetURI, {
        savePath,
        tag,
        paused: Boolean(paused),
        sequential: Boolean(sequential),
        deselectedFiles: Array.isArray(deselectedFiles) ? deselectedFiles : undefined
      });
      if (typeof onOpenWindowRequest === "function") {
        onOpenWindowRequest();
      }
      res.json(torrent);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/torrents/upload", upload.single("torrentFile"), async (req, res) => {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No torrent file provided" });
    }
    try {
      let deselectedFiles;
      if (typeof req.body?.deselectedFiles === "string" && req.body.deselectedFiles.trim()) {
        try {
          const parsed = JSON.parse(req.body.deselectedFiles);
          if (Array.isArray(parsed)) deselectedFiles = parsed;
        } catch {}
      } else if (Array.isArray(req.body?.deselectedFiles)) {
        deselectedFiles = req.body.deselectedFiles;
      }

      const torrent = await torrentManager.addTorrent(req.file.buffer, {
        savePath: req.body?.savePath || undefined,
        tag: req.body?.tag || undefined,
        paused: req.body?.paused === "true" || req.body?.paused === true,
        sequential: req.body?.sequential === "true" || req.body?.sequential === true,
        deselectedFiles
      });
      if (typeof onOpenWindowRequest === "function") {
        onOpenWindowRequest();
      }
      res.json(torrent);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/tag", async (req, res) => {
    try {
      const ok = await torrentManager.setTorrentTag(req.params.infoHash, req.body?.tag || "");
      if (!ok) return res.status(404).json({ ok: false, error: "Torrent not found" });
      res.json({ ok });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/pause", async (req, res) => {
    try {
      const ok = await torrentManager.pauseTorrent(req.params.infoHash);
      if (!ok) return res.status(404).json({ ok: false, error: "Torrent not found" });
      res.json({ ok });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/stop", async (req, res) => {
    try {
      const ok = await torrentManager.stopTorrent(req.params.infoHash);
      if (!ok) return res.status(404).json({ ok: false, error: "Torrent not found" });
      res.json({ ok });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/resume", async (req, res) => {
    try {
      const ok = await torrentManager.resumeTorrent(req.params.infoHash);
      if (!ok) return res.status(404).json({ ok: false, error: "Torrent not found" });
      res.json({ ok });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/sequential", async (req, res) => {
    try {
      const { enabled } = req.body;
      const ok = await torrentManager.setSequential(req.params.infoHash, enabled !== false);
      if (!ok) return res.status(404).json({ ok: false, error: "Torrent not found" });
      res.json({ ok, sequential: torrentManager.isSequential(req.params.infoHash) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/recheck", async (req, res) => {
    try {
      const ok = await torrentManager.recheckTorrent(req.params.infoHash);
      if (!ok) return res.status(404).json({ ok: false, error: "Torrent not found or metadata not ready" });
      res.json({ ok });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/files/:fileIndex/select", async (req, res) => {
    try {
      const fileIndex = parseInt(req.params.fileIndex, 10);
      if (!Number.isInteger(fileIndex) || fileIndex < 0) {
        return res.status(400).json({ ok: false, error: "Invalid file index" });
      }
      const selected = req.body?.selected !== false;
      const ok = await torrentManager.setFileSelection(req.params.infoHash, fileIndex, selected);
      if (!ok) return res.status(404).json({ ok: false, error: "Torrent or file not found" });
      res.json({ ok, selected });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/files/:fileIndex/priority", async (req, res) => {
    try {
      const fileIndex = parseInt(req.params.fileIndex, 10);
      if (!Number.isInteger(fileIndex) || fileIndex < 0) {
        return res.status(400).json({ ok: false, error: "Invalid file index" });
      }
      const priority = req.body?.priority || "normal";
      const ok = await torrentManager.setFilePriority(req.params.infoHash, fileIndex, priority);
      if (!ok) return res.status(404).json({ ok: false, error: "Torrent or file not found" });
      res.json({ ok, priority });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/queue", async (req, res) => {
    try {
      const direction = req.body?.direction;
      if (!["top", "up", "down", "bottom"].includes(direction)) {
        return res.status(400).json({ ok: false, error: "Invalid queue direction" });
      }
      const result = await torrentManager.moveQueue(req.params.infoHash, direction);
      if (!result) return res.status(404).json({ ok: false, error: "Queued torrent not found" });
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/torrents/:infoHash/stream/:fileIndex", async (req, res) => {
    try {
      const fileIndex = parseInt(req.params.fileIndex, 10);
      if (!Number.isInteger(fileIndex) || fileIndex < 0) {
        return res.status(400).json({ error: "Invalid file index" });
      }
      const rangeHeader = req.headers.range;

      const fileStream = await torrentManager.getFileStream(req.params.infoHash, fileIndex, rangeHeader);
      if (!fileStream) {
        return res.status(404).json({ error: "File or torrent not found" });
      }

      const { stream, start, end, total, mimeType, isRange } = fileStream;

      if (isRange) {
        const chunksize = end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize,
          "Content-Type": mimeType
        });
      } else {
        res.writeHead(200, {
          "Accept-Ranges": "bytes",
          "Content-Length": total,
          "Content-Type": mimeType
        });
      }

      req.on("close", () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });

      stream.on("error", (err) => {
        console.error("[Stream Error]", err.message);
        if (!res.headersSent) {
          res.status(500).end();
        } else if (!res.destroyed) {
          res.destroy();
        }
      });

      stream.pipe(res);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: e.message });
      }
    }
  });

  app.post("/api/pause-all", async (req, res) => {
    try {
      await torrentManager.pauseAll();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/stop-all", async (req, res) => {
    try {
      await torrentManager.stopAll();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/resume-all", async (req, res) => {
    try {
      await torrentManager.resumeAll();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/network/interfaces", (req, res) => {
    try {
      res.json(torrentManager.getNetworkSnapshot());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/settings", (req, res) => {
    res.json(torrentManager.getSettings());
  });

  app.post("/api/settings", (req, res) => {
    try {
      torrentManager.setSettings(req.body || {});
      res.json(torrentManager.getSettings());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/torrents/:infoHash", async (req, res) => {
    try {
      const deleteFiles = req.query.deleteFiles === "true";
      const ok = await torrentManager.removeTorrent(req.params.infoHash, deleteFiles);
      if (!ok) return res.status(404).json({ ok: false, error: "Torrent not found" });
      res.json({ ok });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/torrents/:infoHash/open-folder", async (req, res) => {
    try {
      await torrentManager.openFolder(req.params.infoHash);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/open-downloads", async (req, res) => {
    try {
      await torrentManager.openFolder();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/system/browse-folder", async (req, res) => {
    try {
      const result = await browseForFolder(req.body?.initialDir || torrentManager.downloadDir);
      res.json(result);
    } catch (e) {
      res.status(500).json({ cancelled: true, error: e.message });
    }
  });

  // WebSocket Live Broadcasting
  let lastBroadcastLogId = 0;

  wss.on("connection", (ws) => {
    if (appLogger?.enabled && ws.readyState === 1) {
      const entries = appLogger.getEntries();
      if (entries.length > 0) {
        lastBroadcastLogId = Math.max(lastBroadcastLogId, entries[entries.length - 1].id);
      }
      ws.send(JSON.stringify({ type: "logs-init", devMode: true, logs: entries }));
    }
  });

  const broadcast = () => {
    if (wss.clients.size === 0) return;
    let newLogs;
    if (appLogger?.enabled) {
      const delta = appLogger.getEntries(lastBroadcastLogId);
      if (delta.length > 0) {
        lastBroadcastLogId = delta[delta.length - 1].id;
        newLogs = delta;
      }
    }
    const payload = {
      type: "update",
      torrents: torrentManager.getAllTorrents(),
      network: torrentManager.getNetworkSnapshot(),
      schedulerActive: torrentManager.isSchedulerActive()
    };
    if (newLogs) payload.newLogs = newLogs;

    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  };

  const ticker = setInterval(broadcast, 1000);

  server.on("close", () => {
    clearInterval(ticker);
    wss.close();
  });

  return { app, server, wss, port };
}
