import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const nodePath = process.execPath;
const mainPath = path.resolve(process.cwd(), "src", "main.js");
const iconIcoPath = path.resolve(process.cwd(), "public", "icon.ico");
const iconPngPath = path.resolve(process.cwd(), "public", "logo.png");

console.log(`Registering MicroTorrent as default handler for 'magnet:' and '.torrent' (${process.platform})...`);

try {
  if (process.platform === "win32") {
    const command = `\\"${nodePath}\\" \\"${mainPath}\\" \\"%1\\"`;

    execSync(`reg add "HKCU\\Software\\Classes\\magnet" /ve /t REG_SZ /d "URL:BitTorrent Magnet Link" /f`);
    execSync(`reg add "HKCU\\Software\\Classes\\magnet" /v "URL Protocol" /t REG_SZ /d "" /f`);
    execSync(`reg add "HKCU\\Software\\Classes\\magnet\\DefaultIcon" /ve /t REG_SZ /d "${iconIcoPath},0" /f`);
    execSync(`reg add "HKCU\\Software\\Classes\\magnet\\shell\\open\\command" /ve /t REG_SZ /d "${command}" /f`);
    console.log("✓ 'magnet:' protocol registered successfully in HKCU.");

    execSync(`reg add "HKCU\\Software\\Classes\\.torrent" /ve /t REG_SZ /d "MicroTorrent.TorrentFile" /f`);
    execSync(`reg add "HKCU\\Software\\Classes\\MicroTorrent.TorrentFile" /ve /t REG_SZ /d "BitTorrent Document" /f`);
    execSync(`reg add "HKCU\\Software\\Classes\\MicroTorrent.TorrentFile\\DefaultIcon" /ve /t REG_SZ /d "${iconIcoPath},0" /f`);
    execSync(`reg add "HKCU\\Software\\Classes\\MicroTorrent.TorrentFile\\shell\\open\\command" /ve /t REG_SZ /d "${command}" /f`);
    console.log("✓ '.torrent' file extension registered successfully in HKCU.");
  } else if (process.platform === "linux") {
    const appsDir = path.join(os.homedir(), ".local", "share", "applications");
    fs.mkdirSync(appsDir, { recursive: true });
    const desktopFile = path.join(appsDir, "microtorrent.desktop");
    const desktopContent = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=MicroTorrent",
      "Comment=Lightweight BitTorrent Client",
      `Exec="${nodePath}" "${mainPath}" %u`,
      `Icon=${iconPngPath}`,
      "Terminal=false",
      "Categories=Network;FileTransfer;P2P;",
      "MimeType=x-scheme-handler/magnet;application/x-bittorrent;",
      ""
    ].join("\n");
    fs.writeFileSync(desktopFile, desktopContent, "utf8");
    execFileSync("xdg-mime", ["default", "microtorrent.desktop", "x-scheme-handler/magnet"]);
    execFileSync("xdg-mime", ["default", "microtorrent.desktop", "application/x-bittorrent"]);
    console.log(`✓ Created ${desktopFile} and registered magnet/torrent handlers via xdg-mime.`);
  } else if (process.platform === "darwin") {
    console.log("On macOS, magnet: and .torrent associations are registered automatically by the packaged MicroTorrent.app bundle.");
  } else {
    console.log(`Protocol registration is not configured for platform: ${process.platform}`);
  }
} catch (err) {
  console.error("Registration error:", err.message);
  process.exit(1);
}
