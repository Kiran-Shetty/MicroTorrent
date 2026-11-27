<div align="center">
  <img src="public/logo.png" alt="MicroTorrent Logo" width="96" height="96" />
  <h1>MicroTorrent</h1>
  <p>A clean, lightweight, cross-platform BitTorrent desktop client for <strong>Windows, macOS, and Linux</strong> — built with Electron, Node.js, and WebTorrent.</p>
</div>

---

## Features

### BitTorrent Engine & File Management
- **Magnet Links & `.torrent` Files**: Add torrents via `magnet:` URIs, `.torrent` file picker, drag-and-drop onto the window, or OS protocol/file associations.
- **Pre-Download Options**: Choose save destination via the native OS folder picker, assign tags, start paused, enable sequential downloading, and select/deselect individual files before starting.
- **Full Torrent Lifecycle**: Resume, Pause, Stop (disconnect peers and stop seeding), Force Re-check, Remove (with optional disk file deletion), and queue position management.
- **Per-File Controls & Media Streaming**: Set file priorities (`High`, `Normal`, `Skip`) and stream video/audio files directly inside the built-in player over HTTP `206` byte-range requests.
- **Protocol Support**: Mainline DHT (BEP 5), Peer Exchange (PeX), UDP/HTTP/WebSocket trackers, and piece-level verification visualization.

### Cross-Platform Desktop Integration
- **Native Desktop App (`Electron`)**: Runs in a standalone desktop window with native OS dialogs, notifications, file manager integration (Explorer / Finder / `xdg-open`), and single-instance lock for forwarding `magnet:` links and `.torrent` files.
- **System Tray Background Mode**: Closing the window keeps active downloads running in the system tray with live speed tooltips and quick **Show**, **Open Downloads Folder**, **Pause All**, and **Resume All** controls.
- **Sensible Default Storage**:
  - **Packaged Desktop App**: Saves downloads to your OS default `Downloads/MicroTorrent` directory (`C:\Users\<User>\Downloads\MicroTorrent` on Windows, `~/Downloads/MicroTorrent` on macOS/Linux) and stores `settings.json`, `session.json`, and `logs/` in `app.getPath("userData")`.
  - **Standalone Node Mode**: Defaults to `./downloads` in the repository directory (override anytime in **Settings**).

### Bandwidth, Multi-Network & Automation
- **Multi-Network Interface Balancing**: Monitor per-adapter speeds/connections and distribute TCP peer connections round-robin across selected physical or VPN adapters.
- **Bandwidth Controls & Scheduler**: Global download/upload speed caps, max peers (`10–500`), max active downloads, auto-stop seed ratio limit, and scheduled alternative speed windows by time and day of week.
- **Watch Folder & Auto-Move Completed**: Automatically import `.torrent` files from a watched folder (rename or delete after import) and keep incomplete files in a staging directory until 100% verified.
- **Completion Automation**: Desktop notifications on download completion, plus optional post-queue actions (stop seeding, exit app, or put system to sleep).

### Customizable Interface
- **Themes & Density**: Switch between **Dark Slate**, **Midnight OLED**, and **Clean Light** themes, **Comfortable** or **Compact** row density, and `Bytes/s` or `Bits/s` speed units.
- **Inspector & Live Telemetry**: Real-time WebSocket updates (`1s` interval) powering General info, Files tree, Peers list, Piece availability map, 90-second Speed chart, Trackers list, and a Dev-Mode Execution `Logs` tab.
- **Flexible Table Layout**: Show, hide, and reorder torrent table columns from Settings or by right-clicking table headers.

---

## Installation (End Users)

Download the latest installer for your operating system from the [GitHub Releases](https://github.com/Kiran-Shetty/MicroTorrent/releases) page:

| Platform | Available Formats |
| :--- | :--- |
| **Windows (`x64`)** | NSIS Installer (`.exe`), Portable Executable (`.exe`) |
| **macOS (`arm64` & `x64`)** | Disk Image (`.dmg`), Archive (`.zip`) |
| **Linux (`x64`)** | AppImage (`.AppImage`), Debian/Ubuntu Package (`.deb`) |

---

## Development & Running From Source

### Prerequisites
- **Node.js** `v18+` (`v22 LTS` recommended) and `npm`

### Install Dependencies

```bash
npm install
```

### Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run electron` | Launch the Electron desktop app with native tray and OS dialogs |
| `npm run electron:dev` | Launch Electron with dev logging enabled (`Logs` tab + rotating log file) |
| `npm start` | Run standalone Node.js server (`http://localhost:3456`), `systray2`, and browser app-mode window |
| `npm run dev` | Run standalone Node.js server headlessly with dev logging enabled (no auto-launched window) |
| `npm run register` | Register `magnet:` and `.torrent` OS associations for standalone Node mode (Windows/Linux) |
| `npm run unregister` | Remove standalone Node protocol/file associations |
| `npm run dist` | Build installer packages for your current OS into `dist/` |
| `npm run dist:win` | Build Windows NSIS + Portable `.exe` packages |
| `npm run dist:mac` | Build macOS `.dmg` + `.zip` (`arm64` & `x64`) packages |
| `npm run dist:linux` | Build Linux `.AppImage` + `.deb` packages |

> [!TIP]
> If you launch `npm run electron` from an Electron-based IDE terminal (such as VS Code or Antigravity), clear `ELECTRON_RUN_AS_NODE` first so Electron runs in desktop mode instead of plain Node mode:
> ```powershell
> Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; npm run electron
> ```

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl + F` / `Cmd + F` | Focus torrent search filter |
| `Ctrl + A` / `Cmd + A` | Select all visible torrents |
| `Space` | Resume (if paused/queued) or Pause selected torrents |
| `Delete` | Open remove confirmation for selected torrents |
| `Esc` | Close active modal, context menu, or column menu |

---

## Project Structure

```text
├── .github/workflows/
│   └── release.yml            # Multi-platform GitHub Actions build & release workflow
├── build/
│   ├── icon.ico               # Multi-resolution Windows app icon (16, 32, 48, 256)
│   └── icon.png               # High-res icon for macOS & Linux packaging (512x512)
├── electron/
│   └── main.mjs               # Electron main process, native tray, dialogs & single-instance lock
├── public/
│   ├── index.html             # Desktop & web dashboard markup and modals
│   ├── style.css              # Responsive dark/midnight/light theme styles
│   ├── app.js                 # WebSocket client, table/inspector renderers & UI controllers
│   ├── logo.png               # Toolbar and notification logo (256x256)
│   └── icon.ico               # Favicon & standalone Windows tray icon
├── scripts/
│   ├── register-protocol.mjs  # Standalone magnet/torrent handler registration (Windows/Linux)
│   └── unregister-protocol.mjs# Remove standalone protocol/file associations
├── src/
│   ├── main.js                # Standalone Node.js daemon & systray2 launcher
│   ├── server.js              # Express REST API, HTTP 206 streaming & WebSocket broadcaster
│   ├── torrentManager.js      # WebTorrent engine lifecycle, queue, watch folder & session persistence
│   ├── networkManager.js      # Multi-NIC round-robin socket balancing & per-adapter speed stats
│   ├── platformHelpers.js     # Cross-platform folder picker, notifications, sleep & file manager open
│   ├── windowsHelpers.js      # Compatibility re-export for platformHelpers
│   ├── logger.js              # Dev-mode rotating file & in-memory ring-buffer logger
│   └── security.js            # Directory traversal sanitization & magnet URI validation
└── package.json               # Dependencies, scripts & electron-builder configuration
```
