import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const nodePath = process.execPath;
const mainPath = path.resolve(process.cwd(), "src", "main.js");
const iconPath = path.resolve(process.cwd(), "public", "icon.ico");

const command = `\\"${nodePath}\\" \\"${mainPath}\\" \\"%1\\"`;

console.log("Registering MicroTorrent as default handler for 'magnet:' and '.torrent'...");

try {
  // 1. Magnet protocol handler
  execSync(`reg add "HKCU\\Software\\Classes\\magnet" /ve /t REG_SZ /d "URL:BitTorrent Magnet Link" /f`);
  execSync(`reg add "HKCU\\Software\\Classes\\magnet" /v "URL Protocol" /t REG_SZ /d "" /f`);
  execSync(`reg add "HKCU\\Software\\Classes\\magnet\\DefaultIcon" /ve /t REG_SZ /d "${iconPath},0" /f`);
  execSync(`reg add "HKCU\\Software\\Classes\\magnet\\shell\\open\\command" /ve /t REG_SZ /d "${command}" /f`);
  console.log("✓ 'magnet:' protocol registered successfully in HKCU.");

  // 2. .torrent file handler
  execSync(`reg add "HKCU\\Software\\Classes\\.torrent" /ve /t REG_SZ /d "MicroTorrent.TorrentFile" /f`);
  execSync(`reg add "HKCU\\Software\\Classes\\MicroTorrent.TorrentFile" /ve /t REG_SZ /d "BitTorrent Document" /f`);
  execSync(`reg add "HKCU\\Software\\Classes\\MicroTorrent.TorrentFile\\DefaultIcon" /ve /t REG_SZ /d "${iconPath},0" /f`);
  execSync(`reg add "HKCU\\Software\\Classes\\MicroTorrent.TorrentFile\\shell\\open\\command" /ve /t REG_SZ /d "${command}" /f`);
  console.log("✓ '.torrent' file extension registered successfully in HKCU.");

  console.log("\nSetup complete! Any magnet link or .torrent file you click will now open in MicroTorrent.");
} catch (err) {
  console.error("Registration error:", err.message);
  process.exit(1);
}
