import { execFile, spawn } from "node:child_process";
import fs from "node:fs";

function runFirstAvailable(commands, onDone) {
  let index = 0;
  const next = (lastErr) => {
    if (index >= commands.length) {
      return onDone(lastErr || new Error("No supported system utility found"));
    }
    const { cmd, args, opts } = commands[index++];
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err && err.code === "ENOENT") {
        return next(err);
      }
      onDone(err, stdout, stderr);
    });
  };
  next();
}

/**
 * Opens a native OS folder picker dialog.
 * Resolves with { cancelled: boolean, path?: string }.
 */
export function browseForFolder(initialDir = "") {
  return new Promise((resolve, reject) => {
    const validInitial = initialDir && fs.existsSync(initialDir) ? initialDir : "";

    if (process.platform === "win32") {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.ShowInTaskbar = $false
$owner.Show()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select Download Directory'
$dialog.UseDescriptionForTitle = $true
$initial = $env:MT_INITIAL_DIR
if ($initial -and (Test-Path $initial)) { $dialog.SelectedPath = $initial }
$result = $dialog.ShowDialog($owner)
$owner.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
`;
      return execFile(
        "powershell.exe",
        ["-NoProfile", "-STA", "-Command", psScript],
        {
          env: { ...process.env, MT_INITIAL_DIR: validInitial },
          windowsHide: true,
          timeout: 120_000
        },
        (err, stdout) => {
          if (err) return reject(err);
          const selected = stdout.trim();
          resolve(selected ? { cancelled: false, path: selected } : { cancelled: true });
        }
      );
    }

    if (process.platform === "darwin") {
      const script = validInitial
        ? `POSIX path of (choose folder with prompt "Select Download Directory" default location POSIX file (system attribute "MT_INITIAL_DIR"))`
        : `POSIX path of (choose folder with prompt "Select Download Directory")`;
      return execFile(
        "osascript",
        ["-e", script],
        {
          env: { ...process.env, MT_INITIAL_DIR: validInitial },
          timeout: 120_000
        },
        (err, stdout, stderr) => {
          if (err) {
            if (String(stderr || err.message).includes("-128")) {
              return resolve({ cancelled: true });
            }
            return reject(err);
          }
          const selected = stdout.trim().replace(/\/+$/, "") || "/";
          resolve(selected ? { cancelled: false, path: selected } : { cancelled: true });
        }
      );
    }

    if (process.platform === "linux") {
      const zenityArgs = ["--file-selection", "--directory", "--title=Select Download Directory"];
      if (validInitial) zenityArgs.push(`--filename=${validInitial.replace(/\/?$/, "/")}`);
      const kdialogArgs = ["--getexistingdirectory", validInitial || process.env.HOME || "/", "--title", "Select Download Directory"];

      return runFirstAvailable(
        [
          { cmd: "zenity", args: zenityArgs, opts: { timeout: 120_000 } },
          { cmd: "kdialog", args: kdialogArgs, opts: { timeout: 120_000 } }
        ],
        (err, stdout) => {
          if (err) {
            if (err.code === 1 || err.code === 5) {
              return resolve({ cancelled: true });
            }
            return reject(err);
          }
          const selected = String(stdout || "").trim();
          resolve(selected ? { cancelled: false, path: selected } : { cancelled: true });
        }
      );
    }

    reject(new Error(`Native folder dialog is not supported on platform: ${process.platform}`));
  });
}

/**
 * Displays a native OS desktop notification without stealing focus.
 */
export function showDesktopNotification(title, message) {
  const safeTitle = String(title || "MicroTorrent");
  const safeBody = String(message || "");

  if (process.platform === "win32") {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
$notify.BalloonTipTitle = $env:MT_NOTIFY_TITLE
$notify.BalloonTipText = $env:MT_NOTIFY_BODY
$notify.Visible = $true
$notify.ShowBalloonTip(4000)
Start-Sleep -Milliseconds 4200
$notify.Dispose()
`;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", psScript],
      {
        env: { ...process.env, MT_NOTIFY_TITLE: safeTitle, MT_NOTIFY_BODY: safeBody },
        windowsHide: true,
        timeout: 10_000
      },
      () => {}
    );
    return;
  }

  if (process.platform === "darwin") {
    const script = `display notification (system attribute "MT_NOTIFY_BODY") with title (system attribute "MT_NOTIFY_TITLE")`;
    execFile(
      "osascript",
      ["-e", script],
      {
        env: { ...process.env, MT_NOTIFY_TITLE: safeTitle, MT_NOTIFY_BODY: safeBody },
        timeout: 10_000
      },
      () => {}
    );
    return;
  }

  if (process.platform === "linux") {
    execFile("notify-send", [safeTitle, safeBody], { timeout: 10_000 }, () => {});
  }
}

/**
 * Puts the host system to sleep when requested by completion automation.
 */
export function sleepSystem() {
  if (process.platform === "win32") {
    execFile("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], { windowsHide: true }, () => {});
  } else if (process.platform === "darwin") {
    execFile("pmset", ["sleepnow"], () => {});
  } else if (process.platform === "linux") {
    execFile("systemctl", ["suspend"], () => {});
  }
}

/**
 * Opens a file or folder in the OS file manager (Explorer, Finder, or xdg-open).
 */
export function openPathInExplorer(targetPath) {
  if (!targetPath) return;
  if (process.platform === "win32") {
    execFile("explorer.exe", [targetPath], (err) => {
      // explorer.exe often exits with code 1 even when opening a window successfully
      if (err && err.code !== 1) {
        console.warn("[Open Folder Warning]", err.message);
      }
    });
  } else if (process.platform === "darwin") {
    execFile("open", [targetPath], (err) => {
      if (err) console.warn("[Open Folder Warning]", err.message);
    });
  } else {
    execFile("xdg-open", [targetPath], (err) => {
      if (err) console.warn("[Open Folder Warning]", err.message);
    });
  }
}

/**
 * Launches the web dashboard in a standalone app-mode browser window when available,
 * falling back to the OS default browser.
 */
export function openUrlInBrowser(url) {
  const spawnDetached = (cmd, args) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    return child;
  };

  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ];
    const match = candidates.find((p) => fs.existsSync(p));
    if (match) {
      spawnDetached(match, [`--app=${url}`, "--window-size=1080,720"]);
    } else {
      execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true }, () => {});
    }
    return;
  }

  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ];
    const match = candidates.find((p) => fs.existsSync(p));
    if (match) {
      spawnDetached(match, [`--app=${url}`, "--window-size=1080,720"]);
    } else {
      execFile("open", [url], () => {});
    }
    return;
  }

  // Linux / BSD
  const linuxBrowsers = ["microsoft-edge", "google-chrome", "chromium", "chromium-browser"];
  let idx = 0;
  const tryNext = () => {
    if (idx >= linuxBrowsers.length) {
      execFile("xdg-open", [url], () => {});
      return;
    }
    const bin = linuxBrowsers[idx++];
    const child = spawn(bin, [`--app=${url}`, "--window-size=1080,720"], {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", tryNext);
    child.unref();
  };
  tryNext();
}
