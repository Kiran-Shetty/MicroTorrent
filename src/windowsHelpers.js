import { execFile } from "node:child_process";
import fs from "node:fs";

/**
 * Opens a native Windows FolderBrowserDialog (STA thread, TopMost owner so it surfaces in front).
 * Resolves with { cancelled: boolean, path?: string }.
 */
export function browseForFolder(initialDir = "") {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      return reject(new Error("Native folder dialog is currently supported on Windows only"));
    }

    const validInitial = initialDir && fs.existsSync(initialDir) ? initialDir : "";
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

    execFile(
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
        if (!selected) {
          resolve({ cancelled: true });
        } else {
          resolve({ cancelled: false, path: selected });
        }
      }
    );
  });
}

/**
 * Displays a native Windows desktop notification balloon cleanly without stealing focus.
 */
export function showDesktopNotification(title, message) {
  if (process.platform !== "win32") return;
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
      env: {
        ...process.env,
        MT_NOTIFY_TITLE: String(title || "MicroTorrent"),
        MT_NOTIFY_BODY: String(message || "")
      },
      windowsHide: true,
      timeout: 10_000
    },
    () => {}
  );
}

/**
 * Puts Windows to sleep cleanly when requested by completion automation.
 */
export function sleepSystem() {
  if (process.platform !== "win32") return;
  execFile("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], { windowsHide: true }, () => {});
}
