#!/usr/bin/env bun

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { newestScanPath } from "../rooms/room-store.js";

/**
 * `spatial` MCP server — lets an agent reposition its own avatar in the room.
 *
 * This tool MOVES NOTHING. It is a signalling channel: the XR client watches
 * opencode's tool parts over SSE and performs the walk itself, exactly as it
 * already does for `kitchen_inspect_inventory`. The server's job is to
 * validate the requested placement against the room the client is actually
 * rendering, and to tell the agent what the valid options are when it guesses
 * wrong. Keeping movement client-side is what stops the avatar's position from
 * having two sources of truth.
 *
 * It is a SEPARATE server from `kitchen` rather than three more tools on that
 * one, because opencode namespaces tools as `<serverName>_<toolName>`. Folding
 * these in would name them `kitchen_move_agent`, which is both wrong and would
 * break the chef persona, whose prompt enumerates the four kitchen tools it is
 * allowed under `"*": false`.
 *
 * This is the SLOW path. The client resolves obvious phrasings itself with a
 * regex fast path (movement-intent.js) and never involves the model at all;
 * this exists for everything that parser deliberately declines to guess at.
 */

const PLACEMENTS = ["station", "seat", "sit_near", "stand_near", "to_user"] as const;
type Placement = (typeof PLACEMENTS)[number];

/** Placements that name somewhere in the room and therefore need a targetId. */
const NEEDS_TARGET: ReadonlySet<Placement> = new Set<Placement>(["sit_near", "stand_near"]);

interface RoomObject {
  id?: unknown;
  label?: unknown;
}

/**
 * Ids in the newest saved scan.
 *
 * Read fresh on every call rather than cached: a rescan writes a new file at
 * any moment (`newScanPath` never overwrites), and an agent validating against
 * a room the user has since replaced would reject ids that now exist and
 * accept ids that no longer do.
 */
function listPlaces(): Array<{ id: string; label?: string }> {
  const path = newestScanPath();
  if (!path) return [];
  try {
    const room = JSON.parse(readFileSync(path, "utf8")) as { objects?: RoomObject[] };
    const places: Array<{ id: string; label?: string }> = [];
    for (const object of room.objects ?? []) {
      if (typeof object?.id !== "string" || !object.id.trim()) continue;
      places.push(
        typeof object.label === "string"
          ? { id: object.id, label: object.label }
          : { id: object.id },
      );
    }
    return places;
  } catch (error) {
    console.error(`[spatial] Could not read room scan at ${path}:`, error);
    return [];
  }
}

function describePlaces(places: Array<{ id: string; label?: string }>): string {
  if (places.length === 0) return "(no room has been captured yet)";
  return places.map((p) => (p.label ? `${p.id} ("${p.label}")` : p.id)).join(", ");
}

/**
 * Validates a placement request. The valid place list rides along on SUCCESS
 * as well as failure, so an agent that guessed a bad id can correct itself on
 * the next turn without a mandatory discovery call first.
 */
export function resolveMove(
  placement: Placement,
  targetId?: string,
): { ok: true; placement: Placement; targetId: string | null; places: string }
  | { ok: false; error: string; places: string } {
  const places = listPlaces();
  const rendered = describePlaces(places);

  if (NEEDS_TARGET.has(placement)) {
    if (!targetId) {
      return { ok: false, error: `placement "${placement}" requires targetId.`, places: rendered };
    }
    if (!places.some((p) => p.id === targetId)) {
      return {
        ok: false,
        error: `Unknown targetId "${targetId}". Use one of the ids listed in validPlaces exactly.`,
        places: rendered,
      };
    }
  }

  return { ok: true, placement, targetId: targetId ?? null, places: rendered };
}

const server = new McpServer({ name: "spatial", version: "0.1.0" });

server.tool(
  "move_agent",
  "Repositions YOUR OWN avatar in the user's physical room. Call this when the user asks you to move, sit somewhere else, stand near something, go back to your seat, or come over to them -- and for nothing else. It does not do work, read anything, or affect any other agent. Placements: 'station' returns to your assigned seat/post; 'seat' takes a different free seat; 'sit_near'/'stand_near' place you at a named room object (targetId required); 'to_user' walks you over to the user to show them what you have. The response always lists the room's valid object ids, so if a targetId is rejected you can retry immediately with a correct one. If the user's message is ONLY a request to move, call this once and reply with a single short sentence -- do not plan, research, or call other tools.",
  {
    placement: z
      .enum(PLACEMENTS)
      .describe("Where to go. Use 'stand_near'/'sit_near' with targetId to name a specific object."),
    targetId: z
      .string()
      .optional()
      .describe(
        "Room object id for sit_near/stand_near, e.g. \"table\", \"chair_2\", \"fridge\". Must match validPlaces exactly; ignored for other placements.",
      ),
  },
  async ({ placement, targetId }) => {
    const result = resolveMove(placement, targetId);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: result.error, validPlaces: result.places }, null, 2),
          },
        ],
        isError: true,
      };
    }
    // The client is what actually walks the avatar, on seeing this tool part.
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              moving: true,
              placement: result.placement,
              targetId: result.targetId,
              validPlaces: result.places,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main();
}
