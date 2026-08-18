import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { newScanPath, roomsDir } from "../rooms/room-store.js";
import { resolveMove } from "./mcp-server.js";

// resolveOpenworkDataDir() reads the env var on every call, so pointing it at a
// temp dir is enough to isolate these -- same approach as room-store.test.ts.
let dataDir: string;
let previousDataDir: string | undefined;

function writeRoom(objects: Array<{ id: string; label?: string }>, capturedAt?: string): void {
  mkdirSync(roomsDir(), { recursive: true });
  writeFileSync(newScanPath(capturedAt), JSON.stringify({ objects }), "utf8");
}

beforeEach(() => {
  previousDataDir = process.env.OPENWORK_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "openwork-spatial-mcp-"));
  process.env.OPENWORK_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
  else process.env.OPENWORK_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("spatial: resolveMove", () => {
  test("accepts a targetId present in the newest scan", () => {
    writeRoom([{ id: "table", label: "dining table" }, { id: "chair_2" }]);
    const result = resolveMove("stand_near", "table");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targetId).toBe("table");
  });

  test("rejects an unknown targetId and still lists the valid ones", () => {
    // The point of returning validPlaces on FAILURE: an agent that guessed
    // wrong corrects itself in one turn, with no discovery call first.
    writeRoom([{ id: "table", label: "dining table" }, { id: "fridge" }]);
    const result = resolveMove("stand_near", "sideboard");
    expect(result.ok).toBe(false);
    expect(result.places).toContain("table");
    expect(result.places).toContain("fridge");
  });

  test("rejects sit_near/stand_near with no targetId at all", () => {
    writeRoom([{ id: "table" }]);
    expect(resolveMove("stand_near").ok).toBe(false);
    expect(resolveMove("sit_near").ok).toBe(false);
  });

  test("placements that name nowhere need no targetId", () => {
    writeRoom([{ id: "table" }]);
    expect(resolveMove("station").ok).toBe(true);
    expect(resolveMove("seat").ok).toBe(true);
    expect(resolveMove("to_user").ok).toBe(true);
  });

  test("validates against the NEWEST scan, not the first one written", () => {
    // A rescan writes a new file rather than overwriting, so an id that was
    // valid before a rescan must stop validating afterwards -- otherwise the
    // agent and the room the client renders disagree.
    writeRoom([{ id: "fridge" }], "2026-08-13T09:00:00.000Z");
    writeRoom([{ id: "table" }], "2026-08-13T17:00:00.000Z");
    expect(resolveMove("stand_near", "table").ok).toBe(true);
    expect(resolveMove("stand_near", "fridge").ok).toBe(false);
  });

  test("reports no captured room rather than throwing", () => {
    const result = resolveMove("stand_near", "table");
    expect(result.ok).toBe(false);
    expect(result.places).toContain("no room");
  });
});
