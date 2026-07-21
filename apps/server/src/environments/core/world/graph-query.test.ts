import { describe, expect, test } from "bun:test";

import type { AccessPolicy, Capability, Entity, Relation } from "../schemas/world.js";
import {
  descendantsByPredicate,
  findCapability,
  hasAccess,
  hasCapability,
  listArtifacts,
  neighborsByPredicate,
} from "./graph-query.js";
import { buildWorldIndex } from "./world-index.js";
import { validateWorldData } from "./world-loader.js";

function buildIndex() {
  const entities: Entity[] = [
    { id: "agent_a", kind: "agent", type: "agent.test", label: "Agent A", aliases: [], properties: {}, schemaVersion: "0.1" },
    { id: "skill_a", kind: "skill", type: "skill.test", label: "Skill A", aliases: [], properties: {}, schemaVersion: "0.1" },
    { id: "obj_x", kind: "physical_object", type: "physical_object.test", label: "Object X", aliases: [], properties: {}, schemaVersion: "0.1" },
    { id: "obj_y", kind: "physical_object", type: "physical_object.test", label: "Object Y", aliases: [], properties: {}, schemaVersion: "0.1" },
    { id: "obj_z", kind: "physical_object", type: "physical_object.test", label: "Object Z", aliases: [], properties: {}, schemaVersion: "0.1" },
    { id: "artifact_1", kind: "digital_artifact", type: "digital_artifact.test", label: "Artifact 1", aliases: [], properties: {}, schemaVersion: "0.1" },
  ];
  const relations: Relation[] = [
    { id: "r1", subjectId: "obj_x", predicate: "contains", objectId: "obj_y", confidence: 1 },
    { id: "r2", subjectId: "obj_y", predicate: "contains", objectId: "obj_z", confidence: 1 },
    { id: "r3", subjectId: "artifact_1", predicate: "attached_to", objectId: "obj_x", confidence: 1 },
  ];
  const capabilities: Capability[] = [
    {
      id: "cap_1",
      subjectId: "agent_a",
      operation: "read_stuff",
      executor: { type: "skill", ref: "skill_a" },
      permissions: { readScope: [], writeScope: [], actScope: [], approval: "none" },
    },
  ];
  const accessPolicies: AccessPolicy[] = [
    {
      id: "policy_1",
      subjectId: "agent_a",
      rules: [
        { operation: "read", resources: ["obj_x"], effect: "allow" },
        { operation: "read_all", resources: ["*"], effect: "allow" },
        { operation: "denied_op", resources: ["*"], effect: "deny" },
      ],
    },
  ];
  const world = validateWorldData({ entities, relations, observations: [], capabilities, accessPolicies });
  return buildWorldIndex(world);
}

describe("graph-query", () => {
  test("neighborsByPredicate finds direct neighbors only", () => {
    const index = buildIndex();
    expect(neighborsByPredicate(index, "obj_x", "contains").map((e) => e.id)).toEqual(["obj_y"]);
    expect(neighborsByPredicate(index, "obj_y", "contains").map((e) => e.id)).toEqual(["obj_z"]);
  });

  test("descendantsByPredicate walks the full chain, cycle-safe", () => {
    const index = buildIndex();
    expect(descendantsByPredicate(index, "obj_x", "contains").map((e) => e.id).sort()).toEqual(["obj_y", "obj_z"]);
  });

  test("hasAccess matches an exact resource id", () => {
    const index = buildIndex();
    expect(hasAccess(index, "agent_a", "read", "obj_x")).toBe(true);
    expect(hasAccess(index, "agent_a", "read", "obj_y")).toBe(false);
  });

  test("hasAccess matches any resource via the '*' wildcard", () => {
    const index = buildIndex();
    expect(hasAccess(index, "agent_a", "read_all", "obj_x")).toBe(true);
    expect(hasAccess(index, "agent_a", "read_all", "some_entirely_other_id")).toBe(true);
  });

  test("hasAccess returns false for a deny rule even with a wildcard match", () => {
    const index = buildIndex();
    expect(hasAccess(index, "agent_a", "denied_op", "anything")).toBe(false);
  });

  test("hasAccess returns false for an unrelated subject/operation", () => {
    const index = buildIndex();
    expect(hasAccess(index, "agent_a", "purchase", "obj_x")).toBe(false);
    expect(hasAccess(index, "unknown_agent", "read", "obj_x")).toBe(false);
  });

  test("findCapability / hasCapability", () => {
    const index = buildIndex();
    expect(findCapability(index, "agent_a", "read_stuff")?.id).toBe("cap_1");
    expect(hasCapability(index, "agent_a", "read_stuff")).toBe(true);
    expect(hasCapability(index, "agent_a", "nonexistent_op")).toBe(false);
  });

  test("listArtifacts finds digital_artifact entities and their attached_to target", () => {
    const index = buildIndex();
    const artifacts = listArtifacts(index);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].entity.id).toBe("artifact_1");
    expect(artifacts[0].attachedTo).toBe("obj_x");
  });

  test("listArtifacts reports null attachedTo for an artifact with no attached_to relation", () => {
    const entities: Entity[] = [
      { id: "artifact_orphan", kind: "digital_artifact", type: "digital_artifact.test", label: "Orphan", aliases: [], properties: {}, schemaVersion: "0.1" },
    ];
    const world = validateWorldData({ entities, relations: [], observations: [], capabilities: [], accessPolicies: [] });
    const index = buildWorldIndex(world);
    expect(listArtifacts(index)).toEqual([{ entity: entities[0], attachedTo: null }]);
  });
});
