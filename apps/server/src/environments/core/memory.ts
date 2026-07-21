import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Entity } from "./schemas/world.js";

// Memory lives outside the JSON graph as markdown files -- an entity's
// record only ever carries a pointer (`properties.memoryRef`, a path
// relative to `memoryDir`), never the content itself. Generic across any
// environment pack; see SpatialTeammates.md's "Skills, tools, and memory"
// section.
export async function readEntityMemory(memoryDir: string, entity: Entity): Promise<string | null> {
  const memoryRef = entity.properties.memoryRef;
  if (typeof memoryRef !== "string" || !memoryRef.trim()) return null;

  try {
    return await readFile(join(memoryDir, memoryRef), "utf8");
  } catch {
    return null;
  }
}
