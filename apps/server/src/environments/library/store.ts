import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveOpenworkDataDir } from "../../data-dir.js";

/**
 * Where shelved books live between sessions.
 *
 * A flat JSON file rather than the kitchen's world-graph artifact store: the
 * librarian has no inventory, capability or access model that would justify
 * entities and relations, and the XR client needs exactly one thing from this
 * file -- the list of (shelf, level, slot) placements to rebuild on boot. The
 * shape below IS the client's rehydration payload; keep the two in step.
 *
 * Sync fs on purpose, matching room-store.ts: the MCP server reads this on
 * every tool call and the HTTP route reads it once per page load, neither of
 * which benefits from async.
 */

export interface ShelvedBook {
  bookId: string;
  title: string;
  /** `#rrggbb` dominant spine colour as the agent read it from the photo. */
  color: string;
  category: string;
  /** 0 = bottom level. */
  level: number;
  /** 0 = leftmost position on the level, as seen from the front. */
  slot: number;
  shelvedAt: string;
}

export interface ShelfRecord {
  /** Where the books were picked up from (the other bookcase, or the desk). */
  sourceId: string;
  /** How many levels this bookcase was sorted across; fixed once books are on it. */
  levels: number;
  /** Level index -> category, so later calls keep the same assignment. */
  categories: string[];
  books: ShelvedBook[];
}

export interface LibraryStore {
  shelves: Record<string, ShelfRecord>;
}

export function libraryStorePath(): string {
  return join(resolveOpenworkDataDir(), "environments", "library", "shelves.json");
}

/** Tolerant read: a missing or malformed file is an empty library, not an error. */
export function readLibrary(path: string = libraryStorePath()): LibraryStore {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LibraryStore>;
    const shelves: Record<string, ShelfRecord> = {};
    for (const [id, record] of Object.entries(parsed.shelves ?? {})) {
      if (!record || typeof record !== "object") continue;
      shelves[id] = {
        sourceId: typeof record.sourceId === "string" ? record.sourceId : "",
        levels: Number.isInteger(record.levels) && (record.levels as number) > 0 ? (record.levels as number) : 3,
        categories: Array.isArray(record.categories) ? record.categories.filter((c) => typeof c === "string") : [],
        books: Array.isArray(record.books) ? record.books : [],
      };
    }
    return { shelves };
  } catch {
    return { shelves: {} };
  }
}

export function writeLibrary(store: LibraryStore, path: string = libraryStorePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
}
