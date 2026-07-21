#!/usr/bin/env bun

import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { EnvironmentError } from "../core/errors.js";
import { readEntityMemory } from "../core/memory.js";
import { removeArtifact } from "../core/world/artifact-store.js";
import { findCapability, listArtifacts } from "../core/world/graph-query.js";
import { resolveScopedContext } from "../core/world/scope-builder.js";
import { buildWorldIndex } from "../core/world/world-index.js";
import { RecipeSchema } from "./schemas/kitchen.js";
import { buildInventorySummary } from "./services/inventory-service.js";
import { runDinnerPreparationWorkflow } from "./workflow/dinner-preparation-workflow.js";
import { defaultArtifactStorePath, loadKitchenWorld } from "./world/load-kitchen-world.js";

const KITCHEN_DATA_DIR = join(import.meta.dir, "data");
const KITCHEN_ROOT_DIR = import.meta.dir;
const DEFAULT_AGENT_ID = "chef_agent_01";
const DEFAULT_USER_ID = "user_01";
const INSPECT_INVENTORY_OPERATION = "inspect_inventory";
const REMOVE_ARTIFACT_OPERATION = "remove_artifact";

// Read-only: loads the world, resolves scope, and checks the addressed
// agent's own capability requirement (per Slice A's design -- the loader
// never checks this; the workflow/tool that needs the capability does, at
// call time). No recipe, grocery list, or side effect of any kind.
export async function inspectInventory(agentId: string, userId: string) {
  const world = await loadKitchenWorld(KITCHEN_DATA_DIR);
  const index = buildWorldIndex(world);
  const context = resolveScopedContext(index, { agentId, userId });

  if (!findCapability(index, agentId, INSPECT_INVENTORY_OPERATION)) {
    throw new EnvironmentError(
      "REQUIRED_CAPABILITY_MISSING",
      `${agentId} has no "${INSPECT_INVENTORY_OPERATION}" capability`,
    );
  }

  const userProfile = context.userProfile
    ? {
        id: context.userProfile.id,
        label: context.userProfile.label,
        memory: await readEntityMemory(KITCHEN_ROOT_DIR, context.userProfile),
      }
    : null;

  return {
    agentId,
    userId,
    environment: context.environment ? { id: context.environment.id, label: context.environment.label } : null,
    containers: context.containers.map((container) => ({
      container: { id: container.container.id, label: container.container.label },
      items: buildInventorySummary(index, container),
    })),
    // Furniture/appliances present in the environment that no one is
    // specifically "responsible for" (e.g. the oven, dishwasher, table,
    // chairs) -- surfaced here so a question like "what appliances do you
    // have" is answerable directly from this tool, without needing to read
    // the underlying scene/data files.
    otherObjectsInRoom: context.environmentObjects.map((entity) => ({
      id: entity.id,
      label: entity.label,
      type: entity.type,
    })),
    // Recipe/grocery-list cards (or any other digital_artifact) created in
    // an earlier turn -- persisted, so still present here even in a brand
    // new session. Lets the agent discover "there's already a recipe on the
    // table" without needing to already know its id, and gives it an id to
    // pass to remove_artifact once it's no longer needed (e.g. after
    // cooking is done).
    attachedArtifacts: listArtifacts(index).map(({ entity, attachedTo }) => ({
      id: entity.id,
      type: entity.type,
      label: entity.label,
      attachedTo,
    })),
    skills: context.skills.map((skill) => ({ id: skill.id, label: skill.label })),
    tools: context.tools.map((tool) => ({ id: tool.id, label: tool.label })),
    userProfile,
  };
}

// Removes a previously-persisted artifact (e.g. once the user is done
// cooking and the recipe/grocery-list cards are no longer needed). Capability-
// gated like every other operation here; a no-op (not an error) if the id
// doesn't exist -- e.g. already removed, or a stale id from an earlier turn.
export async function removeKitchenArtifact(agentId: string, artifactId: string): Promise<{ removed: boolean }> {
  const world = await loadKitchenWorld(KITCHEN_DATA_DIR);
  const index = buildWorldIndex(world);

  if (!findCapability(index, agentId, REMOVE_ARTIFACT_OPERATION)) {
    throw new EnvironmentError(
      "REQUIRED_CAPABILITY_MISSING",
      `${agentId} has no "${REMOVE_ARTIFACT_OPERATION}" capability`,
    );
  }

  const removed = await removeArtifact(defaultArtifactStorePath(), artifactId);
  return { removed };
}

const server = new McpServer({ name: "kitchen", version: "0.1.0" });

server.tool(
  "inspect_inventory",
  "Read-only inspection of the simulated kitchen: environment, fridge inventory (quantity/unit/condition/confidence per item), other objects present in the room (appliances/furniture such as the oven, dishwasher, table, chairs), the chef's skills/tools, and the user's food profile if accessible. Does not generate a recipe, grocery list, or take any action. Always prefer this tool over reading the kitchen's underlying scene/data files directly -- it reflects the same graph, already access-checked.",
  {
    agentId: z.string().optional().describe(`The addressed agent's entity id. Defaults to "${DEFAULT_AGENT_ID}".`),
    userId: z.string().optional().describe(`The requesting user's entity id. Defaults to "${DEFAULT_USER_ID}".`),
  },
  async ({ agentId, userId }) => {
    try {
      const summary = await inspectInventory(agentId ?? DEFAULT_AGENT_ID, userId ?? DEFAULT_USER_ID);
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    } catch (error) {
      if (error instanceof EnvironmentError) {
        return {
          content: [{ type: "text" as const, text: `Error (${error.code}): ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
);

server.tool(
  "plan_dinner",
  "Persists a dinner recipe you compose yourself (using whatever model this session is running) as a digital_artifact attached to the table, and returns a deterministically-computed grocery list of what's missing from the fridge, persisted attached to the fridge door -- so a later inspection will still find both there. This tool does not call any LLM itself: call inspect_inventory first to see the actual fridge contents and food preferences, then compose a recipe using only ingredients confirmed present there (it's fine to require more of an ingredient than is currently available -- the grocery list step handles that deterministically).",
  {
    agentId: z.string().optional().describe(`The addressed agent's entity id. Defaults to "${DEFAULT_AGENT_ID}".`),
    userId: z.string().optional().describe(`The requesting user's entity id. Defaults to "${DEFAULT_USER_ID}".`),
    recipe: RecipeSchema.describe(
      "The recipe you composed, grounded in inspect_inventory's fridge contents -- never invent an ingredient that isn't listed there.",
    ),
  },
  async ({ agentId, userId, recipe }) => {
    try {
      const result = await runDinnerPreparationWorkflow(agentId ?? DEFAULT_AGENT_ID, userId ?? DEFAULT_USER_ID, recipe, {
        dataDir: KITCHEN_DATA_DIR,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof EnvironmentError) {
        return {
          content: [{ type: "text" as const, text: `Error (${error.code}): ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
);

server.tool(
  "remove_artifact",
  "Removes a previously-persisted artifact (a recipe or grocery-list card, or any other digital_artifact) by id -- e.g. once the user says they're done cooking and the cards on the table/fridge are no longer needed. Call inspect_inventory first if you don't already know the artifact's id (it lists attachedArtifacts). A no-op, not an error, if the id doesn't exist.",
  {
    agentId: z.string().optional().describe(`The addressed agent's entity id. Defaults to "${DEFAULT_AGENT_ID}".`),
    artifactId: z.string().describe("The id of the digital_artifact entity to remove, from inspect_inventory's attachedArtifacts list."),
  },
  async ({ agentId, artifactId }) => {
    try {
      const result = await removeKitchenArtifact(agentId ?? DEFAULT_AGENT_ID, artifactId);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof EnvironmentError) {
        return {
          content: [{ type: "text" as const, text: `Error (${error.code}): ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main();
}
