# MicroTorrent Desktop

A clean, modern, lightweight cross-platform BitTorrent desktop client for **Windows, macOS, and Linux** built with Node.js, WebTorrent, and Electron.

---

## Features

- **Cross-Platform Desktop App**: Native desktop installers for Windows (`.exe`), macOS (`.dmg`, `.zip` for Apple Silicon & Intel), and Linux (`.AppImage`, `.deb`), plus standalone Node.js mode.
- **Full BitTorrent Engine**: Powered by WebTorrent supporting:
  - Magnet URI links (`magnet:?xt=urn:btih:...`)
  - `.torrent` file uploads and direct drag-and-drop onto the window
  - Mainline DHT (BEP 5), PeX, and Tracker communication
  - Piece verification, sequential downloading, media streaming, and file-level selection/priority
- **System Tray & Background Downloads**: Closing the window keeps downloads active in the system tray across Windows, macOS, and Linux.
- **Multi-Network Interface Balancing**: Monitor and balance peer connections across multiple physical/VPN adapters.
- **Session Persistence**: Torrents, settings, and download queues persist automatically in `session.json` and `settings.json`.

---

## Quick Start (Development)

```bash
npm install
```

### Run as Electron Desktop App

```bash
npm run electron
```

### Run as Standalone Node.js Server / Web UI

```bash
npm start
```

Or headless without launching a browser window:

```bash
npm run dev
```

Then open `http://localhost:3456`.

---

## Building Multi-Platform Releases

Build locally for your current OS:

```bash
npm run dist        # current OS
npm run dist:win    # Windows (.exe NSIS + portable)
npm run dist:mac    # macOS (.dmg + .zip, arm64 + x64)
npm run dist:linux  # Linux (.AppImage + .deb)
```

### Automated GitHub Releases

Pushing a version tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml) to build installers on `windows-latest`, `macos-latest`, and `ubuntu-latest` and attach them to a GitHub Release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## Project Structure

```text
├── build/                # Installer icon assets (icon.ico, icon.png)
├── electron/
│   └── main.mjs          # Electron main process, native tray, dialogs & single-instance lock
├── public/               # Desktop Web UI (HTML, CSS, JS, logo.png, icon.ico)
├── scripts/              # Standalone Node protocol registration helpers (Windows/Linux)
├── src/
│   ├── main.js           # Standalone Node.js entry point & systray2 launcher
│   ├── server.js         # Express HTTP & WebSocket live metrics broadcaster
│   ├── torrentManager.js # BitTorrent engine lifecycle & session storage
│   ├── networkManager.js # Multi-NIC balancing & speed sampling
│   ├── platformHelpers.js# Cross-platform dialogs, notifications, sleep & folder open
│   ├── logger.js         # Dev-mode rotating logger
│   └── security.js       # Path traversal & magnet URI validation
└── .github/workflows/
    └── release.yml       # Cross-platform GitHub Actions build & release pipeline
```
