import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { listScanPaths, newScanPath, newestScanPath, roomsDir, scanFileName } from "./room-store.js";

// resolveOpenworkDataDir() reads the env var on every call, so pointing it at a
// temp dir is enough to isolate these.
let dataDir: string;
let previousDataDir: string | undefined;

function writeScan(name: string): void {
  mkdirSync(roomsDir(), { recursive: true });
  writeFileSync(join(roomsDir(), name), "{}\n", "utf8");
}

beforeEach(() => {
  previousDataDir = process.env.OPENWORK_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "openwork-room-store-"));
  process.env.OPENWORK_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
  else process.env.OPENWORK_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("room-store: scanFileName", () => {
  test("encodes the timestamp so lexicographic order is chronological", () => {
    // The whole newest-scan resolution rests on this: picking the current room
    // is a string sort over readdir, with no file opened or parsed.
    const earlier = scanFileName("2026-08-13T09:05:30.000Z");
    const later = scanFileName("2026-08-13T17:45:30.123Z");
    expect(earlier < later).toBe(true);
    expect(later).toBe("room-understanding-2026-08-13T17-45-30-123Z.json");
  });

  test("falls back to now when capturedAt is missing or unparseable", () => {
    // A malformed client payload should still be saveable, not rejected.
    for (const input of [undefined, "", "not-a-date"]) {
      expect(scanFileName(input)).toMatch(/^room-understanding-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
    }
  });
});

describe("room-store: listScanPaths / newestScanPath", () => {
  test("returns nothing when no room has ever been captured", () => {
    expect(listScanPaths()).toEqual([]);
    expect(newestScanPath()).toBeNull();
  });

  test("orders timestamped scans newest first", () => {
    writeScan("room-understanding-2026-08-13T09-05-30-000Z.json");
    writeScan("room-understanding-2026-08-13T17-45-30-123Z.json");
    writeScan("room-understanding-2026-08-12T23-59-59-999Z.json");

    expect(listScanPaths().map((p) => p.split(/[\\/]/).pop())).toEqual([
      "room-understanding-2026-08-13T17-45-30-123Z.json",
      "room-understanding-2026-08-13T09-05-30-000Z.json",
      "room-understanding-2026-08-12T23-59-59-999Z.json",
    ]);
  });

  test("keeps a legacy un-suffixed scan usable, ranked last", () => {
    // It carries no timestamp, so it cannot be ordered honestly. Treating it as
    // oldest means an existing room keeps working until the first new scan.
    writeScan("room-understanding.json");
    expect(newestScanPath()?.endsWith("room-understanding.json")).toBe(true);

    writeScan("room-understanding-2026-08-13T17-45-30-123Z.json");
    expect(newestScanPath()?.endsWith("room-understanding-2026-08-13T17-45-30-123Z.json")).toBe(true);
    expect(listScanPaths()).toHaveLength(2); // superseded, never deleted
  });

  test("ignores unrelated files in the rooms directory", () => {
    writeScan("notes.txt");
    writeScan("room-understanding-2026-08-13T17-45-30-123Z.json.bak");
    writeScan("room-understanding-2026-08-13T17-45-30-123Z.json");
    expect(listScanPaths()).toHaveLength(1);
  });

  test("a new save never collides with the scan it supersedes", () => {
    const first = newScanPath("2026-08-13T09:05:30.000Z");
    const second = newScanPath("2026-08-13T17:45:30.123Z");
    expect(first).not.toBe(second);
    expect(first.startsWith(roomsDir())).toBe(true);
  });
});
