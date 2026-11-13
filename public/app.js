// Column Definitions
const COLUMNS_DEF = {
  name: { label: "Name", width: "28%", defaultVisible: true },
  size: { label: "Size", width: "8%", defaultVisible: true },
  remaining: { label: "Remaining", width: "8%", defaultVisible: false },
  progress: { label: "Progress", width: "16%", defaultVisible: true },
  status: { label: "Status", width: "11%", defaultVisible: true },
  downloadSpeed: { label: "Down", width: "9%", defaultVisible: true },
  uploadSpeed: { label: "Up", width: "9%", defaultVisible: true },
  numPeers: { label: "Peers", width: "5%", defaultVisible: true },
  eta: { label: "ETA", width: "6%", defaultVisible: true },
  ratio: { label: "Ratio", width: "6%", defaultVisible: false },
  availability: { label: "Avail.", width: "6%", defaultVisible: false },
  tag: { label: "Tag", width: "8%", defaultVisible: false },
  queuePos: { label: "#", width: "4%", defaultVisible: false },
  addedAt: { label: "Added", width: "11%", defaultVisible: false },
  completedAt: { label: "Completed", width: "11%", defaultVisible: false },
  tracker: { label: "Tracker", width: "12%", defaultVisible: false }
};

function getDefaultColumnsConfig() {
  return Object.keys(COLUMNS_DEF).map((id) => ({
    id,
    visible: COLUMNS_DEF[id].defaultVisible
  }));
}

function normalizeColumnsConfig(rawCols) {
  const result = [];
  const seen = new Set();
  if (Array.isArray(rawCols)) {
    for (const item of rawCols) {
      if (item && typeof item.id === "string" && COLUMNS_DEF[item.id] && !seen.has(item.id)) {
        seen.add(item.id);
        result.push({ id: item.id, visible: item.id === "name" ? true : Boolean(item.visible) });
      }
    }
  }
  for (const id of Object.keys(COLUMNS_DEF)) {
    if (!seen.has(id)) {
      result.push({ id, visible: COLUMNS_DEF[id].defaultVisible });
    }
  }
  return result;
}

// State
let torrents = [];
let selectedHash = null;
let selectedHashes = new Set();
let anchorHash = null;
let activeFilter = "all";
let activeTag = "";
let searchQuery = "";
let activeTab = "general";
let sortKey = "name";
let sortDir = "asc";
let uiPrefs = loadLocalUiPrefs();
let serverSettings = { showAddDialog: true, downloadDir: "" };
let pendingAddSource = null;
let tagModalHashes = [];
let pendingDeleteHashes = [];
let draftColumnsConfig = [];
const MAX_SPEED_HISTORY = 90;
const speedHistory = [];
const NIC_CHART_COLORS = ["#f59e0b", "#a78bfa", "#ec4899", "#14b8a6"];

function loadLocalUiPrefs() {
  const defaults = {
    theme: "dark",
    density: "comfortable",
    speedUnit: "bytes",
    showSidebar: true,
    showDetailsPanel: true,
    columns: getDefaultColumnsConfig()
  };
  try {
    const raw = localStorage.getItem("microtorrent_ui_prefs");
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed, columns: normalizeColumnsConfig(parsed.columns) };
    }
  } catch {}
  return defaults;
}

function applyUiPrefs(prefs) {
  uiPrefs = {
    ...uiPrefs,
    ...prefs,
    columns: normalizeColumnsConfig(prefs.columns || uiPrefs.columns)
  };
  try {
    localStorage.setItem("microtorrent_ui_prefs", JSON.stringify(uiPrefs));
  } catch {}

  document.documentElement.setAttribute("data-theme", uiPrefs.theme || "dark");
  document.documentElement.setAttribute("data-density", uiPrefs.density || "comfortable");

  const sidebar = document.getElementById("sidebar");
  const detailsPanel = document.getElementById("details-panel");
  if (sidebar) sidebar.style.display = uiPrefs.showSidebar !== false ? "flex" : "none";
  if (detailsPanel) detailsPanel.style.display = uiPrefs.showDetailsPanel !== false ? "flex" : "none";
}

// Elements
const torrentTableHead = document.getElementById("torrent-table-head");
const torrentList = document.getElementById("torrent-list");
const columnMenu = document.getElementById("column-menu");
const emptyState = document.getElementById("empty-state");
const searchInput = document.getElementById("search-input");
const btnResume = document.getElementById("btn-resume");
const btnPause = document.getElementById("btn-pause");
const btnRecheck = document.getElementById("btn-recheck");
const btnDelete = document.getElementById("btn-delete");
const btnSequential = document.getElementById("btn-sequential");
const btnOpenFolder = document.getElementById("btn-open-folder");
const btnOpenDownloads = document.getElementById("btn-open-downloads");
const btnPauseAll = document.getElementById("btn-pause-all");
const btnResumeAll = document.getElementById("btn-resume-all");
const btnToggleDetails = document.getElementById("btn-toggle-details");
const fileInput = document.getElementById("file-input");
const statusMessage = document.getElementById("status-message");
const statusSelectionCount = document.getElementById("status-selection-count");
const statusSchedulerPill = document.getElementById("status-scheduler-pill");
const statusSchedulerBadge = document.getElementById("status-scheduler-badge");

// Modals
const modalMagnet = document.getElementById("modal-magnet");
const magnetInput = document.getElementById("magnet-input");
const modalDelete = document.getElementById("modal-delete");
const deleteTorrentName = document.getElementById("delete-torrent-name");
const deleteFilesCheckbox = document.getElementById("delete-files-checkbox");
const contextMenu = document.getElementById("context-menu");

// Details
const detailName = document.getElementById("detail-name");
const detailStatus = document.getElementById("detail-status");
const detailAvailability = document.getElementById("detail-availability");
const detailTag = document.getElementById("detail-tag");
const detailHash = document.getElementById("detail-hash");
const btnCopyMagnet = document.getElementById("btn-copy-magnet");
const detailPath = document.getElementById("detail-path");
const detailSize = document.getElementById("detail-size");
const detailDownloaded = document.getElementById("detail-downloaded");
const detailUploaded = document.getElementById("detail-uploaded");
const detailRatio = document.getElementById("detail-ratio");
const detailEta = document.getElementById("detail-eta");
const detailAdded = document.getElementById("detail-added");
const detailCompleted = document.getElementById("detail-completed");
const filesCount = document.getElementById("files-count");
const filesList = document.getElementById("files-list");
const peersCount = document.getElementById("peers-count");
const peersList = document.getElementById("peers-list");
const piecesSummary = document.getElementById("pieces-summary");
const pieceMapGrid = document.getElementById("piece-map-grid");
const speedChartCanvas = document.getElementById("speed-chart");
const speedLegendEl = document.getElementById("speed-legend");
const trackersCount = document.getElementById("trackers-count");
const trackersList = document.getElementById("trackers-list");
const sidebarTagsSection = document.getElementById("sidebar-tags-section");
const sidebarTagsList = document.getElementById("sidebar-tags-list");

// Formatters
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) {
    return uiPrefs.speedUnit === "bits" ? "0.0 Kbps" : "0.0 KB/s";
  }
  if (uiPrefs.speedUnit === "bits") {
    const bits = bytesPerSec * 8;
    if (bits >= 1_000_000_000) return `${(bits / 1_000_000_000).toFixed(2)} Gbps`;
    if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(2)} Mbps`;
    return `${(bits / 1000).toFixed(1)} Kbps`;
  }
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return "\u221E";
  if (seconds <= 0) return "Done";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatStatusLabel(t) {
  if (t.status === "checking") {
    return t.verifyProgress > 0 ? `Checking (${t.verifyProgress}%)` : "Checking";
  }
  if (t.status === "queued" && t.queuePosition) {
    return `Queued (#${t.queuePosition})`;
  }
  return t.status;
}

function formatTimestamp(ms) {
  if (!ms) return "-";
  try {
    return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "-";
  }
}

function getHealthInfo(t) {
  const avail = typeof t.availability === "number" ? t.availability : 0;
  if (t.status === "seeding" || t.progress >= 100 || avail >= 1) {
    return { label: `${avail.toFixed(2)} (Healthy)`, cls: "health-good" };
  }
  if (avail > 0) {
    return { label: `${avail.toFixed(2)} (Partial)`, cls: "health-warn" };
  }
  if (t.status === "paused" || t.status === "queued") {
    return { label: "-", cls: "" };
  }
  return { label: "0.00 (Stalled)", cls: "health-bad" };
}

function updateSchedulerIndicator(active) {
  if (!statusSchedulerPill || !statusSchedulerBadge) return;
  if (!serverSettings?.scheduler?.enabled) {
    statusSchedulerPill.style.display = "none";
    return;
  }
  statusSchedulerPill.style.display = "inline-flex";
  statusSchedulerBadge.textContent = active ? "Alt Limit" : "Normal";
  statusSchedulerBadge.style.color = active ? "var(--accent-yellow)" : "var(--accent-green)";
}

function flashStatus(msg) {
  if (!statusMessage) return;
  statusMessage.textContent = msg;
  clearTimeout(flashStatus._timer);
  flashStatus._timer = setTimeout(() => {
    statusMessage.textContent = "Ready";
  }, 2500);
}

let devModeEnabled = false;
let devLogs = [];
const btnTabLogs = document.getElementById("btn-tab-logs");
const logsCountEl = document.getElementById("logs-count");
const logsListEl = document.getElementById("logs-list");
const logsLevelFilter = document.getElementById("logs-level-filter");
const btnClearLogs = document.getElementById("btn-clear-logs");

function setDevLogsState(enabled, entries = []) {
  devModeEnabled = Boolean(enabled);
  if (btnTabLogs) btnTabLogs.style.display = devModeEnabled ? "inline-block" : "none";
  if (!devModeEnabled) return;
  devLogs = Array.isArray(entries) ? entries.slice(-500) : [];
  renderLogsTab(true);
}

function appendDevLogs(entries) {
  if (!devModeEnabled || !Array.isArray(entries) || entries.length === 0) return;
  const lastId = devLogs.length > 0 ? devLogs[devLogs.length - 1].id : 0;
  let added = false;
  for (const e of entries) {
    if (e && e.id > lastId) {
      devLogs.push(e);
      added = true;
    }
  }
  if (devLogs.length > 500) {
    devLogs.splice(0, devLogs.length - 500);
  }
  if (added) renderLogsTab(false);
}

function renderLogsTab(forceScrollBottom = false) {
  if (logsCountEl) logsCountEl.textContent = devLogs.length;
  if (!logsListEl || !devModeEnabled) return;

  const filterLevel = logsLevelFilter ? logsLevelFilter.value : "ALL";
  const nearBottom =
    forceScrollBottom ||
    logsListEl.scrollHeight - logsListEl.scrollTop - logsListEl.clientHeight < 28;

  const visible = filterLevel === "ALL" ? devLogs : devLogs.filter((e) => e.level === filterLevel);
  if (visible.length === 0) {
    logsListEl.innerHTML = `<div class="settings-hint">No log entries recorded yet.</div>`;
    return;
  }

  logsListEl.innerHTML = visible
    .map((e) => {
      const time = e.ts ? e.ts.slice(11, 23) : "";
      return `<div class="log-row"><span class="log-ts">[${escapeHtml(time)}]</span> <span class="log-level-${escapeHtml(e.level)}">[${escapeHtml(e.level)}]</span> <span class="log-scope">[${escapeHtml(e.scope)}]</span> ${escapeHtml(e.message)}</div>`;
    })
    .join("");

  if (nearBottom) {
    logsListEl.scrollTop = logsListEl.scrollHeight;
  }
}

async function fetchInitialLogs() {
  try {
    const res = await fetch("/api/logs");
    if (res.ok) {
      const data = await res.json();
      setDevLogsState(Boolean(data.devMode), data.logs || []);
    }
  } catch {}
}

if (logsLevelFilter) {
  logsLevelFilter.addEventListener("change", () => renderLogsTab(true));
}
if (btnClearLogs) {
  btnClearLogs.addEventListener("click", async () => {
    await fetch("/api/logs", { method: "DELETE" }).catch(() => {});
    devLogs = [];
    renderLogsTab(true);
  });
}

// WebSocket Connection
function setupWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "logs-init") {
        setDevLogsState(Boolean(data.devMode), data.logs || []);
      } else if (data.type === "update") {
        torrents = data.torrents;
        if (typeof data.schedulerActive === "boolean") {
          updateSchedulerIndicator(data.schedulerActive);
        }
        if (Array.isArray(data.newLogs)) {
          appendDevLogs(data.newLogs);
        }
        render();
        if (data.network) {
          renderNetworkSidebar(data.network);
        }
        recordSpeedSample(torrents, data.network);
      }
    } catch (e) {
      console.error("WS Parse Error", e);
    }
  };

  ws.onclose = () => {
    setTimeout(setupWebSocket, 2000);
  };
}

function renderNetworkSidebar(network) {
  const modeBadge = document.getElementById("network-mode-badge");
  const container = document.getElementById("sidebar-interfaces");
  if (!modeBadge || !container || !network) return;

  if (network.multiNetworkActive) {
    modeBadge.textContent = `Multi-NIC (${network.activeCount})`;
    modeBadge.style.color = "var(--accent-green)";
  } else if (network.multiNetworkEnabled) {
    modeBadge.textContent = "Multi (1 NIC)";
    modeBadge.style.color = "var(--accent-yellow)";
  } else {
    modeBadge.textContent = "Default";
    modeBadge.style.color = "var(--accent-green)";
  }

  const list = (network.interfaces || []).filter(
    (i) => i.activeInPool || i.activeConnections > 0 || i.totalDownloaded > 0
  );
  const html = list
    .map((nic) => {
      const statusHtml = nic.unreachable
        ? `<span style="color: var(--accent-yellow);">Unreachable (retrying)</span>`
        : `<span>&#x2193; ${formatSpeed(nic.downloadSpeed)} &bull; ${nic.activeConnections} conn</span>`;
      return `
      <div class="sidebar-nic-item" title="${escapeHtml(nic.name)} (${escapeHtml(nic.ipv4 || nic.ipv6 || "")})">
        <strong>${escapeHtml(nic.name)} (${escapeHtml(nic.kind)})</strong>
        ${statusHtml}
      </div>
    `;
    })
    .join("");
  if (container.dataset.lastHtml !== html) {
    container.dataset.lastHtml = html;
    container.innerHTML = html;
  }
}

async function fetchNetwork() {
  try {
    const res = await fetch("/api/network/interfaces");
    if (res.ok) {
      renderNetworkSidebar(await res.json());
    }
  } catch (e) {
    console.error("Network Fetch Error", e);
  }
}

async function fetchInitialSettings() {
  try {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const data = await res.json();
      serverSettings = data;
      if (data.ui) applyUiPrefs(data.ui);
      updateSchedulerIndicator(Boolean(data.schedulerActive));
      renderTableHeader();
    }
  } catch {}
}

// Fetch Initial List
async function fetchTorrents() {
  try {
    const res = await fetch("/api/torrents");
    torrents = await res.json();
    render();
  } catch (e) {
    console.error("Fetch Error", e);
  }
}

function syncSidebarHighlights() {
  document.querySelectorAll("#sidebar-categories li").forEach((li) => {
    li.classList.toggle("active", !activeTag && li.dataset.filter === activeFilter);
  });
  document.querySelectorAll("#sidebar-tags-list li").forEach((li) => {
    li.classList.toggle("active", Boolean(activeTag) && li.dataset.tag === activeTag);
  });
}

// Filter & Sort Torrents
function getFilteredTorrents() {
  const filtered = torrents.filter((t) => {
    if (searchQuery && !t.name.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (activeTag) return (t.tag || "") === activeTag;
    if (activeFilter === "downloading") return t.status === "downloading";
    if (activeFilter === "checking") return t.status === "checking";
    if (activeFilter === "queued") return t.status === "queued";
    if (activeFilter === "seeding") return t.status === "seeding";
    if (activeFilter === "completed") return t.progress >= 100;
    if (activeFilter === "paused") return t.status === "paused";
    if (activeFilter === "active") return t.downloadSpeed > 0 || t.uploadSpeed > 0 || t.status === "checking";
    return true;
  });

  const dir = sortDir === "asc" ? 1 : -1;
  return filtered.sort((a, b) => {
    if (sortKey === "name" || sortKey === "status" || sortKey === "tag" || sortKey === "tracker") {
      const ka = sortKey === "tracker" ? a.primaryTracker : a[sortKey];
      const kb = sortKey === "tracker" ? b.primaryTracker : b[sortKey];
      return String(ka || "").localeCompare(String(kb || "")) * dir;
    }
    const key = sortKey === "queuePos" ? "queuePosition" : sortKey;
    const defVal = sortKey === "eta" || sortKey === "queuePos" ? Infinity : 0;
    const va = a[key] ?? defVal;
    const vb = b[key] ?? defVal;
    return (va - vb) * dir;
  });
}

function getVisibleColumns() {
  return normalizeColumnsConfig(uiPrefs.columns).filter((c) => c.visible && COLUMNS_DEF[c.id]);
}

function renderTableHeader() {
  if (!torrentTableHead) return;
  const cols = getVisibleColumns();
  const sig = cols.map((c) => c.id).join(",");
  if (torrentTableHead.dataset.colSig !== sig) {
    torrentTableHead.dataset.colSig = sig;
    torrentTableHead.innerHTML = `<tr>${cols
      .map((c) => {
        const def = COLUMNS_DEF[c.id];
        return `<th class="sortable" data-sort="${c.id}" style="width: ${def.width};">${escapeHtml(def.label)} <span class="sort-arrow"></span></th>`;
      })
      .join("")}</tr>`;
  }
  updateSortIndicators();
}

function updateSortIndicators() {
  document.querySelectorAll("#torrent-table th.sortable").forEach((th) => {
    const arrow = th.querySelector(".sort-arrow");
    if (!arrow) return;
    if (th.dataset.sort === sortKey) {
      arrow.textContent = sortDir === "asc" ? "\u25B2" : "\u25BC";
    } else {
      arrow.textContent = "";
    }
  });
}

function renderTorrentCell(t, colId) {
  switch (colId) {
    case "name": {
      const tagBadge = t.tag ? `<span class="tag-chip">${escapeHtml(t.tag)}</span>` : "";
      return `<td title="${escapeHtml(t.name)}"><strong>${escapeHtml(t.name)}</strong>${tagBadge}</td>`;
    }
    case "size":
      return `<td>${formatBytes(t.size)}</td>`;
    case "remaining":
      return `<td>${formatBytes(t.remaining)}</td>`;
    case "progress": {
      const pausedClass = t.status === "paused" || t.status === "queued" ? "paused" : "";
      const barPct = t.status === "checking" && t.verifyProgress > 0 ? t.verifyProgress : t.progress;
      return `<td>
        <div class="progress-bar-container">
          <div class="progress-track">
            <div class="progress-fill ${pausedClass}" style="width: ${barPct}%"></div>
          </div>
          <span class="progress-text">${t.progress}%</span>
        </div>
      </td>`;
    }
    case "status": {
      const statusText = formatStatusLabel(t);
      return `<td><span class="status-pill status-${t.status}">${escapeHtml(statusText)}</span></td>`;
    }
    case "downloadSpeed":
      return `<td>${formatSpeed(t.downloadSpeed)}</td>`;
    case "uploadSpeed":
      return `<td>${formatSpeed(t.uploadSpeed)}</td>`;
    case "numPeers":
      return `<td>${t.numPeers}</td>`;
    case "eta": {
      const etaText = t.status === "checking" ? "..." : t.status === "queued" ? "Queued" : formatEta(t.eta);
      return `<td>${etaText}</td>`;
    }
    case "ratio":
      return `<td>${(t.ratio ?? 0).toFixed(2)}</td>`;
    case "availability": {
      const h = getHealthInfo(t);
      const val = typeof t.availability === "number" ? t.availability.toFixed(2) : "-";
      return `<td>${h.cls ? `<span class="health-pill ${h.cls}">${val}</span>` : val}</td>`;
    }
    case "tag":
      return `<td>${t.tag ? `<span class="tag-chip">${escapeHtml(t.tag)}</span>` : "-"}</td>`;
    case "queuePos":
      return `<td>${t.queuePosition ? `#${t.queuePosition}` : "-"}</td>`;
    case "addedAt":
      return `<td>${escapeHtml(formatTimestamp(t.addedAt))}</td>`;
    case "completedAt":
      return `<td>${escapeHtml(formatTimestamp(t.completedAt))}</td>`;
    case "tracker":
      return `<td title="${escapeHtml(t.primaryTracker || "")}">${escapeHtml(t.primaryTracker || "-")}</td>`;
    default:
      return "<td>-</td>";
  }
}

function getSelectedTorrentsList() {
  return torrents.filter((t) => selectedHashes.has(t.infoHash));
}

// Render Table & Badges
function render() {
  const existingHashes = new Set(torrents.map((t) => t.infoHash));
  for (const h of [...selectedHashes]) {
    if (!existingHashes.has(h)) selectedHashes.delete(h);
  }
  if (selectedHash && !existingHashes.has(selectedHash)) {
    selectedHash = selectedHashes.size > 0 ? [...selectedHashes][0] : null;
  }

  renderTableHeader();
  updateCounts();
  updateGlobalSpeeds();

  if (statusSelectionCount) {
    if (selectedHashes.size > 1) {
      statusSelectionCount.style.display = "inline";
      statusSelectionCount.innerHTML = `<span class="status-separator">|</span><strong>${selectedHashes.size} selected</strong>`;
    } else {
      statusSelectionCount.style.display = "none";
      statusSelectionCount.textContent = "";
    }
  }

  const filtered = getFilteredTorrents();
  const visibleCols = getVisibleColumns();

  if (filtered.length === 0) {
    torrentList.innerHTML = "";
    emptyState.style.display = "flex";
  } else {
    emptyState.style.display = "none";
    torrentList.innerHTML = filtered
      .map((t) => {
        const isSelected = selectedHashes.has(t.infoHash) ? "selected" : "";
        return `<tr class="${isSelected}" data-hash="${t.infoHash}">${visibleCols.map((c) => renderTorrentCell(t, c.id)).join("")}</tr>`;
      })
      .join("");
  }

  // Update Toolbar Action states (supports multi-select!)
  const selectedList = getSelectedTorrentsList();
  const primary = torrents.find((t) => t.infoHash === selectedHash) || selectedList[0] || null;
  const anyResumable = selectedList.some((t) => t.status === "paused" || t.status === "queued");
  const anyPausable = selectedList.some((t) => t.status !== "paused");
  const anyRecheckable = selectedList.some((t) => t.status !== "checking" && t.status !== "connecting");

  btnResume.disabled = selectedList.length === 0 || !anyResumable;
  btnPause.disabled = selectedList.length === 0 || !anyPausable;
  btnRecheck.disabled = selectedList.length === 0 || !anyRecheckable;
  btnDelete.disabled = selectedList.length === 0;
  btnOpenFolder.disabled = !primary;

  if (selectedList.length > 0 && primary) {
    const anySeqOn = selectedList.some((t) => t.sequential);
    btnSequential.disabled = false;
    btnSequential.innerHTML = anySeqOn
      ? "&#x26A1; Sequential: <strong>ON</strong>"
      : "&#x26A1; Sequential: Off";
    btnSequential.style.color = anySeqOn ? "var(--accent-green)" : "";
  } else {
    btnSequential.disabled = true;
    btnSequential.innerHTML = "&#x26A1; Sequential: Off";
    btnSequential.style.color = "";
  }

  renderDetails(primary);
}

function updateCounts() {
  document.getElementById("count-all").textContent = torrents.length;
  document.getElementById("count-downloading").textContent = torrents.filter((t) => t.status === "downloading").length;
  document.getElementById("count-checking").textContent = torrents.filter((t) => t.status === "checking").length;
  document.getElementById("count-queued").textContent = torrents.filter((t) => t.status === "queued").length;
  document.getElementById("count-seeding").textContent = torrents.filter((t) => t.status === "seeding").length;
  document.getElementById("count-completed").textContent = torrents.filter((t) => t.progress >= 100).length;
  document.getElementById("count-paused").textContent = torrents.filter((t) => t.status === "paused").length;
  document.getElementById("count-active").textContent = torrents.filter(
    (t) => t.downloadSpeed > 0 || t.uploadSpeed > 0 || t.status === "checking"
  ).length;
  document.getElementById("status-total-torrents").textContent = `${torrents.length} torrent${torrents.length === 1 ? "" : "s"}`;

  const tagCounts = new Map();
  for (const t of torrents) {
    if (t.tag) tagCounts.set(t.tag, (tagCounts.get(t.tag) || 0) + 1);
  }
  if (activeTag && !tagCounts.has(activeTag)) {
    activeTag = "";
    syncSidebarHighlights();
  }
  if (sidebarTagsSection && sidebarTagsList) {
    if (tagCounts.size === 0) {
      sidebarTagsSection.style.display = "none";
      if (sidebarTagsList.dataset.lastKey) {
        sidebarTagsList.dataset.lastKey = "";
        sidebarTagsList.innerHTML = "";
      }
    } else {
      sidebarTagsSection.style.display = "block";
      const entries = [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const tagKey = `${activeTag}|${entries.map(([k, v]) => `${k}:${v}`).join(",")}`;
      if (sidebarTagsList.dataset.lastKey !== tagKey) {
        sidebarTagsList.dataset.lastKey = tagKey;
        sidebarTagsList.innerHTML = entries
          .map(([tag, count]) => {
            const cls = activeTag === tag ? "active" : "";
            return `<li class="${cls}" data-tag="${escapeHtml(tag)}"><span class="cat-icon">&#x1F3F7;</span> ${escapeHtml(tag)} <span class="badge">${count}</span></li>`;
          })
          .join("");
      }
    }
  }
}

function updateGlobalSpeeds() {
  const downTotal = torrents.reduce((acc, t) => acc + (t.downloadSpeed || 0), 0);
  const upTotal = torrents.reduce((acc, t) => acc + (t.uploadSpeed || 0), 0);
  document.getElementById("status-total-down").textContent = formatSpeed(downTotal);
  document.getElementById("status-total-up").textContent = formatSpeed(upTotal);
}

function renderDetails(t) {
  if (!t) {
    if (activeTab === "pieces") renderPiecesTab(null);
    detailName.textContent = "-";
    detailStatus.textContent = "-";
    if (detailAvailability) detailAvailability.innerHTML = "-";
    if (detailTag) detailTag.textContent = "-";
    detailHash.textContent = "-";
    btnCopyMagnet.style.display = "none";
    detailPath.textContent = "-";
    detailSize.textContent = "-";
    detailDownloaded.textContent = "-";
    detailUploaded.textContent = "-";
    detailRatio.textContent = "-";
    detailEta.textContent = "-";
    if (detailAdded) detailAdded.textContent = "-";
    if (detailCompleted) detailCompleted.textContent = "-";
    filesCount.textContent = "0";
    filesList.dataset.structKey = "";
    filesList.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">No torrent selected</td></tr>`;
    peersCount.textContent = "0";
    peersList.dataset.lastHtml = "";
    peersList.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">No torrent selected</td></tr>`;
    trackersCount.textContent = "0";
    trackersList.dataset.lastHtml = "";
    trackersList.innerHTML = `<tr><td colspan="2" style="text-align:center; color: var(--text-muted);">No torrent selected</td></tr>`;
    return;
  }

  const files = t.files || [];
  const peers = t.peers || [];
  const trackers = t.trackers || [];
  filesCount.textContent = files.length;
  peersCount.textContent = t.numPeers ?? peers.length;
  trackersCount.textContent = trackers.length;

  if (uiPrefs.showDetailsPanel === false) return;

  if (activeTab === "general") {
    detailName.textContent = t.name;
    detailStatus.textContent = formatStatusLabel(t);
    if (detailAvailability) {
      const h = getHealthInfo(t);
      detailAvailability.innerHTML = h.cls
        ? `<span class="health-pill ${h.cls}">${escapeHtml(h.label)}</span>`
        : escapeHtml(h.label);
    }
    if (detailTag) detailTag.textContent = t.tag || "-";
    detailHash.textContent = t.infoHash;
    btnCopyMagnet.style.display = t.magnetURI ? "inline-flex" : "none";
    detailPath.textContent = t.path;
    detailSize.textContent = formatBytes(t.size);
    detailDownloaded.textContent = formatBytes(t.downloaded);
    detailUploaded.textContent = formatBytes(t.uploaded);
    detailRatio.textContent = t.ratio;
    detailEta.textContent = formatEta(t.eta);
    if (detailAdded) detailAdded.textContent = formatTimestamp(t.addedAt);
    if (detailCompleted) detailCompleted.textContent = formatTimestamp(t.completedAt);
    return;
  }

  if (activeTab === "pieces") {
    renderPiecesTab(t);
    return;
  }

  if (activeTab === "files") {
    if (files.length === 0) {
      filesList.dataset.structKey = "";
      filesList.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">Fetching file tree metadata...</td></tr>`;
      return;
    }
    const structKey = `${t.infoHash}:${files.length}:${files.map((f) => f.priority || (f.selected === false ? "skip" : "normal")).join(",")}`;
    const focusedOnPriority = document.activeElement?.classList?.contains("file-priority-select");
    if (filesList.dataset.structKey === structKey) {
      const fills = filesList.querySelectorAll(".progress-fill");
      const texts = filesList.querySelectorAll(".progress-text");
      for (let i = 0; i < files.length; i += 1) {
        const pct = `${files[i].progress}%`;
        if (fills[i] && fills[i].style.width !== pct) fills[i].style.width = pct;
        if (texts[i] && texts[i].textContent !== pct) texts[i].textContent = pct;
      }
    } else if (!focusedOnPriority) {
      filesList.dataset.structKey = structKey;
      filesList.innerHTML = files
        .map((f) => {
          const prio = f.priority || (f.selected === false ? "skip" : "normal");
          const streamBtn = f.isMedia
            ? `<button class="btn btn-primary btn-stream-file" data-index="${f.index}" data-name="${escapeHtml(f.name)}" style="padding: 2px 8px; font-size: 11px;">&#x25B6; Stream</button>`
            : `<span style="color: var(--text-muted); font-size: 11px;">-</span>`;

          return `
            <tr>
              <td style="text-align:center;">
                <select class="file-priority-select file-priority-${prio}" data-index="${f.index}" title="File download priority">
                  <option value="high"${prio === "high" ? " selected" : ""}>High</option>
                  <option value="normal"${prio === "normal" ? " selected" : ""}>Normal</option>
                  <option value="skip"${prio === "skip" ? " selected" : ""}>Skip</option>
                </select>
              </td>
              <td title="${escapeHtml(f.path || f.name)}">${escapeHtml(f.name)}</td>
              <td>${formatBytes(f.length)}</td>
              <td>
                <div class="progress-bar-container">
                  <div class="progress-track">
                    <div class="progress-fill" style="width: ${f.progress}%"></div>
                  </div>
                  <span class="progress-text">${f.progress}%</span>
                </div>
              </td>
              <td style="text-align: center;">${streamBtn}</td>
            </tr>
          `;
        })
        .join("");
    }
    return;
  }

  if (activeTab === "peers") {
    const html =
      peers.length === 0
        ? `<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">No active peers connected</td></tr>`
        : peers
            .map((p) => {
              const stateLabel = p.choked ? (p.interested ? "Choked / Interested" : "Idle") : "Downloading";
              return `
                <tr>
                  <td class="mono">${escapeHtml(p.addr)}</td>
                  <td>${escapeHtml(p.type)}</td>
                  <td class="speed-down">${formatSpeed(p.downloadSpeed)}</td>
                  <td class="speed-up">${formatSpeed(p.uploadSpeed)}</td>
                  <td>${stateLabel}</td>
                </tr>
              `;
            })
            .join("");
    if (peersList.dataset.lastHtml !== html) {
      peersList.dataset.lastHtml = html;
      peersList.innerHTML = html;
    }
    return;
  }

  if (activeTab === "trackers") {
    const rows = [
      `<tr><td class="mono">Mainline DHT (BEP 5) &amp; Peer Exchange (PEX)</td><td>UDP / Swarm</td></tr>`,
      ...trackers.map((url) => {
        const proto = url.startsWith("udp:") ? "UDP" : url.startsWith("https:") ? "HTTPS" : url.startsWith("ws") ? "WebSocket" : "HTTP";
        return `<tr><td class="mono">${escapeHtml(url)}</td><td>${proto}</td></tr>`;
      })
    ];
    const html = rows.join("");
    if (trackersList.dataset.lastHtml !== html) {
      trackersList.dataset.lastHtml = html;
      trackersList.innerHTML = html;
    }
  }
}

function renderPiecesTab(t) {
  if (!piecesSummary || !pieceMapGrid) return;
  if (!t) {
    piecesSummary.textContent = "Select a torrent to view piece verification map";
    pieceMapGrid.dataset.renderKey = "";
    pieceMapGrid.innerHTML = "";
    return;
  }
  const map = t.pieceMap || [];
  if (map.length === 0 || !t.totalPieces) {
    piecesSummary.textContent = "Waiting for torrent metadata...";
    pieceMapGrid.dataset.renderKey = "";
    pieceMapGrid.innerHTML = "";
    return;
  }
  const pct = Math.round((t.verifiedPieces / t.totalPieces) * 100);
  const pieceSizeLabel = t.pieceLength ? ` (${formatBytes(t.pieceLength)} / piece)` : "";
  piecesSummary.textContent = `${t.verifiedPieces} / ${t.totalPieces} pieces verified (${pct}%)${pieceSizeLabel}`;

  const key = `${t.infoHash}:${t.verifiedPieces}:${map.join("")}`;
  if (pieceMapGrid.dataset.renderKey === key) return;
  pieceMapGrid.dataset.renderKey = key;
  pieceMapGrid.innerHTML = map.map((state) => `<div class="piece-cell piece-${state}"></div>`).join("");
}

function recordSpeedSample(list, network) {
  const down = (list || []).reduce((acc, t) => acc + (t.downloadSpeed || 0), 0);
  const up = (list || []).reduce((acc, t) => acc + (t.uploadSpeed || 0), 0);
  const nics = (network?.interfaces || [])
    .filter((nic) => nic.activeInPool || nic.downloadSpeed > 0)
    .slice(0, NIC_CHART_COLORS.length)
    .map((nic) => ({ name: nic.name, down: nic.downloadSpeed || 0 }));

  speedHistory.push({ down, up, nics });
  if (speedHistory.length > MAX_SPEED_HISTORY) {
    speedHistory.shift();
  }
  if (activeTab === "speed" && uiPrefs.showDetailsPanel !== false) {
    renderSpeedChart();
  }
}

function renderSpeedChart() {
  if (!speedChartCanvas) return;
  const rect = speedChartCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (speedChartCanvas.width !== w * dpr || speedChartCanvas.height !== h * dpr) {
    speedChartCanvas.width = w * dpr;
    speedChartCanvas.height = h * dpr;
  }

  const ctx = speedChartCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const styles = getComputedStyle(document.documentElement);
  const borderColor = styles.getPropertyValue("--border-color").trim() || "#383c48";
  const textMuted = styles.getPropertyValue("--text-muted").trim() || "#6b7280";
  const green = styles.getPropertyValue("--accent-green").trim() || "#2ecc71";
  const blue = styles.getPropertyValue("--accent-blue").trim() || "#3498db";

  const latest = speedHistory[speedHistory.length - 1] || { down: 0, up: 0, nics: [] };
  if (speedLegendEl) {
    const nicLegends =
      latest.nics.length > 1
        ? latest.nics
            .map((nic, idx) => {
              const color = NIC_CHART_COLORS[idx % NIC_CHART_COLORS.length];
              return `<span><i class="legend-line" style="background: ${color};"></i> ${escapeHtml(nic.name)}: <strong>${formatSpeed(nic.down)}</strong></span>`;
            })
            .join("")
        : "";
    speedLegendEl.innerHTML =
      `<span><i class="legend-line" style="background: ${green};"></i> Down: <strong>${formatSpeed(latest.down)}</strong></span>` +
      `<span><i class="legend-line" style="background: ${blue};"></i> Up: <strong>${formatSpeed(latest.up)}</strong></span>` +
      nicLegends;
  }

  const padL = 62;
  const padR = 10;
  const padT = 10;
  const padB = 14;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = Math.max(10, h - padT - padB);

  let maxVal = 1024;
  for (const s of speedHistory) {
    if (s.down > maxVal) maxVal = s.down;
    if (s.up > maxVal) maxVal = s.up;
    for (const nic of s.nics) {
      if (nic.down > maxVal) maxVal = nic.down;
    }
  }
  maxVal *= 1.15;

  ctx.strokeStyle = borderColor;
  ctx.fillStyle = textMuted;
  ctx.font = "10px monospace";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 2; i += 1) {
    const ratio = i / 2;
    const y = padT + plotH * ratio;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    const labelVal = maxVal * (1 - ratio);
    ctx.fillText(formatSpeed(labelVal), 4, y);
  }

  if (speedHistory.length === 0) return;

  const drawSeries = (getValue, color, fillAlpha = 0, dashed = false) => {
    const n = speedHistory.length;
    const startOffset = MAX_SPEED_HISTORY - n;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = dashed ? 1.25 : 2;
    if (dashed) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    let firstX = padL;
    let lastX = padL;
    for (let i = 0; i < n; i += 1) {
      const x = padL + ((startOffset + i) / (MAX_SPEED_HISTORY - 1)) * plotW;
      const val = Math.max(0, getValue(speedHistory[i]) || 0);
      const y = padT + plotH - (val / maxVal) * plotH;
      if (i === 0) {
        firstX = x;
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      lastX = x;
    }
    ctx.stroke();

    if (fillAlpha > 0 && n > 1) {
      ctx.lineTo(lastX, padT + plotH);
      ctx.lineTo(firstX, padT + plotH);
      ctx.closePath();
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();
  };

  drawSeries((s) => s.down, green, 0.14, false);
  drawSeries((s) => s.up, blue, 0, false);

  if (latest.nics.length > 1) {
    latest.nics.forEach((nic, idx) => {
      const color = NIC_CHART_COLORS[idx % NIC_CHART_COLORS.length];
      drawSeries(
        (s) => s.nics.find((item) => item.name === nic.name)?.down || 0,
        color,
        0,
        true
      );
    });
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Column Sorting & Header Context Menu
if (torrentTableHead) {
  torrentTableHead.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = ["name", "status", "tag", "tracker"].includes(key) ? "asc" : "desc";
    }
    render();
  });

  torrentTableHead.addEventListener("contextmenu", (e) => {
    if (!columnMenu) return;
    e.preventDefault();
    const cols = normalizeColumnsConfig(uiPrefs.columns);
    columnMenu.innerHTML = cols
      .map((c) => {
        const def = COLUMNS_DEF[c.id];
        if (!def) return "";
        const disabled = c.id === "name" ? " disabled" : "";
        const checked = c.visible ? " checked" : "";
        return `<label class="column-menu-item"><input type="checkbox" class="col-toggle-cb" data-col="${c.id}"${checked}${disabled}> ${escapeHtml(def.label)}</label>`;
      })
      .join("");
    const x = Math.min(e.clientX, window.innerWidth - 190);
    const y = Math.min(e.clientY, window.innerHeight - 310);
    columnMenu.style.left = `${x}px`;
    columnMenu.style.top = `${y}px`;
    columnMenu.classList.add("active");
  });
}

if (columnMenu) {
  columnMenu.addEventListener("change", (e) => {
    const cb = e.target.closest(".col-toggle-cb");
    if (!cb) return;
    const colId = cb.dataset.col;
    const cols = normalizeColumnsConfig(uiPrefs.columns).map((c) =>
      c.id === colId && colId !== "name" ? { ...c, visible: cb.checked } : c
    );
    applyUiPrefs({ columns: cols });
    saveUiPrefsToServer({ columns: cols });
    render();
  });
}

async function saveUiPrefsToServer(partialUi) {
  try {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ui: partialUi })
    });
  } catch {}
}

// Multi-Select Row Selection (Click, Ctrl+Click, Shift+Click) & Context Menu
torrentList.addEventListener("click", (e) => {
  const row = e.target.closest("tr");
  if (!row) return;
  const hash = row.dataset.hash;

  if (e.shiftKey && anchorHash) {
    const ordered = getFilteredTorrents().map((t) => t.infoHash);
    const aIdx = ordered.indexOf(anchorHash);
    const bIdx = ordered.indexOf(hash);
    if (aIdx !== -1 && bIdx !== -1) {
      const [start, end] = aIdx <= bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
      if (!e.ctrlKey && !e.metaKey) selectedHashes.clear();
      for (let i = start; i <= end; i += 1) {
        selectedHashes.add(ordered[i]);
      }
      selectedHash = hash;
      render();
      return;
    }
  }

  if (e.ctrlKey || e.metaKey) {
    if (selectedHashes.has(hash)) {
      selectedHashes.delete(hash);
      if (selectedHash === hash) {
        selectedHash = selectedHashes.size > 0 ? [...selectedHashes][0] : null;
      }
    } else {
      selectedHashes.add(hash);
      selectedHash = hash;
    }
    anchorHash = hash;
  } else {
    selectedHashes = new Set([hash]);
    selectedHash = hash;
    anchorHash = hash;
  }
  render();
});

torrentList.addEventListener("dblclick", (e) => {
  const row = e.target.closest("tr");
  if (!row) return;
  fetch(`/api/torrents/${row.dataset.hash}/open-folder`, { method: "POST" });
});

torrentList.addEventListener("contextmenu", (e) => {
  const row = e.target.closest("tr");
  if (!row) return;
  e.preventDefault();
  const hash = row.dataset.hash;
  if (!selectedHashes.has(hash)) {
    selectedHashes = new Set([hash]);
    selectedHash = hash;
    anchorHash = hash;
    render();
  }

  const selectedList = getSelectedTorrentsList();
  const primary = torrents.find((t) => t.infoHash === hash) || selectedList[0];
  if (!primary) return;

  const canResume = selectedList.some((t) => t.status === "paused" || t.status === "queued");
  const canPause = selectedList.some((t) => t.status !== "paused");
  const canRecheck = selectedList.some((t) => t.status !== "checking" && t.status !== "connecting");
  const canMoveQueue = selectedList.length === 1 && primary.status === "queued";

  contextMenu.querySelector('[data-action="resume"]').disabled = !canResume;
  contextMenu.querySelector('[data-action="pause"]').disabled = !canPause;
  contextMenu.querySelector('[data-action="recheck"]').disabled = !canRecheck;
  contextMenu.querySelector('[data-action="queue-top"]').disabled = !canMoveQueue;
  contextMenu.querySelector('[data-action="queue-up"]').disabled = !canMoveQueue;
  contextMenu.querySelector('[data-action="queue-down"]').disabled = !canMoveQueue;

  const x = Math.min(e.clientX, window.innerWidth - 205);
  const y = Math.min(e.clientY, window.innerHeight - 360);
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  contextMenu.classList.add("active");
});

window.addEventListener("click", (e) => {
  if (!e.target.closest("#context-menu")) {
    contextMenu.classList.remove("active");
  }
  if (columnMenu && !e.target.closest("#column-menu")) {
    columnMenu.classList.remove("active");
  }
});

async function runBulkAction(hashes, fn) {
  await Promise.all(hashes.map(fn));
  fetchTorrents();
}

contextMenu.addEventListener("click", async (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item || item.disabled) return;
  const selectedList = getSelectedTorrentsList();
  if (selectedList.length === 0) return;
  const primary = torrents.find((t) => t.infoHash === selectedHash) || selectedList[0];
  const action = item.dataset.action;
  contextMenu.classList.remove("active");

  if (action === "resume") {
    const targets = selectedList.filter((t) => t.status === "paused" || t.status === "queued").map((t) => t.infoHash);
    await runBulkAction(targets, (h) => fetch(`/api/torrents/${h}/resume`, { method: "POST" }));
  } else if (action === "pause") {
    const targets = selectedList.filter((t) => t.status !== "paused").map((t) => t.infoHash);
    await runBulkAction(targets, (h) => fetch(`/api/torrents/${h}/pause`, { method: "POST" }));
  } else if (action === "recheck") {
    const targets = selectedList
      .filter((t) => t.status !== "checking" && t.status !== "connecting")
      .map((t) => t.infoHash);
    await runBulkAction(targets, (h) => fetch(`/api/torrents/${h}/recheck`, { method: "POST" }));
    flashStatus("Verifying torrent files...");
  } else if (action === "sequential") {
    btnSequential.click();
  } else if (action === "set-tag") {
    openTagModal(selectedList.map((t) => t.infoHash));
  } else if (action.startsWith("queue-")) {
    const dir = action.replace("queue-", "");
    await fetch(`/api/torrents/${primary.infoHash}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: dir })
    });
    fetchTorrents();
  } else if (action === "copy-magnet") {
    const uris = selectedList.map((t) => t.magnetURI).filter(Boolean);
    if (uris.length > 0) {
      await navigator.clipboard.writeText(uris.join("\n")).catch(() => {});
      flashStatus(uris.length > 1 ? `Copied ${uris.length} magnet links` : "Magnet link copied to clipboard");
    }
  } else if (action === "open-folder") {
    fetch(`/api/torrents/${primary.infoHash}/open-folder`, { method: "POST" });
  } else if (action === "remove") {
    btnDelete.click();
  }
});

// Category & Tag Sidebar Switchers
document.querySelectorAll("#sidebar-categories li").forEach((li) => {
  li.addEventListener("click", () => {
    activeFilter = li.dataset.filter;
    activeTag = "";
    syncSidebarHighlights();
    render();
  });
});

if (sidebarTagsList) {
  sidebarTagsList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-tag]");
    if (!li) return;
    activeTag = li.dataset.tag;
    activeFilter = "all";
    syncSidebarHighlights();
    render();
  });
}

// Details Panel Tab Switcher
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    ["general", "files", "peers", "pieces", "speed", "trackers", "logs"].forEach((id) => {
      const pane = document.getElementById(`tab-${id}`);
      if (pane) pane.style.display = activeTab === id ? "block" : "none";
    });
    if (activeTab === "speed") {
      renderSpeedChart();
    } else if (activeTab === "logs") {
      renderLogsTab(true);
    } else {
      const primary = torrents.find((t) => t.infoHash === selectedHash) || getSelectedTorrentsList()[0] || null;
      renderDetails(primary);
    }
  });
});

window.addEventListener("resize", () => {
  if (activeTab === "speed") renderSpeedChart();
});

// File Priority Selector (High / Normal / Skip)
filesList.addEventListener("change", async (e) => {
  const sel = e.target.closest(".file-priority-select");
  if (!sel || !selectedHash) return;
  const fileIndex = parseInt(sel.dataset.index, 10);
  const priority = sel.value;
  sel.className = `file-priority-select file-priority-${priority}`;
  await fetch(`/api/torrents/${selectedHash}/files/${fileIndex}/priority`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priority })
  });
  filesList.dataset.structKey = "";
  fetchTorrents();
});

// Copy Magnet from General Tab
btnCopyMagnet.addEventListener("click", async () => {
  const selected = torrents.find((t) => t.infoHash === selectedHash);
  if (selected?.magnetURI) {
    await navigator.clipboard.writeText(selected.magnetURI).catch(() => {});
    flashStatus("Magnet link copied to clipboard");
  }
});

// Search
searchInput.addEventListener("input", (e) => {
  searchQuery = e.target.value;
  render();
});

// Toolbar Bulk Actions
btnResume.addEventListener("click", async () => {
  const targets = getSelectedTorrentsList()
    .filter((t) => t.status === "paused" || t.status === "queued")
    .map((t) => t.infoHash);
  if (targets.length === 0) return;
  await runBulkAction(targets, (h) => fetch(`/api/torrents/${h}/resume`, { method: "POST" }));
});

btnPause.addEventListener("click", async () => {
  const targets = getSelectedTorrentsList()
    .filter((t) => t.status !== "paused")
    .map((t) => t.infoHash);
  if (targets.length === 0) return;
  await runBulkAction(targets, (h) => fetch(`/api/torrents/${h}/pause`, { method: "POST" }));
});

btnRecheck.addEventListener("click", async () => {
  const targets = getSelectedTorrentsList()
    .filter((t) => t.status !== "checking" && t.status !== "connecting")
    .map((t) => t.infoHash);
  if (targets.length === 0) return;
  await runBulkAction(targets, (h) => fetch(`/api/torrents/${h}/recheck`, { method: "POST" }));
  flashStatus(targets.length > 1 ? `Verifying ${targets.length} torrents...` : "Verifying files...");
});

btnPauseAll.addEventListener("click", async () => {
  await fetch("/api/pause-all", { method: "POST" });
  flashStatus("Paused all torrents");
  fetchTorrents();
});

btnResumeAll.addEventListener("click", async () => {
  await fetch("/api/resume-all", { method: "POST" });
  flashStatus("Resumed all torrents");
  fetchTorrents();
});

btnToggleDetails.addEventListener("click", () => {
  applyUiPrefs({ showDetailsPanel: !uiPrefs.showDetailsPanel });
  if (uiPrefs.showDetailsPanel) {
    if (activeTab === "speed") {
      renderSpeedChart();
    } else {
      const primary = torrents.find((t) => t.infoHash === selectedHash) || getSelectedTorrentsList()[0] || null;
      renderDetails(primary);
    }
  }
});

btnOpenFolder.addEventListener("click", () => {
  if (selectedHash) fetch(`/api/torrents/${selectedHash}/open-folder`, { method: "POST" });
});

btnOpenDownloads.addEventListener("click", () => {
  fetch("/api/open-downloads", { method: "POST" });
});

// Helper: Native Windows Folder Picker
async function browseDirectory(inputEl, buttonEl) {
  if (!inputEl || !buttonEl) return;
  const prevText = buttonEl.textContent;
  buttonEl.disabled = true;
  buttonEl.textContent = "Opening...";
  try {
    const res = await fetch("/api/system/browse-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialDir: inputEl.value.trim() })
    });
    const data = await res.json();
    if (res.ok && !data.cancelled && data.path) {
      inputEl.value = data.path;
    }
  } catch (e) {
    flashStatus("Folder picker error: " + e.message);
  } finally {
    buttonEl.disabled = false;
    buttonEl.textContent = prevText;
  }
}

// Add Torrent Options & Direct Submit Helpers
const modalAddOptions = document.getElementById("modal-add-options");
const addOptionsName = document.getElementById("add-options-name");
const addOptionsMeta = document.getElementById("add-options-meta");
const addOptionsPath = document.getElementById("add-options-path");
const addOptionsTag = document.getElementById("add-options-tag");
const addOptionsPaused = document.getElementById("add-options-paused");
const addOptionsSequential = document.getElementById("add-options-sequential");
const addOptionsFilesSection = document.getElementById("add-options-files-section");
const addOptionsFilesCount = document.getElementById("add-options-files-count");
const addOptionsFilesList = document.getElementById("add-options-files-list");
const addOptionsMagnetNote = document.getElementById("add-options-magnet-note");

async function submitMagnetDirect(magnetURI, opts = {}) {
  const res = await fetch("/api/torrents/magnet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ magnetURI, ...opts })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || res.statusText);
  }
  fetchTorrents();
}

async function submitFileDirect(file, opts = {}) {
  const formData = new FormData();
  formData.append("torrentFile", file);
  if (opts.savePath) formData.append("savePath", opts.savePath);
  if (opts.tag) formData.append("tag", opts.tag);
  if (opts.paused) formData.append("paused", "true");
  if (opts.sequential) formData.append("sequential", "true");
  if (Array.isArray(opts.deselectedFiles) && opts.deselectedFiles.length > 0) {
    formData.append("deselectedFiles", JSON.stringify(opts.deselectedFiles));
  }
  const res = await fetch("/api/torrents/upload", { method: "POST", body: formData });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || res.statusText);
  }
  fetchTorrents();
}

async function openAddOptionsDialog({ type, magnetURI, file }) {
  try {
    let inspectRes;
    if (type === "magnet") {
      inspectRes = await fetch("/api/torrents/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ magnetURI })
      });
    } else {
      const formData = new FormData();
      formData.append("torrentFile", file);
      inspectRes = await fetch("/api/torrents/inspect", { method: "POST", body: formData });
    }
    const info = await inspectRes.json();
    if (!inspectRes.ok) {
      throw new Error(info.error || "Could not read torrent metadata");
    }

    pendingAddSource = { type, magnetURI, file, info };
    addOptionsName.textContent = info.name || "Torrent";
    const metaParts = [];
    if (info.size > 0) metaParts.push(formatBytes(info.size));
    if (info.infoHash) metaParts.push(info.infoHash.slice(0, 12) + "...");
    addOptionsMeta.textContent = metaParts.join(" \u2022 ") || "Magnet URI";
    addOptionsPath.value = serverSettings.downloadDir || "";
    addOptionsTag.value = "";
    addOptionsPaused.checked = false;
    addOptionsSequential.checked = false;

    if (info.hasFileList && Array.isArray(info.files) && info.files.length > 0) {
      addOptionsFilesSection.style.display = "block";
      addOptionsMagnetNote.style.display = "none";
      addOptionsFilesCount.textContent = info.files.length;
      addOptionsFilesList.innerHTML = info.files
        .map(
          (f) => `
            <label class="add-file-row">
              <span class="add-file-name" title="${escapeHtml(f.path || f.name)}">
                <input type="checkbox" class="add-file-checkbox" data-index="${f.index}" checked>
                ${escapeHtml(f.name)}
              </span>
              <span class="settings-hint" style="flex-shrink:0;">${formatBytes(f.length)}</span>
            </label>
          `
        )
        .join("");
    } else {
      addOptionsFilesSection.style.display = "none";
      addOptionsMagnetNote.style.display = "block";
      addOptionsFilesList.innerHTML = "";
    }

    modalAddOptions.classList.add("active");
  } catch (e) {
    alert("Failed to inspect torrent: " + e.message);
  }
}

document.getElementById("btn-browse-add-dir").addEventListener("click", (e) => {
  browseDirectory(addOptionsPath, e.currentTarget);
});

document.getElementById("btn-add-files-all").addEventListener("click", () => {
  addOptionsFilesList.querySelectorAll(".add-file-checkbox").forEach((cb) => {
    cb.checked = true;
  });
});

document.getElementById("btn-add-files-none").addEventListener("click", () => {
  addOptionsFilesList.querySelectorAll(".add-file-checkbox").forEach((cb) => {
    cb.checked = false;
  });
});

document.getElementById("modal-add-options-close").addEventListener("click", () => {
  modalAddOptions.classList.remove("active");
  pendingAddSource = null;
});
document.getElementById("modal-add-options-cancel").addEventListener("click", () => {
  modalAddOptions.classList.remove("active");
  pendingAddSource = null;
});

document.getElementById("modal-add-options-submit").addEventListener("click", async (e) => {
  if (!pendingAddSource) return;
  const submitBtn = e.currentTarget;
  submitBtn.disabled = true;

  const rawPath = addOptionsPath.value.trim();
  const opts = {
    savePath: rawPath === (serverSettings.downloadDir || "") ? "" : rawPath,
    tag: addOptionsTag.value.trim(),
    paused: addOptionsPaused.checked,
    sequential: addOptionsSequential.checked,
    deselectedFiles: Array.from(addOptionsFilesList.querySelectorAll(".add-file-checkbox:not(:checked)")).map(
      (cb) => parseInt(cb.dataset.index, 10)
    )
  };

  try {
    if (pendingAddSource.type === "magnet") {
      await submitMagnetDirect(pendingAddSource.magnetURI, opts);
    } else {
      await submitFileDirect(pendingAddSource.file, opts);
    }
    modalAddOptions.classList.remove("active");
    pendingAddSource = null;
    flashStatus("Torrent added");
  } catch (err) {
    alert("Failed to add torrent: " + err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

// Set Tag Modal (supports single or multi-select)
const modalTag = document.getElementById("modal-tag");
const tagModalName = document.getElementById("tag-modal-name");
const tagModalInput = document.getElementById("tag-modal-input");

function openTagModal(hashesOrOne) {
  const list = Array.isArray(hashesOrOne) ? hashesOrOne : [hashesOrOne];
  if (list.length === 0) return;
  tagModalHashes = list;
  if (list.length === 1) {
    const t = torrents.find((item) => item.infoHash === list[0]);
    tagModalName.textContent = t?.name || "torrent";
    tagModalInput.value = t?.tag || "";
  } else {
    tagModalName.textContent = `${list.length} selected torrents`;
    tagModalInput.value = "";
  }
  modalTag.classList.add("active");
  tagModalInput.focus();
  tagModalInput.select();
}

async function applyTagModalValue(tagValue) {
  if (tagModalHashes.length === 0) return;
  const targets = [...tagModalHashes];
  tagModalHashes = [];
  modalTag.classList.remove("active");
  await runBulkAction(targets, (hash) =>
    fetch(`/api/torrents/${hash}/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: tagValue })
    })
  );
  flashStatus(tagValue ? `Tag set: ${tagValue}` : "Tag cleared");
}

document.getElementById("modal-tag-close").addEventListener("click", () => {
  modalTag.classList.remove("active");
  tagModalHashes = [];
});
document.getElementById("modal-tag-clear").addEventListener("click", () => applyTagModalValue(""));
document.getElementById("modal-tag-save").addEventListener("click", () => applyTagModalValue(tagModalInput.value.trim()));

// Modals: Add Magnet
document.getElementById("btn-add-magnet").addEventListener("click", () => {
  magnetInput.value = "";
  modalMagnet.classList.add("active");
  magnetInput.focus();
});

document.getElementById("modal-magnet-close").addEventListener("click", () => {
  modalMagnet.classList.remove("active");
});
document.getElementById("modal-magnet-cancel").addEventListener("click", () => {
  modalMagnet.classList.remove("active");
});

document.getElementById("modal-magnet-submit").addEventListener("click", async () => {
  const magnetURI = magnetInput.value.trim();
  if (!magnetURI) return;
  modalMagnet.classList.remove("active");
  if (serverSettings.showAddDialog !== false) {
    await openAddOptionsDialog({ type: "magnet", magnetURI });
    return;
  }
  try {
    await submitMagnetDirect(magnetURI);
  } catch (e) {
    alert("Failed to add magnet link: " + e.message);
  }
});

// File Upload
document.getElementById("btn-add-file").addEventListener("click", () => {
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  if (!fileInput.files || fileInput.files.length === 0) return;
  const file = fileInput.files[0];
  if (serverSettings.showAddDialog !== false) {
    await openAddOptionsDialog({ type: "file", file });
    return;
  }
  try {
    await submitFileDirect(file);
  } catch (e) {
    alert("Failed to upload torrent file: " + e.message);
  }
});

// Drag & Drop
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
  const torrentFiles = Array.from(e.dataTransfer.files).filter((f) => f.name.endsWith(".torrent"));
  if (torrentFiles.length === 1 && serverSettings.showAddDialog !== false) {
    await openAddOptionsDialog({ type: "file", file: torrentFiles[0] });
    return;
  }
  for (const file of torrentFiles) {
    await submitFileDirect(file).catch((err) => alert("Failed to add torrent: " + err.message));
  }
});

// Delete Modal (supports single or multi-select)
btnDelete.addEventListener("click", () => {
  const selectedList = getSelectedTorrentsList();
  if (selectedList.length === 0) return;
  pendingDeleteHashes = selectedList.map((t) => t.infoHash);
  deleteTorrentName.textContent =
    selectedList.length === 1 ? selectedList[0].name : `${selectedList.length} selected torrents`;
  deleteFilesCheckbox.checked = false;
  modalDelete.classList.add("active");
});

document.getElementById("modal-delete-close").addEventListener("click", () => {
  modalDelete.classList.remove("active");
  pendingDeleteHashes = [];
});
document.getElementById("modal-delete-cancel").addEventListener("click", () => {
  modalDelete.classList.remove("active");
  pendingDeleteHashes = [];
});

document.getElementById("modal-delete-submit").addEventListener("click", async () => {
  if (pendingDeleteHashes.length === 0) return;
  const targets = [...pendingDeleteHashes];
  const deleteFiles = deleteFilesCheckbox.checked;
  pendingDeleteHashes = [];
  modalDelete.classList.remove("active");
  try {
    await Promise.all(
      targets.map(async (hash) => {
        const res = await fetch(`/api/torrents/${hash}?deleteFiles=${deleteFiles}`, { method: "DELETE" });
        if (res.ok) {
          selectedHashes.delete(hash);
          if (selectedHash === hash) selectedHash = null;
        }
      })
    );
    fetchTorrents();
  } catch (e) {
    alert("Failed to remove torrent: " + e.message);
  }
});

// Tabbed Settings Modal
const modalSettings = document.getElementById("modal-settings");
const settingsDownloadDir = document.getElementById("settings-download-dir");
const settingsShowAddDialog = document.getElementById("settings-show-add-dialog");
const settingsAutoTagSubfolder = document.getElementById("settings-auto-tag-subfolder");
const settingsIncompleteDirEnabled = document.getElementById("settings-incomplete-dir-enabled");
const settingsIncompleteDir = document.getElementById("settings-incomplete-dir");
const settingsWatchFolderEnabled = document.getElementById("settings-watch-folder-enabled");
const settingsWatchFolderPath = document.getElementById("settings-watch-folder-path");
const settingsWatchFolderAction = document.getElementById("settings-watch-folder-action");
const settingsWatchFolderTag = document.getElementById("settings-watch-folder-tag");
const settingsDownSpeed = document.getElementById("settings-down-speed");
const settingsUpSpeed = document.getElementById("settings-up-speed");
const settingsMaxConns = document.getElementById("settings-max-conns");
const settingsMaxActiveDownloads = document.getElementById("settings-max-active-downloads");
const settingsSeedRatioLimit = document.getElementById("settings-seed-ratio-limit");
const settingsSchedulerEnabled = document.getElementById("settings-scheduler-enabled");
const settingsSchedulerStart = document.getElementById("settings-scheduler-start");
const settingsSchedulerEnd = document.getElementById("settings-scheduler-end");
const settingsSchedulerDown = document.getElementById("settings-scheduler-down");
const settingsSchedulerUp = document.getElementById("settings-scheduler-up");
const settingsSchedulerDaysEl = document.getElementById("settings-scheduler-days");
const settingsMultiNetwork = document.getElementById("settings-multi-network");
const settingsNotificationsEnabled = document.getElementById("settings-notifications-enabled");
const settingsOnCompleteAction = document.getElementById("settings-on-complete-action");
const settingsInterfacesList = document.getElementById("settings-interfaces-list");
const settingsColumnsList = document.getElementById("settings-columns-list");
const uiThemeSelect = document.getElementById("ui-theme");
const uiDensitySelect = document.getElementById("ui-density");
const uiSpeedUnitSelect = document.getElementById("ui-speed-unit");
const uiShowSidebarCheck = document.getElementById("ui-show-sidebar");
const uiShowDetailsCheck = document.getElementById("ui-show-details");
let defaultDownloadDir = "downloads";

function renderSettingsColumnsList() {
  if (!settingsColumnsList) return;
  settingsColumnsList.innerHTML = draftColumnsConfig
    .map((col, idx) => {
      const def = COLUMNS_DEF[col.id];
      if (!def) return "";
      const disableCheck = col.id === "name" ? " disabled" : "";
      const disableUp = idx === 0 ? " disabled" : "";
      const disableDown = idx === draftColumnsConfig.length - 1 ? " disabled" : "";
      return `
        <div class="column-config-row" data-idx="${idx}">
          <label class="column-config-left">
            <input type="checkbox" class="draft-col-visible" data-idx="${idx}"${col.visible ? " checked" : ""}${disableCheck}>
            <span>${escapeHtml(def.label)}</span>
          </label>
          <div style="display:flex; gap: 4px;">
            <button type="button" class="btn draft-col-move" data-idx="${idx}" data-dir="-1" style="padding: 1px 7px; font-size: 11px;"${disableUp}>&#x25B2;</button>
            <button type="button" class="btn draft-col-move" data-idx="${idx}" data-dir="1" style="padding: 1px 7px; font-size: 11px;"${disableDown}>&#x25BC;</button>
          </div>
        </div>
      `;
    })
    .join("");
}

if (settingsColumnsList) {
  settingsColumnsList.addEventListener("change", (e) => {
    const cb = e.target.closest(".draft-col-visible");
    if (!cb) return;
    const idx = parseInt(cb.dataset.idx, 10);
    if (draftColumnsConfig[idx] && draftColumnsConfig[idx].id !== "name") {
      draftColumnsConfig[idx].visible = cb.checked;
    }
  });

  settingsColumnsList.addEventListener("click", (e) => {
    const btn = e.target.closest(".draft-col-move");
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    const dir = parseInt(btn.dataset.dir, 10);
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= draftColumnsConfig.length) return;
    const temp = draftColumnsConfig[idx];
    draftColumnsConfig[idx] = draftColumnsConfig[targetIdx];
    draftColumnsConfig[targetIdx] = temp;
    renderSettingsColumnsList();
  });
}

document.getElementById("btn-reset-columns").addEventListener("click", () => {
  draftColumnsConfig = getDefaultColumnsConfig();
  renderSettingsColumnsList();
});

function switchSettingsTab(tabName) {
  document.querySelectorAll(".settings-tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.stab === tabName);
  });
  document.querySelectorAll(".settings-pane").forEach((pane) => {
    pane.style.display = pane.id === `stab-${tabName}` ? "block" : "none";
  });
}

document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchSettingsTab(btn.dataset.stab));
});

async function loadInterfacesChecklist(selectedNames) {
  try {
    const res = await fetch("/api/network/interfaces");
    const network = await res.json();
    const interfaces = network.interfaces || [];
    const selectedSet = new Set(
      Array.isArray(selectedNames) ? selectedNames : (network.selectedInterfaces || [])
    );

    if (interfaces.length === 0) {
      settingsInterfacesList.innerHTML = `<div class="settings-hint">No active external network interfaces found.</div>`;
      return;
    }

    settingsInterfacesList.innerHTML = interfaces
      .map((nic) => {
        const checked = selectedSet.has(nic.name) ? "checked" : "";
        const ipText = nic.ipv4 || nic.ipv6 || "No IP";
        const connText = `${nic.activeConnections} active`;
        return `
          <label class="interface-row">
            <div class="interface-left">
              <input type="checkbox" class="nic-checkbox" value="${escapeHtml(nic.name)}" ${checked}>
              <div>
                <div class="interface-name">${escapeHtml(nic.name)} <span class="interface-kind">${escapeHtml(nic.kind)}</span></div>
                <div class="settings-hint mono">${escapeHtml(ipText)}</div>
              </div>
            </div>
            <div class="interface-meta">
              <div>&#x2193; ${formatSpeed(nic.downloadSpeed)} / &#x2191; ${formatSpeed(nic.uploadSpeed)}</div>
              <div>${connText}</div>
            </div>
          </label>
        `;
      })
      .join("");
  } catch (e) {
    settingsInterfacesList.innerHTML = `<div class="settings-hint">Could not enumerate interfaces: ${escapeHtml(e.message)}</div>`;
  }
}

async function openSettingsModal(initialTab = "general") {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    serverSettings = data;
    if (data.defaultDownloadDir) {
      defaultDownloadDir = data.defaultDownloadDir;
    }
    settingsDownloadDir.value = data.downloadDir || "";
    settingsShowAddDialog.checked = data.showAddDialog !== false;
    settingsAutoTagSubfolder.checked = Boolean(data.autoTagSubfolder);
    settingsIncompleteDirEnabled.checked = Boolean(data.incompleteDirEnabled);
    settingsIncompleteDir.value = data.incompleteDir || "";
    settingsWatchFolderEnabled.checked = Boolean(data.watchFolderEnabled);
    settingsWatchFolderPath.value = data.watchFolderPath || "";
    settingsWatchFolderAction.value = data.watchFolderAction || "rename";
    settingsWatchFolderTag.value = data.watchFolderTag || "";
    settingsDownSpeed.value = data.maxDownloadSpeed ?? -1;
    settingsUpSpeed.value = data.maxUploadSpeed ?? -1;
    settingsMaxConns.value = data.maxConns ?? 120;
    settingsMaxActiveDownloads.value = data.maxActiveDownloads ?? 0;
    settingsSeedRatioLimit.value = data.seedRatioLimit ?? -1;

    const sched = data.scheduler || {};
    settingsSchedulerEnabled.checked = Boolean(sched.enabled);
    settingsSchedulerStart.value = sched.startTime || "09:00";
    settingsSchedulerEnd.value = sched.endTime || "18:00";
    settingsSchedulerDown.value = sched.altDownloadSpeed ?? 2048;
    settingsSchedulerUp.value = sched.altUploadSpeed ?? 512;
    const schedDays = new Set(Array.isArray(sched.days) ? sched.days : [0, 1, 2, 3, 4, 5, 6]);
    settingsSchedulerDaysEl.querySelectorAll("input[type='checkbox']").forEach((cb) => {
      cb.checked = schedDays.has(parseInt(cb.value, 10));
    });

    settingsMultiNetwork.checked = Boolean(data.multiNetworkEnabled);
    settingsNotificationsEnabled.checked = data.notificationsEnabled !== false;
    settingsOnCompleteAction.value = data.onCompleteAction || "none";

    const ui = data.ui || uiPrefs;
    uiThemeSelect.value = ui.theme || "dark";
    uiDensitySelect.value = ui.density || "comfortable";
    uiSpeedUnitSelect.value = ui.speedUnit || "bytes";
    uiShowSidebarCheck.checked = ui.showSidebar !== false;
    uiShowDetailsCheck.checked = ui.showDetailsPanel !== false;
    draftColumnsConfig = normalizeColumnsConfig(ui.columns || uiPrefs.columns).map((c) => ({ ...c }));
    renderSettingsColumnsList();

    await loadInterfacesChecklist(data.selectedInterfaces || []);
    switchSettingsTab(initialTab);
    modalSettings.classList.add("active");
  } catch (e) {
    alert("Failed to load settings: " + e.message);
  }
}

document.getElementById("btn-settings").addEventListener("click", () => openSettingsModal("general"));
document.getElementById("status-network-pill").addEventListener("click", () => openSettingsModal("network"));
if (statusSchedulerPill) {
  statusSchedulerPill.addEventListener("click", () => openSettingsModal("bandwidth"));
}

document.getElementById("btn-browse-download-dir").addEventListener("click", (e) => {
  browseDirectory(settingsDownloadDir, e.currentTarget);
});
document.getElementById("btn-browse-incomplete-dir").addEventListener("click", (e) => {
  browseDirectory(settingsIncompleteDir, e.currentTarget);
});
document.getElementById("btn-browse-watch-dir").addEventListener("click", (e) => {
  browseDirectory(settingsWatchFolderPath, e.currentTarget);
});

document.getElementById("btn-refresh-interfaces").addEventListener("click", async () => {
  const checked = Array.from(document.querySelectorAll(".nic-checkbox:checked")).map((el) => el.value);
  await loadInterfacesChecklist(checked);
});

document.getElementById("btn-max-bandwidth-preset").addEventListener("click", () => {
  settingsDownSpeed.value = -1;
  settingsUpSpeed.value = -1;
  settingsMaxConns.value = 250;
  settingsMultiNetwork.checked = true;
  flashStatus("Applied Max Bandwidth preset (click Save Settings)");
});

document.getElementById("modal-settings-close").addEventListener("click", () => {
  modalSettings.classList.remove("active");
});
document.getElementById("modal-settings-cancel").addEventListener("click", () => {
  modalSettings.classList.remove("active");
});

document.getElementById("btn-reset-download-dir").addEventListener("click", () => {
  settingsDownloadDir.value = defaultDownloadDir;
});

document.getElementById("modal-settings-save").addEventListener("click", async () => {
  const downloadDir = settingsDownloadDir.value.trim();
  const parsedDown = parseInt(settingsDownSpeed.value, 10);
  const parsedUp = parseInt(settingsUpSpeed.value, 10);
  const parsedConns = parseInt(settingsMaxConns.value, 10);
  const parsedQueue = parseInt(settingsMaxActiveDownloads.value, 10);
  const parsedRatio = parseFloat(settingsSeedRatioLimit.value);
  const parsedSchedDown = parseInt(settingsSchedulerDown.value, 10);
  const parsedSchedUp = parseInt(settingsSchedulerUp.value, 10);

  const maxDownloadSpeed = Number.isNaN(parsedDown) ? -1 : parsedDown;
  const maxUploadSpeed = Number.isNaN(parsedUp) ? -1 : parsedUp;
  const maxConns = Number.isNaN(parsedConns) ? 120 : Math.max(10, Math.min(500, parsedConns));
  const maxActiveDownloads = Number.isNaN(parsedQueue) ? 0 : Math.max(0, parsedQueue);
  const seedRatioLimit = Number.isNaN(parsedRatio) || parsedRatio < 0 ? -1 : parsedRatio;

  const multiNetworkEnabled = settingsMultiNetwork.checked;
  const selectedInterfaces = Array.from(document.querySelectorAll(".nic-checkbox:checked")).map((el) => el.value);
  const showAddDialog = settingsShowAddDialog.checked;
  const autoTagSubfolder = settingsAutoTagSubfolder.checked;
  const incompleteDirEnabled = settingsIncompleteDirEnabled.checked;
  const incompleteDir = settingsIncompleteDir.value.trim();
  const watchFolderEnabled = settingsWatchFolderEnabled.checked;
  const watchFolderPath = settingsWatchFolderPath.value.trim();
  const watchFolderAction = settingsWatchFolderAction.value || "rename";
  const watchFolderTag = settingsWatchFolderTag.value.trim();
  const notificationsEnabled = settingsNotificationsEnabled.checked;
  const onCompleteAction = settingsOnCompleteAction.value || "none";

  const scheduler = {
    enabled: settingsSchedulerEnabled.checked,
    startTime: settingsSchedulerStart.value || "09:00",
    endTime: settingsSchedulerEnd.value || "18:00",
    altDownloadSpeed: Number.isNaN(parsedSchedDown) ? 2048 : parsedSchedDown,
    altUploadSpeed: Number.isNaN(parsedSchedUp) ? 512 : parsedSchedUp,
    days: Array.from(settingsSchedulerDaysEl.querySelectorAll("input[type='checkbox']:checked")).map((cb) =>
      parseInt(cb.value, 10)
    )
  };

  const ui = {
    theme: uiThemeSelect.value,
    density: uiDensitySelect.value,
    speedUnit: uiSpeedUnitSelect.value,
    showSidebar: uiShowSidebarCheck.checked,
    showDetailsPanel: uiShowDetailsCheck.checked,
    columns: normalizeColumnsConfig(draftColumnsConfig)
  };

  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        downloadDir,
        showAddDialog,
        autoTagSubfolder,
        incompleteDirEnabled,
        incompleteDir,
        watchFolderEnabled,
        watchFolderPath,
        watchFolderAction,
        watchFolderTag,
        maxDownloadSpeed,
        maxUploadSpeed,
        maxConns,
        maxActiveDownloads,
        seedRatioLimit,
        scheduler,
        multiNetworkEnabled,
        selectedInterfaces,
        notificationsEnabled,
        onCompleteAction,
        ui
      })
    });
    if (res.ok) {
      serverSettings = await res.json();
      applyUiPrefs(ui);
      updateSchedulerIndicator(Boolean(serverSettings.schedulerActive));
      modalSettings.classList.remove("active");
      render();
      fetchNetwork();
      flashStatus("Settings saved");
    } else {
      const data = await res.json().catch(() => ({}));
      alert("Failed to save settings: " + (data.error || res.statusText));
    }
  } catch (e) {
    alert("Error saving settings: " + e.message);
  }
});

// Bulk Sequential Download Toggle
btnSequential.addEventListener("click", async () => {
  const selectedList = getSelectedTorrentsList();
  if (selectedList.length === 0) return;

  const nextSequential = selectedList.some((t) => !t.sequential);
  try {
    await runBulkAction(
      selectedList.map((t) => t.infoHash),
      (hash) =>
        fetch(`/api/torrents/${hash}/sequential`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextSequential })
        })
    );
  } catch (e) {
    console.error("Sequential toggle failed:", e);
  }
});

// Stream Media Player
const modalPlayer = document.getElementById("modal-player");
const playerTitle = document.getElementById("player-title");
const playerVideo = document.getElementById("player-video");
const playerAudio = document.getElementById("player-audio");
const playerLoading = document.getElementById("player-loading");
const modalPlayerClose = document.getElementById("modal-player-close");
const modalPlayerCloseBtn = document.getElementById("modal-player-close-btn");

function closeMediaPlayer() {
  playerVideo.pause();
  playerVideo.removeAttribute("src");
  playerVideo.load();
  playerAudio.pause();
  playerAudio.removeAttribute("src");
  playerAudio.load();
  modalPlayer.classList.remove("active");
}

modalPlayerClose.addEventListener("click", closeMediaPlayer);
modalPlayerCloseBtn.addEventListener("click", closeMediaPlayer);

filesList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-stream-file");
  if (!btn || !selectedHash) return;

  const fileIndex = btn.dataset.index;
  const fileName = btn.dataset.name;
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  const isAudio = [".mp3", ".wav", ".flac", ".ogg"].includes(ext);

  playerTitle.innerHTML = `&#x25B6; Streaming: ${escapeHtml(fileName)}`;
  playerLoading.style.display = "block";
  modalPlayer.classList.add("active");

  fetch(`/api/torrents/${selectedHash}/sequential`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true })
  });

  const streamUrl = `/api/torrents/${selectedHash}/stream/${fileIndex}`;

  if (isAudio) {
    playerVideo.style.display = "none";
    playerAudio.style.display = "block";
    playerAudio.src = streamUrl;
    playerAudio.oncanplay = () => { playerLoading.style.display = "none"; };
    playerAudio.play().catch(() => {});
  } else {
    playerAudio.style.display = "none";
    playerVideo.style.display = "block";
    playerVideo.src = streamUrl;
    playerVideo.oncanplay = () => { playerLoading.style.display = "none"; };
    playerVideo.play().catch(() => {});
  }
});

// Keyboard Shortcuts
window.addEventListener("keydown", (e) => {
  const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

  if (e.key === "Escape") {
    contextMenu.classList.remove("active");
    if (columnMenu) columnMenu.classList.remove("active");
    modalMagnet.classList.remove("active");
    modalAddOptions.classList.remove("active");
    pendingAddSource = null;
    modalTag.classList.remove("active");
    tagModalHashes = [];
    modalDelete.classList.remove("active");
    pendingDeleteHashes = [];
    modalSettings.classList.remove("active");
    if (modalPlayer.classList.contains("active")) closeMediaPlayer();
    return;
  }

  if (e.key === "Enter" && modalTag.classList.contains("active") && document.activeElement === tagModalInput) {
    e.preventDefault();
    applyTagModalValue(tagModalInput.value.trim());
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }

  if (inInput) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    const visible = getFilteredTorrents();
    selectedHashes = new Set(visible.map((t) => t.infoHash));
    selectedHash = visible[0]?.infoHash || null;
    anchorHash = selectedHash;
    render();
    return;
  }

  if (e.key === " " && selectedHashes.size > 0) {
    e.preventDefault();
    const list = getSelectedTorrentsList();
    if (list.some((t) => t.status === "paused" || t.status === "queued")) btnResume.click();
    else if (list.length > 0) btnPause.click();
  } else if (e.key === "Delete" && selectedHashes.size > 0) {
    btnDelete.click();
  }
});

// Init
applyUiPrefs(uiPrefs);
fetchInitialSettings();
fetchInitialLogs();
fetchTorrents();
fetchNetwork();
setupWebSocket();
