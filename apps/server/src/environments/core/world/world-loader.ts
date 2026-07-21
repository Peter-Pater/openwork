import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CORE_ERROR_CODES, EnvironmentError } from "../errors.js";
import { SUPPORTED_SCHEMA_VERSIONS, WorldDataSchema, type WorldData } from "../schemas/world.js";

// Raw (pre-validation) shape of a pack's five data files. Each field is
// `unknown` until WorldDataSchema.safeParse proves otherwise.
export interface WorldSourceFiles {
  entities: unknown;
  relations: unknown;
  observations: unknown;
  capabilities: unknown;
  accessPolicies: unknown;
}

// Exported so packs that need to merge in additional entities/relations
// (e.g. a scene-graph import) before validating can reuse the same
// read-and-parse-with-a-clear-error behavior.
export async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new EnvironmentError(
      CORE_ERROR_CODES.INVALID_WORLD_DATA,
      `Failed to parse JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Reads a pack's five data files off disk and validates them. This is the
// only fs-touching function here -- validateWorldData() below is pure and
// is what tests exercise directly against in-memory fixtures.
export async function loadWorldFromDir(dataDir: string): Promise<WorldData> {
  const [entities, relations, observations, capabilities, accessPolicies] = await Promise.all([
    readJsonFile(join(dataDir, "entities.json")),
    readJsonFile(join(dataDir, "relations.json")),
    readJsonFile(join(dataDir, "observations.json")),
    readJsonFile(join(dataDir, "capabilities.json")),
    readJsonFile(join(dataDir, "access-policies.json")),
  ]);
  return validateWorldData({ entities, relations, observations, capabilities, accessPolicies });
}

// STRUCTURAL validation only: schema shape, duplicate ids, dangling
// references, unsupported schema versions. Deliberately does not check for
// the presence of any particular capability or access-policy rule -- a
// structurally valid world can still be missing something a given workflow
// requires, and that is the workflow's precondition to check at runtime,
// not the loader's.
export function validateWorldData(source: WorldSourceFiles): WorldData {
  const parsed = WorldDataSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvironmentError(
      CORE_ERROR_CODES.INVALID_WORLD_DATA,
      `World data failed schema validation: ${parsed.error.message}`,
      { details: { issues: parsed.error.issues } },
    );
  }
  const world = parsed.data;

  assertNoDuplicateIds(world);
  assertSupportedSchemaVersions(world);
  assertReferentialIntegrity(world);

  return world;
}

function assertNoDuplicateIds(world: WorldData): void {
  const entityIds = new Set<string>();
  for (const entity of world.entities) {
    if (entityIds.has(entity.id)) {
      throw new EnvironmentError(CORE_ERROR_CODES.INVALID_WORLD_DATA, `Duplicate entity id: ${entity.id}`);
    }
    entityIds.add(entity.id);
  }

  for (const records of [world.relations, world.observations, world.capabilities, world.accessPolicies]) {
    const recordIds = new Set<string>();
    for (const record of records) {
      if (recordIds.has(record.id)) {
        throw new EnvironmentError(CORE_ERROR_CODES.INVALID_WORLD_DATA, `Duplicate id: ${record.id}`);
      }
      recordIds.add(record.id);
    }
  }
}

function assertSupportedSchemaVersions(world: WorldData): void {
  const supported = new Set<string>(SUPPORTED_SCHEMA_VERSIONS);
  for (const entity of world.entities) {
    if (!supported.has(entity.schemaVersion)) {
      throw new EnvironmentError(
        CORE_ERROR_CODES.INVALID_WORLD_DATA,
        `Unsupported schema version "${entity.schemaVersion}" on entity ${entity.id}`,
      );
    }
  }
}

function assertReferentialIntegrity(world: WorldData): void {
  const entityIds = new Set(world.entities.map((entity) => entity.id));

  for (const relation of world.relations) {
    if (!entityIds.has(relation.subjectId)) {
      throw new EnvironmentError(
        CORE_ERROR_CODES.INVALID_WORLD_DATA,
        `Relation ${relation.id} references missing subject entity ${relation.subjectId}`,
      );
    }
    if (!entityIds.has(relation.objectId)) {
      throw new EnvironmentError(
        CORE_ERROR_CODES.INVALID_WORLD_DATA,
        `Relation ${relation.id} references missing object entity ${relation.objectId}`,
      );
    }
  }

  for (const observation of world.observations) {
    if (!entityIds.has(observation.objectId)) {
      throw new EnvironmentError(
        CORE_ERROR_CODES.INVALID_WORLD_DATA,
        `Observation ${observation.id} references missing object entity ${observation.objectId}`,
      );
    }
  }

  for (const capability of world.capabilities) {
    if (!entityIds.has(capability.subjectId)) {
      throw new EnvironmentError(
        CORE_ERROR_CODES.INVALID_WORLD_DATA,
        `Capability ${capability.id} references missing subject entity ${capability.subjectId}`,
      );
    }
    if (!entityIds.has(capability.executor.ref)) {
      throw new EnvironmentError(
        CORE_ERROR_CODES.INVALID_WORLD_DATA,
        `Capability ${capability.id} references missing executor entity ${capability.executor.ref}`,
      );
    }
  }

  for (const policy of world.accessPolicies) {
    if (!entityIds.has(policy.subjectId)) {
      throw new EnvironmentError(
        CORE_ERROR_CODES.INVALID_WORLD_DATA,
        `Access policy ${policy.id} references missing subject entity ${policy.subjectId}`,
      );
    }
  }
}
