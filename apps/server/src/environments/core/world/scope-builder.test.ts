import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { EnvironmentError } from "../errors.js";
import { loadKitchenWorld } from "../../kitchen/world/load-kitchen-world.js";
import { resolveScopedContext } from "./scope-builder.js";
import { buildWorldIndex } from "./world-index.js";

const KITCHEN_DATA_DIR = join(import.meta.dir, "..", "..", "kitchen", "data");

async function loadKitchenIndex() {
  const world = await loadKitchenWorld(KITCHEN_DATA_DIR);
  return buildWorldIndex(world);
}

describe("scope-builder: dual-root resolveScopedContext", () => {
  test("resolves the chef's agent-rooted environment, fridge contents, skills, tools, and policies", async () => {
    const index = await loadKitchenIndex();
    const context = resolveScopedContext(index, { agentId: "chef_agent_01", userId: "user_01" });

    expect(context.environment?.id).toBe("kitchen_01");

    expect(context.containers).toHaveLength(1);
    expect(context.containers[0].container.id).toBe("fridge");
    const contentIds = context.containers[0].contents.map((entity) => entity.id).sort();
    expect(contentIds).toEqual(
      [
        "ingredient_beef_01",
        "ingredient_broccoli_01",
        "ingredient_butter_01",
        "ingredient_cabbage_01",
        "ingredient_garlic_01",
        "ingredient_hamburger_01",
        "ingredient_tomato_01",
        "ingredient_yogurt_01",
      ].sort(),
    );

    expect(context.skills.map((entity) => entity.id).sort()).toEqual(
      [
        "skill_dinner_planning_01",
        "skill_grocery_planning_01",
        "skill_inventory_check_01",
        "skill_artifact_management_01",
      ].sort(),
    );
    expect(context.tools.map((entity) => entity.id).sort()).toEqual(
      ["tool_save_on_foods_cart_01", "tool_save_on_foods_purchase_01"].sort(),
    );
    expect(context.accessPolicies.map((policy) => policy.id)).toEqual(["policy_chef_01"]);
  });

  test("surfaces other room objects not already listed as a container", async () => {
    const index = await loadKitchenIndex();
    const context = resolveScopedContext(index, { agentId: "chef_agent_01", userId: "user_01" });
    const otherIds = context.environmentObjects.map((entity) => entity.id).sort();
    // Scene-imported furniture/appliances the chef isn't specifically
    // responsible_for, but which still exist in the graph and should be
    // answerable -- the fridge itself is excluded since it's already
    // reported as a container. (The dishwasher/oven were added to the live
    // scene file through the scene editor with generated ids, hence
    // `simulator-object-N` rather than semantic names.)
    expect(otherIds).toEqual(
      ["chair_right", "simulator-object-1", "simulator-object-2", "table_left"].sort(),
    );
    expect(otherIds).not.toContain("fridge");
  });

  test("includes the user's food profile via the user root, gated by the chef's access policy", async () => {
    const index = await loadKitchenIndex();
    const context = resolveScopedContext(index, { agentId: "chef_agent_01", userId: "user_01" });
    expect(context.userProfile?.id).toBe("user_food_profile_01");
  });

  test("omits the user profile for an agent without a read grant on it", async () => {
    const index = await loadKitchenIndex();
    const context = resolveScopedContext(index, { agentId: "kitchen_inventory_bot_01", userId: "user_01" });
    expect(context.userProfile).toBeNull();
    // Has no responsible_for/has_skill/has_tool relations in the fixture...
    expect(context.containers).toEqual([]);
    expect(context.skills).toEqual([]);
    expect(context.tools).toEqual([]);
    // ...but environmentObjects is independent of responsible_for -- it's
    // assigned_to the same kitchen_01, so it still sees everything located
    // in that room, fridge included (nothing here is listed as a container
    // for this agent, so nothing gets excluded).
    expect(context.environmentObjects.map((e) => e.id).sort()).toEqual(
      ["chair_right", "fridge", "simulator-object-1", "simulator-object-2", "table_left"].sort(),
    );
  });

  test("throws ADDRESSED_AGENT_NOT_FOUND for an unknown addressed entity", async () => {
    const index = await loadKitchenIndex();
    expect(() => resolveScopedContext(index, { agentId: "does_not_exist", userId: "user_01" })).toThrow(
      EnvironmentError,
    );
  });

  test("throws ADDRESSED_AGENT_NOT_FOUND when the addressed entity is not an agent", async () => {
    const index = await loadKitchenIndex();
    expect(() => resolveScopedContext(index, { agentId: "fridge", userId: "user_01" })).toThrow(EnvironmentError);
  });

  test("does not pull in unrelated entities", async () => {
    const index = await loadKitchenIndex();
    const context = resolveScopedContext(index, { agentId: "chef_agent_01", userId: "user_01" });
    const containerIds = context.containers.map((c) => c.container.id);
    // kitchen_inventory_bot_01 is a second agent in the fixture, unrelated to
    // the chef's own scope, and must never leak into the chef's context.
    expect(containerIds).not.toContain("kitchen_inventory_bot_01");
    expect(context.skills.map((s) => s.id)).not.toContain("kitchen_inventory_bot_01");
  });
});
