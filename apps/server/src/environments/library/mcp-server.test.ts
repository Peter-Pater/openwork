import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { newScanPath, roomsDir } from "../rooms/room-store.js";
import { DEFAULT_SHELF_LEVELS, listShelves, resolveShelving, slotsPerLevel, type Shelf } from "./mcp-server.js";
import { libraryStorePath, readLibrary, writeLibrary } from "./store.js";

// Same isolation as spatial/mcp-server.test.ts: resolveOpenworkDataDir() reads
// the env var on every call.
let dataDir: string;
let previousDataDir: string | undefined;

function writeRoom(objects: unknown[]): void {
  mkdirSync(roomsDir(), { recursive: true });
  writeFileSync(newScanPath(), JSON.stringify({ objects }), "utf8");
}

beforeEach(() => {
  previousDataDir = process.env.OPENWORK_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "openwork-library-mcp-"));
  process.env.OPENWORK_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
  else process.env.OPENWORK_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

// A 1 m wide shelf: (1 - 0.08) / 0.045 = 20 slots per level.
const WIDE: Shelf = { id: "bookcase_2", label: "bookcase", widthMeters: 1, heightMeters: 1.9, depthMeters: 0.3, levels: DEFAULT_SHELF_LEVELS, capacityPerLevel: slotsPerLevel(1), shelved: 0 };
const SOURCE: Shelf = { ...WIDE, id: "bookcase", widthMeters: 1.4 };
const CATS = ["fiction", "science", "history", "poetry"];
const EMPTY = { shelves: {} };
const NOW = "2026-08-20T00:00:00.000Z";

function books(...specs: Array<[string, string]>) {
  return specs.map(([title, category]) => ({ title, color: "#336699", category }));
}

describe("library: listShelves", () => {
  test("finds bookcases by canonical type or by label, never other furniture", () => {
    writeRoom([
      { id: "bookcase", label: "bookcase", type: "physical_object.unknown", halfExtents: [0.71, 0.35, 0.11] },
      { id: "shelf_3", label: "shelving unit", type: "furniture.bookcase", halfExtents: [0.1, 0.9, 0.4] },
      { id: "table", label: "table", type: "furniture.table", halfExtents: [0.5, 0.3, 0.5] },
    ]);
    const shelves = listShelves(EMPTY);
    expect(shelves.map((s) => s.id)).toEqual(["bookcase", "shelf_3"]);
    // Width is the larger horizontal extent regardless of which axis it is on.
    expect(shelves[0]!.widthMeters).toBeCloseTo(1.42);
    expect(shelves[0]!.depthMeters).toBeCloseTo(0.22);
    expect(shelves[1]!.widthMeters).toBeCloseTo(0.8);
    expect(shelves[1]!.levels).toBe(DEFAULT_SHELF_LEVELS);
  });

  test("reports how many books are already shelved", () => {
    writeRoom([{ id: "bookcase_2", label: "bookcase", halfExtents: [0.23, 0.96, 0.25] }]);
    const library = { shelves: { bookcase_2: { sourceId: "bookcase", levels: 3, categories: CATS.slice(0, 3), books: [{ bookId: "b1", title: "T", color: "#000000", category: "fiction", level: 0, slot: 0, shelvedAt: NOW }] } } };
    expect(listShelves(library)[0]!.shelved).toBe(1);
    // An occupied shelf reports the level count it was sorted across, not the default.
    expect(listShelves(library)[0]!.levels).toBe(3);
  });

  test("is empty with no scan", () => {
    expect(listShelves(EMPTY)).toEqual([]);
  });
});

describe("library: resolveShelving", () => {
  test("assigns level by category order and packs slots from zero", () => {
    const result = resolveShelving(
      { targetId: "bookcase_2", categories: CATS, books: books(["A", "fiction"], ["B", "history"], ["C", "fiction"], ["D", "science"]) },
      [SOURCE, WIDE],
      EMPTY,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sourceId).toBe("bookcase"); // the only other shelf
    expect(result.plan.levels).toBe(4);
    expect(result.plan.placements.map((p) => [p.title, p.level, p.slot])).toEqual([
      ["A", 0, 0],
      ["B", 2, 0],
      ["C", 0, 1],
      ["D", 1, 0],
    ]);
    expect(result.store.shelves.bookcase_2!.levels).toBe(4);
    expect(new Set(result.plan.placements.map((p) => p.bookId)).size).toBe(4);
    expect(result.store.shelves.bookcase_2!.books).toHaveLength(4);
    expect(result.store.shelves.bookcase_2!.books[0]!.shelvedAt).toBe(NOW);
  });

  test("a second call continues the slots and must keep the category order", () => {
    const first = resolveShelving({ targetId: "bookcase_2", categories: CATS, books: books(["A", "fiction"], ["B", "fiction"]) }, [SOURCE, WIDE], EMPTY, NOW);
    if (!first.ok) throw new Error(first.error);
    const second = resolveShelving({ targetId: "bookcase_2", categories: CATS, books: books(["C", "Fiction"]) }, [SOURCE, WIDE], first.store, NOW);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.plan.placements[0]!.slot).toBe(2);

    const reordered = resolveShelving({ targetId: "bookcase_2", categories: ["science", "fiction", "history", "poetry"], books: books(["C", "fiction"]) }, [SOURCE, WIDE], first.store, NOW);
    expect(reordered.ok).toBe(false);
    if (!reordered.ok) expect(reordered.error).toContain("clear_shelf");
    // Nor can the level count change under books already on the shelf.
    const relevelled = resolveShelving({ targetId: "bookcase_2", levels: 3, categories: CATS.slice(0, 3), books: books(["C", "fiction"]) }, [SOURCE, WIDE], first.store, NOW);
    expect(relevelled.ok).toBe(false);
    if (!relevelled.ok) expect(relevelled.error).toContain("4 levels");
  });

  test("rejects when a level overflows the shelf width", () => {
    const narrow: Shelf = { ...WIDE, widthMeters: 0.17, capacityPerLevel: slotsPerLevel(0.17) }; // 2 slots
    expect(narrow.capacityPerLevel).toBe(2);
    const result = resolveShelving({ targetId: "bookcase_2", categories: CATS, books: books(["A", "fiction"], ["B", "fiction"], ["C", "fiction"]) }, [SOURCE, narrow], EMPTY, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("full");
  });

  test("validates ids, categories and book fields", () => {
    const bad = (input: Parameters<typeof resolveShelving>[0], shelves = [SOURCE, WIDE]) => {
      const r = resolveShelving(input, shelves, EMPTY, NOW);
      return r.ok ? null : r.error;
    };
    expect(bad({ targetId: "nope", categories: CATS, books: books(["A", "fiction"]) })).toContain("Unknown targetId");
    expect(bad({ targetId: "bookcase_2", categories: CATS, books: books(["A", "fiction"]) }, [WIDE])).toContain("sourceId is required");
    expect(bad({ targetId: "bookcase_2", sourceId: "bookcase_2", categories: CATS, books: books(["A", "fiction"]) })).toContain("different");
    expect(bad({ targetId: "bookcase_2", categories: ["a", "b"], books: books(["A", "a"]) })).toContain("exactly 4");
    expect(bad({ targetId: "bookcase_2", categories: ["a", "A", "b", "c"], books: books(["A", "a"]) })).toContain("distinct");
    expect(bad({ targetId: "bookcase_2", levels: 9, categories: CATS, books: books(["A", "fiction"]) })).toContain("levels must");
    expect(bad({ targetId: "bookcase_2", categories: CATS, books: [] })).toContain("empty");
    expect(bad({ targetId: "bookcase_2", categories: CATS, books: [{ title: " ", color: "#000000", category: "fiction" }] })).toContain("empty title");
    expect(bad({ targetId: "bookcase_2", categories: CATS, books: [{ title: "A", color: "red", category: "fiction" }] })).toContain("#rrggbb");
    expect(bad({ targetId: "bookcase_2", categories: CATS, books: books(["A", "cooking"]) })).toContain("not one of");
  });

  test("honours an explicit level count on an empty shelf", () => {
    const result = resolveShelving({ targetId: "bookcase_2", levels: 3, categories: CATS.slice(0, 3), books: books(["A", "history"]) }, [SOURCE, WIDE], EMPTY, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.levels).toBe(3);
      expect(result.plan.placements[0]!.level).toBe(2);
    }
  });

  test("accepts the desk as a source even though it is not a shelf", () => {
    const result = resolveShelving({ targetId: "bookcase_2", sourceId: "table", categories: CATS, books: books(["A", "fiction"]) }, [SOURCE, WIDE], EMPTY, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.sourceId).toBe("table");
  });
});

describe("library: store", () => {
  test("round-trips through the data dir and tolerates a missing file", () => {
    expect(readLibrary()).toEqual({ shelves: {} });
    const store = { shelves: { bookcase_2: { sourceId: "bookcase", levels: 4, categories: CATS, books: [] } } };
    writeLibrary(store);
    expect(libraryStorePath().startsWith(dataDir)).toBe(true);
    expect(readLibrary()).toEqual(store);
  });

  test("treats malformed JSON as empty", () => {
    mkdirSync(join(dataDir, "environments", "library"), { recursive: true });
    writeFileSync(libraryStorePath(), "{not json", "utf8");
    expect(readLibrary()).toEqual({ shelves: {} });
  });
});
