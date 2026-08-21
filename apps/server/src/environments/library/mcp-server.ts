#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { newestScanPath } from "../rooms/room-store.js";
import { readLibrary, writeLibrary, type LibraryStore, type ShelvedBook } from "./store.js";

/**
 * `library` MCP server — lets the librarian sort books onto a real bookcase.
 *
 * These tools SHELVE NOTHING. Like `spatial_move_agent`, they are a signalling
 * channel: the agent reads the photo of the books itself and calls
 * `shelve_books` with what it saw; this server validates that against the
 * bookcases in the newest room scan, assigns each book a (level, slot) on the
 * target shelf, persists the result, and returns the plan. The XR client
 * watches the tool part over SSE and performs the trips -- carrying a virtual
 * replica of each book from the source to the target and standing it in its
 * slot. Geometry (where a slot IS in metres) is the client's business, because
 * only the client knows the room's current anchor transform.
 *
 * Separate from `kitchen` and `spatial` for the same reason those are separate
 * from each other: opencode names tools `<serverName>_<toolName>`, and the
 * chef's `"*": false` allow-list enumerates its tools by that name.
 *
 * No LLM is called here. Recognition is the agent's job; this is bookkeeping.
 */

/**
 * Levels per bookcase when the agent does not say: one category per level.
 * The real shelf has four evenly spaced levels; a call may pass `levels` to
 * match a different bookcase. Once books are on a shelf its level count is
 * fixed (stored in the record) -- re-dividing the height would move them.
 */
export const DEFAULT_SHELF_LEVELS = 4;
export const MIN_SHELF_LEVELS = 2;
export const MAX_SHELF_LEVELS = 6;

/**
 * Capacity model -- MUST match shelf-slots.js in the XR client, which turns a
 * slot index into a position with the same pitch and margin. Change both or
 * books at the end of a row end up outside the shelf.
 */
export const BOOK_PITCH_METERS = 0.045; // 3.5 cm book + 1 cm gap
export const SIDE_MARGIN_METERS = 0.04;

export function slotsPerLevel(widthMeters: number): number {
  return Math.max(0, Math.floor((widthMeters - 2 * SIDE_MARGIN_METERS) / BOOK_PITCH_METERS));
}

const SHELF_LABEL_RE = /bookcase|bookshelf|shelving|shelf|shelves/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

export interface Shelf {
  id: string;
  label: string;
  widthMeters: number;
  heightMeters: number;
  depthMeters: number;
  levels: number;
  capacityPerLevel: number;
  shelved: number;
}

interface RoomObject {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  halfExtents?: unknown;
}

/**
 * Bookcases in the newest saved scan. Read fresh on every call (a rescan
 * writes a new file at any moment). Matches on the client's canonical type
 * first and falls back to the label so scans saved before the `bookcase`
 * class existed still work.
 */
export function listShelves(library: LibraryStore = readLibrary()): Shelf[] {
  const path = newestScanPath();
  if (!path) return [];
  try {
    const room = JSON.parse(readFileSync(path, "utf8")) as { objects?: RoomObject[] };
    const shelves: Shelf[] = [];
    for (const object of room.objects ?? []) {
      if (typeof object?.id !== "string" || !object.id.trim()) continue;
      const label = typeof object.label === "string" ? object.label : "";
      const isShelf = object.type === "furniture.bookcase" || SHELF_LABEL_RE.test(label) || SHELF_LABEL_RE.test(object.id);
      if (!isShelf) continue;
      const he = Array.isArray(object.halfExtents) && object.halfExtents.length === 3
        ? (object.halfExtents as number[]).map((v) => (Number.isFinite(v) ? Math.abs(v) : 0))
        : [0, 0, 0];
      // Width is the larger horizontal extent: the scan's OBB is yaw-aligned to
      // the object, so which of x/z is "across the front" depends on how it
      // was captured. Depth is the smaller one.
      const widthMeters = 2 * Math.max(he[0]!, he[2]!);
      const depthMeters = 2 * Math.min(he[0]!, he[2]!);
      shelves.push({
        id: object.id,
        label,
        widthMeters,
        heightMeters: 2 * he[1]!,
        depthMeters,
        levels: library.shelves[object.id]?.books.length ? library.shelves[object.id]!.levels : DEFAULT_SHELF_LEVELS,
        capacityPerLevel: slotsPerLevel(widthMeters),
        shelved: library.shelves[object.id]?.books.length ?? 0,
      });
    }
    return shelves;
  } catch (error) {
    console.error(`[library] Could not read room scan at ${path}:`, error);
    return [];
  }
}

function describeShelves(shelves: Shelf[]): string {
  if (shelves.length === 0) return "(no bookcase has been captured in the room scan yet)";
  return shelves
    .map((s) => `${s.id}${s.label ? ` ("${s.label}")` : ""}: ${s.widthMeters.toFixed(2)}m wide, ${s.heightMeters.toFixed(2)}m tall, ${s.levels} levels, ${s.capacityPerLevel} books per level, ${s.shelved} shelved`)
    .join("; ");
}

export interface BookInput {
  title: string;
  color: string;
  category: string;
}

export interface ShelveInput {
  targetId: string;
  sourceId?: string;
  levels?: number;
  categories: string[];
  books: BookInput[];
}

export interface Placement extends BookInput {
  bookId: string;
  level: number;
  slot: number;
}

export interface ShelvePlan {
  sourceId: string;
  targetId: string;
  levels: number;
  categories: string[];
  placements: Placement[];
}

export type ShelveResult =
  | { ok: true; plan: ShelvePlan; store: LibraryStore }
  | { ok: false; error: string };

/**
 * Validates a shelving request and assigns each book a level and slot.
 *
 * Pure: takes the shelves and the current library, returns the plan and the
 * updated store without touching disk, so the rules are testable without a
 * data dir. Level = index of the book's category in `categories` (bottom
 * first); slot = next free position on that level, continuing from whatever
 * an earlier call already shelved. A second call to the same shelf must reuse
 * the same category order -- otherwise the levels would silently mean
 * different things to books shelved ten minutes apart.
 */
export function resolveShelving(input: ShelveInput, shelves: Shelf[], library: LibraryStore, now: string): ShelveResult {
  const target = shelves.find((s) => s.id === input.targetId);
  if (!target) {
    return { ok: false, error: `Unknown targetId "${input.targetId}". It must be one of the bookcase ids listed in shelves exactly.` };
  }

  let sourceId = input.sourceId?.trim() ?? "";
  if (!sourceId) {
    const others = shelves.filter((s) => s.id !== target.id);
    if (others.length !== 1) {
      return { ok: false, error: "sourceId is required: it is where the books are picked up from (another bookcase, or the desk they are lying on)." };
    }
    sourceId = others[0]!.id;
  } else if (sourceId === target.id) {
    return { ok: false, error: "sourceId and targetId must be different objects." };
  }

  const existing = library.shelves[target.id];
  const occupied = Boolean(existing && existing.books.length > 0);
  const levels = occupied ? existing!.levels : (input.levels ?? DEFAULT_SHELF_LEVELS);
  if (!Number.isInteger(levels) || levels < MIN_SHELF_LEVELS || levels > MAX_SHELF_LEVELS) {
    return { ok: false, error: `levels must be a whole number from ${MIN_SHELF_LEVELS} to ${MAX_SHELF_LEVELS}.` };
  }
  if (occupied && input.levels !== undefined && input.levels !== levels) {
    return { ok: false, error: `${target.id} already holds books sorted across ${levels} levels; pass levels=${levels} or call clear_shelf first.` };
  }

  const categories = input.categories.map((c) => c.trim()).filter(Boolean);
  if (categories.length !== levels || new Set(categories.map((c) => c.toLowerCase())).size !== levels) {
    return { ok: false, error: `categories must be exactly ${levels} distinct names, one per shelf level from the bottom up (this bookcase has ${levels} levels).` };
  }

  if (occupied) {
    const same = existing!.categories.length === categories.length
      && existing.categories.every((c, i) => c.toLowerCase() === categories[i]!.toLowerCase());
    if (!same) {
      return {
        ok: false,
        error: `${target.id} already holds ${existing.books.length} books sorted as [${existing.categories.join(", ")}] (bottom to top). Reuse that order, or call clear_shelf first.`,
      };
    }
  }

  if (input.books.length === 0) return { ok: false, error: "books must not be empty." };
  if (input.books.length > 30) return { ok: false, error: "At most 30 books per call." };

  const lowerCategories = categories.map((c) => c.toLowerCase());
  const nextSlot = categories.map((_, level) =>
    (existing?.books ?? []).filter((b) => b.level === level).reduce((max, b) => Math.max(max, b.slot + 1), 0),
  );
  const placements: Placement[] = [];
  for (const [i, book] of input.books.entries()) {
    const title = book.title?.trim();
    if (!title) return { ok: false, error: `books[${i}] has an empty title.` };
    if (!COLOR_RE.test(book.color ?? "")) return { ok: false, error: `books[${i}] ("${title}") color must be a #rrggbb hex string.` };
    const level = lowerCategories.indexOf((book.category ?? "").trim().toLowerCase());
    if (level < 0) return { ok: false, error: `books[${i}] ("${title}") category "${book.category}" is not one of [${categories.join(", ")}].` };
    const slot = nextSlot[level]!;
    if (slot >= target.capacityPerLevel) {
      return { ok: false, error: `Level ${level} ("${categories[level]}") of ${target.id} is full: it fits ${target.capacityPerLevel} books.` };
    }
    nextSlot[level] = slot + 1;
    placements.push({ bookId: `book_${randomUUID().slice(0, 8)}`, title, color: book.color.toLowerCase(), category: categories[level]!, level, slot });
  }

  const shelvedBooks: ShelvedBook[] = placements.map((p) => ({ ...p, shelvedAt: now }));
  const store: LibraryStore = {
    shelves: {
      ...library.shelves,
      [target.id]: {
        sourceId,
        levels,
        categories: occupied ? existing!.categories : categories,
        books: [...(existing?.books ?? []), ...shelvedBooks],
      },
    },
  };
  return { ok: true, plan: { sourceId, targetId: target.id, levels, categories, placements }, store };
}

function textResult(payload: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}

const server = new McpServer({ name: "library", version: "0.1.0" });

server.tool(
  "inspect_shelves",
  "Lists the bookcases in the user's room: id, size, how many levels it is sorted across (one category per level, numbered from the bottom; 4 unless books already on it were sorted differently), how many books fit on a level, and how many are already shelved with which category order. Call this before shelve_books so you know the valid ids and capacity. Read-only.",
  {},
  async () => {
    const library = readLibrary();
    const shelves = listShelves(library);
    return textResult({
      shelves,
      existing: Object.fromEntries(Object.entries(library.shelves).map(([id, r]) => [id, { sourceId: r.sourceId, levels: r.levels, categories: r.categories, books: r.books.map((b) => ({ title: b.title, category: b.category, level: b.level, slot: b.slot })) }])),
      summary: describeShelves(shelves),
    });
  },
);

server.tool(
  "shelve_books",
  "Sorts books onto a bookcase. YOU read the photo: list every book you can identify with its exact title as printed on it, its dominant spine colour as a #rrggbb hex string, and which category it belongs to. Pass one category name per shelf level in bottom-to-top order -- as many categories as the bookcase has levels (see inspect_shelves; 4 by default). The tool assigns each book a level and slot on targetId, saves the arrangement, and returns the plan; your avatar then carries each book from sourceId to targetId one at a time. Call it ONCE per sorting task with all the books. This does no recognition and moves nothing itself.",
  {
    targetId: z.string().describe("Id of the bookcase to shelve onto, from inspect_shelves (e.g. \"bookcase_2\")."),
    sourceId: z.string().optional().describe("Id of the object the books are picked up from (the other bookcase, or the desk). Optional when the room has exactly two bookcases."),
    levels: z.number().int().min(MIN_SHELF_LEVELS).max(MAX_SHELF_LEVELS).optional().describe("How many levels the bookcase has (default 4). Must equal the number of categories."),
    categories: z.array(z.string()).min(MIN_SHELF_LEVELS).max(MAX_SHELF_LEVELS).describe("One distinct category name per level, bottom level first."),
    books: z
      .array(
        z.object({
          title: z.string().describe("Exact title as printed on the book."),
          color: z.string().describe("Dominant spine colour as #rrggbb."),
          category: z.string().describe("One of `categories`."),
        }),
      )
      .min(1)
      .max(30),
  },
  async (input) => {
    const library = readLibrary();
    const shelves = listShelves(library);
    const result = resolveShelving(input, shelves, library, new Date().toISOString());
    if (!result.ok) return textResult({ error: result.error, shelves: describeShelves(shelves) }, true);
    writeLibrary(result.store);
    return textResult({ shelving: true, ...result.plan, shelves: describeShelves(listShelves(result.store)) });
  },
);

server.tool(
  "clear_shelf",
  "Removes every book previously shelved on a bookcase (the virtual replicas disappear and the arrangement is forgotten). Use when the user asks to clear, reset or redo the sorting.",
  {
    targetId: z.string().describe("Id of the bookcase to clear, from inspect_shelves."),
  },
  async ({ targetId }) => {
    const library = readLibrary();
    const shelves = listShelves(library);
    if (!shelves.some((s) => s.id === targetId)) {
      return textResult({ error: `Unknown targetId "${targetId}".`, shelves: describeShelves(shelves) }, true);
    }
    const removed = library.shelves[targetId]?.books.length ?? 0;
    const { [targetId]: _gone, ...rest } = library.shelves;
    writeLibrary({ shelves: rest });
    return textResult({ cleared: true, targetId, removed });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main();
}
