import { randomUUID } from "node:crypto";

import { CORE_ERROR_CODES, EnvironmentError } from "../../core/errors.js";
import type { Entity, Relation } from "../../core/schemas/world.js";
import { appendArtifact } from "../../core/world/artifact-store.js";
import { findCapability } from "../../core/world/graph-query.js";
import { resolveScopedContext } from "../../core/world/scope-builder.js";
import { buildWorldIndex } from "../../core/world/world-index.js";
import type { GroceryList, Recipe } from "../schemas/kitchen.js";
import { computeGroceryList } from "../services/grocery-list-service.js";
import { buildInventorySummary, type InventoryItem } from "../services/inventory-service.js";
import { defaultArtifactStorePath, loadKitchenWorld } from "../world/load-kitchen-world.js";

const PLAN_DINNER_OPERATION = "plan_dinner";
const PLAN_GROCERIES_OPERATION = "plan_groceries";
// Semantic targets only -- no computed offset position, see the plan's
// "Placement is semantic only" decision. Real placement math is the later
// XR phase's job, once it has panel dimensions/rendering context to get it
// right.
//
// Targets are resolved by entity TYPE against the loaded world, not by
// hardcoded id: the demo kitchen scene names its table `table_left` while a
// captured room understanding names it `table` (see the XR client's
// canonical mapping) -- resolving by type keeps both working with no id
// string coupling. Ties break on lexicographically-smallest id, which also
// prefers the bare canonical id over `_2`/`_3` duplicates.
const RECIPE_ATTACHMENT_TYPE = "furniture.table";
const GROCERY_LIST_ATTACHMENT_TYPE = "appliance.refrigerator";

function resolveAttachmentTarget(entities: Entity[], type: string, purpose: string): string {
  const candidates = entities
    .filter((entity) => entity.kind === "physical_object" && entity.type === type)
    .map((entity) => entity.id)
    .sort();
  if (candidates.length === 0) {
    throw new EnvironmentError(
      CORE_ERROR_CODES.INVALID_WORLD_DATA,
      `No ${type} object in the room to attach the ${purpose} to -- rescan the room or check the scene file.`,
    );
  }
  return candidates[0]!;
}

export interface DinnerPreparationWorkflowOptions {
  dataDir: string;
  sceneFilePath?: string;
  artifactStorePath?: string;
}

export interface DinnerPreparationArtifactSummary {
  id: string;
  type: string;
  attachedTo: string;
  attachmentSlot: string;
}

export interface DinnerPreparationResult {
  status: "GROCERY_LIST_GENERATED";
  recipe: Recipe;
  groceryList: GroceryList;
  artifacts: DinnerPreparationArtifactSummary[];
}

function createArtifactEntity(params: { idPrefix: string; type: string; label: string; attachmentSlot: string; content: unknown }): Entity {
  return {
    id: `artifact_${params.idPrefix}_${randomUUID().slice(0, 8)}`,
    kind: "digital_artifact",
    type: params.type,
    label: params.label,
    aliases: [],
    properties: {
      attachmentSlot: params.attachmentSlot,
      content: params.content,
    },
    schemaVersion: "0.1",
  };
}

function attachedToRelation(artifactId: string, targetId: string): Relation {
  return {
    id: `relation_${artifactId}_attached_to_${targetId}`,
    subjectId: artifactId,
    predicate: "attached_to",
    objectId: targetId,
    confidence: 1,
    provenance: { source: "workflow:dinner_preparation" },
  };
}

// Sequential, synchronous (single tool-call) workflow: no state-machine
// scaffolding, since there's no async approval/cart boundary yet (those are
// postponed). Throws EnvironmentError on failure at any step.
//
// `recipe` is composed by the calling agent, not generated here -- this
// backend has no visibility into which model/provider a session is using,
// so it doesn't make its own LLM call. The MCP layer already validates
// `recipe` against RecipeSchema before this function ever runs (see
// mcp-server.ts); this function's job is deterministic from here on:
// persist the recipe, compute what's missing, persist that too.
export async function runDinnerPreparationWorkflow(
  agentId: string,
  userId: string,
  recipe: Recipe,
  options: DinnerPreparationWorkflowOptions,
): Promise<DinnerPreparationResult> {
  const artifactStorePath = options.artifactStorePath ?? defaultArtifactStorePath();
  const world = await loadKitchenWorld(options.dataDir, options.sceneFilePath, artifactStorePath);
  const index = buildWorldIndex(world);
  const context = resolveScopedContext(index, { agentId, userId });

  if (!findCapability(index, agentId, PLAN_DINNER_OPERATION)) {
    throw new EnvironmentError(
      CORE_ERROR_CODES.REQUIRED_CAPABILITY_MISSING,
      `${agentId} has no "${PLAN_DINNER_OPERATION}" capability`,
    );
  }

  const inventory: InventoryItem[] = context.containers.flatMap((container) => buildInventorySummary(index, container));

  const recipeAttachmentTarget = resolveAttachmentTarget(world.entities, RECIPE_ATTACHMENT_TYPE, "recipe");
  const groceryListAttachmentTarget = resolveAttachmentTarget(
    world.entities,
    GROCERY_LIST_ATTACHMENT_TYPE,
    "grocery list",
  );

  const recipeArtifact = createArtifactEntity({
    idPrefix: "recipe",
    type: "digital_artifact.recipe",
    label: `Recipe: ${recipe.title}`,
    attachmentSlot: "surface",
    content: recipe,
  });
  await appendArtifact(artifactStorePath, recipeArtifact, [
    attachedToRelation(recipeArtifact.id, recipeAttachmentTarget),
  ]);

  if (!findCapability(index, agentId, PLAN_GROCERIES_OPERATION)) {
    throw new EnvironmentError(
      CORE_ERROR_CODES.REQUIRED_CAPABILITY_MISSING,
      `${agentId} has no "${PLAN_GROCERIES_OPERATION}" capability`,
    );
  }

  const groceryList = computeGroceryList(recipe, inventory);

  const groceryArtifact = createArtifactEntity({
    idPrefix: "grocery_list",
    type: "digital_artifact.grocery_list",
    label: "Grocery List",
    attachmentSlot: "door",
    content: groceryList,
  });
  await appendArtifact(artifactStorePath, groceryArtifact, [
    attachedToRelation(groceryArtifact.id, groceryListAttachmentTarget),
  ]);

  return {
    status: "GROCERY_LIST_GENERATED",
    recipe,
    groceryList,
    artifacts: [
      {
        id: recipeArtifact.id,
        type: recipeArtifact.type,
        attachedTo: recipeAttachmentTarget,
        attachmentSlot: "surface",
      },
      {
        id: groceryArtifact.id,
        type: groceryArtifact.type,
        attachedTo: groceryListAttachmentTarget,
        attachmentSlot: "door",
      },
    ],
  };
}
