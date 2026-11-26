import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

console.log(`Unregistering MicroTorrent associations (${process.platform})...`);

try {
  if (process.platform === "win32") {
    try {
      execSync(`reg delete "HKCU\\Software\\Classes\\magnet" /f`);
      console.log("✓ 'magnet:' protocol unregistered.");
    } catch {}

    try {
      execSync(`reg delete "HKCU\\Software\\Classes\\.torrent" /f`);
      console.log("✓ '.torrent' association unregistered.");
    } catch {}

    try {
      execSync(`reg delete "HKCU\\Software\\Classes\\MicroTorrent.TorrentFile" /f`);
    } catch {}
  } else if (process.platform === "linux") {
    const desktopFile = path.join(os.homedir(), ".local", "share", "applications", "microtorrent.desktop");
    if (fs.existsSync(desktopFile)) {
      fs.rmSync(desktopFile, { force: true });
      console.log(`✓ Removed ${desktopFile}.`);
    }
    try {
      execFileSync("update-desktop-database", [path.join(os.homedir(), ".local", "share", "applications")]);
    } catch {}
  } else if (process.platform === "darwin") {
    console.log("On macOS, remove MicroTorrent.app from /Applications to unregister its bundle handlers.");
  }

  console.log("Unregister complete.");
} catch (err) {
  console.error("Error:", err.message);
}
