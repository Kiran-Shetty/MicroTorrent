import path from "node:path";

/**
 * Validates and sanitizes a target file path relative to a base directory,
 * preventing Directory Traversal attacks (e.g. `../../etc/passwd` or `..\Windows\System32`).
 */
export function sanitizeFilePath(baseDir, relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("Invalid relative file path");
  }

  // Remove null bytes and carriage returns
  let cleaned = relativePath.replace(/[\0\r\n]/g, "");

  // Normalize path separators to current OS
  cleaned = cleaned.replace(/[/\\]+/g, path.sep);

  // Prevent Windows absolute drive paths (e.g. C:\)
  cleaned = cleaned.replace(/^[a-zA-Z]:[/\\]?/, "");

  // Resolve against baseDir
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, cleaned);

  // Enforce boundary check
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (!resolvedTarget.startsWith(baseWithSep) && resolvedTarget !== resolvedBase) {
    // If it attempted to escape, safely sanitize by flattening leading traversal dots
    const safeName = path.basename(cleaned);
    return path.join(resolvedBase, safeName);
  }

  return resolvedTarget;
}

/**
 * Validates that an input string is a legitimate BitTorrent Magnet URI or hex infoHash.
 */
export function validateMagnetURI(uri) {
  if (!uri || typeof uri !== "string") return false;
  const trimmed = uri.trim();

  // Valid standard magnet scheme with BitTorrent info hash (xt=urn:btih:...)
  if (/^magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,64}/i.test(trimmed)) {
    return true;
  }

  // Raw 40-character hex infoHash
  if (/^[a-fA-F0-9]{40}$/.test(trimmed)) {
    return true;
  }

  // Raw 32-character base32 infoHash
  if (/^[a-zA-Z2-7]{32}$/.test(trimmed)) {
    return true;
  }

  return false;
}
