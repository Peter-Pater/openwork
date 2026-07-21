import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Entity, Relation } from "../schemas/world.js";

interface ArtifactStoreFile {
  entities: Entity[];
  relations: Relation[];
}

async function readStoreFile(path: string): Promise<ArtifactStoreFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ArtifactStoreFile>;
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
    };
  } catch {
    // Missing file (nothing created yet) or invalid JSON -- either way,
    // an empty store is the correct starting point, not an error.
    return { entities: [], relations: [] };
  }
}

// Generic (not kitchen-specific): the first write-path in the system. An
// agent-created artifact (e.g. a recipe or grocery list) is appended here so
// it's still present on the next world load, not just returned once and
// forgotten -- "attached to the table" should stay true.
export async function readArtifacts(path: string): Promise<{ entities: Entity[]; relations: Relation[] }> {
  return readStoreFile(path);
}

export async function appendArtifact(path: string, entity: Entity, relations: Relation[]): Promise<void> {
  const current = await readStoreFile(path);
  current.entities.push(entity);
  current.relations.push(...relations);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(current, null, 2), "utf8");
}

// Removes a previously-created artifact and any relations mentioning it (as
// either subject or object), so nothing dangling is left behind. Returns
// false (no-op, not an error) if the id wasn't found -- e.g. already
// removed, or a stale id from an earlier conversation turn.
export async function removeArtifact(path: string, entityId: string): Promise<boolean> {
  const current = await readStoreFile(path);
  const nextEntities = current.entities.filter((entity) => entity.id !== entityId);
  if (nextEntities.length === current.entities.length) return false;

  const nextRelations = current.relations.filter(
    (relation) => relation.subjectId !== entityId && relation.objectId !== entityId,
  );

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ entities: nextEntities, relations: nextRelations }, null, 2), "utf8");
  return true;
}
