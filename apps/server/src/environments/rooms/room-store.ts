import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveOpenworkDataDir } from "../../data-dir.js";

/**
 * Where captured room-understanding scans live, and which one is current.
 *
 * This module exists because the directory used to be spelled out in two
 * places that had no way of knowing about each other -- the HTTP route in
 * server.ts and `roomUnderstandingPath()` in the kitchen world loader. The
 * loader reads the file directly (never over HTTP) on every MCP tool call, so
 * a naming change applied to only one of them would silently revert the
 * agents' world to the demo kitchen while the XR client happily served the new
 * scan. One owner, no drift.
 *
 * Which directory this resolves to depends on OPENWORK_DATA_DIR:
 *   - `~/.openwork/openwork-server`            this server standalone (data-dir.ts default)
 *   - `~/.openwork/openwork-orchestrator-dev`  desktop `pnpm dev`
 *   - `~/.openwork/openwork-orchestrator`      packaged desktop app
 * and the orchestrator CLI's `--data-dir` flag outranks the env var. The
 * desktop launcher injects the variable into the whole process tree, so the
 * opencode-spawned kitchen MCP child resolves the same directory. Consequence
 * worth remembering: a room captured under `pnpm dev` is NOT visible to the
 * packaged app.
 */

/** Un-suffixed name written by every build before scans became timestamped. */
const LEGACY_SCAN_FILE = "room-understanding.json";

const SCAN_PREFIX = "room-understanding-";
const SCAN_SUFFIX = ".json";

export function roomsDir(): string {
  return join(resolveOpenworkDataDir(), "environments", "rooms");
}

/**
 * Filename for a scan captured at `capturedAt`.
 *
 * The timestamp is the ISO string with `:` and `.` swapped for `-` (both are
 * awkward in filenames on Windows). Fixed-width ISO means **lexicographic
 * order equals chronological order**, which is the whole point: picking the
 * newest scan is a string sort over `readdir`, with no file opened or parsed.
 *
 * @param capturedAt ISO timestamp; anything unparseable falls back to now, so
 *   a malformed client payload can still be saved rather than rejected.
 */
export function scanFileName(capturedAt?: string): string {
  const parsed = capturedAt ? new Date(capturedAt) : null;
  const iso = (parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date()).toISOString();
  return `${SCAN_PREFIX}${iso.replace(/[:.]/g, "-")}${SCAN_SUFFIX}`;
}

/**
 * Every saved scan, newest first.
 *
 * A legacy un-suffixed `room-understanding.json` is appended LAST rather than
 * sorted in: it carries no timestamp, so it cannot be ordered honestly, and
 * treating it as oldest means an existing room keeps working until the first
 * new scan supersedes it. It is never renamed or deleted -- migrating a file
 * someone may be relying on is not worth the risk.
 */
export function listScanPaths(): string[] {
  const dir = roomsDir();
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const timestamped = entries
    .filter((name) => name.startsWith(SCAN_PREFIX) && name.endsWith(SCAN_SUFFIX))
    .sort()
    .reverse();

  const paths = timestamped.map((name) => join(dir, name));
  if (entries.includes(LEGACY_SCAN_FILE)) paths.push(join(dir, LEGACY_SCAN_FILE));
  return paths;
}

/** The scan to load, or null when none has been captured yet. */
export function newestScanPath(): string | null {
  return listScanPaths()[0] ?? null;
}

/** Absolute path a scan captured at `capturedAt` should be written to. */
export function newScanPath(capturedAt?: string): string {
  return join(roomsDir(), scanFileName(capturedAt));
}
