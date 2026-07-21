import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Entity, Relation } from "../schemas/world.js";
import { appendArtifact, readArtifacts, removeArtifact } from "./artifact-store.js";

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kitchen-artifact-store-"));
  storePath = join(dir, "artifacts.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function artifact(id: string): Entity {
  return {
    id,
    kind: "digital_artifact",
    type: "digital_artifact.test",
    label: id,
    aliases: [],
    properties: {},
    schemaVersion: "0.1",
  };
}

function attachedTo(id: string, targetId: string): Relation {
  return {
    id: `relation_${id}_attached_to_${targetId}`,
    subjectId: id,
    predicate: "attached_to",
    objectId: targetId,
    confidence: 1,
  };
}

describe("artifact-store", () => {
  test("readArtifacts returns an empty store when the file doesn't exist yet", async () => {
    const result = await readArtifacts(storePath);
    expect(result).toEqual({ entities: [], relations: [] });
  });

  test("appendArtifact creates the file and readArtifacts sees it", async () => {
    await appendArtifact(storePath, artifact("artifact_1"), [attachedTo("artifact_1", "table_left")]);
    const result = await readArtifacts(storePath);
    expect(result.entities.map((e) => e.id)).toEqual(["artifact_1"]);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].objectId).toBe("table_left");
  });

  test("appendArtifact accumulates across multiple calls", async () => {
    await appendArtifact(storePath, artifact("artifact_1"), [attachedTo("artifact_1", "table_left")]);
    await appendArtifact(storePath, artifact("artifact_2"), [attachedTo("artifact_2", "fridge")]);
    const result = await readArtifacts(storePath);
    expect(result.entities.map((e) => e.id).sort()).toEqual(["artifact_1", "artifact_2"]);
    expect(result.relations).toHaveLength(2);
  });

  test("removeArtifact removes the entity and its relations, returning true", async () => {
    await appendArtifact(storePath, artifact("artifact_1"), [attachedTo("artifact_1", "table_left")]);
    const removed = await removeArtifact(storePath, "artifact_1");
    expect(removed).toBe(true);
    const result = await readArtifacts(storePath);
    expect(result).toEqual({ entities: [], relations: [] });
  });

  test("removeArtifact only removes the targeted artifact, leaving others intact", async () => {
    await appendArtifact(storePath, artifact("artifact_1"), [attachedTo("artifact_1", "table_left")]);
    await appendArtifact(storePath, artifact("artifact_2"), [attachedTo("artifact_2", "fridge")]);
    const removed = await removeArtifact(storePath, "artifact_1");
    expect(removed).toBe(true);
    const result = await readArtifacts(storePath);
    expect(result.entities.map((e) => e.id)).toEqual(["artifact_2"]);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].subjectId).toBe("artifact_2");
  });

  test("removeArtifact is a no-op (returns false) for an id that doesn't exist", async () => {
    await appendArtifact(storePath, artifact("artifact_1"), [attachedTo("artifact_1", "table_left")]);
    const removed = await removeArtifact(storePath, "nonexistent_id");
    expect(removed).toBe(false);
    const result = await readArtifacts(storePath);
    expect(result.entities).toHaveLength(1);
  });
});
