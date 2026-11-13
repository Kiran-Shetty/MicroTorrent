import fs from "node:fs";
import path from "node:path";

export function detectDevMode(argv = process.argv.slice(2), env = process.env) {
  return Boolean(
    argv.includes("--dev") ||
      env.NODE_ENV === "development" ||
      env.MT_DEV === "1" ||
      env.npm_lifecycle_event === "dev"
  );
}

/**
 * Bounded dev-mode application logger: mirrors structured entries to terminal,
 * retains an in-memory ring buffer for the UI Logs tab, and writes to a rotating file.
 * Disabled in normal (non-dev) runs except optional alwaysConsole milestones/errors.
 */
export class AppLogger {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.logDir = options.logDir || "";
    this.logFile = this.enabled && this.logDir ? path.join(this.logDir, "microtorrent.log") : "";
    this.maxBytes = options.maxBytes || 5 * 1024 * 1024;
    this.maxEntries = options.maxEntries || 500;
    this.mirrorToConsole = options.mirrorToConsole !== false;
    this.entries = [];
    this._nextId = 0;
    this._dirReady = false;
  }

  _writeToFile(line) {
    if (!this.logFile) return;
    try {
      if (!this._dirReady) {
        fs.mkdirSync(this.logDir, { recursive: true });
        this._dirReady = true;
      }
      if (fs.existsSync(this.logFile)) {
        const size = fs.statSync(this.logFile).size;
        if (size >= this.maxBytes) {
          const backup = `${this.logFile}.1`;
          fs.rmSync(backup, { force: true });
          fs.renameSync(this.logFile, backup);
        }
      }
      fs.appendFileSync(this.logFile, `${line}\n`, "utf8");
    } catch {}
  }

  log(level, scope, message, { alwaysConsole = false } = {}) {
    const cleanLevel = level === "ERROR" || level === "WARN" ? level : "INFO";
    const cleanScope = String(scope || "App");
    const cleanMsg = String(message ?? "");

    if (!this.enabled) {
      if (alwaysConsole) {
        const text = `[${cleanScope}] ${cleanMsg}`;
        if (cleanLevel === "ERROR") console.error(text);
        else if (cleanLevel === "WARN") console.warn(text);
        else console.log(text);
      }
      return null;
    }

    const now = new Date();
    const entry = {
      id: ++this._nextId,
      ts: now.toISOString(),
      level: cleanLevel,
      scope: cleanScope,
      message: cleanMsg
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    const timeLabel = now.toISOString().slice(11, 23);
    const consoleLine = `[${timeLabel}] [${cleanLevel}] [${cleanScope}] ${cleanMsg}`;
    if (this.mirrorToConsole) {
      if (cleanLevel === "ERROR") console.error(consoleLine);
      else if (cleanLevel === "WARN") console.warn(consoleLine);
      else console.log(consoleLine);
    }

    this._writeToFile(`[${entry.ts}] [${cleanLevel}] [${cleanScope}] ${cleanMsg}`);
    return entry;
  }

  info(scope, message, opts) {
    return this.log("INFO", scope, message, opts);
  }

  warn(scope, message, opts) {
    return this.log("WARN", scope, message, opts);
  }

  error(scope, message, opts) {
    return this.log("ERROR", scope, message, opts);
  }

  getEntries(sinceId = 0) {
    if (!this.enabled) return [];
    if (!sinceId) return [...this.entries];
    return this.entries.filter((e) => e.id > sinceId);
  }

  clear() {
    this.entries = [];
  }
}
