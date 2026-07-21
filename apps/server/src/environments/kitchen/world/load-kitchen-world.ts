import { join } from "node:path";

import { resolveOpenworkDataDir } from "../../../data-dir.js";
import { CORE_ERROR_CODES, EnvironmentError } from "../../core/errors.js";
import type { WorldData } from "../../core/schemas/world.js";
import { readArtifacts } from "../../core/world/artifact-store.js";
import { importScene, type SceneFile } from "../../core/world/scene-import.js";
import { readJsonFile, validateWorldData } from "../../core/world/world-loader.js";

const ROOM_ENTITY_ID = "kitchen_01";
const SCENE_ID = "kitchen_scene_01";

// `simulated-kitchen` lives in a sibling repo (`playground/`), not inside
// `openwork/` -- this default assumes the two are checked out side by side
// under the same parent directory, matching how this whole project has been
// laid out. Override with KITCHEN_SCENE_PATH if that's not the case.
function defaultSceneFilePath(): string {
  return join(
    import.meta.dir,
    "../../../../../../../playground/spatial-agent/simulated-kitchen/Scenes/kitchen-scene.json",
  );
}

function resolveSceneFilePath(sceneFilePath?: string): string {
  return sceneFilePath ?? process.env.KITCHEN_SCENE_PATH?.trim() ?? defaultSceneFilePath();
}

// Where agent-created artifacts (recipe, grocery list, ...) persist --
// following the OPENWORK_DATA_DIR convention already used for audit logs, so
// nothing generated lands in the repo. Overridable so tests can point it at
// a temp path instead of the real data dir.
export function defaultArtifactStorePath(): string {
  return join(resolveOpenworkDataDir(), "environments", "kitchen", "artifacts.json");
}

// Loads the kitchen world by merging scene-graph-derived physical objects
// (fridge, oven, dishwasher, table, chairs -- see scene-import.ts), the
// hand-authored data files (agents, user, food-as-IoT-simulated-inventory,
// skills, tools, capabilities, access policies), and any agent-created
// artifacts persisted so far (see artifact-store.ts). Structural validation
// is unchanged -- this only assembles the raw input validateWorldData
// already checks.
export async function loadKitchenWorld(
  dataDir: string,
  sceneFilePath?: string,
  artifactStorePath?: string,
): Promise<WorldData> {
  const resolvedScenePath = resolveSceneFilePath(sceneFilePath);
  let sceneRaw: unknown;
  try {
    sceneRaw = await readJsonFile(resolvedScenePath);
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError(
      CORE_ERROR_CODES.INVALID_WORLD_DATA,
      `Could not read kitchen scene file at ${resolvedScenePath}: ${error instanceof Error ? error.message : String(error)}. Set KITCHEN_SCENE_PATH if simulated-kitchen isn't checked out alongside openwork.`,
    );
  }

  const { entities: sceneEntities, relations: sceneRelations } = importScene(sceneRaw as SceneFile, {
    roomEntityId: ROOM_ENTITY_ID,
    sceneId: SCENE_ID,
  });

  const [entities, relations, observations, capabilities, accessPolicies] = await Promise.all([
    readJsonFile(join(dataDir, "entities.json")),
    readJsonFile(join(dataDir, "relations.json")),
    readJsonFile(join(dataDir, "observations.json")),
    readJsonFile(join(dataDir, "capabilities.json")),
    readJsonFile(join(dataDir, "access-policies.json")),
  ]);

  const { entities: artifactEntities, relations: artifactRelations } = await readArtifacts(
    artifactStorePath ?? defaultArtifactStorePath(),
  );

  const mergedEntities = [...sceneEntities, ...(entities as unknown[]), ...artifactEntities];
  const mergedRelations = [...sceneRelations, ...(relations as unknown[]), ...artifactRelations];

  return validateWorldData({
    entities: mergedEntities,
    relations: mergedRelations,
    observations,
    capabilities,
    accessPolicies,
  });
}
