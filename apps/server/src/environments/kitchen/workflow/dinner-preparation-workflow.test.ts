import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvironmentError } from "../../core/errors.js";
import { readArtifacts } from "../../core/world/artifact-store.js";
import type { Recipe } from "../schemas/kitchen.js";
import { runDinnerPreparationWorkflow } from "./dinner-preparation-workflow.js";

const KITCHEN_DATA_DIR = join(import.meta.dir, "..", "data");

// Represents what the calling agent would compose itself (using whatever
// model its session runs) after seeing inspect_inventory's fridge contents.
const RECIPE: Recipe = {
  title: "Beef and Broccoli Stir Fry",
  servings: 2,
  rationale: "Uses the beef and broccoli that need using soon.",
  requiredIngredients: [
    { name: "beef", quantity: 300, unit: "g", required: true },
    { name: "broccoli", quantity: 150, unit: "g", required: true },
  ],
  instructions: [{ step: 1, text: "Stir fry the beef and broccoli." }],
  estimatedMinutes: 25,
};

let dir: string;
let artifactStorePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kitchen-workflow-test-"));
  artifactStorePath = join(dir, "artifacts.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dinner-preparation-workflow: runDinnerPreparationWorkflow", () => {
  test("persists the given recipe and computes a deterministic grocery list from the real fridge inventory", async () => {
    const result = await runDinnerPreparationWorkflow("chef_agent_01", "user_01", RECIPE, {
      dataDir: KITCHEN_DATA_DIR,
      artifactStorePath,
    });

    expect(result.status).toBe("GROCERY_LIST_GENERATED");
    expect(result.recipe.title).toBe("Beef and Broccoli Stir Fry");

    // Fixture has 200g beef, 100g broccoli -- recipe requires 300g/150g.
    const beefItem = result.groceryList.items.find((item) => item.ingredientName === "beef");
    const broccoliItem = result.groceryList.items.find((item) => item.ingredientName === "broccoli");
    expect(beefItem?.missingQuantity).toBe(100);
    expect(broccoliItem?.missingQuantity).toBe(50);

    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0].attachedTo).toBe("table_left");
    expect(result.artifacts[0].attachmentSlot).toBe("surface");
    expect(result.artifacts[1].attachedTo).toBe("fridge");
    expect(result.artifacts[1].attachmentSlot).toBe("door");
  });

  test("persists both artifacts with an attached_to relation to their target", async () => {
    await runDinnerPreparationWorkflow("chef_agent_01", "user_01", RECIPE, {
      dataDir: KITCHEN_DATA_DIR,
      artifactStorePath,
    });

    const stored = await readArtifacts(artifactStorePath);
    expect(stored.entities).toHaveLength(2);
    expect(stored.entities.every((entity) => entity.kind === "digital_artifact")).toBe(true);

    const recipeRelation = stored.relations.find((relation) => relation.objectId === "table_left");
    const groceryRelation = stored.relations.find((relation) => relation.objectId === "fridge");
    expect(recipeRelation?.predicate).toBe("attached_to");
    expect(groceryRelation?.predicate).toBe("attached_to");
  });

  test("throws REQUIRED_CAPABILITY_MISSING for an agent without plan_dinner", async () => {
    await expect(
      runDinnerPreparationWorkflow("kitchen_inventory_bot_01", "user_01", RECIPE, {
        dataDir: KITCHEN_DATA_DIR,
        artifactStorePath,
      }),
    ).rejects.toThrow(EnvironmentError);

    // Nothing should have been persisted for a failed precondition check.
    const stored = await readArtifacts(artifactStorePath);
    expect(stored.entities).toEqual([]);
  });
});
