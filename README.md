# MicroTorrent Desktop (Clean & Ad-Free)

A clean, modern, lightweight BitTorrent desktop client inspired by classic µTorrent, built with **zero advertisements, zero telemetry, and zero bundled third-party offers**.

---

## Features

- **Ad-Free & Private**: Pure BitTorrent functionality without sponsored offers, web promotions, or background tracking.
- **Lightweight Desktop Window**: Runs as a standalone desktop application window using native OS WebView/Edge App Mode with minimal RAM usage.
- **Full BitTorrent Engine**: Powered by WebTorrent supporting:
  - Magnet URI links (`magnet:?xt=urn:btih:...`)
  - `.torrent` file uploads and direct drag-and-drop anywhere onto the window
  - Mainline DHT (BEP 5) and Tracker communication
  - Piece verification & SHA-1 integrity checks
  - Pause, Resume, and Delete (with optional removal of downloaded files)
- **Session Persistence**: Torrents and their states automatically persist across app restarts in `session.json`.
- **Integrated File & Swarm Inspector**:
  - Live download and upload speeds
  - ETA calculation
  - File-by-file progress breakdown for multi-file torrents
  - Swarm connection stats
  - One-click access to open files in Windows Explorer

---

## Quick Start

### 1. Start the Desktop App

From this directory (`C:\Users\Kiran\IdeaProjects\torrent`):

```bash
npm start
```

This starts the local BitTorrent daemon and immediately opens the standalone desktop window.

### 2. Headless / Browser-Only Mode

If you only want the local server without launching a desktop window:

```bash
npm run dev
```

Then open your browser to `http://localhost:3456`.

---

## Project Structure

```
C:\Users\Kiran\IdeaProjects\torrent\
├── downloads\            # Default destination for downloaded files
├── public\               # Desktop Web UI
│   ├── index.html        # App layout, tables, toolbar, modals
│   ├── style.css         # Dark theme UI styling
│   └── app.js            # WebSocket client and UI controllers
├── src\
│   ├── main.js           # App entry point & desktop window launcher
│   ├── server.js         # Express HTTP & WebSocket live metrics broadcaster
│   └── torrentManager.js # BitTorrent engine lifecycle & session storage
├── session.json          # Persistent torrent state
└── package.json          # Dependencies (webtorrent, express, ws, multer)
```
