import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { EnvironmentError } from "../errors.js";
import { loadKitchenWorld } from "../../kitchen/world/load-kitchen-world.js";
import type { AccessPolicy, Capability, Entity, Observation, Relation } from "../schemas/world.js";
import type { WorldSourceFiles } from "./world-loader.js";
import { validateWorldData } from "./world-loader.js";

const KITCHEN_DATA_DIR = join(import.meta.dir, "..", "..", "kitchen", "data");

function minimalValidWorld() {
  const entities: Entity[] = [
    {
      id: "agent_01",
      kind: "agent",
      type: "agent.test",
      label: "Agent",
      aliases: [],
      properties: {},
      schemaVersion: "0.1",
    },
  ];
  const relations: Relation[] = [];
  const observations: Observation[] = [];
  const capabilities: Capability[] = [];
  const accessPolicies: AccessPolicy[] = [];
  return { entities, relations, observations, capabilities, accessPolicies } satisfies WorldSourceFiles;
}

describe("world-loader: structural validation only", () => {
  test("loads the merged kitchen world (scene-imported + hand-authored) without error", async () => {
    const world = await loadKitchenWorld(KITCHEN_DATA_DIR);
    expect(world.entities.length).toBeGreaterThan(0);
    expect(world.entities.find((entity) => entity.id === "chef_agent_01")).toBeDefined();
    expect(world.entities.find((entity) => entity.id === "fridge")).toBeDefined();
  });

  test("accepts a structurally valid world with no capabilities or access policies at all", () => {
    // The loader must NOT assert that any particular capability or policy
    // exists (e.g. a purchase-approval policy) -- that is a workflow
    // precondition, checked at runtime by the workflow that needs it.
    const world = validateWorldData(minimalValidWorld());
    expect(world.capabilities).toEqual([]);
    expect(world.accessPolicies).toEqual([]);
  });

  test("rejects duplicate entity ids", () => {
    const source = minimalValidWorld();
    source.entities = [...source.entities, ...source.entities];
    expect(() => validateWorldData(source)).toThrow(EnvironmentError);
  });

  test("rejects a relation referencing a missing object entity", () => {
    const source = minimalValidWorld();
    source.relations = [{ id: "r1", subjectId: "agent_01", predicate: "contains", objectId: "missing_01", confidence: 1 }];
    expect(() => validateWorldData(source)).toThrow(EnvironmentError);
  });

  test("rejects a relation referencing a missing subject entity", () => {
    const source = minimalValidWorld();
    source.relations = [{ id: "r1", subjectId: "missing_01", predicate: "contains", objectId: "agent_01", confidence: 1 }];
    expect(() => validateWorldData(source)).toThrow(EnvironmentError);
  });

  test("rejects an observation referencing a missing object entity", () => {
    const source = minimalValidWorld();
    source.observations = [
      { id: "o1", objectId: "missing_01", key: "quantity", value: 1, observedAt: "2026-01-01T00:00:00Z", confidence: 1 },
    ];
    expect(() => validateWorldData(source)).toThrow(EnvironmentError);
  });

  test("rejects a capability referencing a missing subject entity", () => {
    const source = minimalValidWorld();
    source.capabilities = [
      {
        id: "c1",
        subjectId: "missing_01",
        operation: "test_operation",
        executor: { type: "skill", ref: "agent_01" },
        permissions: { readScope: [], writeScope: [], actScope: [], approval: "none" },
      },
    ];
    expect(() => validateWorldData(source)).toThrow(EnvironmentError);
  });

  test("rejects a capability referencing a missing executor entity", () => {
    const source = minimalValidWorld();
    source.capabilities = [
      {
        id: "c1",
        subjectId: "agent_01",
        operation: "test_operation",
        executor: { type: "skill", ref: "missing_01" },
        permissions: { readScope: [], writeScope: [], actScope: [], approval: "none" },
      },
    ];
    expect(() => validateWorldData(source)).toThrow(EnvironmentError);
  });

  test("rejects an access policy referencing a missing subject entity", () => {
    const source = minimalValidWorld();
    source.accessPolicies = [{ id: "p1", subjectId: "missing_01", rules: [] }];
    expect(() => validateWorldData(source)).toThrow(EnvironmentError);
  });

  test("rejects an unsupported schema version", () => {
    const source = minimalValidWorld();
    source.entities = [{ ...source.entities[0], schemaVersion: "9.9" }];
    expect(() => validateWorldData(source)).toThrow(EnvironmentError);
  });
});
