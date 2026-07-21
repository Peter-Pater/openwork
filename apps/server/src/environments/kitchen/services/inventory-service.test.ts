import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { importScene, type SceneFile } from "../../core/world/scene-import.js";
import { resolveScopedContext } from "../../core/world/scope-builder.js";
import { buildWorldIndex } from "../../core/world/world-index.js";
import { readJsonFile, validateWorldData } from "../../core/world/world-loader.js";
import accessPolicies from "../data/access-policies.json" with { type: "json" };
import capabilities from "../data/capabilities.json" with { type: "json" };
import entities from "../data/entities.json" with { type: "json" };
import lowConfidenceObservations from "../data/fixtures/inventory-low-confidence.json" with { type: "json" };
import relations from "../data/relations.json" with { type: "json" };
import { loadKitchenWorld } from "../world/load-kitchen-world.js";
import { buildInventorySummary, LOW_CONFIDENCE_THRESHOLD } from "./inventory-service.js";

const KITCHEN_DATA_DIR = join(import.meta.dir, "..", "data");
const SCENE_FILE_PATH = join(
  import.meta.dir,
  "../../../../../../../playground/spatial-agent/simulated-kitchen/Scenes/kitchen-scene.json",
);

// Mirrors load-kitchen-world.ts's merge, but lets a test swap in a different
// observations fixture (e.g. the low-confidence variant) while keeping the
// scene-imported fridge + hand-authored entities/relations the same.
async function buildMergedWorld(observations: unknown) {
  const sceneRaw = await readJsonFile(SCENE_FILE_PATH);
  const { entities: sceneEntities, relations: sceneRelations } = importScene(sceneRaw as SceneFile, {
    roomEntityId: "kitchen_01",
    sceneId: "kitchen_scene_01",
  });
  return validateWorldData({
    entities: [...sceneEntities, ...entities],
    relations: [...sceneRelations, ...relations],
    observations,
    capabilities,
    accessPolicies,
  });
}

describe("inventory-service: buildInventorySummary", () => {
  test("normalizes all fridge ingredients from the base fixture", async () => {
    const world = await loadKitchenWorld(KITCHEN_DATA_DIR);
    const index = buildWorldIndex(world);
    const context = resolveScopedContext(index, { agentId: "chef_agent_01", userId: "user_01" });
    const [fridge] = context.containers;
    const summary = buildInventorySummary(index, fridge);

    expect(summary).toHaveLength(8);
    const beef = summary.find((item) => item.entityId === "ingredient_beef_01");
    expect(beef).toEqual({
      entityId: "ingredient_beef_01",
      name: "Beef",
      quantity: 200,
      unit: "g",
      condition: "good",
      confidence: 1,
      lowConfidence: false,
    });

    const cabbage = summary.find((item) => item.entityId === "ingredient_cabbage_01");
    expect(cabbage?.condition).toBe("use_soon");
  });

  test("flags a low-confidence quantity rather than treating it as certain", async () => {
    const world = await buildMergedWorld(lowConfidenceObservations);
    const index = buildWorldIndex(world);
    const context = resolveScopedContext(index, { agentId: "chef_agent_01", userId: "user_01" });
    const [fridge] = context.containers;
    const summary = buildInventorySummary(index, fridge);

    const broccoli = summary.find((item) => item.entityId === "ingredient_broccoli_01");
    expect(broccoli?.confidence).toBe(0.4);
    expect(broccoli?.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
    expect(broccoli?.lowConfidence).toBe(true);

    // Everything else in this variant is unaffected.
    const beef = summary.find((item) => item.entityId === "ingredient_beef_01");
    expect(beef?.confidence).toBe(1);
    expect(beef?.lowConfidence).toBe(false);
  });
});
