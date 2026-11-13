import { execSync } from "node:child_process";

console.log("Unregistering MicroTorrent associations from Windows Registry...");

try {
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

  console.log("Unregister complete.");
} catch (err) {
  console.error("Error:", err.message);
}
