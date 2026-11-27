import os from "node:os";
import net from "node:net";

/**
 * Classifies an OS network adapter name into a friendly category.
 */
function classifyInterface(name) {
  const lower = name.toLowerCase();
  if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wlan") || lower.includes("wireless")) {
    return "Wi-Fi";
  }
  if (lower.includes("ethernet") || lower.includes("eth") || lower.includes("lan") || lower.includes("enp")) {
    return "Ethernet";
  }
  if (lower.includes("usb") || lower.includes("rndis") || lower.includes("mobile") || lower.includes("tether") || lower.includes("iphone") || lower.includes("android")) {
    return "USB / Mobile";
  }
  if (lower.includes("vpn") || lower.includes("wireguard") || lower.includes("tun") || lower.includes("tap") || lower.includes("tailscale") || lower.includes("zerotier")) {
    return "VPN";
  }
  if (lower.includes("vethernet") || lower.includes("vmware") || lower.includes("virtualbox") || lower.includes("wsl") || lower.includes("hyper-v") || lower.includes("docker")) {
    return "Virtual";
  }
  return "Network";
}

function isLinkLocal(address, family) {
  if (family === "IPv4") {
    return address.startsWith("169.254.") || address.startsWith("127.");
  }
  if (family === "IPv6") {
    const lower = address.toLowerCase();
    return lower.startsWith("fe80:") || lower === "::1";
  }
  return false;
}

function isLoopbackHost(host) {
  if (!host) return true;
  const clean = host.replace(/^\[|\]$/g, "").toLowerCase();
  return clean === "localhost" || clean === "::1" || clean.startsWith("127.");
}

export class NetworkManager {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.multiNetworkEnabled = Boolean(options.multiNetworkEnabled);
    // Empty array when multiNetworkEnabled = auto-use all non-virtual external adapters,
    // or explicit adapter names selected by the user.
    this.selectedInterfaces = Array.isArray(options.selectedInterfaces)
      ? [...options.selectedInterfaces]
      : [];

    this._cachedInterfaces = [];
    this._activeAdaptersRef = null;
    this._activeAdaptersCache = [];
    this._lastScanAt = 0;
    this._rrIndex4 = 0;
    this._rrIndex6 = 0;

    // Socket & byte counters keyed by adapter name
    this._interfaceStats = new Map();
    this._lastSampleAt = Date.now();
    this._lastLoggedConfig = "";
  }

  configure({ multiNetworkEnabled, selectedInterfaces } = {}) {
    if (typeof multiNetworkEnabled === "boolean") {
      this.multiNetworkEnabled = multiNetworkEnabled;
    }
    if (Array.isArray(selectedInterfaces)) {
      this.selectedInterfaces = selectedInterfaces
        .filter((item) => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim());
    }
    this._activeAdaptersRef = null;
    for (const stat of this._interfaceStats.values()) {
      stat.cooldownUntil = 0;
      stat.consecutiveErrors = 0;
    }
    this.refreshInterfaces(true);

    if (this.logger?.enabled) {
      const pool = this.getActiveAdapters().map((a) => `${a.name} (${a.ipv4 || a.ipv6 || "no-ip"})`).join(", ") || "none";
      const sig = `${this.multiNetworkEnabled}:${pool}`;
      if (sig !== this._lastLoggedConfig) {
        this._lastLoggedConfig = sig;
        this.logger.info(
          "Network",
          this.multiNetworkEnabled
            ? `Multi-NIC balancing enabled -> adapters: ${pool}`
            : `Single/default OS routing active (detected: ${pool})`
        );
      }
    }
  }

  refreshInterfaces(force = false) {
    const now = Date.now();
    if (!force && now - this._lastScanAt < 4000 && this._cachedInterfaces.length > 0) {
      return this._cachedInterfaces;
    }

    const raw = os.networkInterfaces();
    const adapters = [];

    for (const [name, entries] of Object.entries(raw)) {
      if (!Array.isArray(entries)) continue;
      const ipv4Entries = entries.filter(
        (e) => !e.internal && e.family === "IPv4" && !isLinkLocal(e.address, "IPv4")
      );
      const ipv6Entries = entries.filter(
        (e) => !e.internal && e.family === "IPv6" && !isLinkLocal(e.address, "IPv6")
      );

      if (ipv4Entries.length === 0 && ipv6Entries.length === 0) continue;

      const primary4 = ipv4Entries[0] || null;
      const primary6 = ipv6Entries[0] || null;
      const kind = classifyInterface(name);

      adapters.push({
        name,
        kind,
        isVirtual: kind === "Virtual",
        ipv4: primary4 ? primary4.address : null,
        ipv6: primary6 ? primary6.address : null,
        netmask: primary4 ? primary4.netmask : null,
        mac: (primary4 || primary6)?.mac || null
      });
    }

    this._cachedInterfaces = adapters;
    this._lastScanAt = now;
    return adapters;
  }

  getActiveAdapters() {
    const all = this.refreshInterfaces();
    if (this._activeAdaptersRef === all) {
      return this._activeAdaptersCache;
    }
    let result;
    if (this.selectedInterfaces.length > 0) {
      const selectedSet = new Set(this.selectedInterfaces);
      const matched = all.filter((a) => selectedSet.has(a.name) || (a.ipv4 && selectedSet.has(a.ipv4)));
      if (matched.length > 0) result = matched;
    }
    if (!result) {
      // Auto mode: prefer physical / non-virtual adapters; fallback to all if only virtual exist
      const nonVirtual = all.filter((a) => !a.isVirtual);
      result = nonVirtual.length > 0 ? nonVirtual : all;
    }
    this._activeAdaptersRef = all;
    this._activeAdaptersCache = result;
    return result;
  }

  shouldBindMultiNetwork() {
    if (!this.multiNetworkEnabled) return false;
    const all = this.refreshInterfaces();
    const active = this.getActiveAdapters();
    // Only bind localAddress / disable uTP when >= 2 adapters are active,
    // or user explicitly chose 1 adapter out of multiple available adapters.
    if (active.length >= 2) return true;
    return active.length === 1 && this.selectedInterfaces.length > 0 && all.length >= 2;
  }

  _pickHealthyCandidate(candidates, indexKey) {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const now = Date.now();
    const healthy = candidates.filter((a) => {
      const stat = this._interfaceStats.get(a.name);
      return !stat || stat.cooldownUntil <= now;
    });
    const pool = healthy.length > 0 ? healthy : candidates;
    if (healthy.length === 0) {
      for (const a of candidates) {
        const stat = this._interfaceStats.get(a.name);
        if (stat) stat.cooldownUntil = 0;
      }
    }
    const chosen = pool[this[indexKey] % pool.length];
    this[indexKey] = (this[indexKey] + 1) % pool.length;
    return chosen;
  }

  pickInterfaceForHost(remoteHost) {
    if (!this.shouldBindMultiNetwork()) return null;
    if (!remoteHost || isLoopbackHost(remoteHost)) return null;

    const cleanHost = remoteHost.replace(/^\[|\]$/g, "");
    const ipVersion = net.isIP(cleanHost);
    if (ipVersion === 0) return null; // Skip hostnames to avoid IPv4/IPv6 mismatch

    const adapters = this.getActiveAdapters();

    if (ipVersion === 4) {
      const chosen = this._pickHealthyCandidate(adapters.filter((a) => Boolean(a.ipv4)), "_rrIndex4");
      return chosen ? { name: chosen.name, address: chosen.ipv4, family: 4 } : null;
    }

    if (ipVersion === 6) {
      const chosen = this._pickHealthyCandidate(adapters.filter((a) => Boolean(a.ipv6)), "_rrIndex6");
      return chosen ? { name: chosen.name, address: chosen.ipv6, family: 6 } : null;
    }

    return null;
  }

  _ensureStatEntry(name) {
    let entry = this._interfaceStats.get(name);
    if (!entry) {
      entry = {
        sockets: new Set(),
        closedBytesRead: 0,
        closedBytesWritten: 0,
        lastTotalRead: 0,
        lastTotalWritten: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        totalDownloaded: 0,
        totalUploaded: 0,
        establishedCount: 0,
        errors: 0,
        consecutiveErrors: 0,
        cooldownUntil: 0
      };
      this._interfaceStats.set(name, entry);
    }
    return entry;
  }

  trackSocket(adapterName, socket) {
    if (!socket) return;

    const attachToEntry = (name) => {
      const entry = this._ensureStatEntry(name);
      if (entry.sockets.has(socket)) return;
      entry.sockets.add(socket);

      let finalized = false;
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        entry.closedBytesRead += socket.bytesRead || 0;
        entry.closedBytesWritten += socket.bytesWritten || 0;
        entry.sockets.delete(socket);
      };

      const onConnect = () => {
        entry.consecutiveErrors = 0;
        entry.cooldownUntil = 0;
      };

      if (!socket.connecting) {
        onConnect();
      } else {
        socket.once("connect", onConnect);
      }

      socket.once("error", () => {
        if ((socket.bytesRead || 0) === 0 && (socket.bytesWritten || 0) === 0) {
          entry.errors += 1;
          entry.consecutiveErrors += 1;
          if (entry.consecutiveErrors >= 5 && entry.establishedCount === 0) {
            const wasCooling = entry.cooldownUntil > Date.now();
            entry.cooldownUntil = Date.now() + 20_000;
            if (!wasCooling) {
              this.logger?.warn("Network", `Adapter "${name}" unreachable after ${entry.consecutiveErrors} connect failures; pausing for 20s`);
            }
          }
        }
        finalize();
      });
      socket.once("close", finalize);
    };

    const resolveByLocalAddress = () => {
      const rawAddr = socket.localAddress || "";
      const localAddr = rawAddr.startsWith("::ffff:") ? rawAddr.slice(7) : rawAddr;
      const adapters = this.refreshInterfaces();
      const match = adapters.find((a) => a.ipv4 === localAddr || a.ipv6 === localAddr);
      attachToEntry(match ? match.name : "Default Route");
    };

    if (adapterName) {
      attachToEntry(adapterName);
    } else if (!socket.connecting && socket.localAddress) {
      resolveByLocalAddress();
    } else {
      socket.once("connect", resolveByLocalAddress);
    }
  }

  sampleSpeeds() {
    const now = Date.now();
    const dtSec = Math.max(0.2, (now - this._lastSampleAt) / 1000);
    this._lastSampleAt = now;

    for (const entry of this._interfaceStats.values()) {
      let activeRead = 0;
      let activeWritten = 0;
      let establishedCount = 0;
      for (const s of entry.sockets) {
        if (s.destroyed) continue;
        if (!s.connecting) establishedCount += 1;
        activeRead += s.bytesRead || 0;
        activeWritten += s.bytesWritten || 0;
      }

      const totalRead = entry.closedBytesRead + activeRead;
      const totalWritten = entry.closedBytesWritten + activeWritten;

      const deltaRead = Math.max(0, totalRead - entry.lastTotalRead);
      const deltaWritten = Math.max(0, totalWritten - entry.lastTotalWritten);

      entry.lastTotalRead = totalRead;
      entry.lastTotalWritten = totalWritten;
      entry.totalDownloaded = totalRead;
      entry.totalUploaded = totalWritten;
      entry.establishedCount = establishedCount;
      entry.downloadSpeed = Math.round(deltaRead / dtSec);
      entry.uploadSpeed = Math.round(deltaWritten / dtSec);
    }
  }

  getNetworkSnapshot() {
    this.sampleSpeeds();
    const adapters = this.refreshInterfaces(false);
    const activeSet = new Set(this.getActiveAdapters().map((a) => a.name));
    const now = Date.now();

    const interfaces = adapters.map((adapter) => {
      const stat = this._interfaceStats.get(adapter.name);
      const unreachable = Boolean(stat && stat.cooldownUntil > now);
      return {
        ...adapter,
        selected: this.selectedInterfaces.includes(adapter.name),
        activeInPool: activeSet.has(adapter.name),
        unreachable,
        activeConnections: stat ? (stat.establishedCount ?? 0) : 0,
        downloadSpeed: stat ? stat.downloadSpeed : 0,
        uploadSpeed: stat ? stat.uploadSpeed : 0,
        totalDownloaded: stat ? stat.totalDownloaded : 0,
        totalUploaded: stat ? stat.totalUploaded : 0,
        errors: stat ? stat.errors : 0
      };
    });

    return {
      multiNetworkEnabled: this.multiNetworkEnabled,
      multiNetworkActive: this.shouldBindMultiNetwork(),
      selectedInterfaces: [...this.selectedInterfaces],
      activeCount: activeSet.size,
      interfaces
    };
  }
}
